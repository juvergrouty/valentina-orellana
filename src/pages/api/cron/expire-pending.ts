import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendPendingExpiredEmail } from '../../../lib/email';
import { deleteBookingFromCalendar } from '../../../lib/syncCalendar';

export const prerender = false;

const EXPIRE_AFTER_MS = 3 * 60 * 1000; // 3 minutos sin completar el pago

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Se llama cada pocos minutos (ver .github/workflows/frequent-cron.yml — Vercel Hobby
// solo permite cron diario, así que la frecuencia real la da GitHub Actions, gratis).
// Libera reservas `pending_payment` que llevan más de 3 min sin pagarse: avisa al
// paciente por correo y elimina la reserva (y su evento de calendario si llegó a crearse)
// para que el horario quede disponible de inmediato.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }

  const cutoff = new Date(Date.now() - EXPIRE_AFTER_MS).toISOString();

  const { data: expired } = await supabase
    .from('bookings')
    .select('id, patient_name, patient_email, session_date, session_time, google_event_id')
    .eq('status', 'pending_payment')
    .neq('session_date', '2099-12-31') // no tocar cobros manuales sin fecha
    .lt('created_at', cutoff);

  let released = 0, notified = 0;

  for (const b of expired ?? []) {
    if (b.google_event_id) {
      await deleteBookingFromCalendar(b.id).catch((e) => console.error('[expire-pending] gcal:', e));
    }
    if (b.patient_email) {
      const res = await sendPendingExpiredEmail({
        patient_name:  b.patient_name,
        patient_email: b.patient_email,
        session_date:  b.session_date,
        session_time:  (b.session_time ?? '00:00').slice(0, 5),
      });
      if (res.sent) notified++;
    }
    const { error } = await supabase.from('bookings').delete().eq('id', b.id);
    if (!error) released++;
  }

  return json({ ok: true, released, notified });
};
