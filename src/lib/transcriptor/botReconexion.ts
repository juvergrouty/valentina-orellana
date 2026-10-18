// Transcriptor IA — reconexión del robot de Meet (segunda ronda, 18 oct 2026).
// Lo usan bot.ts (evento `fin`) y pipeline.ts (despacho, relanzamiento, vigilante y máquinas caídas).
//
// Reglas (documentadas también en bot/src/vigia.ts):
//  - Si el robot termina por error, se cae (la máquina murió sin avisar) o sale por 'solo' ANTES del
//    término previsto, la grabación sigue en 'grabando' sin máquina (bot_machine_id = null, token
//    revocado) y el orquestador lanza un robot NUEVO (máquina y token nuevos) a la MISMA grabación.
//    El robot nuevo numera sus segmentos desde el último confirmado + 1 (SEQ_INICIAL) y mide sus
//    tiempos desde el mismo origen (ORIGEN_MS = inicio_at), así no se duplican ni se pisan; el tramo
//    sin audio queda marcado como "interrupción" en la transcripción (hablantes.ts, H13).
//  - Nunca hay dos robots a la vez: el relanzamiento exige bot_machine_id = null y la toma del cron.
//  - 'solo' solo relanza si quedan más de 10 min (si no, casi seguro terminó la sesión y se transcribe
//    ya); error/caída si quedan más de 3 min. Tope: 4 lanzamientos por grabación (costo de Fly).
//  - El robot relanzado espera a lo más 5 min a que haya alguien (el primero espera 30).
//  - Vale salió, expulsado, participantes extra, sin consentimiento y hora_fin NO relanzan.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Grabacion, LineaHablante } from './tipos';
import { transicionar } from './estados';
import { liberarSesion } from './botCuenta';

export const NOTA_NADIE_LLEGO = 'Nadie llegó a la sesión: el asistente de notas esperó y salió sin grabar nada.';
export const NOTA_RECONECTANDO = 'El asistente de notas se desconectó; está volviendo a entrar a la sesión.';
export const NOTA_RECONECTADO = 'El asistente de notas se desconectó y volvió a entrar durante la sesión; los tramos sin audio quedan marcados en la transcripción.';
export const NOTA_SIN_CONSENTIMIENTO_BOT = 'El asistente de notas salió: el consentimiento de grabación ya no está vigente. Desde ese momento no se grabó nada.';

export const MAX_LANZAMIENTOS_BOT = 4;
export const ESPERA_LLEGADA_RELANZADO_MS = 5 * 60_000;
export const RESTANTE_MIN_ERROR_MS = 3 * 60_000;
export const RESTANTE_MIN_SOLO_MS = 10 * 60_000;
/** Tope de la línea de hablantes combinada (hablantes.ts acepta hasta 50 000). */
export const MAX_LINEA_COMBINADA = 50_000;
/** Una máquina recién tocada no se da por caída (evita la carrera con un `fin` en vuelo). */
export const GRACIA_REVISAR_MAQUINA_MS = 90_000;

/** 'caida' = la máquina murió sin mandar `fin` (lo detecta el orquestador). */
export type MotivoReconexion = string;

/** ¿Se lanza un robot nuevo a la misma grabación? (pura) */
export function debeRelanzarBot(p: { motivo: MotivoReconexion; horaFinPrevista: string | null | undefined; ahora: Date; lanzamientos: number }): boolean {
  if (p.lanzamientos >= MAX_LANZAMIENTOS_BOT) return false;
  const fin = p.horaFinPrevista ? Date.parse(p.horaFinPrevista) : NaN;
  if (Number.isNaN(fin)) return false;
  const restante = fin - p.ahora.getTime();
  if (p.motivo === 'error' || p.motivo === 'caida') return restante > RESTANTE_MIN_ERROR_MS;
  if (p.motivo === 'solo') return restante > RESTANTE_MIN_SOLO_MS;
  return false;
}

function lineaPrevia(x: unknown): LineaHablante[] {
  if (!Array.isArray(x)) return [];
  return x.filter((e): e is LineaHablante => !!e && typeof e === 'object'
    && Number.isInteger((e as LineaHablante).t_ms) && typeof (e as LineaHablante).nombre === 'string' && typeof (e as LineaHablante).on === 'boolean');
}

/** Línea de hablantes de todos los robots de la grabación (ya vienen en el mismo origen de tiempo). */
export function combinarLinea(previa: unknown, nueva: LineaHablante[] | null | undefined): LineaHablante[] {
  return [...lineaPrevia(previa), ...(nueva ?? [])].slice(0, MAX_LINEA_COMBINADA);
}

/** Nota final: si hubo reconexión, se dice (y se suma la nota del motivo de salida, si hay). */
export function notaCierre(notaActual: string | null | undefined, notaFin: string | null): string | null {
  const reconecto = notaActual === NOTA_RECONECTANDO || notaActual?.startsWith(NOTA_RECONECTADO);
  if (!reconecto) return notaFin;
  return notaFin ? `${NOTA_RECONECTADO} ${notaFin}` : NOTA_RECONECTADO;
}

/**
 * Estados de máquina de Fly que significan "ya no corre" (docs.fly.io/machines/machine-states:
 * stopped = "Exited on its own or was explicitly stopped", failed, destroying, destroyed,
 * launch_failed). 404 = ya no existe. Cualquier otra respuesta = no se sabe (null): no se toca nada.
 */
