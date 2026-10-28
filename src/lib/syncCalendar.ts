/**
 * syncCalendar.ts
 * Crea un evento en Google Calendar para una reserva confirmada.
 * Maneja el refresco automático del access_token.
 */

import { supabase } from './supabase';
import { quitarPrefijoSiHayInvitados, refreshAccessToken, createCalendarEvent, deleteCalendarEvent, updateCalendarEventTime, updateCalendarEventTitle, setCalendarEventPaidState, setCalendarEventVoided, UNPAID_PREFIX } from './googleCalendar';
import { logError, logWarn } from './logger';
import { cambiarNotas } from './apigateway';
import { ESTACIONAMIENTO } from '../data/consulta';
import { normalizarMeet, quitarLineaEnlacePropio, traeEnlacePropio } from './enlaceSesion';

const SESSION_LABELS: Record<string, string> = {
  'online':            'Sesión Individual Online',
  'presencial':        'Sesión Individual Presencial',
  'pareja-online':     'Sesión de Pareja Online',
  'pareja-presencial': 'Sesión de Pareja Presencial',
};

export interface BookingForCalendar {
  id:            string;
  session_type:  string;
  session_date:  string;
  session_time:  string;
  patient_name:  string;
  patient_email: string;
  amount:        number;
}

/** Obtiene un access_token válido desde settings, refrescando si es necesario */
/** Dirección de la consulta (Configuración → clinic_address), o undefined. */
async function direccionConsulta(): Promise<string | undefined> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'clinic_address').maybeSingle();
  return data?.value?.trim() || undefined;
}

