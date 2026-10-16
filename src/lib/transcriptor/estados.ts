// Máquina de estados de una grabación (50-arquitectura.md §4).
// Toda transición es condicional en la base (`update … where estado in (de)`): si devuelve
// 0 filas, otro proceso ya la hizo y no se repite nada (mismo patrón que tareas_envio).
// Las funciones puras (sin base) están arriba y tienen pruebas en estados.test.ts.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ESTADOS, TIEMPOS, type EstadoGrabacion, type Grabacion } from './tipos';

/** Transiciones válidas. 'error' → estado_antes_error se valida aparte (reintentar). */
export const TRANSICIONES: Readonly<Record<EstadoGrabacion, readonly EstadoGrabacion[]>> = {
  creada:             ['sin_consentimiento', 'grabando', 'bot_lanzando', 'cancelada', 'error'],
  sin_consentimiento: ['creada', 'cancelada'],                      // Vale asigna ficha / firma → vuelve a creada
  bot_lanzando:       ['bot_en_lobby', 'cancelada', 'error'],
  bot_en_lobby:       ['grabando', 'bot_no_admitido', 'cancelada', 'error'],
  bot_no_admitido:    [],
  grabando:           ['pausada', 'subiendo', 'cancelada', 'error'],
  pausada:            ['grabando', 'subiendo', 'cancelada', 'error'],
  subiendo:           ['subida', 'sin_audio', 'cancelada', 'error'],  // cancelada: Vale descarta una subida que nunca llegará (añadido por P6)
  subida:             ['transcribiendo', 'error'],
  transcribiendo:     ['transcrita', 'error'],
  transcrita:         ['resumiendo', 'error'],
  resumiendo:         ['lista', 'error'],
  lista:              ['resumiendo'],                               // "Regenerar resumen" (nueva versión)
  sin_audio:          [],
  cancelada:          [],
  error:              [],                                           // solo vía reintentar() o cancelar
};

/** Estados a los que se puede volver desde 'error' (los que se guardan en estado_antes_error). */
export const REINTENTABLES: readonly EstadoGrabacion[] = [
  'creada', 'bot_lanzando', 'grabando', 'pausada', 'subiendo', 'subida', 'transcribiendo', 'transcrita', 'resumiendo',
];

export const TERMINALES: readonly EstadoGrabacion[] = ['lista', 'sin_audio', 'cancelada', 'bot_no_admitido'];

export class TransicionInvalidaError extends Error {
  constructor(public readonly de: string, public readonly a: string) {
    super(`Transición inválida de grabación: ${de} → ${a}`);
    this.name = 'TransicionInvalidaError';
  }
}

export function esEstado(x: unknown): x is EstadoGrabacion {
  return typeof x === 'string' && (ESTADOS as readonly string[]).includes(x);
}

/** ¿Se puede pasar de `de` a `a`? Desde 'error' solo a 'cancelada' o a un reintentable (ver destinoReintento). */
export function esTransicionValida(de: EstadoGrabacion, a: EstadoGrabacion): boolean {
  if (!esEstado(de) || !esEstado(a)) return false;
  if (de === 'error') return a === 'cancelada' || REINTENTABLES.includes(a);
  return TRANSICIONES[de].includes(a);
}

/** Lanza TransicionInvalidaError si la transición no está permitida. */
export function validarTransicion(de: EstadoGrabacion, a: EstadoGrabacion): void {
  if (!esTransicionValida(de, a)) throw new TransicionInvalidaError(String(de), String(a));
}

/** Estados desde los que se puede llegar a `a`. */
export function origenesValidos(a: EstadoGrabacion): EstadoGrabacion[] {
  return ESTADOS.filter((de) => de !== 'error' && TRANSICIONES[de].includes(a));
}

/** Desde 'error', ¿a qué estado vuelve "Reintentar"? null si no hay a dónde. */
export function destinoReintento(g: Pick<Grabacion, 'estado' | 'estado_antes_error'>): EstadoGrabacion | null {
  if (g.estado !== 'error') return null;
  const antes = g.estado_antes_error;
  return antes && REINTENTABLES.includes(antes) ? antes : null;
}

/** Qué se guarda en estado_antes_error al fallar en `de` (bot en lobby → se relanza el bot). */
export function estadoParaReintentar(de: EstadoGrabacion): EstadoGrabacion | null {
  if (de === 'bot_en_lobby') return 'bot_lanzando';
  return REINTENTABLES.includes(de) ? de : null;
}

export function leaseVencido(tomadaEn: string | null, ahora: Date = new Date()): boolean {
  if (!tomadaEn) return true;
  const t = Date.parse(tomadaEn);
  return Number.isNaN(t) || ahora.getTime() - t >= TIEMPOS.leaseTomaMs;
}

// ─── Operaciones en la base (service_role) ───────────────────────────────────

type Cliente = SupabaseClient;
async function clientePorDefecto(): Promise<Cliente> {
  // Import perezoso: las funciones puras se pueden probar sin variables de Supabase.
  return (await import('../supabase')).supabase;
}

/** Columnas que nunca se cambian por `cambios` (las controla esta capa o son identidad). */
const PROTEGIDAS = new Set(['id', 'estado', 'estado_antes_error', 'created_at', 'updated_at']);

