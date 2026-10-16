// Transcriptor IA (P4) — subida MULTIPARTE del audio directo iPhone → R2 (bucket de audio
// temporal) con URLs prefirmadas (30-seguridad §4.1). El audio nunca pasa por Vercel
// (límite 4,5 MB por request). El navegador nunca recibe credenciales: solo URLs que
// permiten subir UNA parte de UN objeto durante 15 min.
//
// Contrato P1 (Almacenamiento en tipos.ts) no tiene multiparte; esto vive aquí (archivo
// de P4) con las mismas variables de entorno de P1. Si P1 lo absorbe, se reemplaza.
// Docs verificadas:
//  - Endpoint jurisdiccional https://<ACCOUNT_ID>.<JURISDICCION>.r2.cloudflarestorage.com,
//    region 'auto': https://developers.cloudflare.com/r2/reference/data-location/
//  - Prefirmadas (PUT/GET/HEAD/DELETE, máx 7 días, CORS): https://developers.cloudflare.com/r2/api/s3/presigned-urls/
//  - Multipart: partes de 5 MiB a 5 GiB, iguales salvo la última, máx 10.000:
//    https://developers.cloudflare.com/r2/objects/upload-objects/
// El CORS del bucket debe exponer ETag (ExposeHeaders: ETag) para leerlo en el navegador.
import { randomUUID } from 'node:crypto';
import { PREFIJO_AUDIO, TIEMPOS } from './tipos';

/** Tamaño fijo de parte (8 MiB). La última puede ser menor; con una sola parte, cualquier tamaño. */
export const TAMANO_PARTE = 8 * 1024 * 1024;
/** Tope por segmento (≈ 50 min a 64 kbps pesan ~24 MB; deja holgura para 3 h). */
export const MAX_BYTES_SEGMENTO = 200 * 1024 * 1024;
export const MAX_PARTES = Math.ceil(MAX_BYTES_SEGMENTO / TAMANO_PARTE);

/** Tipos de audio aceptados → extensión del objeto. Safari: MP4/AAC; Chrome: WebM/Opus. */
const MIMES: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/aac': 'aac', 'audio/ogg': 'ogg' };

/** 'audio/mp4;codecs=mp4a.40.2' → 'audio/mp4'. null si no es un audio aceptado. */
export function mimeBase(mime: unknown): string | null {
  const b = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return b in MIMES ? b : null;
}

/** Llave opaca del objeto (sin nombre, fecha ni id de paciente). */
export function nuevaLlaveAudio(mime: string): string {
  const base = mimeBase(mime);
  if (!base) throw new Error('Tipo de audio no aceptado.');
  return `${PREFIJO_AUDIO}${randomUUID()}.${MIMES[base]}`;
}

/** Cuántas partes tiene un segmento de `bytes`. */
export function partesPara(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / TAMANO_PARTE);
}

// ─── Cliente S3 de R2 (perezoso: el build y las pruebas no necesitan las variables) ───

type S3 = typeof import('@aws-sdk/client-s3');
let cache: { s3: S3; cliente: InstanceType<S3['S3Client']>; bucket: string } | null = null;

export class R2NoConfiguradoError extends Error {
  constructor() { super('R2 no está configurado (faltan variables R2_*).'); this.name = 'R2NoConfiguradoError'; }
}

async function r2() {
  if (cache) return cache;
  const env = import.meta.env;
  const cuenta = env.R2_ACCOUNT_ID, id = env.R2_ACCESS_KEY_ID, secreto = env.R2_SECRET_ACCESS_KEY, bucket = env.R2_BUCKET_AUDIO;
  if (!cuenta || !id || !secreto || !bucket) throw new R2NoConfiguradoError();
  const jur = (env.R2_JURISDICCION ?? '').trim();
  const s3 = await import('@aws-sdk/client-s3');
  const cliente = new s3.S3Client({
    region: 'auto',
    endpoint: `https://${cuenta}.${jur ? `${jur}.` : ''}r2.cloudflarestorage.com`,
    credentials: { accessKeyId: id, secretAccessKey: secreto },
    // Sin esto el SDK (>= 3.729) agrega x-amz-checksum-crc32 del cuerpo VACÍO a la URL prefirmada
    // de UploadPart y el PUT real del navegador falla (verificado generando la URL con 3.1151).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  cache = { s3, cliente, bucket };
  return cache;
}

export async function iniciarMultiparte(key: string, contentType: string): Promise<string> {
  const { s3, cliente, bucket } = await r2();
  const r = await cliente.send(new s3.CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
  if (!r.UploadId) throw new Error('R2 no devolvió UploadId.');
  return r.UploadId;
}

/** URLs PUT prefirmadas para las partes pedidas (1-based), vigencia 15 min. */
export async function urlsPartes(key: string, uploadId: string, partes: number[], vigenciaSeg: number = TIEMPOS.urlSubidaSeg): Promise<Record<number, string>> {
  const { s3, cliente, bucket } = await r2();
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const out: Record<number, string> = {};
  for (const n of partes) {
    out[n] = await getSignedUrl(cliente, new s3.UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n }), { expiresIn: vigenciaSeg });
  }
  return out;
}

export interface ParteSubida { n: number; etag: string }

export async function completarMultiparte(key: string, uploadId: string, partes: ParteSubida[]): Promise<void> {
  const { s3, cliente, bucket } = await r2();
  const Parts = [...partes].sort((a, b) => a.n - b.n).map((p) => ({ PartNumber: p.n, ETag: p.etag }));
  await cliente.send(new s3.CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts } }));
}

export async function abortarMultiparte(key: string, uploadId: string): Promise<void> {
  const { s3, cliente, bucket } = await r2();
  await cliente.send(new s3.AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

/** Tamaño del objeto en el bucket de audio; null si no existe. */
export async function bytesObjeto(key: string): Promise<number | null> {
  const { s3, cliente, bucket } = await r2();
  try {
    const r = await cliente.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }));
    return typeof r.ContentLength === 'number' ? r.ContentLength : null;
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw e;
  }
}

/** ¿El error de S3 es "la subida multiparte ya no existe" (completada antes o vencida)? */
export function esSubidaInexistente(e: unknown): boolean {
  const x = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === 'NoSuchUpload' || x?.Code === 'NoSuchUpload' || x?.$metadata?.httpStatusCode === 404;
}