export const ESTADOS_MAQUINA_MUERTA = ['stopped', 'failed', 'destroying', 'destroyed', 'launch_failed'] as const;
export function maquinaMuerta(status: number, estado: unknown): boolean | null {
  if (status === 404) return true;
  if (status < 200 || status >= 300) return null;
  return typeof estado === 'string' ? (ESTADOS_MAQUINA_MUERTA as readonly string[]).includes(estado) : null;
}

/**
 * Evento MOVIDO (punto 7): la grabación previa del mismo google_event_id terminó SIN audio y ANTES
 * de la nueva hora de inicio (el robot fue a la hora vieja y nadie llegó / nadie lo admitió / se cayó
 * antes de grabar). Entonces se libera el google_event_id para despachar otro robot a la hora nueva.
 */
export type PreviaEvento = Pick<Grabacion, 'id' | 'estado' | 'estado_antes_error' | 'fin_at' | 'updated_at'>;
export function previaLiberable(previa: PreviaEvento, inicioNuevo: string): boolean {
  const sinAudio = previa.estado === 'sin_audio' || previa.estado === 'bot_no_admitido'
    || (previa.estado === 'error' && previa.estado_antes_error === 'bot_lanzando');
  if (!sinAudio) return false;
  const termino = Date.parse(previa.fin_at ?? previa.updated_at ?? '');
  const inicio = Date.parse(inicioNuevo);
  return !Number.isNaN(termino) && !Number.isNaN(inicio) && termino < inicio;
}

/** google_event_id con que queda la fila vieja (único, trazable, ya no choca con el índice). */
export function eventIdLiberado(googleEventId: string, grabacionId: string): string {
  return `${googleEventId}~movido-${grabacionId.slice(0, 8)}`;
}

// ─── Con base ────────────────────────────────────────────────────────────────

type Cliente = SupabaseClient;
export type FilaReconexion = Pick<Grabacion, 'id' | 'estado' | 'inicio_at' | 'bot_machine_id' | 'hora_fin_prevista'>
  & Partial<Pick<Grabacion, 'linea_hablantes' | 'nota_sistema'>>;

/** Lanzamientos de robot de la grabación (bitácora bot_lanzar). Si no se puede contar: tope (no relanza). */
export async function lanzamientosDe(c: Cliente, grabacionId: string): Promise<number> {
  const { count, error } = await c.from('transcriptor_auditoria').select('id', { count: 'exact', head: true })
    .eq('grabacion_id', grabacionId).eq('accion', 'bot_lanzar');
  if (error || count == null) return MAX_LANZAMIENTOS_BOT;
  return count;
}

/**
 * Deja la grabación lista para un robot nuevo: sigue en 'grabando', sin máquina, token revocado, la
 * línea de hablantes del robot que salió guardada y los segmentos nunca confirmados fuera. Condicional
 * a que la máquina siga siendo la que terminó (si otro proceso ya la movió, no hace nada).
 */
export async function prepararRelanzamiento(c: Cliente, g: FilaReconexion, op: { ahora: Date; linea?: LineaHablante[] | null }): Promise<boolean> {
  let q = c.from('grabaciones').update({
    bot_machine_id: null, bot_token_vence_at: op.ahora.toISOString(), linea_hablantes: combinarLinea(g.linea_hablantes, op.linea),
    nota_sistema: NOTA_RECONECTANDO, tomada_en: null, intentos: 0, proximo_intento_at: null, ultimo_error: null,
  }).eq('id', g.id).eq('estado', 'grabando');
  q = g.bot_machine_id ? q.eq('bot_machine_id', g.bot_machine_id) : q.is('bot_machine_id', null);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) throw new Error(`grabaciones (relanzar): ${error.message}`);
  if (!data) return false;
  await c.from('grabacion_segmentos').delete().eq('grabacion_id', g.id).is('subido_at', null);
  await liberarSesion(c, g.id).catch(() => {});
  return true;
}

/**
 * Cierra una grabación del robot con lo que alcanzó a subir: grabando → subiendo → subida (o
 * sin_audio si no llegó nada). Devuelve null si otro proceso ya la cerró.
 */
export async function cerrarConLoGrabado(c: Cliente, g: FilaReconexion, op: { ahora: Date; linea?: LineaHablante[] | null; notaFin: string | null }): Promise<{ conAudio: boolean } | null> {
  const finAt = op.ahora.toISOString();
  const inicio = g.inicio_at ? Date.parse(g.inicio_at) : op.ahora.getTime();
  const duracionSeg = Math.max(0, Math.round((op.ahora.getTime() - inicio) / 1000));
  const movida = await transicionar(g.id, ['grabando'], 'subiendo', {
    bot_token_vence_at: finAt, fin_at: finAt, duracion_seg: duracionSeg,
    linea_hablantes: combinarLinea(g.linea_hablantes, op.linea),
    nota_sistema: notaCierre(g.nota_sistema, op.notaFin),
  } as Partial<Grabacion>, c);
  if (!movida) return null;
  await c.from('grabacion_segmentos').delete().eq('grabacion_id', g.id).is('subido_at', null);
  const { count } = await c.from('grabacion_segmentos').select('id', { count: 'exact', head: true })
    .eq('grabacion_id', g.id).not('subido_at', 'is', null);
  const conAudio = (count ?? 0) > 0;
  await transicionar(g.id, ['subiendo'], conAudio ? 'subida' : 'sin_audio', {}, c);
  await liberarSesion(c, g.id).catch(() => {});
  return { conAudio };
}
