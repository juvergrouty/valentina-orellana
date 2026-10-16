// Almacenamiento del transcriptor — paquete P1 (50-arquitectura §3.2, 30-seguridad §3–4, §7.2).
//
// Cloudflare R2 (API S3, jurisdicción 'us'):
//   • R2_BUCKET_AUDIO           audio temporal, llaves a/…; ciclo de vida 1 día como red de seguridad.
//   • R2_BUCKET_TRANSCRIPCIONES objetos cifrados VOT1, llaves t/<uuid>.bin.
// Backblaze B2 (API S3): B2_BUCKET, copia de las transcripciones con la MISMA llave.
//
// Reglas:
//   • El audio nunca pasa por Vercel: el iPhone sube directo con URLs prefirmadas (multiparte de
//     8 MiB o PUT simple para los segmentos del bot). AssemblyAI lee con GET prefirmado corto.
//   • Objetos sin x-amz-meta-*, Content-Type application/octet-stream para lo cifrado, llaves
//     opacas (sin nombre, RUT, fecha ni id de paciente).
//   • Las URLs prefirmadas son tokens portador: no registrarlas ni guardarlas en Supabase.
//   • B2 guarda versiones: borrar = eliminar TODAS las versiones y marcas de ocultamiento.
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PREFIJO_AUDIO, PREFIJO_TRANSCRIPCION, TIEMPOS, type Almacenamiento, type BucketLogico, type ContextoCifrado, type TranscripcionClara } from './tipos';
import { requeridas, variable } from './entorno';
import { cifrado as cifradoPorDefecto, sha256Hex, type CifradoVOT1 } from './cifrado';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Tamaño fijo de parte para la subida multiparte del grabador (R2 exige ≥ 5 MiB salvo la última). */
export const TAMANO_PARTE = 8 * 1024 * 1024;
/** R2/S3: máximo de partes por subida. */
export const MAX_PARTES = 10_000;
/** Tope de tamaño de un audio (una sesión de 50–90 min a 32–64 kbps pesa 12–45 MB). */
export const TOPE_AUDIO_BYTES = 200 * 1024 * 1024;
/** Vigencia máxima de una URL prefirmada en R2 (7 días). */
const MAX_VIGENCIA_SEG = 7 * 24 * 60 * 60;
const TIPO_CIFRADO = 'application/octet-stream';

