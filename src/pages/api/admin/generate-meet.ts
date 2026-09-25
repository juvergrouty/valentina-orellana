import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { syncBookingToCalendar } from '../../../lib/syncCalendar';

export const prerender = false;

// Genera el evento de Google Calendar / link de Meet al instante, sin esperar
// a que el paciente pague. syncBookingToCalendar ya es idempotente (si la
// reserva ya tiene google_event_id, no crea uno nuevo), así que da lo mismo
// si esto se llama antes o después del pago — siempre queda el MISMO link.
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const id = body?.id;
  if (!id) return json({ ok: false, error: 'Falta id.' }, 400);

  const { data: booking } = await supabase.from('bookings').select('*').eq('id', id).single();
  if (!booking) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);
  if (!booking.session_type?.includes('online')) {
    return json({ ok: false, error: 'No es una sesión online.' }, 400);
  }

  const result = await syncBookingToCalendar(booking);
  if (!result.success) return json({ ok: false, error: result.error ?? 'No se pudo generar el link.' }, 502);

  // Si ya existía (idempotente) pero notes no traía "Meet:" por algún motivo
  // raro, se re-lee para no devolver un link vacío.
  let meetLink = result.meetLink ?? null;
  if (!meetLink) {
    const { data: fresh } = await supabase.from('bookings').select('notes').eq('id', id).maybeSingle();
    meetLink = fresh?.notes?.match(/Meet:\s*(https:\/\/\S+)/)?.[1] ?? null;
  }
  return json({ ok: true, meetLink });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
