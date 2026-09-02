import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendReminderEmail, emailTypeEnabled } from '../../../lib/email';

export const prerender = false;

const MARKER = 'RecordatorioEnviado';
const CHILE_OFFSET_MS = 4 * 60 * 60 * 1000; // Chile UTC-4/-3; usamos -4 (conservador)

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Se llama cada 5 min vía GitHub Actions (.github/workflows/frequent-cron.yml —
// Vercel Hobby solo permite cron diario, así que la frecuencia real la da GH Actions,
// gratis en repos públicos). Envía el recordatorio por correo a los pacientes cuya
// sesión empieza dentro de la ventana configurada (reminder_window_hours, default 24h).
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }

  if (!(await emailTypeEnabled('reminder'))) {
    return json({ ok: true, skipped: 'recordatorios desactivados en Configuración' });
  }

  // Ventana de antelación en horas antes de la sesión (por defecto 24h antes).
  const { data: winRow } = await supabase.from('settings').select('value').eq('key', 'reminder_window_hours').maybeSingle();
  const windowHours = parseInt(winRow?.value ?? '24') || 24;

  const now      = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const today    = new Date(now).toISOString().slice(0, 10);
  const tomorrow = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Sesiones confirmadas de hoy/mañana, con correo, aún sin recordatorio enviado.
  // reminder_email_enabled puede no existir aún (columna nueva) — si falla, reintenta sin ella.
  let bookings: any[] | null = null;
  {
    const q = await supabase
      .from('bookings')
      .select('id, patient_name, patient_email, patient_phone, session_type, session_date, session_time, amount, payment_method, service_id, notes, reminder_email_enabled')
      .eq('status', 'confirmed')
      .gte('session_date', today)
      .lte('session_date', tomorrow)
      .not('patient_email', 'is', null);
    if (q.error?.code === '42703') {
      const retry = await supabase
        .from('bookings')
        .select('id, patient_name, patient_email, patient_phone, session_type, session_date, session_time, amount, payment_method, service_id, notes')
        .eq('status', 'confirmed')
        .gte('session_date', today)
        .lte('session_date', tomorrow)
        .not('patient_email', 'is', null);
      bookings = retry.data;
    } else {
      bookings = q.data;
    }
  }

  let sent = 0, failed = 0, skipped = 0;

  for (const b of bookings ?? []) {
    if (!b.patient_email) { skipped++; continue; }
    if (b.session_date === '2099-12-31') { skipped++; continue; }
    if (b.reminder_email_enabled === false) { skipped++; continue; }
    if ((b.notes ?? '').includes(MARKER)) { skipped++; continue; }

    // ¿La sesión empieza dentro de la ventana (entre ahora y ahora+ventana)?
    const time = (b.session_time ?? '00:00').slice(0, 5);
    const startUtc = Date.parse(`${b.session_date}T${time}:00Z`) + CHILE_OFFSET_MS;
    if (isNaN(startUtc) || startUtc <= now || startUtc > now + windowMs) { skipped++; continue; }

    let serviceName: string | undefined;
    if (b.service_id) {
      const { data: svc } = await supabase.from('services_catalog').select('name').eq('id', b.service_id).maybeSingle();
      serviceName = svc?.name;
    }

    const res = await sendReminderEmail({
      patient_name:   b.patient_name,
      patient_email:  b.patient_email,
      patient_phone:  b.patient_phone ?? '',
      session_type:   b.session_type,
      session_date:   b.session_date,
      session_time:   time,
      amount:         b.amount ?? 0,
      payment_method: b.payment_method ?? 'manual',
      service_name:   serviceName,
    });

    if (res.sent) {
      sent++;
      const nota = `${b.notes ? b.notes + '\n' : ''}${MARKER} ${today}`;
      await supabase.from('bookings').update({ notes: nota }).eq('id', b.id);
    } else {
      failed++;
    }
  }

  return json({ ok: true, sent, failed, skipped, windowHours });
};
