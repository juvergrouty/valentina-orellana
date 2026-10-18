// GET /sesion/<código> — enlace propio de la sesión online (pedido de Vale, 18 oct 2026).
// Lo usa src/pages/sesion/[codigo].astro. Reglas:
//  - Código inválido → 404 genérico (no dice si la reserva existe). Se audita como 'denegado' con la IP;
//    pasado el límite por IP ya no se escribe nada más (no se puede llenar la bitácora).
//  - Código válido → SIEMPRE redirige al Meet de la reserva (nunca se bloquea la entrada a la sesión).
//    Solo a https://meet.google.com/<sala> (normalizado: sin redirección abierta).
//  - En segundo plano (waitUntil, el usuario no espera): si la sesión es online, va a ocurrir y estamos
//    en [inicio − 30 min, fin), se despacha el robot por el MISMO camino del cron
//    (pipeline.despacharPorEnlace: índice único google_event_id, consentimiento, toma, cuenta del robot).
//    Las vistas previas de WhatsApp/correo no mandan el robot. Tope de despachos por enlace.
//  - Bitácora: transcriptor_auditoria, accion 'enlace_sesion', solo el id de la reserva y el resultado
//    (nunca el Meet, el código ni datos clínicos). Los logs de consola tampoco llevan el Meet.
import type { SupabaseClient } from '@supabase/supabase-js';
import { destinoMeet, esVisitaAutomatica, meetDeNotas, normalizarMeet, reservaDesdeCodigo } from '../enlaceSesion';
import { reservaVaAOcurrir } from './bot';
import type { AccionAuditoria } from './tipos';

export const ACCION_ENLACE = 'enlace_sesion' as AccionAuditoria;
/** Códigos inválidos por IP antes de dejar de auditarlos (siempre responden 404). */
export const MAX_INVALIDOS_IP = 20;
export const VENTANA_INVALIDOS_MS = 15 * 60_000;
/** Despachos del robot por enlace (reserva) en la ventana; el resto solo redirige. */
export const MAX_DESPACHOS_ENLACE = 6;
/** Visitas auditadas por enlace en la ventana (más allá no se escribe la bitácora; se redirige igual). */
export const MAX_AUDITADAS_ENLACE = 40;
export const VENTANA_ENLACE_MS = 10 * 60_000;
/** Filtro barato antes de leer Calendar: la reserva empieza entre 6 h atrás y 3 h adelante. */
const PREVIA_ATRAS_MS = 6 * 60 * 60_000;
const PREVIA_ADELANTE_MS = 3 * 60 * 60_000;

export type RespuestaEnlace =
  | { tipo: 'redirigir'; url: string }
  | { tipo: 'no_encontrado' }
  | { tipo: 'sin_meet' }
  | { tipo: 'error' };

export interface FilaReservaEnlace {
  id: string; session_type: string | null; status: string; created_by_admin?: boolean | null;
  notes: string | null; google_event_id: string | null; session_date: string | null; session_time: string | null;
}

export interface EntradaEnlace {
  codigo: unknown;
  metodo: string;
  request: Request;
  clientAddress?: string | null;
  /** ?authuser=<correo> (panel de Vale: abrir Meet con la cuenta del negocio). */
  authuser?: string | null;
}

export interface DepsEnlace {
  db?: SupabaseClient;
  ahora?: () => Date;
  /** Base para las llaves del código (por defecto ADMIN_SECRET). */
  secreto?: string;
  /** Despacho del robot (por defecto pipeline.despacharPorEnlace con las dependencias reales). */
  despachar?: (ref: { bookingId: string; googleEventId: string | null }, ahora: Date) => Promise<string>;
  /** Meet desde el evento de Calendar cuando las notas no lo traen (por defecto Google Calendar, 3 s). */
  meetDeCalendario?: (googleEventId: string) => Promise<string | null>;
  /** Trabajo después de responder (por defecto waitUntil de Vercel; fuera de Vercel, sin esperar). */
  enSegundoPlano?: (trabajo: () => Promise<unknown>) => void;
  auditar?: (accion: AccionAuditoria, op: { resultado: 'ok' | 'denegado' | 'error'; detalle: Record<string, unknown>; request: Request; clientAddress?: string | null }) => Promise<unknown>;
}

