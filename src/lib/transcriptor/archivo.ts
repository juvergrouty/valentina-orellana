// Transcriptor IA — archivo externo de los resúmenes antiguos ("sitio liviano",
// docs/transcriptor/02-decisiones-16oct-noche.md, B). Migración: 0020_transcriptor_archivo_resumenes.sql.
//
// • En Supabase queda el contenido (cifrado) SOLO de los resúmenes de las ÚLTIMAS 4 sesiones de cada
//   paciente (SESIONES_EN_SITIO). Los de sesiones anteriores se mueven al bucket de transcripciones de
//   R2 con copia en B2 (almacenamiento.guardarCifrado: put + head + copia B2 verificada por sha256),
//   cifrados con cifrado.ts (VOT1, DEK propia, tipo 'resumen', AAD = llave opaca t/<uuid>.bin).
// • El objeto guarda un "sobre" JSON { v, resumen_id, grabacion_id, contenido }: al leerlo se exige que
//   resumen_id sea el de la fila (un archivo apuntado desde otra fila no se muestra).
// • Orden seguro: escribir R2 → copiar y verificar B2 → leer de vuelta R2 y B2 y comparar con el texto →
//   recién entonces la fila pasa a archivado_at + referencias y contenido/contenido_cifrado = null (el
//   trigger de 0020 solo permite vaciar el texto en esa misma actualización). Si B2 falla, la fila queda
//   con archivo_r2_key y el texto SIGUE en la base; la próxima corrida reintenta la copia.
// • Leer: textoResumen / conTextoResumen sirven para filas en la base y archivadas (R2 → B2 si R2 falla).
//   Nunca se registra contenido ni llaves; la bitácora de acceso la hace quien muestra (ver_resumen).
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccionAuditoria } from './tipos';
import type { AlmacenamientoTranscriptor } from './almacenamiento';
import type { CifradoVOT1, ContextoCifrado } from './cifrado';
import { bytesDeBytea, leerContenidoResumen, type FilaConContenido } from './resumenCifrado';
import { auditar } from './auditoria';

/** Sesiones por paciente cuyo resumen se queda en Supabase (las más recientes). */
export const SESIONES_EN_SITIO = 4;
/** Máximo de resúmenes que archiva una corrida del orquestador (cada uno son ~6 llamadas a R2/B2). */
export const MAX_POR_CORRIDA = 5;
/** Columnas de resumenes_ia que hay que pedir para poder leer un resumen archivado. */
export const COLUMNAS_ARCHIVO = 'archivo_r2_key, archivo_b2_key, archivado_at';

export const ACC_ARCHIVAR = 'archivar_resumen' as AccionAuditoria;

export type AlmArchivo = Pick<AlmacenamientoTranscriptor, 'guardarCifrado' | 'leerCifrado' | 'copiarAB2' | 'borrar'>;
type Cif = Pick<CifradoVOT1, 'cifrar' | 'descifrar'>;

export interface FilaArchivo extends FilaConContenido {
  grabacion_id?: string | null;
  patient_id?: string | null;
  estado?: string | null;
  archivo_r2_key?: string | null;
  archivo_b2_key?: string | null;
  archivado_at?: string | null;
}

export const estaArchivado = (f: Pick<FilaArchivo, 'archivado_at' | 'archivo_r2_key'>): boolean => !!(f.archivado_at && f.archivo_r2_key);

/** ¿La fila tiene texto que mostrar (en la base o en el archivo)? */
export function tieneTexto(f: FilaArchivo): boolean {
  if (estaArchivado(f)) return true;
  const b = bytesDeBytea(f.contenido_cifrado);
  return !!(f.contenido || (b && b.length));
}

export const ctxArchivo = (key: string): ContextoCifrado => ({ claveObjeto: key, tipo: 'resumen' });

/** Llave opaca nueva en el bucket de transcripciones (mismo formato que validarClave exige). */
export function nuevaClaveArchivo(): string {
  return `t/${randomUUID()}.bin`;
}

interface Sobre { v: 1; resumen_id: string; grabacion_id: string | null; contenido: string }

export function serializarSobre(f: Pick<FilaArchivo, 'id' | 'grabacion_id'>, contenido: string): Uint8Array {
  const s: Sobre = { v: 1, resumen_id: f.id, grabacion_id: f.grabacion_id ?? null, contenido };
  return new TextEncoder().encode(JSON.stringify(s));
}

/** Abre el sobre y exige que sea de ESTA fila. */
export function abrirSobre(claro: Uint8Array, resumenId: string): string {
  const s = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(claro)) as Partial<Sobre>;
  if (s?.v !== 1 || typeof s.contenido !== 'string') throw new Error('archivo: formato inesperado');
  if (s.resumen_id !== resumenId) throw new Error('archivo: el objeto no corresponde a este resumen');
  return s.contenido;
}

async function almacen(alm?: AlmArchivo): Promise<AlmArchivo> {
  return alm ?? (await import('./almacenamiento')).almacenamiento;
}

