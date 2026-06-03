import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendConfirmationToClient, sendNotificationToAdmin } from '../../../lib/email';

export const prerender = false;

// POST /api/bookings/confirm-manual
// Confirma una reserva existente (ya creada) como "pago en consulta"
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ error: 'Body inválido.' }, 400); }

  const bookingId = body.bookingId as string;
  if (!bookingId) return json({ error: 'Falta bookingId.' }, 400);

  // Verificar que la reserva existe y está pendiente de pago
  const { data: booking, error: fetchErr } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .eq('status', 'pending_payment')
    .single();

  if (fetchErr || !booking) {
    return json({ error: 'Reserva no encontrada o ya procesada.' }, 404);
  }

  // Verificar settings: pago en consulta habilitado
  const { data: settingsRows } = await supabase.from('settings').select('key, value');
  const settings: Record<string, string> = {};
  (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => {
    settings[key] = value;
  });
  if (settings['manual_payment_enabled'] === 'false') {
    return json({ error: 'El pago en consulta no está habilitado.' }, 403);
  }
  const notificationEmail = settings['notification_email'] ?? 'juver@grouty.cl';

  // Confirmar la reserva
  const { error: updateErr } = await supabase
    .from('bookings')
    .update({ status: 'confirmed', payment_method: 'manual' })
    .eq('id', bookingId);

  if (updateErr) {
    return json({ error: 'Error al confirmar la reserva.' }, 500);
  }

  // Enviar emails en segundo plano
  const emailData = {
    patient_name:   booking.patient_name,
    patient_email:  booking.patient_email,
    patient_phone:  booking.patient_phone,
    session_type:   booking.session_type,
    session_date:   booking.session_date,
    session_time:   booking.session_time,
    amount:         booking.amount,
    payment_method: 'manual',
  };
  Promise.all([
    sendConfirmationToClient(emailData).catch(console.error),
    sendNotificationToAdmin(emailData, notificationEmail).catch(console.error),
  ]);

  return json({ confirmed: true });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