/**
 * Transición atómica: `update grabaciones set estado=a, … where id=? and estado in (de) returning *`.
 * Devuelve la fila actualizada o null si otro proceso ya la movió. Rechaza (lanza) si alguna
 * de las transiciones de→a no es válida, ANTES de tocar la base.
 * Para ir a 'error' usar marcarError (guarda estado_antes_error); para salir de 'error', reintentar.
 */
export async function transicionar(
  id: string,
  de: readonly EstadoGrabacion[],
  a: EstadoGrabacion,
  cambios: Partial<Grabacion> = {},
  cliente?: Cliente,
): Promise<Grabacion | null> {
  if (!de.length) throw new Error('transicionar: falta al menos un estado de origen');
  if (a === 'error') throw new Error('transicionar: usar marcarError para pasar a error');
  if (de.includes('error')) throw new Error('transicionar: usar reintentar para salir de error');
  for (const d of de) validarTransicion(d, a);
  const extra = Object.fromEntries(Object.entries(cambios).filter(([k]) => !PROTEGIDAS.has(k)));
  const db = cliente ?? (await clientePorDefecto());
  const { data, error } = await db
    .from('grabaciones')
    .update({ ...extra, estado: a })
    .eq('id', id)
    .in('estado', [...de])
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`transicionar(${id} → ${a}): ${error.message}`);
  return (data as Grabacion | null) ?? null;
}

/** Pasa a 'error' desde un estado conocido, guardando estado_antes_error y el mensaje. */
export async function marcarError(
  id: string,
  de: EstadoGrabacion,
  mensaje: string,
  cliente?: Cliente,
): Promise<Grabacion | null> {
  validarTransicion(de, 'error');
  const db = cliente ?? (await clientePorDefecto());
  const { data, error } = await db
    .from('grabaciones')
    .update({
      estado: 'error',
      estado_antes_error: estadoParaReintentar(de),
      ultimo_error: mensaje.slice(0, 2000),
    })
    .eq('id', id)
    .eq('estado', de)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`marcarError(${id}): ${error.message}`);
  return (data as Grabacion | null) ?? null;
}

/**
 * Columnas que "Reintentar" deja en limpio al volver a `destino` (función pura, con pruebas).
 *  - intentos = 0 y proximo_intento_at = null: el reintento manual vuelve a tener TODOS sus intentos
 *    y su backoff (82-revision-codigo M2: antes quedaba intentos = máximo y el primer fallo era definitivo).
 *  - Hacia bot_lanzando: bot_machine_id = null para que el orquestador relance el bot (M3). La máquina
 *    anterior, si seguía viva, la apaga antes quien llama (reintentoAlerta.opsReintentoSupabase) y su
 *    token ya no sirve (lanzarBot genera uno nuevo).
 */
export function limpiezaReintento(destino: EstadoGrabacion): Record<string, null | number> {
  const base: Record<string, null | number> = {
    estado_antes_error: null, ultimo_error: null, tomada_en: null, intentos: 0, proximo_intento_at: null,
  };
  if (destino === 'bot_lanzando') base.bot_machine_id = null;
  return base;
}

/** "Reintentar": vuelve de 'error' a estado_antes_error (atómico). null si no aplica o ya lo hizo otro. */
export async function reintentar(id: string, cliente?: Cliente): Promise<Grabacion | null> {
  const db = cliente ?? (await clientePorDefecto());
  const { data: g, error: e1 } = await db
    .from('grabaciones').select('id, estado, estado_antes_error').eq('id', id).maybeSingle();
  if (e1) throw new Error(`reintentar(${id}): ${e1.message}`);
  if (!g) return null;
  const destino = destinoReintento(g as Pick<Grabacion, 'estado' | 'estado_antes_error'>);
  if (!destino) return null;
  const { data, error } = await db
    .from('grabaciones')
    .update({ ...limpiezaReintento(destino), estado: destino })
    .eq('id', id)
    .eq('estado', 'error')
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`reintentar(${id}): ${error.message}`);
  return (data as Grabacion | null) ?? null;
}

/** Toma atómica para el cron (lease de 10 min en tomada_en). null si otro proceso la tiene. */
export async function tomar(id: string, ahora: Date = new Date(), cliente?: Cliente): Promise<Grabacion | null> {
  const db = cliente ?? (await clientePorDefecto());
  const limite = new Date(ahora.getTime() - TIEMPOS.leaseTomaMs).toISOString();
  const { data, error } = await db
    .from('grabaciones')
    .update({ tomada_en: ahora.toISOString() })
    .eq('id', id)
    .or(`tomada_en.is.null,tomada_en.lt.${limite}`)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`tomar(${id}): ${error.message}`);
  return (data as Grabacion | null) ?? null;
}

/** Libera la toma (al terminar el paso, haya salido bien o mal). */
export async function soltar(id: string, cliente?: Cliente): Promise<void> {
  const db = cliente ?? (await clientePorDefecto());
  const { error } = await db.from('grabaciones').update({ tomada_en: null }).eq('id', id);
  if (error) throw new Error(`soltar(${id}): ${error.message}`);
}
