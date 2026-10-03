import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { syncBookingToCalendar } from '../../../lib/syncCalendar';

export const prerender = false;

// Crea el evento de Google Calendar de una reserva que sigue sin pagar
// (pending_payment) y todavía no lo tiene — por ejemplo las agendadas con link
// de pago antes de que ese camino creara el evento. Va SIN invitación al
// paciente. Es idempotente: syncBookingToCalendar no crea otro si la reserva ya
// tiene google_event_id. Si la reserva expira sin pago, expireBooking lo borra.
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const id = body?.id;
  if (!id) return json({ ok: false, error: 'Falta id.' }, 400);

  const { data: booking } = await supabase.from('bookings').select('*').eq('id', id).single();
  if (!booking) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);
  if (booking.status !== 'pending_payment' || booking.session_date === '2099-12-31') {
    return json({ ok: true, skipped: true });
  }

  const result = await syncBookingToCalendar(booking, { invite: false });
  if (!result.success) return json({ ok: false, error: result.error ?? 'No se pudo crear el evento.' }, 502);
  return json({ ok: true });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
