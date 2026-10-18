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
//
// Atraso de Vale (pedido de Vale, 18 oct: "el robot debe responder al llamado al enlace más que a la hora"):
//  - El robot empieza a grabar recién cuando Vale está en la llamada (bot/src/vigia.ts, decidirInicio), así
//    que inicio_at (lo fija `activo`) es la llegada de Vale (o la del robot, si llegó después: cota superior).
//  - grabaciones.hora_fin_prevista es el término EFECTIVO: max(fin del evento, llegada de Vale + duración
//    agendada), con tope fin del evento + 2 h (finEfectivo). Todo lo que depende de la hora (token, candado de
//    la sesión del robot, vigilante a +40 min, reemplazo tras una caída, salida del robot a +30 min) usa ese
//    valor, así una sesión que partió tarde no se corta a la hora del calendario.
//
// Una sesión = una grabación = una transcripción (Vale, 18 oct): el robot lo manda Vale al abrir la sesión.
// Si Vale sale (vale_salio), la llamada queda vacía (solo, sin reemplazo posible) o el robot de reemplazo
// no la encuentra (nadie_llego), la grabación NO se cierra: queda en 'grabando' sin máquina con la nota
// NOTA_ESPERANDO_VALE (esperarVale; fin_at = cuándo salió). Si Vale vuelve a abrir la sesión, el robot
// nuevo sigue la MISMA grabación (seq continuo). Si no vuelve en ESPERA_VUELTA_VALE_MS (15 min), el cron
// la cierra con todo lo grabado y se transcribe UNA vez. Expulsado, participantes extra, sin
// consentimiento y hora_fin cierran al tiro (decisión o resguardo).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Grabacion, LineaHablante } from './tipos';
import { transicionar } from './estados';
import { extenderUsoSesion, liberarSesion } from './botCuenta';

export const NOTA_NADIE_LLEGO = 'Nadie llegó a la sesión: el asistente de notas esperó y salió sin grabar nada.';
export const NOTA_RECONECTANDO = 'El asistente de notas se desconectó; está volviendo a entrar a la sesión.';
export const NOTA_RECONECTADO = 'El asistente de notas se desconectó y volvió a entrar durante la sesión; los tramos sin audio quedan marcados en la transcripción.';
export const NOTA_ESPERANDO_VALE = 'Vale salió de la sesión: si vuelve a entrar en 15 min, el asistente sigue en esta misma grabación.';
/** Igual, cuando ya hubo una reconexión antes (para que la nota final lo diga). */
export const NOTA_ESPERANDO_VALE_RECONECTADO = 'Vale salió de la sesión (ya hubo una reconexión): si vuelve a entrar en 15 min, el asistente sigue en esta misma grabación.';
export const NOTA_SIN_CONSENTIMIENTO_BOT = 'El asistente de notas salió: el consentimiento de grabación ya no está vigente. Desde ese momento no se grabó nada.';

export const MAX_LANZAMIENTOS_BOT = 4;
/** Robots por grabación cuando los manda Vale con un clic (salir y volver varias veces en la misma sesión). */
export const MAX_LANZAMIENTOS_VALE = 10;
/** Plazo para que Vale vuelva a la misma sesión antes de cerrarla y transcribirla. */
export const ESPERA_VUELTA_VALE_MS = 15 * 60_000;
/** Salidas del robot tras las que se espera a que Vale vuelva (no se cierra la grabación). */
export const MOTIVOS_ESPERAR_VALE: readonly string[] = ['vale_salio', 'solo', 'nadie_llego', 'error', 'caida'];
export const ESPERA_LLEGADA_RELANZADO_MS = 5 * 60_000;
export const RESTANTE_MIN_ERROR_MS = 3 * 60_000;
export const RESTANTE_MIN_SOLO_MS = 10 * 60_000;
/** Tope de la línea de hablantes combinada (hablantes.ts acepta hasta 50 000). */
export const MAX_LINEA_COMBINADA = 50_000;
/** Una máquina recién tocada no se da por caída (evita la carrera con un `fin` en vuelo). */
export const GRACIA_REVISAR_MAQUINA_MS = 90_000;

/** Tope del corrimiento por atraso: el término efectivo nunca pasa de fin del evento + 2 h. */
export const MAX_ATRASO_TRAS_FIN_MS = 2 * 60 * 60_000;
/** Vigencia del token tras el término (igual que VIGENCIA_TOKEN_TRAS_FIN_MS de bot.ts). */
const VIGENCIA_TOKEN_TRAS_FIN_MS = 2 * 60 * 60_000;

/**
 * Término efectivo de la sesión (ms): max(fin agendado, llegada de Vale + duración agendada), con tope fin
 * agendado + 2 h. Sin llegada (o si llegó a tiempo) es el fin agendado. NaN si el evento no tiene horas válidas.
 */
export function finEfectivo(inicioAgendado: string | number, finAgendado: string | number, llegadaVale?: string | number | Date | null): number {
  const i = typeof inicioAgendado === 'number' ? inicioAgendado : Date.parse(inicioAgendado);
  const f = typeof finAgendado === 'number' ? finAgendado : Date.parse(finAgendado);
  if (Number.isNaN(f)) return NaN;
  const l = llegadaVale == null ? NaN : llegadaVale instanceof Date ? llegadaVale.getTime() : typeof llegadaVale === 'number' ? llegadaVale : Date.parse(llegadaVale);
  if (Number.isNaN(i) || Number.isNaN(l) || f <= i) return f;
  return Math.min(Math.max(f, l + (f - i)), f + MAX_ATRASO_TRAS_FIN_MS);
}

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

