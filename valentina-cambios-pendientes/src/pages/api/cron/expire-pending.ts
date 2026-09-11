import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendPendingExpiredEmail, sendExpiredBookingAdminAlert } from '../../../lib/email';
import { deleteBookingFromCalendar } from '../../../lib/syncCalendar';

export const prerender = false;

// Antes eran 3 minutos — absurdamente corto: los pagos por transferencia (Khipu)
// dentro de Flow pueden tardar bastante más que eso en confirmarse, y una reserva
// se liberaba antes de que el paciente alcanzara a pagar. Se sube a 45 minutos.
const EXPIRE_AFTER_MS = 45 * 60 * 1000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Se llama cada pocos minutos (ver .github/workflows/frequent-cron.yml — Vercel Hobby
// solo permite cron diario, así que la frecuencia real la da GitHub Actions, gratis).
// Libera reservas `pending_payment` que llevan más de EXPIRE_AFTER_MS sin pagarse:
// avisa al paciente (y a la admin) por correo y elimina la reserva (y su evento de
// calendario si llegó a crearse) para que el horario quede disponible de inmediato.
//
// IMPORTANTE: las reservas creadas por la propia admin (created_by_admin=true, p.ej.
// desde el panel al agendar a un paciente) NUNCA se liberan automáticamente aquí,
// sin importar cuánto tiempo lleven pendientes de pago — instrucción explícita:
// esta condición de expiración no aplica cuando es ella quien agenda.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }

  const cutoff = new Date(Date.now() - EXPIRE_AFTER_MS).toISOString();

  let { data: expired, error: expErr } = await supabase
    .from('bookings')
    .select('id, patient_name, patient_email, session_date, session_time, google_event_id, created_by_admin')
    .eq('status', 'pending_payment')
    .neq('session_date', '2099-12-31') // no tocar cobros manuales sin fecha
    .lt('created_at', cutoff);

  if (expErr?.code === '42703') {
    // La columna created_by_admin todavía no existe en la base de datos (falta
    // aplicar la migración) — se degrada al comportamiento anterior, sin distinguir
    // reservas creadas por la admin. Ver README / instrucciones de despliegue.
    const retry = await supabase
      .from('bookings')
      .select('id, patient_name, patient_email, session_date, session_time, google_event_id')
      .eq('status', 'pending_payment')
      .neq('session_date', '2099-12-31')
      .lt('created_at', cutoff);
    expired = retry.data;
  }

  const toExpire = (expired ?? []).filter((b: { created_by_admin?: boolean }) => !b.created_by_admin);

  const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const adminEmail = notifRow?.value ?? 'juver@grouty.cl';

  const siteUrl = (import.meta.env.PUBLIC_SITE_URL ?? 'https://www.valentinaorellana.cl').replace(/\/$/, '');

  let released = 0, notified = 0;

  for (const b of toExpire) {
    if (b.google_event_id) {
      await deleteBookingFromCalendar(b.id).catch((e) => console.error('[expire-pending] gcal:', e));
    }

    // En vez de borrar la reserva, se marca como 'expired' con un token de
    // recuperación: el horario queda libre para otros (el índice único y los
    // chequeos de conflicto ya no cuentan 'expired' como ocupado), pero los
    // datos del paciente se conservan por si quiere pagar y recuperar la misma
    // hora dentro de las próximas 4 horas antes de la sesión (ver /recuperar).
    // Se degrada a borrar la fila (comportamiento anterior) si la base de datos
    // todavía no tiene la migración de 'expired'/recovery_token aplicada.
    const token = crypto.randomUUID();
    const { error: markErr } = await supabase
      .from('bookings')
      .update({ status: 'expired', recovery_token: token })
      .eq('id', b.id);

    let recoverUrl: string | undefined;
    if (!markErr) {
      recoverUrl = `${siteUrl}/recuperar?token=${token}`;
    } else {
      await supabase.from('bookings').delete().eq('id', b.id);
    }

    if (b.patient_email) {
      const res = await sendPendingExpiredEmail({
        patient_name:  b.patient_name,
        patient_email: b.patient_email,
        session_date:  b.session_date,
        session_time:  (b.session_time ?? '00:00').slice(0, 5),
        recoverUrl,
      });
      if (res.sent) notified++;
    }
    try {
      await sendExpiredBookingAdminAlert({
        patient_name:  b.patient_name,
        patient_email: b.patient_email ?? '',
        session_date:  b.session_date,
        session_time:  (b.session_time ?? '00:00').slice(0, 5),
      }, adminEmail);
    } catch (e) { console.error('[expire-pending] admin alert:', e); }

    released++;
  }

  return json({ ok: true, released, notified, exemptedAdminCreated: (expired ?? []).length - toExpire.length });
};
