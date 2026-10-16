// Pruebas de almacenamiento (sin red): clientes S3 reales con `send` reemplazado por un
// almacén en memoria; las URLs prefirmadas se firman localmente (no hacen requests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { crearAlmacenamiento, OPCIONES_COMUNES, endpointR2, nuevaClaveAudio, nuevaClaveTranscripcion, validarClave, TAMANO_PARTE } from './almacenamiento';
import { crearCifrado, leerCabecera } from './cifrado';
import type { TranscripcionClara } from './tipos';

const CUENTA = '0123456789abcdef0123456789abcdef';
const K1 = new Uint8Array(randomBytes(32));
const cif = crearCifrado({ activa: 1, obtener: (v) => (v === 1 ? K1 : undefined) });
const BUCKETS = { audio: 'vo-audio-temporal', transcripciones: 'vo-transcripciones', b2: 'vo-respaldo' };

interface Version { id: string; datos: Uint8Array | null } // datos null = marca de ocultamiento
type Llamada = { cmd: string; input: Record<string, unknown> };

/** Almacén falso estilo S3. `versionado` imita B2 (DeleteObject sin VersionId solo oculta). */
function falso(versionado: boolean, opciones: { fallarPut?: boolean } = {}) {
  const objetos = new Map<string, Version[]>();
  const llamadas: Llamada[] = [];
  let n = 0;
  const err404 = () => Object.assign(new Error('no existe'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  const actual = (k: string) => { const vs = objetos.get(k); const u = vs?.[vs.length - 1]; return u?.datos ? u : null; };
  const cliente = new S3Client({
    ...OPCIONES_COMUNES, region: 'auto', endpoint: endpointR2(CUENTA, 'us'),
    credentials: { accessKeyId: 'AKIAPRUEBA', secretAccessKey: 'secreto-de-prueba' },
  });
  (cliente as unknown as { send: (c: unknown) => Promise<unknown> }).send = async (c: unknown) => {
    const cmd = (c as { constructor: { name: string } }).constructor.name;
    const input = (c as { input: Record<string, unknown> }).input;
    llamadas.push({ cmd, input });
    const Key = input.Key as string;
    switch (cmd) {
      case 'PutObjectCommand': {
        if (opciones.fallarPut) throw Object.assign(new Error('caída'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
        const v = { id: `v${++n}`, datos: new Uint8Array(input.Body as Uint8Array) };
        if (versionado) objetos.set(Key, [...(objetos.get(Key) ?? []), v]); else objetos.set(Key, [v]);
        return {};
      }
      case 'GetObjectCommand': {
        const v = actual(Key); if (!v) throw Object.assign(new Error('no existe'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        return { Body: { transformToByteArray: async () => v.datos } };
      }
      case 'HeadObjectCommand': {
        const v = actual(Key); if (!v) throw err404();
        return { ContentLength: v.datos!.length };
      }
      case 'DeleteObjectCommand': {
        const vid = input.VersionId as string | undefined;
        if (!versionado) { objetos.delete(Key); return {}; }
        if (!vid) { objetos.set(Key, [...(objetos.get(Key) ?? []), { id: `v${++n}`, datos: null }]); return {}; }
        objetos.set(Key, (objetos.get(Key) ?? []).filter((v) => v.id !== vid));
        if (objetos.get(Key)!.length === 0) objetos.delete(Key);
        return {};
      }
      case 'ListObjectVersionsCommand': {
        const Versions: object[] = []; const DeleteMarkers: object[] = [];
        for (const [k, vs] of objetos) {
          if (!k.startsWith(input.Prefix as string)) continue;
          for (const v of vs) (v.datos ? Versions : DeleteMarkers).push({ Key: k, VersionId: v.id });
        }
        return { Versions, DeleteMarkers, IsTruncated: false };
      }
      case 'CreateMultipartUploadCommand': return { UploadId: 'subida-1' };
      case 'CompleteMultipartUploadCommand': {
        const partes = (input.MultipartUpload as { Parts: unknown[] }).Parts;
        objetos.set(Key, [{ id: 'm', datos: new Uint8Array(partes.length * 10) }]);
        return {};
      }
      case 'AbortMultipartUploadCommand': return {};
      default: throw new Error(`comando no simulado: ${cmd}`);
    }
  };
  return { cliente, objetos, llamadas };
}

const TRANS: TranscripcionClara = {
  v: 1, idioma: 'es', modelo: 'universal-2', duracion_s: 3000, hablantes: ['Terapeuta', 'Consultante'],
  segmentos: [{ inicio_ms: 0, fin_ms: 4200, hablante: 'Terapeuta', texto: 'Texto ficticio de prueba, sin datos reales.' }],
};

test('guardar transcripción: cifra, verifica en R2, copia a B2 y se lee de vuelta', async () => {
  const r2 = falso(false); const b2 = falso(true);
  const alm = crearAlmacenamiento({ r2: r2.cliente, b2: b2.cliente, buckets: BUCKETS, cifrado: cif });
  const res = await alm.guardarTranscripcion(TRANS);
  assert.match(res.r2Key, /^t\/[0-9a-f-]{36}\.bin$/);
  assert.equal(res.b2Key, res.r2Key);
  assert.equal(res.b2Error, null);
  assert.equal(res.kekV, 1);
  assert.equal(res.formatoV, 1);
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  const guardado = r2.objetos.get(res.r2Key)![0].datos!;
  assert.equal(leerCabecera(guardado).kekV, 1);
  assert.ok(!Buffer.from(guardado).toString('latin1').includes('ficticio'), 'el objeto no lleva texto en claro');
  const put = r2.llamadas.find((l) => l.cmd === 'PutObjectCommand')!;
  assert.equal(put.input.ContentType, 'application/octet-stream');
  assert.equal(put.input.Metadata, undefined, 'sin x-amz-meta-*');
  assert.deepEqual(await alm.leerTranscripcion(res.r2Key), TRANS);
});

test('si B2 falla, el guardado en R2 igual queda y se informa b2Error', async () => {
  const r2 = falso(false); const b2 = falso(true, { fallarPut: true });
  const alm = crearAlmacenamiento({ r2: r2.cliente, b2: b2.cliente, buckets: BUCKETS, cifrado: cif });
  const res = await alm.guardarTranscripcion(TRANS);
  assert.equal(res.b2Key, null);
  assert.match(res.b2Error!, /ServiceUnavailable/);
  assert.ok(r2.objetos.has(res.r2Key));
});

test('leer usa la copia de B2 si el objeto no está en R2', async () => {
  const r2 = falso(false); const b2 = falso(true);
  const alm = crearAlmacenamiento({ r2: r2.cliente, b2: b2.cliente, buckets: BUCKETS, cifrado: cif });
  const res = await alm.guardarTranscripcion(TRANS);
  r2.objetos.clear();
  assert.deepEqual(await alm.leerTranscripcion(res.r2Key), TRANS);
});

test('borrado en B2 elimina todas las versiones y marcas de ocultamiento', async () => {
  const r2 = falso(false); const b2 = falso(true);
  const alm = crearAlmacenamiento({ r2: r2.cliente, b2: b2.cliente, buckets: BUCKETS, cifrado: cif });
  const key = nuevaClaveTranscripcion();
  const otra = nuevaClaveTranscripcion();
  await alm.put('b2', key, new Uint8Array([1]));
  await alm.put('b2', key, new Uint8Array([2]));               // versión nueva → la vieja queda oculta
  await b2.cliente.send(new (await import('@aws-sdk/client-s3')).DeleteObjectCommand({ Bucket: 'vo-respaldo', Key: key })); // marca
  await alm.put('b2', otra, new Uint8Array([9]));
  assert.equal(b2.objetos.get(key)!.length, 3);
  await alm.borrarDeB2(key);
  assert.equal(b2.objetos.has(key), false);
  assert.equal(b2.objetos.has(otra), true, 'no toca otras llaves con el mismo prefijo');
});

test('borrarTranscripcion borra en R2 y en B2', async () => {
  const r2 = falso(false); const b2 = falso(true);
  const alm = crearAlmacenamiento({ r2: r2.cliente, b2: b2.cliente, buckets: BUCKETS, cifrado: cif });
  const res = await alm.guardarTranscripcion(TRANS);
  await alm.borrarTranscripcion(res.r2Key);
  assert.equal(r2.objetos.has(res.r2Key), false);
  assert.equal(b2.objetos.has(res.r2Key), false);
});

test('borrar audio y head devuelve null cuando no existe', async () => {
  const r2 = falso(false);
  const alm = crearAlmacenamiento({ r2: r2.cliente, b2: falso(true).cliente, buckets: BUCKETS, cifrado: cif });
  const key = nuevaClaveAudio('m4a');
  await alm.put('audio', key, new Uint8Array(10), 'audio/mp4');
  assert.deepEqual(await alm.head('audio', key), { bytes: 10 });
  await alm.borrarAudio(key);
  assert.equal(await alm.head('audio', key), null);
});

test('URLs prefirmadas: endpoint us, vigencia, sin checksums, Content-Type firmado', async () => {
  const alm = crearAlmacenamiento({ r2: falso(false).cliente, b2: falso(true).cliente, buckets: BUCKETS, cifrado: cif });
  const key = nuevaClaveAudio('webm', { id: 'abc', seq: 3 });
  assert.equal(key, 'a/abc/3.webm');
  const put = new URL(await alm.urlSubida(key, 'audio/webm'));
  assert.equal(put.host, `${CUENTA}.us.r2.cloudflarestorage.com`);
  assert.equal(put.pathname, '/vo-audio-temporal/a/abc/3.webm');
  assert.equal(put.searchParams.get('X-Amz-Expires'), '900');
  assert.match(put.searchParams.get('X-Amz-SignedHeaders')!, /content-type/);
  assert.equal([...put.searchParams.keys()].some((k) => /checksum/i.test(k)), false);
  const get = new URL(await alm.urlLectura(key));
  assert.equal(get.searchParams.get('X-Amz-Expires'), String(6 * 3600));
  await assert.rejects(alm.urlLectura(key, 8 * 24 * 3600), /Vigencia/);
  await assert.rejects(alm.urlSubida(key, 'text/html'), /Content-Type/);
});

test('multiparte: URLs por parte de 8 MiB, completar ordena y valida partes', async () => {
  const r2 = falso(false);
  const alm = crearAlmacenamiento({ r2: r2.cliente, b2: falso(true).cliente, buckets: BUCKETS, cifrado: cif });
  assert.equal(TAMANO_PARTE, 8 * 1024 * 1024);
  const key = nuevaClaveAudio('m4a');
  const { uploadId } = await alm.iniciarMultiparte(key, 'audio/mp4');
  const urls = await alm.urlsPartes(key, uploadId, [1, 2, 2, 3]);
  assert.equal(urls.length, 3);
  const u = new URL(urls[1].url);
  assert.equal(u.searchParams.get('partNumber'), '2');
  assert.equal(u.searchParams.get('uploadId'), uploadId);
  await assert.rejects(alm.urlsPartes(key, uploadId, [0]), /rango/);
  await assert.rejects(alm.completarMultiparte(key, uploadId, [{ numero: 1, etag: 'a' }, { numero: 3, etag: 'b' }]), /Faltan partes/);
  const fin = await alm.completarMultiparte(key, uploadId, [{ numero: 2, etag: '"bb"' }, { numero: 1, etag: 'aa' }]);
  assert.equal(fin.bytes, 20);
  const comp = r2.llamadas.find((l) => l.cmd === 'CompleteMultipartUploadCommand')!;
  assert.deepEqual((comp.input.MultipartUpload as { Parts: unknown[] }).Parts, [{ PartNumber: 1, ETag: '"aa"' }, { PartNumber: 2, ETag: '"bb"' }]);
});

test('llaves: se rechazan rutas fuera de prefijo, con ".." o con datos legibles', () => {
  assert.throws(() => validarClave('audio', 't/x.bin'));
  assert.throws(() => validarClave('audio', 'a/../t/x.webm'));
  assert.throws(() => validarClave('transcripciones', 't/Juan Pérez 12.345.678-9.bin'));
  assert.throws(() => validarClave('transcripciones', 'a/x.webm'));
  assert.throws(() => nuevaClaveAudio('exe'));
  assert.doesNotThrow(() => validarClave('b2', nuevaClaveTranscripcion()));
});

test('endpoint R2 por jurisdicción', () => {
  assert.equal(endpointR2(CUENTA, 'us'), `https://${CUENTA}.us.r2.cloudflarestorage.com`);
  assert.equal(endpointR2(CUENTA), `https://${CUENTA}.r2.cloudflarestorage.com`);
  assert.throws(() => endpointR2('no-es-cuenta', 'us'));
  assert.throws(() => endpointR2(CUENTA, 'cl'));
});