/** Formatos de audio aceptados (extensión → Content-Type que queda firmado en la URL). */
export const TIPOS_AUDIO: Readonly<Record<string, string>> = {
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

// ─── Llaves de objeto ─────────────────────────────────────────────────────────

const RE_AUDIO = /^a\/[A-Za-z0-9_-]{1,64}(?:\/[0-9]{1,5})?\.(webm|m4a|mp4|aac|ogg|wav)$/;
const RE_TRANSCRIPCION = /^t\/[A-Za-z0-9_-]{1,64}\.bin$/;

/** Llave nueva para un audio: a/<uuid>.<ext> (o a/<uuid>/<seq>.<ext> para segmentos). */
export function nuevaClaveAudio(ext: string, opciones?: { id?: string; seq?: number }): string {
  if (!(ext in TIPOS_AUDIO)) throw new Error(`Formato de audio no permitido: ${ext}`);
  const id = opciones?.id ?? randomUUID();
  const key = opciones?.seq != null ? `${PREFIJO_AUDIO}${id}/${opciones.seq}.${ext}` : `${PREFIJO_AUDIO}${id}.${ext}`;
  validarClave('audio', key);
  return key;
}

/** Llave nueva para una transcripción u otro objeto cifrado: t/<uuid>.bin. */
export function nuevaClaveTranscripcion(): string {
  return `${PREFIJO_TRANSCRIPCION}${randomUUID()}.bin`;
}

/** Rechaza llaves que no sean del prefijo y forma esperados (defensa contra llaves del cliente). */
export function validarClave(bucket: BucketLogico, key: string): void {
  const ok = bucket === 'audio' ? RE_AUDIO.test(key) : RE_TRANSCRIPCION.test(key);
  if (!ok) throw new Error(`Llave de objeto inválida para el bucket ${bucket}`);
}

function vigencia(seg: number | undefined, defecto: number): number {
  const v = Math.floor(seg ?? defecto);
  if (!Number.isFinite(v) || v < 1 || v > MAX_VIGENCIA_SEG) throw new Error('Vigencia de URL fuera de rango (1 s a 7 días)');
  return v;
}

// ─── Clientes S3 ──────────────────────────────────────────────────────────────

/**
 * Opciones comunes: solo calcular checksums cuando la operación lo exige. Desde v3.729 el SDK
 * agrega CRC32 por defecto y lo mete en las URLs prefirmadas; eso rompe la subida del navegador
 * (no puede calcular ese checksum) y no todos los S3 compatibles lo aceptan.
 */
export const OPCIONES_COMUNES = {
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  maxAttempts: 3,
} as const;

/** Endpoint R2 según jurisdicción: https://<ACCOUNT_ID>.<jurisdicción>.r2.cloudflarestorage.com */
export function endpointR2(accountId: string, jurisdiccion?: string): string {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('R2_ACCOUNT_ID con formato inesperado');
  const j = (jurisdiccion ?? '').trim().toLowerCase();
  if (j && !/^(us|eu|fedramp)$/.test(j)) throw new Error('R2_JURISDICCION inválida (us, eu o fedramp)');
  return j ? `https://${accountId}.${j}.r2.cloudflarestorage.com` : `https://${accountId}.r2.cloudflarestorage.com`;
}

export function crearClienteR2(): S3Client {
  const e = requeridas(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const);
  return new S3Client({
    ...OPCIONES_COMUNES,
    region: 'auto',
    endpoint: endpointR2(e.R2_ACCOUNT_ID, variable('R2_JURISDICCION') ?? 'us'),
    credentials: { accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY },
  });
}

export function crearClienteB2(): S3Client {
  const e = requeridas(['B2_ENDPOINT', 'B2_REGION', 'B2_KEY_ID', 'B2_APPLICATION_KEY'] as const);
  const endpoint = /^https:\/\//.test(e.B2_ENDPOINT) ? e.B2_ENDPOINT : `https://${e.B2_ENDPOINT}`;
  return new S3Client({
    ...OPCIONES_COMUNES,
    region: e.B2_REGION,
    endpoint,
    credentials: { accessKeyId: e.B2_KEY_ID, secretAccessKey: e.B2_APPLICATION_KEY },
  });
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function esNoEncontrado(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Mensaje de error sin URLs firmadas ni credenciales (solo nombre/código/estado HTTP). */
export function describirError(err: unknown): string {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return `${e?.name ?? 'Error'}${e?.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : ''}`;
}

async function cuerpoABytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof b.transformToByteArray === 'function') return await b.transformToByteArray();
  if (body instanceof Uint8Array) return body;
  throw new Error('Cuerpo de respuesta S3 no reconocido');
}

/** JSON → gzip (se comprime ANTES de cifrar; 30-seguridad §3.3). */
export function serializarTranscripcion(t: TranscripcionClara): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(t), 'utf8')));
}
export function deserializarTranscripcion(bytes: Uint8Array): TranscripcionClara {
  const t = JSON.parse(gunzipSync(bytes).toString('utf8')) as TranscripcionClara;
  if (!t || t.v !== 1 || !Array.isArray(t.segmentos)) throw new Error('Transcripción con formato inesperado');
  return t;
}

// ─── Interfaz extendida ───────────────────────────────────────────────────────

export interface ParteSubida { numero: number; etag: string }

export interface ResultadoGuardado {
  r2Key: string;
  /** null si la copia a B2 falló (el chequeo diario `copias_b2` la reintenta). */
  b2Key: string | null;
  b2Error: string | null;
  sha256: string;
  bytes: number;
  kekV: number;
  /** iv_envoltura ‖ DEK envuelta (60 bytes) → columna `dek_envuelta` (bytea). */
  dekEnvuelta: Uint8Array;
  formatoV: number;
}