/** ¿La grabación está esperando a que Vale vuelva? (en 'grabando' sin máquina) */
export function esperandoVale(g: { estado: string; bot_machine_id?: string | null; nota_sistema?: string | null }): boolean {
  return g.estado === 'grabando' && !g.bot_machine_id && (g.nota_sistema === NOTA_ESPERANDO_VALE || g.nota_sistema === NOTA_ESPERANDO_VALE_RECONECTADO);
}

/** ¿Venció el plazo para que Vale vuelva? (fin_at = cuándo salió el último robot). Sin fin_at: sí. */
export function esperaVencida(g: { fin_at?: string | null }, ahora: Date): boolean {
  const t = Date.parse(g.fin_at ?? '');
  return Number.isNaN(t) || ahora.getTime() - t >= ESPERA_VUELTA_VALE_MS;
}

/** Nota final: si hubo reconexión, se dice (y se suma la nota del motivo de salida, si hay). */
export function notaCierre(notaActual: string | null | undefined, notaFin: string | null): string | null {
  const reconecto = notaActual === NOTA_RECONECTANDO || notaActual === NOTA_ESPERANDO_VALE_RECONECTADO || notaActual?.startsWith(NOTA_RECONECTADO);
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
export type PreviaEvento = Pick<Grabacion, 'id' | 'estado' | 'estado_antes_error' | 'fin_at' | 'updated_at' | 'hora_fin_prevista'>
  & Partial<Pick<Grabacion, 'nota_sistema'>>;
export function previaLiberable(previa: PreviaEvento, inicioNuevo: string, finNuevo: string): boolean {
  const termino = Date.parse(previa.fin_at ?? '');
  const inicio = Date.parse(inicioNuevo);
  if (Number.isNaN(termino) || Number.isNaN(inicio) || termino >= inicio) return false;
  // "Nadie llegó": el robot esperó 30 min desde (a lo más) 4 min antes de la hora vieja; si salió antes
  // de la hora nueva, la sesión se movió sí o sí.
  if (previa.estado === 'sin_audio' && previa.nota_sistema === NOTA_NADIE_LLEGO) return true;
  // No admitido: además el término del evento debe ser otro (si Vale lo rechazó sin mover nada, no se insiste).
  if (previa.estado === 'bot_no_admitido') {
    const finPrevio = Date.parse(previa.hora_fin_prevista ?? '');
    return !Number.isNaN(finPrevio) && finPrevio !== Date.parse(finNuevo);
  }
  return false; // error, cancelada, con audio…: nunca
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
 * Guarda otro término previsto (evento movido o sesión que partió tarde) en una grabación con robot activo:
 * alarga el token si sigue vigente y el candado de la sesión de Google del robot. El robot recibe la hora
 * nueva en la respuesta de `activo` y de cada segmento. true si la fila cambió.
 */
export async function fijarFinPrevisto(c: Cliente, p: Pick<Grabacion, 'id' | 'hora_fin_prevista' | 'bot_token_vence_at'>, nuevaMs: number, ahora: Date): Promise<boolean> {
  if (!Number.isFinite(nuevaMs) || (p.hora_fin_prevista && Date.parse(p.hora_fin_prevista) === nuevaMs)) return false;
  const nueva = new Date(nuevaMs).toISOString();
  const cambios: Record<string, unknown> = { hora_fin_prevista: nueva };
  if (p.bot_token_vence_at && Date.parse(p.bot_token_vence_at) > ahora.getTime()) cambios.bot_token_vence_at = new Date(nuevaMs + VIGENCIA_TOKEN_TRAS_FIN_MS).toISOString();
  const { data } = await c.from('grabaciones').update(cambios).eq('id', p.id).in('estado', ['bot_lanzando', 'bot_en_lobby', 'grabando']).select('id').maybeSingle();
  if (!data) return false;
  await extenderUsoSesion(c, p.id, ahora, nueva).catch(() => {});
  return true;
}

/**
 * Vale salió (o el robot no la encontró): la grabación sigue abierta en 'grabando' sin máquina, token
 * revocado, con la línea de hablantes guardada y fin_at = ahora (desde cuándo se espera). Si Vale vuelve a
 * abrir la sesión, el robot nuevo sigue esta misma grabación; si no, el cron la cierra a los 15 min.
 * Condicional a que la máquina siga siendo la que terminó. true si quedó esperando.
 */
export async function esperarVale(c: Cliente, g: FilaReconexion, op: { ahora: Date; linea?: LineaHablante[] | null }): Promise<boolean> {
  const huboReconexion = g.nota_sistema === NOTA_RECONECTANDO || g.nota_sistema === NOTA_ESPERANDO_VALE_RECONECTADO || !!g.nota_sistema?.startsWith(NOTA_RECONECTADO);
  let q = c.from('grabaciones').update({
    bot_machine_id: null, bot_token_vence_at: op.ahora.toISOString(), fin_at: op.ahora.toISOString(),
    linea_hablantes: combinarLinea(g.linea_hablantes, op.linea),
    nota_sistema: huboReconexion ? NOTA_ESPERANDO_VALE_RECONECTADO : NOTA_ESPERANDO_VALE,
    tomada_en: null, intentos: 0, proximo_intento_at: null, ultimo_error: null,
  }).eq('id', g.id).eq('estado', 'grabando');
  q = g.bot_machine_id ? q.eq('bot_machine_id', g.bot_machine_id) : q.is('bot_machine_id', null);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) throw new Error(`grabaciones (esperar a Vale): ${error.message}`);
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
