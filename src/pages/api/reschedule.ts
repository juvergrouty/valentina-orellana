import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { sendConfirmationToClient, sendNotificationToAdmin } from '../../lib/email';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, string>;
  try { body = await request.json(); }
  catch { return json({ error: 'Body inválido.' }, 400); }

  const { bookingId, email, session_date, session_time } = body;

  if (!bookingId || !email || !session_date || !session_time) {
    return json({ error: 'Faltan campos obligatorios.' }, 400);
  }

  // Verificar que la reserva existe y el email coincide
  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .eq('patient_email', email.trim().toLowerCase())
    .eq('status', 'confirmed')
    .single();

  if (!booking) {
    return json({ error: 'Reserva no encontrada o no tienes permiso para modificarla.' }, 404);
  }

  // Verificar que el nuevo horario esté disponible
  const { data: conflict } = await supabase
    .from('bookings')
    .select('id')
    .eq('session_date', session_date)
    .eq('session_time', session_time)
    .neq('status', 'cancelled')
    .neq('id', bookingId)
    .maybeSingle();

  if (conflict) {
    return json({ error: 'Ese horario ya no está disponible. Por favor elige otro.' }, 409);
  }

  // Verificar que la fecha no es bloqueada
  const { data: blocked } = await supabase
    .from('blocked_dates')
    .select('id')
    .eq('date', session_date)
    .maybeSingle();

  if (blocked) {
    return json({ error: 'Esa fecha no está disponible.' }, 409);
  }

  // Verificar con al menos 24h de anticipación
  const newDateTime = new Date(`${session_date}T${session_time}:00`);
  if (newDateTime.getTime() - Date.now() < 24 * 60 * 60 * 1000) {
    return json({ error: 'El reagendamiento debe realizarse con al menos 24 horas de anticipación.' }, 400);
  }

  // Actualizar la reserva
  await supabase
    .from('bookings')
    .update({ session_date, session_time })
    .eq('id', bookingId);

  // Leer settings para email admin
  const { data: settingsRows } = await supabase.from('settings').select('key, value');
  const cfg: Record<string, string> = {};
  (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { cfg[key] = value; });
  const adminEmail = cfg['notification_email'] ?? 'juver@grouty.cl';

  const emailData = {
    patient_name:   booking.patient_name,
    patient_email:  booking.patient_email,
    patient_phone:  booking.patient_phone,
    session_type:   booking.session_type,
    session_date,
    session_time,
    amount:         booking.amount,
    payment_method: booking.payment_method,
  };

  // Notificar por email (sin bloquear)
  Promise.all([
    sendConfirmationToClient(emailData).catch(console.error),
    sendNotificationToAdmin(emailData, adminEmail).catch(console.error),
  ]);

  return json({ success: true, session_date, session_time });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
