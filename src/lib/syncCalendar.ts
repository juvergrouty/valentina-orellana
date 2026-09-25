/**
 * syncCalendar.ts
 * Crea un evento en Google Calendar para una reserva confirmada.
 * Maneja el refresco automático del access_token.
 */

import { supabase } from './supabase';
import { refreshAccessToken, createCalendarEvent, deleteCalendarEvent, updateCalendarEventTime, updateCalendarEventTitle } from './googleCalendar';
import { logError } from './logger';

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

/** Elimina el evento de Google Calendar asociado a una reserva */
export async function deleteBookingFromCalendar(bookingId: string): Promise<void> {
  try {
    const { data: booking } = await supabase.from('bookings').select('google_event_id').eq('id', bookingId).single();
    if (!booking?.google_event_id) return;
    const auth = await getValidAccessToken();
    if (!auth) return;
    await deleteCalendarEvent(auth.token, auth.calendarId, booking.google_event_id);
  } catch (e) {
    // No relanzar: los llamadores ya tratan esto como "mejor esfuerzo", pero
    // antes una falla (ej. token de Google vencido) no dejaba ningún rastro.
    await logError('calendar/eliminar', 'No se pudo eliminar el evento de Google Calendar', { bookingId, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Actualiza fecha/hora del evento en Google Calendar al reagendar */
export async function rescheduleBookingInCalendar(bookingId: string, date: string, time: string, durationMin = 55): Promise<void> {
  try {
    const { data: booking } = await supabase.from('bookings').select('google_event_id').eq('id', bookingId).single();
    if (!booking?.google_event_id) return;
    const auth = await getValidAccessToken();
    if (!auth) return;
    await updateCalendarEventTime(auth.token, auth.calendarId, booking.google_event_id, date, time, durationMin);
  } catch (e) {
    await logError('calendar/reagendar', 'No se pudo actualizar el evento de Google Calendar', { bookingId, date, time, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Actualiza el título del evento en Google Calendar al renombrar la sesión o
 *  cambiar su servicio — antes solo quedaba guardado en la BD, el evento real
 *  en su Google Calendar (y el del paciente) se quedaba con el nombre viejo. */
export async function retitleBookingInCalendar(bookingId: string, title: string): Promise<void> {
  try {
    const { data: booking } = await supabase.from('bookings').select('google_event_id').eq('id', bookingId).single();
    if (!booking?.google_event_id) return;
    const auth = await getValidAccessToken();
    if (!auth) return;
    await updateCalendarEventTitle(auth.token, auth.calendarId, booking.google_event_id, title);
  } catch (e) {
    await logError('calendar/renombrar', 'No se pudo actualizar el título del evento de Google Calendar', { bookingId, title, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function syncBookingToCalendar(booking: BookingForCalendar): Promise<{
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

    // Leer duración de settings
    const { data: durRows } = await supabase.from('settings').select('key, value')
      .in('key', ['session_duration_min']);
    const durCfg: Record<string, string> = {};
    (durRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { durCfg[key] = value; });
    const durationMin = parseInt(durCfg['session_duration_min'] ?? '55');

    const sessionLabel = SESSION_LABELS[booking.session_type] ?? booking.session_type;

    const event = await createCalendarEvent(accessToken, {
      title:         `${sessionLabel} — ${booking.patient_name}`,
      description:   `Sesión con Ps. Valentina Orellana\nPaciente: ${booking.patient_name}\nTipo: ${sessionLabel}`,
      date:          booking.session_date,
      startTime:     booking.session_time.slice(0, 5),
      durationMin,
      attendeeEmail: booking.patient_email || undefined,
      isOnline,
      calendarId:    cfg['google_calendar_id'] ?? 'primary',
    });

    // Guardar event_id y Meet link en la reserva SIN pisar otras notas (ej. folio de boleta)
    const updateData: Record<string, string> = { google_event_id: event.id };
    if (event.meetLink) {
      const { data: cur } = await supabase.from('bookings').select('notes').eq('id', booking.id).single();
      const prev = (cur?.notes ?? '').replace(/(^|\n)\s*Meet:\s*\S+/g, '').trim(); // quita Meet previo
      updateData.notes = (prev ? prev + '\n' : '') + `Meet: ${event.meetLink}`;
    }
    await supabase.from('bookings').update(updateData).eq('id', booking.id);

    return { success: true, meetLink: event.meetLink, eventLink: event.htmlLink };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[syncCalendar] Error:', msg);
    await logError('calendar/crear', 'No se pudo crear el evento de Google Calendar', { bookingId: booking.id, error: msg });
    return { success: false, error: msg };
  }
}