export interface AlmacenamientoTranscriptor extends Almacenamiento {
  // Subida multiparte del grabador presencial (partes de 8 MiB).
  iniciarMultiparte(key: string, contentType: string): Promise<{ uploadId: string }>;
  urlsPartes(key: string, uploadId: string, numeros: number[], vigenciaSeg?: number): Promise<{ numero: number; url: string }[]>;
  completarMultiparte(key: string, uploadId: string, partes: ParteSubida[]): Promise<{ bytes: number }>;
  abortarMultiparte(key: string, uploadId: string): Promise<void>;
  /** Lista objetos de un bucket R2 (para el chequeo "audio > 12 h"). Sin contenido. */
  listar(bucket: 'audio' | 'transcripciones', prefijo?: string, max?: number): Promise<{ key: string; bytes: number; modificado: Date | null }[]>;
  // Alto nivel.
  guardarTranscripcion(t: TranscripcionClara, key?: string): Promise<ResultadoGuardado>;
  guardarCifrado(claro: Uint8Array, ctx: ContextoCifrado): Promise<ResultadoGuardado>;
  leerTranscripcion(key: string): Promise<TranscripcionClara>;
  leerCifrado(ctx: ContextoCifrado, origen?: 'r2' | 'b2'): Promise<Uint8Array>;
  borrarAudio(key: string): Promise<void>;
  /** Borra la transcripción en R2 y TODAS sus versiones en B2 (supresión / plazo de 15 años). */
  borrarTranscripcion(key: string): Promise<void>;
}

export interface OpcionesAlmacenamiento {
  r2?: S3Client;
  b2?: S3Client;
  buckets?: { audio: string; transcripciones: string; b2: string };
  cifrado?: CifradoVOT1;
}

// ─── Implementación ───────────────────────────────────────────────────────────