async function clientePorDefecto(): Promise<SupabaseClient> {
  return (await import('../supabase')).supabase;
}

/** Inicio de la reserva (fecha y hora de Chile) en ms UTC; NaN si no hay fecha. */
export function inicioChileMs(fecha: string | null | undefined, hora: string | null | undefined): number {
  const mf = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha ?? ''));
  const mh = /^(\d{2}):(\d{2})/.exec(String(hora ?? ''));
  if (!mf || !mh) return NaN;
  const supuesto = Date.UTC(+mf[1], +mf[2] - 1, +mf[3], +mh[1], +mh[2]);
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(supuesto));
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  const comoUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'));
  return supuesto - (comoUtc - supuesto);
}

/** ¿Vale la pena revisar Calendar para mandar el robot? (filtro previo, sin red). */
export function cercaDeLaHora(b: Pick<FilaReservaEnlace, 'session_date' | 'session_time'>, ahora: Date): boolean {
  const t = inicioChileMs(b.session_date, b.session_time);
  if (Number.isNaN(t)) return false;
  return ahora.getTime() >= t - PREVIA_ADELANTE_MS && ahora.getTime() <= t + PREVIA_ATRAS_MS;
}

async function meetDeCalendarioPorDefecto(googleEventId: string): Promise<string | null> {
  const { getValidAccessToken } = await import('../syncCalendar');
  const auth = await getValidAccessToken();
  if (!auth) return null;
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events/${encodeURIComponent(googleEventId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const ev = (await res.json()) as { hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } };
  return normalizarMeet(ev.hangoutLink)
    ?? normalizarMeet(ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri);
}

async function despacharPorDefecto(ref: { bookingId: string; googleEventId: string | null }, ahora: Date): Promise<string> {
  const { crearPipeline, depsProduccion } = await import('./pipeline');
  return crearPipeline(await depsProduccion()).despacharPorEnlace(ref, ahora);
}

function segundoPlanoPorDefecto(trabajo: () => Promise<unknown>): void {
  void import('./despuesDeResponder').then(({ despuesDeResponder }) => {
    // Fuera de Vercel no hay waitUntil: se corre sin esperar (el cron del minuto cubre si se corta).
    if (!despuesDeResponder(trabajo)) void trabajo().catch(() => undefined);
  }).catch(() => undefined);
}

/**
 * Resuelve la visita. Lo que responde no depende de la base salvo para leer la reserva (el Meet):
 * el despacho y la bitácora van en segundo plano.
 */
export async function abrirEnlaceSesion(entrada: EntradaEnlace, deps: DepsEnlace = {}): Promise<RespuestaEnlace> {
  const ahora = deps.ahora?.() ?? new Date();
  const db = async () => deps.db ?? (await clientePorDefecto());
  const segundoPlano = deps.enSegundoPlano ?? segundoPlanoPorDefecto;
  const auditar = deps.auditar ?? (async (accion, op) => {
    const m = await import('./auditoria');
    return m.auditar('sistema', accion, { ...op, cliente: await db() });
  });
  const ipDe = async () => (await import('./auditoria')).ipDeRequest(entrada.request, entrada.clientAddress);

  const bookingId = reservaDesdeCodigo(entrada.codigo, 'secreto' in deps ? deps.secreto : undefined);
  if (!bookingId) {
    segundoPlano(async () => {
      const ip = await ipDe();
      const c = await db();
      if (ip) {
        const { count, error } = await c.from('transcriptor_auditoria').select('id', { count: 'exact', head: true })
          .eq('accion', ACCION_ENLACE).eq('resultado', 'denegado').eq('ip', ip)
          .gte('at', new Date(ahora.getTime() - VENTANA_INVALIDOS_MS).toISOString());
        if (error || (count ?? 0) >= MAX_INVALIDOS_IP) return; // límite por IP: ya no se audita más
      }
      await auditar(ACCION_ENLACE, { resultado: 'denegado', detalle: { motivo: 'codigo_invalido' }, request: entrada.request, clientAddress: entrada.clientAddress });
    });
    return { tipo: 'no_encontrado' };
  }

  let b: FilaReservaEnlace | null;
  try {
    const { data, error } = await (await db()).from('bookings')
      .select('id, session_type, status, created_by_admin, notes, google_event_id, session_date, session_time')
      .eq('id', bookingId).maybeSingle();
    if (error) throw new Error(error.message);
    b = (data as FilaReservaEnlace | null) ?? null;
  } catch {
    console.warn('[enlace-sesion] no se pudo leer la reserva');
    return { tipo: 'error' };
  }
  if (!b) return { tipo: 'no_encontrado' }; // reserva borrada: mismo 404 que un código inválido

  const online = String(b.session_type ?? '').includes('online');
  let meet = meetDeNotas(b.notes);
  if (!meet && online && b.google_event_id) {
    try { meet = await (deps.meetDeCalendario ?? meetDeCalendarioPorDefecto)(b.google_event_id); } catch { meet = null; }
  }
  const destino = destinoMeet(meet, entrada.authuser);

  const reserva = b;
  segundoPlano(async () => {
    const detalle: Record<string, unknown> = { reserva: reserva.id, con_meet: !!destino };
    const c = await db();
    const desde = new Date(ahora.getTime() - VENTANA_ENLACE_MS).toISOString();
    const { count: auditadas, error: eA } = await c.from('transcriptor_auditoria').select('id', { count: 'exact', head: true })
      .eq('accion', ACCION_ENLACE).eq('detalle->>reserva', reserva.id).gte('at', desde);
    if (eA) return;
    let resultado: 'ok' | 'error' = 'ok';
    if (entrada.metodo !== 'GET') detalle.despacho = 'no_get';
    else if (esVisitaAutomatica(entrada.request.headers.get('user-agent'))) detalle.despacho = 'vista_previa';
    else if (!online || !destino) detalle.despacho = 'sin_meet';
    else if (!reservaVaAOcurrir({ status: reserva.status, created_by_admin: reserva.created_by_admin ?? null })) detalle.despacho = 'reserva_no_vigente';
    else if (!cercaDeLaHora(reserva, ahora)) detalle.despacho = 'fuera_de_ventana';
    else {
      const { count: despachos, error: eD } = await c.from('transcriptor_auditoria').select('id', { count: 'exact', head: true })
        .eq('accion', ACCION_ENLACE).eq('detalle->>reserva', reserva.id).eq('detalle->>intento', 'si').gte('at', desde);
      if (eD || (despachos ?? 0) >= MAX_DESPACHOS_ENLACE) detalle.despacho = 'limite';
      else {
        detalle.intento = 'si';
        try {
          detalle.despacho = await (deps.despachar ?? despacharPorDefecto)({ bookingId: reserva.id, googleEventId: reserva.google_event_id }, ahora);
        } catch (e) {
          resultado = 'error';
          detalle.despacho = 'error';
          // Sin el Meet ni el código en el log: solo el tipo de error.
          console.warn('[enlace-sesion] despacho falló:', e instanceof Error ? e.name : 'error');
        }
      }
    }
    if ((auditadas ?? 0) >= MAX_AUDITADAS_ENLACE && detalle.intento !== 'si') return;
    await auditar(ACCION_ENLACE, { resultado, detalle, request: entrada.request, clientAddress: entrada.clientAddress });
  });

  return destino ? { tipo: 'redirigir', url: destino } : { tipo: 'sin_meet' };
}
