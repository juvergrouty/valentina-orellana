/**
 * syncCalendar.ts
 * Crea un evento en Google Calendar para una reserva confirmada.
 * Maneja el refresco automático del access_token.
 */

import { supabase } from './supabase';
import { refreshAccessToken, createCalendarEvent } from './googleCalendar';

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

export async function syncBookingToCalendar(booking: BookingForCalendar): Promise<{
  success: boolean;
  meetLink?: string;
  eventLink?: string;
  error?: string;
}> {
  try {
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

    // Guardar el Meet link en la reserva si lo hay
    if (event.meetLink) {
      await supabase.from('bookings').update({ notes: `Meet: ${event.meetLink}` }).eq('id', booking.id);
    }

    return { success: true, meetLink: event.meetLink, eventLink: event.htmlLink };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[syncCalendar] Error:', msg);
    return { success: false, error: msg };
  }
}
