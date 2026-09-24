import { supabase } from './supabase';
import { sendPendingExpiredEmail, sendExpiredBookingAdminAlert, ADMIN_EMAIL_FALLBACK } from './email';
import { deleteBookingFromCalendar } from './syncCalendar';
import { logError } from './logger';

const EXPIRE_AFTER_MS = 30 * 60 * 1000;

// Único lugar que libera reservas `pending_payment` abandonadas (>30 min sin pagar).
// Antes había 3 versiones distintas: dos silenciosas (en availability.ts y en
// bookings.ts, que corren en cada carga del calendario y en cada intento de
// reserva — es decir, todo el tiempo) que borraban la fila sin avisarle a nadie,
// y una "amable" (este cron) que manda el correo con el link de recuperación
// (/recuperar) — pero como las silenciosas corren muchísimo más seguido, casi
// siempre borraban la fila antes de que esta alcanzara a avisarle al paciente.
// Ahora las 3 llaman a esta misma función: cualquiera que la encuentre primero
// hace el aviso completo.
export async function expireStaleBookings(): Promise<{ claimed: number }> {
  const cutoff = new Date(Date.now() - EXPIRE_AFTER_MS).toISOString();

  // IMPORTANTE: nunca tocar reservas creadas por la propia admin (created_by_admin=true)
  // — esas solo se liberan si ella misma las cancela.
  let stale: any[] | null = null;
  {
    const q = await supabase
      .from('bookings')
      .select('id, patient_name, patient_email, session_date, session_time, google_event_id, created_by_admin')
      .eq('status', 'pending_payment')
      .neq('session_date', '2099-12-31') // no tocar cobros manuales sin fecha
      .lt('created_at', cutoff);
    if (q.error?.code === '42703') {
      const retry = await supabase
        .from('bookings')
        .select('id, patient_name, patient_email, session_date, session_time, google_event_id')
        .eq('status', 'pending_payment')
        .neq('session_date', '2099-12-31')
        .lt('created_at', cutoff);
      stale = retry.data;
    } else {
      stale = q.data;
    }
  }

  const candidates = (stale ?? []).filter((b: { created_by_admin?: boolean }) => !b.created_by_admin);
  if (!candidates.length) return { claimed: 0 };

  const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const adminEmail = notifRow?.value || ADMIN_EMAIL_FALLBACK;
  const siteUrl = (import.meta.env.PUBLIC_SITE_URL ?? 'https://www.valentinaorellana.cl').replace(/\/$/, '');

  let claimed = 0;

  for (const b of candidates) {
    const token = crypto.randomUUID();
    // "Reclama" la fila de forma atómica con el propio WHERE status='pending_payment':
    // si otra de las 3 llamadas (u otra ejecución concurrente de esta misma) ya la
    // procesó, este update no afecta ninguna fila y no se manda un segundo aviso.
    const { data: updated, error: updErr } = await supabase
      .from('bookings')
      .update({ status: 'expired', recovery_token: token })
      .eq('id', b.id)
      .eq('status', 'pending_payment')
      .select('id');

    if (updErr?.code === '42703') {
      // Migración de 'expired'/recovery_token no aplicada aún — se degrada al
      // comportamiento anterior (borrar sin aviso), único caso sin recuperación posible.
      await supabase.from('bookings').delete().eq('id', b.id).eq('status', 'pending_payment');
      continue;
    }
    if (updErr || !updated?.length) continue; // ya la había tomado otra llamada

    claimed++;

    if (b.google_event_id) {
      try { await deleteBookingFromCalendar(b.id); }
      catch (e) { await logError('bookings/expirar', 'No se pudo borrar el evento de Google Calendar', { bookingId: b.id, error: e instanceof Error ? e.message : String(e) }); }
    }

    if (b.patient_email) {
      try {
        await sendPendingExpiredEmail({
          patient_name:  b.patient_name,
          patient_email: b.patient_email,
          session_date:  b.session_date,
          session_time:  (b.session_time ?? '00:00').slice(0, 5),
          recoverUrl:    `${siteUrl}/recuperar?token=${token}`,
        });
      } catch (e) { await logError('bookings/expirar', 'No se pudo avisar al paciente que su hora se liberó', { bookingId: b.id, error: e instanceof Error ? e.message : String(e) }); }
    }

    try {
      await sendExpiredBookingAdminAlert({
        patient_name:  b.patient_name,
        patient_email: b.patient_email ?? '',
        session_date:  b.session_date,
        session_time:  (b.session_time ?? '00:00').slice(0, 5),
      }, adminEmail);
    } catch (e) { await logError('bookings/expirar', 'Falló el aviso a Valentina de hora liberada', { bookingId: b.id, error: e instanceof Error ? e.message : String(e) }); }
  }

  return { claimed };
}