export async function getValidAccessToken(): Promise<{ token: string; calendarId: string } | null> {
  const { data: rows } = await supabase.from('settings').select('key, value')
    .in('key', ['google_access_token','google_refresh_token','google_token_expiry','google_calendar_id']);
  const cfg: Record<string, string> = {};
  (rows ?? []).forEach(({ key, value }: { key: string; value: string }) => { cfg[key] = value; });

  if (!cfg['google_refresh_token']) return null;

  let token = cfg['google_access_token'];
  const expiry = parseInt(cfg['google_token_expiry'] ?? '0');

  if (!token || Date.now() > expiry - 60_000) {
    const refreshed = await refreshAccessToken(cfg['google_refresh_token']);
    token = refreshed.access_token;
    await supabase.from('settings').upsert(
      { key: 'google_access_token', value: token, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    await supabase.from('settings').upsert(
      { key: 'google_token_expiry', value: String(Date.now() + refreshed.expires_in * 1000), updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  }

  return { token, calendarId: cfg['google_calendar_id'] ?? 'primary' };
}

// ── Reintento de borrar/mover el evento (auditoría 28 oct 2026) ─────────────
// Si Google falla (o no está conectado) al anular o reagendar, antes solo
// quedaba en el registro: la paciente seguía viendo la sesión vieja en su
// calendario. Ahora queda pendiente en settings ("calendario_pendiente:<id>")
// y la tarea de cada 5 min (cron/boletas-pendientes) lo reintenta con el estado
// ACTUAL de la reserva: borra solo si sigue anulada y mueve a su fecha/hora de
// ahora. Tras ~1 hora sin éxito queda un error visible en el panel.
const PREFIJO_PENDIENTE = 'calendario_pendiente:';
const MAX_INTENTOS_CALENDARIO = 12;
type PendienteCalendario = { accion: 'borrar' | 'mover'; avisar: boolean; intentos: number }; // avisar: solo al mover

async function registrarPendienteCalendario(bookingId: string, accion: PendienteCalendario['accion'], avisar: boolean, error: string): Promise<void> {
  const valor: PendienteCalendario = { accion, avisar, intentos: 0 };
  const { error: e } = await supabase.from('settings').upsert(
    { key: PREFIJO_PENDIENTE + bookingId, value: JSON.stringify(valor), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  // Mientras se reintenta solo es una advertencia (sin la franja roja del panel, 28 oct 2026: "si se
  // arregla deben desaparecer"). La franja sale solo si se agotan los reintentos o si ni siquiera
  // se pudo dejar pendiente.
  const ctx = accion === 'borrar' ? 'calendar/eliminar' : 'calendar/reagendar';
  const verbo = accion === 'borrar' ? 'eliminar' : 'mover';
  if (e) await logError(ctx, `No se pudo ${verbo} el evento de Google Calendar: revísalo a mano en tu calendario`, { bookingId, error, errorPendiente: e.message });
  else await logWarn(ctx, `No se pudo ${verbo} el evento de Google Calendar; se reintenta solo cada 5 minutos`, { bookingId, error });
}

// Borrar nunca avisa por Google (decisión de Vale, 19 oct 2026: el correo de anulación es el único aviso).
async function borrarEventoAhora(bookingId: string): Promise<void> {
  const { data: booking } = await supabase.from('bookings').select('google_event_id').eq('id', bookingId).single();
  if (!booking?.google_event_id) return;
  const auth = await getValidAccessToken();
  if (!auth) throw new Error('Google Calendar no está conectado');
  await deleteCalendarEvent(auth.token, auth.calendarId, booking.google_event_id);
}

/** Elimina el evento de Google Calendar asociado a una reserva */
export async function deleteBookingFromCalendar(bookingId: string): Promise<void> {
  try {
    await borrarEventoAhora(bookingId);
  } catch (e) {
    // No relanzar: los llamadores lo tratan como "mejor esfuerzo"; queda pendiente y se reintenta.
    await registrarPendienteCalendario(bookingId, 'borrar', false, e instanceof Error ? e.message : String(e));
  }
}

/** Reintenta lo pendiente (lo llama la tarea de cada 5 min). Nunca lanza. */
export async function reintentarCalendarioPendiente(): Promise<{ hechos: number; pendientes: number }> {
  let hechos = 0, pendientes = 0;
  try {
    const { data: filas } = await supabase.from('settings').select('key, value').like('key', `${PREFIJO_PENDIENTE}%`).limit(50);
    for (const f of filas ?? []) {
      const bookingId = String(f.key).slice(PREFIJO_PENDIENTE.length);
      let p: PendienteCalendario;
      try { p = JSON.parse(f.value); } catch { await supabase.from('settings').delete().eq('key', f.key); continue; }
      try {
        const { data: b } = await supabase.from('bookings').select('status, session_date, session_time, duration_min').eq('id', bookingId).maybeSingle();
        const anulada = !b || b.status === 'cancelled' || b.status === 'expired';
        if (p.accion === 'borrar' && anulada) await borrarEventoAhora(bookingId);
        else if (p.accion === 'mover' && !anulada) await moverEventoAhora(bookingId, String(b!.session_date), String(b!.session_time).slice(0, 5), b!.duration_min ?? 55, p.avisar);
        // Si la reserva cambió de estado entretanto (p. ej. se reactivó), no hay nada que hacer.
        await supabase.from('settings').delete().eq('key', f.key);
        hechos++;
      } catch (e) {
        const intentos = (p.intentos ?? 0) + 1;
        if (intentos >= MAX_INTENTOS_CALENDARIO) {
          await supabase.from('settings').delete().eq('key', f.key);
          await logError('calendar/pendiente-agotado',
            `No se pudo ${p.accion === 'borrar' ? 'borrar' : 'mover'} en Google Calendar una sesión tras ${intentos} intentos: revisa ese evento a mano en tu calendario.`,
            { bookingId, error: e instanceof Error ? e.message : String(e) });
        } else {
          const { error: errInt } = await supabase.from('settings').update({ value: JSON.stringify({ ...p, intentos }), updated_at: new Date().toISOString() }).eq('key', f.key);
          // Si ni el contador se puede guardar, nunca llegaría al aviso final: se avisa ya.
          if (errInt) await logError('calendar/pendiente-agotado', `No se pudo ${p.accion === 'borrar' ? 'borrar' : 'mover'} en Google Calendar una sesión y tampoco registrar el reintento: revisa ese evento a mano en tu calendario.`, { bookingId, error: errInt.message });
          pendientes++;
        }
      }
    }
  } catch (e) { console.error('[calendario pendiente]', e); }
  return { hechos, pendientes };
}

async function moverEventoAhora(bookingId: string, date: string, time: string, durationMin: number, notify: boolean): Promise<void> {
  const { data: booking } = await supabase.from('bookings').select('google_event_id, session_type').eq('id', bookingId).single();
  if (!booking?.google_event_id) return;
  const auth = await getValidAccessToken();
  if (!auth) throw new Error('Google Calendar no está conectado');
  const online = (booking.session_type ?? '').includes('online');
  if (online) await limpiarEnlacePropioDelEvento(bookingId, booking.google_event_id, auth);
  const location = online ? undefined : await direccionConsulta();
  await updateCalendarEventTime(auth.token, auth.calendarId, booking.google_event_id, date, time, durationMin, location, notify);
}

/** Actualiza fecha/hora del evento en Google Calendar al reagendar */
export async function rescheduleBookingInCalendar(bookingId: string, date: string, time: string, durationMin = 55, notify = true): Promise<void> {
  try {
    const { data: booking } = await supabase.from('bookings').select('google_event_id, session_type').eq('id', bookingId).single();
    if (!booking?.google_event_id) return;
    const auth = await getValidAccessToken();
    if (!auth) throw new Error('Google Calendar no está conectado');
    // Presencial: la invitación lleva la dirección (también corrige eventos
    // antiguos que se crearon sin ella).
    // Online: la ubicación no se toca (la paciente es invitada: solo ve el Meet del evento). Si el evento es de
    // los que llevaron el enlace propio (18–19 oct 2026), se limpia antes de mover la hora.
    const online = (booking.session_type ?? '').includes('online');
    if (online) await limpiarEnlacePropioDelEvento(bookingId, booking.google_event_id, auth);
    const location = online ? undefined : await direccionConsulta();
    await updateCalendarEventTime(auth.token, auth.calendarId, booking.google_event_id, date, time, durationMin, location, notify);
  } catch (e) {
    await registrarPendienteCalendario(bookingId, 'mover', notify, e instanceof Error ? e.message : String(e));
  }
}

/** Actualiza el título del evento en Google Calendar al renombrar la sesión o
 *  cambiar su servicio — antes solo quedaba guardado en la BD, el evento real
 *  en su Google Calendar (y el del paciente) se quedaba con el nombre viejo. */
export async function retitleBookingInCalendar(bookingId: string, title: string): Promise<void> {
  try {
    const { data: booking } = await supabase.from('bookings').select('google_event_id, status').eq('id', bookingId).single();
    if (!booking?.google_event_id) return;
    const auth = await getValidAccessToken();
    if (!auth) return;
    // Una reserva todavía pendiente de pago conserva su marca "Por pagar" al renombrarla
    const finalTitle = booking.status === 'pending_payment' && !title.startsWith(UNPAID_PREFIX) ? UNPAID_PREFIX + title : title;
    await updateCalendarEventTitle(auth.token, auth.calendarId, booking.google_event_id, finalTitle);
  } catch (e) {
    await logError('calendar/renombrar', 'No se pudo actualizar el título del evento de Google Calendar', { bookingId, title, error: e instanceof Error ? e.message : String(e) });
  }
}

const CALENDAR_API_EVENTOS = 'https://www.googleapis.com/calendar/v3/calendars';

/** Meet directo (hangoutLink) de un evento de Calendar; null si no tiene o no se pudo leer (3 s). */
export async function meetDeEventoCalendario(googleEventId: string): Promise<string | null> {
  const auth = await getValidAccessToken();
  if (!auth) return null;
  const res = await fetch(`${CALENDAR_API_EVENTOS}/${encodeURIComponent(auth.calendarId)}/events/${encodeURIComponent(googleEventId)}`, {
    headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return null;
  const ev = (await res.json()) as { hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } };
  return normalizarMeet(ev.hangoutLink) ?? normalizarMeet(ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri);
}

/**
 * Eventos online creados el 18–19 oct 2026 llevaban el enlace propio /sesion/ en la ubicación y la
 * descripción (que la paciente ve como invitada). Esto los deja solo con el Meet directo: ubicación = Meet
 * del evento (o vacía) y descripción sin la línea "Entrar a la sesión: …/sesion/…". Sin aviso a la invitada
 * (sendUpdates=none). Solo escribe si el evento trae el enlace propio. Mejor esfuerzo: nunca lanza.
 * true = quedó bien (limpio o no había nada que limpiar); false = falló y conviene reintentar.
 */
export async function limpiarEnlacePropioDelEvento(
  bookingId: string,
  googleEventId: string,
  auth?: { token: string; calendarId: string } | null,
): Promise<boolean> {
  try {
    const a = auth ?? (await getValidAccessToken());
    if (!a) return true; // sin Google conectado no hay evento que limpiar
    const url = `${CALENDAR_API_EVENTOS}/${encodeURIComponent(a.calendarId)}/events/${encodeURIComponent(googleEventId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(5000) });
    if (res.status === 404 || res.status === 410) return true; // evento borrado: nada que limpiar
    if (!res.ok) throw new Error(`GET ${res.status}`);
    const ev = (await res.json()) as { location?: string; description?: string; hangoutLink?: string };
    if (!traeEnlacePropio(ev.location) && !traeEnlacePropio(ev.description)) return true;
    const meet = normalizarMeet(ev.hangoutLink);
    const body: Record<string, string> = {};
    if (traeEnlacePropio(ev.location)) body.location = meet ?? '';
    if (traeEnlacePropio(ev.description)) body.description = quitarLineaEnlacePropio(ev.description);
    const r = await fetch(`${url}?sendUpdates=none`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`PATCH ${r.status}`);
    return true;
  } catch (e) {
    await logError('calendar/limpiar-enlace', 'No se pudo quitar el enlace propio del evento de Google Calendar', { bookingId, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function syncBookingToCalendar(booking: BookingForCalendar, opts: { unpaid?: boolean; invite?: boolean } = {}): Promise<{
  success: boolean;
  meetLink?: string;
  eventLink?: string;
  error?: string;
}> {
  try {
    // Si esta reserva ya tiene un evento creado, no crear uno duplicado
    // (defensa adicional por si esta función se llama dos veces para la misma reserva).
    const { data: existing } = await supabase.from('bookings').select('google_event_id').eq('id', booking.id).single();
    if (existing?.google_event_id) {
      return { success: true };
    }

    // Leer settings de Google
    const { data: rows } = await supabase.from('settings').select('key, value')
      .in('key', ['google_access_token','google_refresh_token','google_token_expiry','google_calendar_id','google_calendar_name']);

    const cfg: Record<string, string> = {};
    (rows ?? []).forEach(({ key, value }: { key: string; value: string }) => { cfg[key] = value; });

    if (!cfg['google_refresh_token']) {
      return { success: false, error: 'Google Calendar no está conectado.' };
    }

    // Obtener access_token válido (refrescar si expiró)
    let accessToken = cfg['google_access_token'];
    const expiry    = parseInt(cfg['google_token_expiry'] ?? '0');

    if (!accessToken || Date.now() > expiry - 60_000) {
      const refreshed = await refreshAccessToken(cfg['google_refresh_token']);
      accessToken = refreshed.access_token;
      // Actualizar token en settings
      await supabase.from('settings').upsert(
        { key: 'google_access_token', value: accessToken,
          updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      await supabase.from('settings').upsert(
        { key: 'google_token_expiry',
          value: String(Date.now() + refreshed.expires_in * 1000),
          updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }

    const isOnline = booking.session_type.includes('online');

    // ¿Pagada o por pagar? Si quien llama no lo fuerza, se lee de la reserva
    // (paid_at). Si esa columna aún no existe, queda el comportamiento antiguo
    // (evento sin color).
    let unpaid = opts.unpaid;
    let paid   = false;
    if (unpaid === undefined) {
      const pr = await supabase.from('bookings').select('paid_at, debt_voided').eq('id', booking.id).single();
      if (!pr.error && pr.data) {
        paid   = !!pr.data.paid_at;
        unpaid = !paid && pr.data.debt_voided !== true;
      }
    }

    // Duración: la de la propia reserva (la que se ve en el panel); si no la
    // tiene, la de settings. Antes era siempre la de settings (55).
    const { data: durRows } = await supabase.from('settings').select('key, value')
      .in('key', ['session_duration_min']);
    const durCfg: Record<string, string> = {};
    (durRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { durCfg[key] = value; });
    const { data: durRow } = await supabase.from('bookings').select('duration_min').eq('id', booking.id).maybeSingle();
    const durationMin = Number(durRow?.duration_min) || parseInt(durCfg['session_duration_min'] ?? '55');

    const sessionLabel = SESSION_LABELS[booking.session_type] ?? booking.session_type;
    // Presencial: la invitación de Google lleva la dirección de la consulta.
    // Online: la paciente es invitada y ve el evento, así que solo lleva el Meet directo del propio evento
    // (decisión de Vale, 19 oct 2026: el enlace propio /sesion/ es solo para ella, en el panel).
    const location = isOnline ? undefined : await direccionConsulta();

    const event = await createCalendarEvent(accessToken, {
      title:         `${sessionLabel} — ${booking.patient_name}`,
      description:   `Sesión con Ps. Valentina Orellana\nPaciente: ${booking.patient_name}\nTipo: ${sessionLabel}${location ? `\nDirección: ${location}\n${ESTACIONAMIENTO}` : ''}`,
      location,
      date:          booking.session_date,
      startTime:     booking.session_time.slice(0, 5),
      durationMin,
      // unpaid → reserva aún sin pagar: prefijo "Por pagar" + color rojo; paid →
      // verde. invite:false → sin invitación de Google al paciente (reservas con
      // link de pago: se le invita recién cuando paga, ver markBookingPaidInCalendar).
      attendeeEmail: opts.invite === false ? undefined : (booking.patient_email || undefined),
      unpaid:        unpaid === true,
      paid,
      isOnline,
      calendarId:    cfg['google_calendar_id'] ?? 'primary',
      // Id fijo derivado de la reserva (hex sin guiones = base32hex válido):
      // si un intento se corta tras crear el evento y antes de guardar su id,
      // el reintento encuentra ese mismo evento en vez de duplicarlo.
      eventId:       booking.id.replace(/-/g, '').toLowerCase(),
    });

    // Guardar event_id y Meet link en la reserva SIN pisar otras notas (ej. el
    // folio de la boleta): las notas se escriben con cambiarNotas, que no
    // pierde una línea si otra parte del sistema las cambia al mismo tiempo.
    await supabase.from('bookings').update({ google_event_id: event.id }).eq('id', booking.id);
    if (event.meetLink) {
      const link = event.meetLink;
      await cambiarNotas(booking.id, (n) => {
        const prev = n.replace(/(^|\n)\s*Meet:\s*\S+/g, '').trim(); // quita Meet previo
        return (prev ? prev + '\n' : '') + `Meet: ${link}`;
      });
    }

    return { success: true, meetLink: event.meetLink, eventLink: event.htmlLink };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[syncCalendar] Error:', msg);
    await logError('calendar/crear', 'No se pudo crear el evento de Google Calendar', { bookingId: booking.id, error: msg });
    return { success: false, error: msg };
  }
}

/** Cambia el evento de la reserva a "pagado" (quita "Por pagar" y lo pone en verde, e
 *  invita al paciente) o de vuelta a "por pagar" (al anular un pago). Mejor
 *  esfuerzo: si falla, queda en /admin/logs y no interrumpe el flujo. */
export async function markBookingPaidInCalendar(bookingId: string, paid: boolean, opts: { invitar?: boolean } = {}): Promise<boolean> {
  // true = quedó hecho (o no hay evento/Google que actualizar); false = falló y conviene reintentar.
  try {
    const { data: booking } = await supabase.from('bookings').select('google_event_id, patient_email, session_type').eq('id', bookingId).single();
    if (!booking?.google_event_id) return true;
    const auth = await getValidAccessToken();
    if (!auth) return true;
    // Online: al pagar se invita a la paciente; antes, el evento queda solo con el Meet directo (por si es
    // de los que llevaron el enlace propio /sesion/ el 18–19 oct 2026).
    if (paid && String(booking.session_type ?? '').includes('online')) {
      await limpiarEnlacePropioDelEvento(bookingId, booking.google_event_id, auth);
    }
    await setCalendarEventPaidState(auth.token, auth.calendarId, booking.google_event_id, paid, paid && opts.invitar !== false ? (booking.patient_email || undefined) : undefined);
    return true;
  } catch (e) {
    await logError('calendar/estado-pago', 'No se pudo actualizar el estado de pago del evento de Google Calendar', { bookingId, paid, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Deuda anulada: el evento deja de verse como deuda (gris, sin "Por pagar"), sin avisar a la paciente. */
export async function markBookingDebtVoidedInCalendar(bookingId: string): Promise<boolean> {
  try {
    const { data: booking } = await supabase.from('bookings').select('google_event_id').eq('id', bookingId).single();
    if (!booking?.google_event_id) return true;
    const auth = await getValidAccessToken();
    if (!auth) return true;
    await setCalendarEventVoided(auth.token, auth.calendarId, booking.google_event_id);
    return true;
  } catch (e) {
    await logError('calendar/deuda-anulada', 'No se pudo actualizar el evento de Google Calendar de una deuda anulada', { bookingId, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Corrección única (3 oct 2026) de eventos YA enviados: invitaciones a
 * pacientes con el título "Por pagar · …". Corre una sola vez al abrir el
 * panel (marca en settings) sobre las sesiones futuras con evento.
 */
export async function corregirPrefijoInvitacionesUnaVez(): Promise<void> {
  const MARCA = 'fix_prefijo_invitados_v1';
  const { data: hecho } = await supabase.from('settings').select('value').eq('key', MARCA).maybeSingle();
  if (hecho?.value) return;
  // Se marca antes de empezar: si algo falla, no se reintenta en cada carga.
  await supabase.from('settings').upsert({ key: MARCA, value: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  const auth = await getValidAccessToken();
  if (!auth) return;
  const hoy = new Date().toISOString().slice(0, 10);
  const { data: rows } = await supabase.from('bookings').select('id, google_event_id')
    .gte('session_date', hoy).neq('session_date', '2099-12-31')
    .not('google_event_id', 'is', null).not('status', 'in', '(cancelled,expired)').limit(200);
  let corregidos = 0;
  for (const r of rows ?? []) {
    try { if (await quitarPrefijoSiHayInvitados(auth.token, auth.calendarId, r.google_event_id)) corregidos++; } catch { /* sigue con las demás */ }
  }
  await supabase.from('settings').upsert({ key: MARCA, value: `${new Date().toISOString()} · ${corregidos} corregidos de ${(rows ?? []).length}`, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}