/** Texto de un resumen archivado (R2; si R2 no lo tiene, la copia de B2). */
export async function leerResumenArchivado(f: FilaArchivo, alm?: AlmArchivo, origen: 'r2' | 'b2' = 'r2'): Promise<string> {
  if (!f.archivo_r2_key) throw new Error('archivo: la fila no tiene archivo');
  const a = await almacen(alm);
  return abrirSobre(await a.leerCifrado(ctxArchivo(f.archivo_r2_key), origen), f.id);
}

export interface OpcionesLectura { alm?: AlmArchivo; cif?: Cif }

/** Texto del resumen, esté en la base (cifrado o en claro antiguo) o archivado. Lanza si no se puede abrir. */
export async function textoResumen(f: FilaArchivo, op: OpcionesLectura = {}): Promise<string | null> {
  if (estaArchivado(f)) return leerResumenArchivado(f, op.alm);
  return leerContenidoResumen(f, op.cif);
}

/** Igual que conContenidoClaro (resumenCifrado.ts) pero también trae los archivados desde R2/B2. */
export async function conTextoResumen<T extends FilaArchivo>(filas: T[], op: OpcionesLectura = {}): Promise<{ filas: (T & { contenido: string | null })[]; fallidas: number }> {
  let fallidas = 0;
  const out = await Promise.all(filas.map(async (f) => {
    if (!tieneTexto(f)) return { ...f, contenido: null };
    try {
      return { ...f, contenido: await textoResumen(f, op) };
    } catch {
      fallidas++;
      return { ...f, contenido: null };
    }
  }));
  return { filas: out, fallidas };
}

// ─── Qué se archiva ──────────────────────────────────────────────────────────

export interface SesionConResumen { grabacion_id: string; patient_id: string; session_date: string; created_at?: string | null }

/**
 * Grabaciones cuyo resumen ya NO va en el sitio: por paciente, todas menos las SESIONES_EN_SITIO más
 * recientes (fecha de sesión y, a igual fecha, la creada después).
 */
