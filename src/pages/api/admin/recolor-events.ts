import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { getValidAccessToken } from '../../../lib/syncCalendar';
import { setCalendarEventPaidState } from '../../../lib/googleCalendar';
import { todayCL } from '../../../lib/dateUtils';

export const prerender = false;

// Pone al día el color de los eventos de Google Calendar que ya existían antes
// del sistema rojo/verde: pagadas → verde, sin pagar → "Por pagar" en rojo.
// Solo reservas desde hoy en adelante. NO invita ni avisa a nadie (solo cambia
// color y prefijo del título). Idempotente: no toca lo que ya está correcto.
export const POST: APIRoute = async () => {
  const auth = await getValidAccessToken();
  if (!auth) return json({ ok: false, error: 'Google Calendar no está conectado.' }, 400);

  // Fecha de Chile (8 oct 2026): con la de UTC, desde las 20:00/21:00 ya era
  // "mañana" y quedaban fuera las sesiones del resto del día.
  const today = todayCL();
  const { data: rows, error } = await supabase
    .from('bookings')
    .select('id, google_event_id, paid_at, debt_voided, status, session_date')
    .not('google_event_id', 'is', null)
    .in('status', ['pending_payment', 'confirmed'])
    .gte('session_date', today);
  if (error) return json({ ok: false, error: error.message }, 500);

  let paid = 0, unpaid = 0, skipped = 0, failed = 0;
  for (const b of rows ?? []) {
    try {
      if (b.paid_at) { await setCalendarEventPaidState(auth.token, auth.calendarId, b.google_event_id, true); paid++; }
      else if (b.debt_voided !== true) { await setCalendarEventPaidState(auth.token, auth.calendarId, b.google_event_id, false); unpaid++; }
      else skipped++;
    } catch { failed++; }
  }
  return json({ ok: true, total: rows?.length ?? 0, paid, unpaid, skipped, failed });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