export function crearAlmacenamiento(op: OpcionesAlmacenamiento = {}): AlmacenamientoTranscriptor {
  let r2: S3Client | undefined = op.r2;
  let b2: S3Client | undefined = op.b2;
  const cif = op.cifrado ?? cifradoPorDefecto;

  const clienteR2 = () => (r2 ??= crearClienteR2());
  const clienteB2 = () => (b2 ??= crearClienteB2());

  function nombreBucket(b: BucketLogico): string {
    if (op.buckets) return op.buckets[b];
    if (b === 'audio') return requeridas(['R2_BUCKET_AUDIO'] as const).R2_BUCKET_AUDIO;
    if (b === 'transcripciones') return requeridas(['R2_BUCKET_TRANSCRIPCIONES'] as const).R2_BUCKET_TRANSCRIPCIONES;
    return requeridas(['B2_BUCKET'] as const).B2_BUCKET;
  }
  const cliente = (b: BucketLogico) => (b === 'b2' ? clienteB2() : clienteR2());

  async function put(bucket: BucketLogico, key: string, datos: Uint8Array, contentType = TIPO_CIFRADO) {
    validarClave(bucket, key);
    await cliente(bucket).send(new PutObjectCommand({
      Bucket: nombreBucket(bucket), Key: key, Body: datos, ContentType: contentType, ContentLength: datos.length,
    }));
    return { sha256: await sha256Hex(datos), bytes: datos.length };
  }

  async function get(bucket: BucketLogico, key: string): Promise<Uint8Array> {
    validarClave(bucket, key);
    const r = await cliente(bucket).send(new GetObjectCommand({ Bucket: nombreBucket(bucket), Key: key }));
    return cuerpoABytes(r.Body);
  }

  async function head(bucket: BucketLogico, key: string): Promise<{ bytes: number } | null> {
    validarClave(bucket, key);
    try {
      const r = await cliente(bucket).send(new HeadObjectCommand({ Bucket: nombreBucket(bucket), Key: key }));
      return { bytes: Number(r.ContentLength ?? 0) };
    } catch (err) {
      if (esNoEncontrado(err)) return null;
      throw err;
    }
  }

  async function borrarDeB2(key: string): Promise<void> {
    validarClave('b2', key);
    const Bucket = nombreBucket('b2');
    const c = clienteB2();
    // Hasta 3 pasadas: listar todas las versiones y marcas de ocultamiento de ESA llave y
    // borrarlas por VersionId (un DeleteObject sin VersionId solo oculta en B2).
    for (let pasada = 0; pasada < 3; pasada++) {
      const versiones: string[] = [];
      let KeyMarker: string | undefined;
      let VersionIdMarker: string | undefined;
      do {
        const r = await c.send(new ListObjectVersionsCommand({ Bucket, Prefix: key, KeyMarker, VersionIdMarker, MaxKeys: 1000 }));
        for (const v of [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]) {
          if (v.Key === key && v.VersionId) versiones.push(v.VersionId);
        }
        KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
        VersionIdMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
      } while (KeyMarker);
      if (versiones.length === 0) return;
      for (const VersionId of versiones) {
        await c.send(new DeleteObjectCommand({ Bucket, Key: key, VersionId }));
      }
    }
    throw new Error('B2: quedaron versiones sin borrar tras 3 pasadas');
  }

  async function borrar(bucket: BucketLogico, key: string): Promise<void> {
    if (bucket === 'b2') return borrarDeB2(key);
    validarClave(bucket, key);
    // R2 no tiene versionado: DeleteObject es definitivo (y no falla si no existe).
    await clienteR2().send(new DeleteObjectCommand({ Bucket: nombreBucket(bucket), Key: key }));
  }

  async function copiarAB2(key: string) {
    const datos = await get('transcripciones', key);
    const { sha256 } = await put('b2', key, datos, TIPO_CIFRADO);
    const vuelta = await get('b2', key);
    const shaB2 = await sha256Hex(vuelta);
    if (shaB2 !== sha256) throw new Error('B2: la copia no coincide (sha256)');
    return { b2Key: key, sha256 };
  }

  async function urlSubida(key: string, contentType: string, vigenciaSeg?: number): Promise<string> {
    validarClave('audio', key);
    const ext = key.slice(key.lastIndexOf('.') + 1);
    if (TIPOS_AUDIO[ext] !== contentType && !(ext === 'webm' && contentType.startsWith('audio/webm'))) {
      throw new Error('Content-Type no corresponde a la extensión del audio');
    }
    return getSignedUrl(clienteR2(), new PutObjectCommand({ Bucket: nombreBucket('audio'), Key: key, ContentType: contentType }), {
      expiresIn: vigencia(vigenciaSeg, TIEMPOS.urlSubidaSeg),
      signableHeaders: new Set(['content-type']),
    });
  }

  async function urlLectura(key: string, vigenciaSeg?: number): Promise<string> {
    validarClave('audio', key); // solo audio: las transcripciones nunca salen por URL
    return getSignedUrl(clienteR2(), new GetObjectCommand({ Bucket: nombreBucket('audio'), Key: key }), {
      expiresIn: vigencia(vigenciaSeg, TIEMPOS.urlLecturaAssemblyAISeg),
    });
  }

  async function guardarCifrado(claro: Uint8Array, ctx: ContextoCifrado): Promise<ResultadoGuardado> {
    validarClave('transcripciones', ctx.claveObjeto);
    const c = await cif.cifrar(claro, ctx);
    const { sha256, bytes } = await put('transcripciones', ctx.claveObjeto, c.datos, TIPO_CIFRADO);
    // Verificar antes de seguir (el audio solo se borra después de esto: 50-arquitectura §4 punto 5).
    const h = await head('transcripciones', ctx.claveObjeto);
    if (!h || h.bytes !== bytes) throw new Error('R2: el objeto guardado no coincide en tamaño');
    let b2Key: string | null = null;
    let b2Error: string | null = null;
    try {
      b2Key = (await copiarAB2(ctx.claveObjeto)).b2Key;
    } catch (err) {
      b2Error = describirError(err); // no bloquea: ya hay copia cifrada verificada en R2
    }
    return { r2Key: ctx.claveObjeto, b2Key, b2Error, sha256, bytes, kekV: c.kekV, dekEnvuelta: c.dekEnvuelta, formatoV: c.datos[4] };
  }

  async function leerCifrado(ctx: ContextoCifrado, origen: 'r2' | 'b2' = 'r2'): Promise<Uint8Array> {
    let datos: Uint8Array;
    if (origen === 'b2') {
      datos = await get('b2', ctx.claveObjeto);
    } else {
      try {
        datos = await get('transcripciones', ctx.claveObjeto);
      } catch (err) {
        if (!esNoEncontrado(err)) throw err;
        datos = await get('b2', ctx.claveObjeto); // R2 sin el objeto → se intenta la copia
      }
    }
    return cif.descifrar(datos, ctx);
  }

  return {
    urlSubida,
    urlLectura,
    put,
    get,
    head,
    borrar,
    copiarAB2,
    borrarDeB2,

    async iniciarMultiparte(key, contentType) {
      validarClave('audio', key);
      const r = await clienteR2().send(new CreateMultipartUploadCommand({ Bucket: nombreBucket('audio'), Key: key, ContentType: contentType }));
      if (!r.UploadId) throw new Error('R2 no devolvió UploadId');
      return { uploadId: r.UploadId };
    },

    async urlsPartes(key, uploadId, numeros, vigenciaSeg) {
      validarClave('audio', key);
      if (!uploadId) throw new Error('Falta uploadId');
      const exp = vigencia(vigenciaSeg, TIEMPOS.urlSubidaSeg);
      const unicos = [...new Set(numeros)];
      if (unicos.length === 0 || unicos.length > 100) throw new Error('Pedir entre 1 y 100 partes por vez');
      return Promise.all(unicos.map(async (numero) => {
        if (!Number.isInteger(numero) || numero < 1 || numero > MAX_PARTES) throw new Error('Número de parte fuera de rango');
        const url = await getSignedUrl(clienteR2(), new UploadPartCommand({ Bucket: nombreBucket('audio'), Key: key, UploadId: uploadId, PartNumber: numero }), { expiresIn: exp });
        return { numero, url };
      }));
    },

    async completarMultiparte(key, uploadId, partes) {
      validarClave('audio', key);
      if (!partes.length) throw new Error('Sin partes');
      const ordenadas = [...partes].sort((a, b) => a.numero - b.numero);
      ordenadas.forEach((p, i) => {
        if (p.numero !== i + 1) throw new Error('Faltan partes o hay repetidas');
        if (!/^"?[A-Za-z0-9-]{1,128}"?$/.test(p.etag)) throw new Error('ETag inválido');
      });
      await clienteR2().send(new CompleteMultipartUploadCommand({
        Bucket: nombreBucket('audio'), Key: key, UploadId: uploadId,
        MultipartUpload: { Parts: ordenadas.map((p) => ({ PartNumber: p.numero, ETag: p.etag.startsWith('"') ? p.etag : `"${p.etag}"` })) },
      }));
      const h = await head('audio', key);
      if (!h) throw new Error('R2: el audio no aparece tras completar la subida');
      if (h.bytes > TOPE_AUDIO_BYTES) {
        await borrar('audio', key);
        throw new Error('Audio sobre el tope permitido; se borró');
      }
      return { bytes: h.bytes };
    },

    async abortarMultiparte(key, uploadId) {
      validarClave('audio', key);
      try {
        await clienteR2().send(new AbortMultipartUploadCommand({ Bucket: nombreBucket('audio'), Key: key, UploadId: uploadId }));
      } catch (err) {
        if (!esNoEncontrado(err)) throw err; // NoSuchUpload: ya no existe
      }
    },

    async listar(bucket, prefijo, max = 1000) {
      const Prefix = prefijo ?? (bucket === 'audio' ? PREFIJO_AUDIO : PREFIJO_TRANSCRIPCION);
      const out: { key: string; bytes: number; modificado: Date | null }[] = [];
      let ContinuationToken: string | undefined;
      do {
        const r = await clienteR2().send(new ListObjectsV2Command({ Bucket: nombreBucket(bucket), Prefix, ContinuationToken, MaxKeys: Math.min(1000, max) }));
        for (const o of r.Contents ?? []) {
          if (o.Key) out.push({ key: o.Key, bytes: Number(o.Size ?? 0), modificado: o.LastModified ?? null });
        }
        ContinuationToken = r.IsTruncated && out.length < max ? r.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out.slice(0, max);
    },

    guardarCifrado,
    guardarTranscripcion(t, key = nuevaClaveTranscripcion()) {
      return guardarCifrado(serializarTranscripcion(t), { claveObjeto: key, tipo: 'transcripcion' });
    },
    leerCifrado,
    async leerTranscripcion(key) {
      return deserializarTranscripcion(await leerCifrado({ claveObjeto: key, tipo: 'transcripcion' }));
    },

    borrarAudio: (key) => borrar('audio', key),

    async borrarTranscripcion(key) {
      validarClave('transcripciones', key);
      await borrar('transcripciones', key);
      await borrarDeB2(key);
    },
  };
}

/** Instancia por defecto (clientes y buckets desde las variables de Vercel, creados al primer uso). */
export const almacenamiento: AlmacenamientoTranscriptor = crearAlmacenamiento();