export function grabacionesFueraDelSitio(sesiones: SesionConResumen[], n = SESIONES_EN_SITIO): Set<string> {
  const porPaciente = new Map<string, SesionConResumen[]>();
  for (const s of sesiones) {
    if (!s.patient_id || !s.grabacion_id) continue;
    const l = porPaciente.get(s.patient_id) ?? [];
    if (!l.some((x) => x.grabacion_id === s.grabacion_id)) l.push(s);
    porPaciente.set(s.patient_id, l);
  }
  const fuera = new Set<string>();
  for (const l of porPaciente.values()) {
    l.sort((a, b) => b.session_date.localeCompare(a.session_date) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    for (const s of l.slice(n)) fuera.add(s.grabacion_id);
  }
  return fuera;
}

// ─── Archivar ────────────────────────────────────────────────────────────────

export interface DepsArchivo {
  db: SupabaseClient;
  almacenamiento?: AlmArchivo;
  cifrado?: Cif;
  ahora?: () => Date;
  max?: number;
}

export type ResultadoArchivo = 'archivado' | 'pendiente_b2' | 'ya_archivado' | 'sin_contenido';

const COLS_FILA = 'id, grabacion_id, patient_id, estado, contenido, contenido_cifrado, archivo_r2_key, archivo_b2_key, archivado_at';

export class MigracionArchivoFaltante extends Error {
  constructor() { super('Falta aplicar la migración 0020 (archivo de resúmenes) en Supabase.'); this.name = 'MigracionArchivoFaltante'; }
}

/** Mueve UN resumen listo al archivo (R2 + B2). Idempotente. */
export async function archivarResumen(f: FilaArchivo, deps: DepsArchivo): Promise<ResultadoArchivo> {
  if (estaArchivado(f)) return 'ya_archivado';
  if (f.estado && f.estado !== 'listo') return 'sin_contenido';
  const texto = await leerContenidoResumen(f, deps.cifrado);
  if (texto == null) return 'sin_contenido';
  const alm = await almacen(deps.almacenamiento);
  const ahora = (deps.ahora ?? (() => new Date()))().toISOString();
  const base = { grabacionId: f.grabacion_id ?? null, patientId: f.patient_id ?? null, cliente: deps.db };

  let key = f.archivo_r2_key ?? null;
  const nuevo = !key;
  let b2Key: string | null = null;
  let extra: Record<string, unknown> = {};
  if (!key) {
    key = nuevaClaveArchivo();
    const g = await alm.guardarCifrado(serializarSobre(f, texto), ctxArchivo(key));
    b2Key = g.b2Key;
    extra = { archivo_r2_key: key, archivo_sha256: g.sha256, archivo_kek_v: g.kekV };
  } else {
    try { b2Key = (await alm.copiarAB2(key)).b2Key; } catch { b2Key = null; }
  }
  const ctx = ctxArchivo(key);
  const limpiar = async () => {
    if (!nuevo) return;
    try { await alm.borrar('transcripciones', key!); } catch { /* queda huérfano cifrado; el texto sigue en la base */ }
    if (b2Key) { try { await alm.borrar('b2', key!); } catch { /* idem */ } }
  };
  // Ida y vuelta: lo que quedó afuera es exactamente este resumen (y de esta fila).
  try {
    if (abrirSobre(await alm.leerCifrado(ctx, 'r2'), f.id) !== texto) throw new Error('archivo: la copia en R2 no coincide');
    if (b2Key && abrirSobre(await alm.leerCifrado(ctx, 'b2'), f.id) !== texto) throw new Error('archivo: la copia en B2 no coincide');
  } catch (e) {
    await limpiar();
    throw e;
  }

  if (!b2Key) {
    // Sin copia en B2: se guarda la referencia de R2, pero el texto se queda en la base hasta que B2 vuelva.
    if (nuevo) {
      const { error } = await deps.db.from('resumenes_ia').update(extra).eq('id', f.id).is('archivado_at', null);
      if (error) { await limpiar(); throw new Error(`resumenes_ia (archivo): ${error.code ?? error.message}`); }
    }
    await auditar('cron', ACC_ARCHIVAR, { ...base, resultado: 'error', detalle: { resumen_id: f.id, fase: 'b2_pendiente' } });
    return 'pendiente_b2';
  }

  const { error } = await deps.db.from('resumenes_ia').update({
    ...extra, archivo_b2_key: b2Key, archivado_at: ahora, contenido: null, contenido_cifrado: null,
  }).eq('id', f.id).is('archivado_at', null);
  if (error) {
    await limpiar();
    throw new Error(`resumenes_ia (archivo): ${error.code ?? error.message}`);
  }
  await auditar('cron', ACC_ARCHIVAR, { ...base, detalle: { resumen_id: f.id, fase: 'listo' } });
  return 'archivado';
}

/** Paso del orquestador: archiva lo que quedó fuera de las últimas 4 sesiones de cada paciente. */
export async function archivarAntiguos(deps: DepsArchivo): Promise<number> {
  const { db } = deps;
  const { data: enSitio, error } = await db.from('resumenes_ia')
    .select('id, grabacion_id, patient_id, archivo_r2_key, archivado_at')
    .eq('estado', 'listo').is('archivado_at', null).not('patient_id', 'is', null).limit(5000);
  if (error) {
    if (error.code === '42703') throw new MigracionArchivoFaltante();
    throw new Error(`resumenes_ia (archivo): ${error.code ?? error.message}`);
  }
  if (!enSitio?.length) return 0;
  const pacientes = [...new Set(enSitio.map((r) => r.patient_id as string))];
  // Sesiones con resumen listo de esos pacientes (archivadas o no) → cuáles quedan fuera de las 4 últimas.
  const { data: todos, error: e2 } = await db.from('resumenes_ia').select('grabacion_id').eq('estado', 'listo').in('patient_id', pacientes).limit(20000);
  if (e2) throw new Error(`resumenes_ia (archivo): ${e2.code ?? e2.message}`);
  const grabIds = [...new Set((todos ?? []).map((r) => r.grabacion_id as string))];
  if (grabIds.length <= SESIONES_EN_SITIO) return 0;
  const { data: gs, error: e3 } = await db.from('grabaciones').select('id, patient_id, session_date, created_at').in('id', grabIds);
  if (e3) throw new Error(`grabaciones (archivo): ${e3.code ?? e3.message}`);
  const fuera = grabacionesFueraDelSitio((gs ?? []).filter((g) => g.patient_id).map((g) => ({
    grabacion_id: g.id as string, patient_id: g.patient_id as string, session_date: g.session_date as string, created_at: g.created_at as string,
  })));
  if (!fuera.size) return 0;
  // Primero las que esperan su copia en B2; después, de la más antigua a la más nueva.
  const candidatas = enSitio.filter((r) => fuera.has(r.grabacion_id as string))
    .sort((a, b) => Number(!a.archivo_r2_key) - Number(!b.archivo_r2_key))
    .slice(0, deps.max ?? MAX_POR_CORRIDA);
  let n = 0;
  for (const c of candidatas) {
    const { data: f } = await db.from('resumenes_ia').select(COLS_FILA).eq('id', c.id).maybeSingle();
    if (!f) continue;
    try {
      if ((await archivarResumen(f as FilaArchivo, deps)) === 'archivado') n++;
    } catch (e) {
      // Sin contenido clínico: solo el tipo de error. El texto sigue en la base.
      console.warn('[transcriptor/archivo] no se pudo archivar un resumen:', e instanceof Error ? e.message.slice(0, 120) : 'error');
      await auditar('cron', ACC_ARCHIVAR, { grabacionId: (f as FilaArchivo).grabacion_id ?? null, patientId: (f as FilaArchivo).patient_id ?? null, cliente: db, resultado: 'error', detalle: { resumen_id: c.id, fase: 'fallo' } });
    }
  }
  return n;
}
