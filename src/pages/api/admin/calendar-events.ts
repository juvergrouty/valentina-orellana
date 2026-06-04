import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { getValidAccessToken } from '../../../lib/syncCalendar';

export const prerender = false;

// GET /api/admin/calendar-events?start=ISO&end=ISO
// Devuelve todos los eventos (reservas + Google Calendar) en formato FullCalendar
export const GET: APIRoute = async ({ url }) => {
  const start = url.searchParams.get('start') ?? new Date().toISOString();
  const end   = url.searchParams.get('end')   ?? new Date(Date.now() + 30*24*60*60*1000).toISOString();

  const events: any[] = [];

  // ── Reservas del sistema ───────────────────────────────────────────────────
  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, session_type, session_date, session_time, patient_name, status, amount, google_event_id')
    .gte('session_date', start.slice(0, 10))
    .lte('session_date', end.slice(0, 10))
    .neq('status', 'cancelled');

  const SESSION_LABELS: Record<string, string> = {
    'online': 'Ind. Online', 'presencial': 'Ind. Presencial',
    'pareja-online': 'Par. Online', 'pareja-presencial': 'Par. Presencial',
  };
  const STATUS_COLOR: Record<string, string> = {
    confirmed:       '#576352',
    pending_payment: '#A8906C',
  };

  for (const b of bookings ?? []) {
    const [h, m] = b.session_time.slice(0, 5).split(':').map(Number);
    const startDt = `${b.session_date}T${b.session_time.slice(0,5)}:00`;
    const endMin  = h * 60 + m + 55;
    const endDt   = `${b.session_date}T${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}:00`;

    events.push({
      id:    `booking-${b.id}`,
      title: `${b.patient_name} · ${SESSION_LABELS[b.session_type] ?? b.session_type}`,
      start: startDt,
      end:   endDt,
      backgroundColor: STATUS_COLOR[b.status] ?? '#576352',
      borderColor:     STATUS_COLOR[b.status] ?? '#576352',
      textColor:       '#fff',
      extendedProps: {
        type:          'booking',
        bookingId:     b.id,
        status:        b.status,
        googleEventId: b.google_event_id,
      },
    });
  }

  // ── Google Calendar events ─────────────────────────────────────────────────
  try {
    const auth = await getValidAccessToken();
    if (auth) {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events` +
        `?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&orderBy=startTime&singleEvents=true&maxResults=50`,
        { headers: { Authorization: `Bearer ${auth.token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        for (const ev of data.items ?? []) {
          // Omitir eventos del sistema (ya están como bookings)
          const isSystem = ev.description?.includes('Ps. Valentina Orellana');
          if (isSystem) continue;

          events.push({
            id:    `gcal-${ev.id}`,
            title: ev.summary ?? 'Sin título',
            start: ev.start?.dateTime ?? ev.start?.date,
            end:   ev.end?.dateTime   ?? ev.end?.date,
            backgroundColor: '#6B6860',
            borderColor:     '#6B6860',
            textColor:       '#fff',
            extendedProps: {
              type:         'gcal',
              googleEventId: ev.id,
              meetLink:     ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri,
            },
          });
        }
      }
    }
  } catch (err) {
    console.error('[calendar-events] GCal error:', err);
  }

  return new Response(JSON.stringify(events), {
    headers: { 'Content-Type': 'application/json' },
  });
};
