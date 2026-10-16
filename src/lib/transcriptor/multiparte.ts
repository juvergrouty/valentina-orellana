// Transcriptor IA (P4) — subida MULTIPARTE del audio directo iPhone → R2 (bucket de audio
// temporal) con URLs prefirmadas (30-seguridad §4.1). El audio nunca pasa por Vercel
// (límite 4,5 MB por request). El navegador nunca recibe credenciales: solo URLs que
// permiten subir UNA parte de UN objeto durante 15 min.
//
// Integración P6 (16 oct 2026): las operaciones S3 las hace almacenamiento.ts (P1), que lee
// las llaves SOLO de process.env en tiempo de ejecución (Vite no las incrusta en el bundle) y
// usa un único cliente R2. Este archivo conserva la interfaz que usan los endpoints de P4.
// El CORS del bucket debe exponer ETag (ExposeHeaders: ETag) para leerlo en el navegador.
import { randomUUID } from 'node:crypto';
import { PREFIJO_AUDIO, TIEMPOS } from './tipos';
import { almacenamiento } from './almacenamiento';
import { ConfiguracionFaltanteError } from './entorno';

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

export class R2NoConfiguradoError extends Error {
  constructor() { super('R2 no está configurado (faltan variables R2_*).'); this.name = 'R2NoConfiguradoError'; }
}

/** Traduce "falta variable" de almacenamiento.ts al error que entienden los endpoints de P4. */
async function conR2<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConfiguracionFaltanteError) throw new R2NoConfiguradoError();
    throw e;
  }
}

export async function iniciarMultiparte(key: string, contentType: string): Promise<string> {
  return conR2(async () => (await almacenamiento.iniciarMultiparte(key, contentType)).uploadId);
}

/** URLs PUT prefirmadas para las partes pedidas (1-based), vigencia 15 min. */
export async function urlsPartes(key: string, uploadId: string, partes: number[], vigenciaSeg: number = TIEMPOS.urlSubidaSeg): Promise<Record<number, string>> {
  return conR2(async () => {
    const lista = await almacenamiento.urlsPartes(key, uploadId, partes, vigenciaSeg);
    return Object.fromEntries(lista.map((p) => [p.numero, p.url])) as Record<number, string>;
  });
}

export interface ParteSubida { n: number; etag: string }

export async function completarMultiparte(key: string, uploadId: string, partes: ParteSubida[]): Promise<void> {
  await conR2(() => almacenamiento.completarMultiparte(key, uploadId, partes.map((p) => ({ numero: p.n, etag: p.etag }))));
}

export async function abortarMultiparte(key: string, uploadId: string): Promise<void> {
  await conR2(() => almacenamiento.abortarMultiparte(key, uploadId));
}

/** Tamaño del objeto en el bucket de audio; null si no existe. */
export async function bytesObjeto(key: string): Promise<number | null> {
  return conR2(async () => (await almacenamiento.head('audio', key))?.bytes ?? null);
}

/** ¿El error de S3 es "la subida multiparte ya no existe" (completada antes o vencida)? */
export function esSubidaInexistente(e: unknown): boolean {
  const x = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === 'NoSuchUpload' || x?.Code === 'NoSuchUpload' || x?.$metadata?.httpStatusCode === 404;
}
