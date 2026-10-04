import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { syncBookingToCalendar, getValidAccessToken } from '../../../lib/syncCalendar';
import { agregarMeetAEvento } from '../../../lib/googleCalendar';
import { cambiarNotas } from '../../../lib/apigateway';
import { logError } from '../../../lib/logger';

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

  const result = await syncBookingToCalendar(booking, booking.status === 'pending_payment' ? { unpaid: true, invite: false } : {});
  if (!result.success) return json({ ok: false, error: result.error ?? 'No se pudo generar el link.' }, 502);

  // Si ya existía (idempotente) pero notes no traía "Meet:" por algún motivo
  // raro, se re-lee para no devolver un link vacío.
  let meetLink = result.meetLink ?? null;
  if (!meetLink) {
    const { data: fresh } = await supabase.from('bookings').select('notes').eq('id', id).maybeSingle();
    meetLink = [...(fresh?.notes ?? '').matchAll(/(?:^|\n)Meet: (https:\/\/meet\.google\.com\/\S+)/g)].at(-1)?.[1] ?? null;
  }
  // El evento existe pero sin videollamada (ej. la sesión era presencial y se
  // cambió a online): se le agrega el Meet. Antes el panel decía "No se pudo
  // generar el link de Meet" para siempre.
  if (!meetLink) {
    try {
      const { data: fila } = await supabase.from('bookings').select('google_event_id').eq('id', id).maybeSingle();
      const auth = await getValidAccessToken();
      if (fila?.google_event_id && auth) {
        meetLink = await agregarMeetAEvento(auth.token, auth.calendarId, fila.google_event_id);
        if (meetLink) {
          const link = meetLink;
          await cambiarNotas(id, (n) => {
            const sinMeet = n.split('\n').filter(l => !/^\s*Meet:/.test(l)).join('\n').trim();
            return `${sinMeet ? sinMeet + '\n' : ''}Meet: ${link}`;
          });
        }
      }
    } catch (e) {
      await logError('calendar/meet', 'No se pudo agregar el Meet a un evento existente', { bookingId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, meetLink });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
