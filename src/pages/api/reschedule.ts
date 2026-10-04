import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { sendSessionUpdatedEmail, sendRescheduleAdminAlert, ADMIN_EMAIL_FALLBACK } from '../../lib/email';
import { rescheduleBookingInCalendar } from '../../lib/syncCalendar';
import { hoursUntilSessionCL } from '../../lib/dateUtils';
import { quitarLineasNotas } from '../../lib/apigateway';
import { claveReagendarValida, REAGENDAR_TEXTO } from '../../lib/rescheduleLink';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, string>;
  try { body = await request.json(); }
  catch { return json({ error: 'Body inválido.' }, 400); }

  const { bookingId, email, session_date, session_time, k } = body;
  // Con el link personal del correo (clave firmada) no hace falta el correo.
  const conClave = claveReagendarValida(bookingId, k);

  if (!bookingId || (!email && !conClave) || !session_date || !session_time) {
    return json({ error: 'Faltan campos obligatorios.' }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(session_date) || !/^\d{2}:\d{2}$/.test(session_time.slice(0, 5))) {
    return json({ error: 'Fecha u hora inválida.' }, 400);
  }

  // Verificar que la reserva existe y el email coincide
  let bq = supabase.from('bookings').select('*').eq('id', bookingId).eq('status', 'confirmed');
  if (!conClave) bq = bq.eq('patient_email', String(email).trim().toLowerCase());
  const { data: booking } = await bq.single();

  if (!booking) {
    return json({ error: 'Reserva no encontrada o no tienes permiso para modificarla.' }, 404);
  }

  // Política: la paciente puede reagendar sola solo hasta 24 horas antes de su
  // sesión ACTUAL (antes solo se revisaba la hora nueva, así que se podía mover
  // una sesión que empezaba en 1 hora). Valentina reagenda siempre desde el panel.
  if (hoursUntilSessionCL(booking.session_date, booking.session_time) < 24) {
    return json({ error: `Este enlace caducó. ${REAGENDAR_TEXTO} Escríbeme por WhatsApp y lo vemos.` }, 400);
  }

  // La hora nueva tiene que estar disponible para el servicio de esta sesión
  // (mismo cálculo que ve la paciente en la agenda: horario del servicio,
  // bloqueos, descanso entre sesiones y reservas existentes).
  try {
    const q = new URLSearchParams({ date: session_date });
    if (booking.service_id) q.set('service_id', booking.service_id);
    if (booking.duration_min) q.set('duration', String(booking.duration_min));
    const av = await fetch(new URL(`/api/availability?${q}`, request.url), { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    if (!Array.isArray(av.slots) || !av.slots.includes(session_time.slice(0, 5))) {
      return json({ error: 'Ese horario no está disponible. Por favor elige otro.' }, 409);
    }
  } catch {
    return json({ error: 'No se pudo comprobar la disponibilidad. Intenta de nuevo.' }, 503);
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

  // Verificar con al menos 24h de anticipación (en hora de Chile — el parseo
  // naive anterior se interpretaba en UTC, el huso del servidor, y desfasaba
  // el chequeo en 3-4 horas).
  if (hoursUntilSessionCL(session_date, session_time) < 24) {
    return json({ error: 'El reagendamiento debe realizarse con al menos 24 horas de anticipación.' }, 400);
  }

  // Actualizar la reserva. Si no se guarda, no se avisa a nadie (antes decía
  // "¡Sesión reagendada!" y mandaba los correos aunque el cambio fallara).
  const { error: updErr } = await supabase
    .from('bookings')
    .update({ session_date, session_time })
    .eq('id', bookingId);
  if (updErr) {
    return json({ error: updErr.code === '23505' ? 'Ese horario ya no está disponible. Por favor elige otro.' : 'No se pudo guardar el cambio. Intenta de nuevo.' }, updErr.code === '23505' ? 409 : 500);
  }
  // Nueva fecha: se borran las marcas de recordatorio para que llegue uno nuevo.
  await quitarLineasNotas(bookingId, ['RecordatorioEnviado', 'RecordatorioWhatsAppEnviado']);

  // Mover el evento en Google Calendar (el de Valentina y el del paciente, con
  // el mismo Meet si es online) — antes esto solo se actualizaba en la base de
  // datos, y el evento real de calendario se quedaba con la fecha vieja.
  try { await rescheduleBookingInCalendar(bookingId, session_date, session_time, booking.duration_min ?? undefined); }
  catch (e) { console.error('[reschedule] gcal:', e); }

  // Leer settings para email admin
  const { data: settingsRows } = await supabase.from('settings').select('key, value');
  const cfg: Record<string, string> = {};
  (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { cfg[key] = value; });
  const adminEmail = cfg['notification_email'] || ADMIN_EMAIL_FALLBACK;

  // Notificar por email (sin bloquear). Al paciente: su sesión ya con la hora
  // nueva. A Valentina: aviso de que fue un REAGENDAMIENTO, no una reserva
  // nueva — antes esto reusaba sendNotificationToAdmin, que decía "Nueva
  // reserva confirmada" y era indistinguible de una reserva real nueva.
  // AWAIT: en una función serverless, sin esperar, los correos pueden no salir.
  await Promise.all([
    sendSessionUpdatedEmail({
      patient_name:  booking.patient_name,
      patient_email: booking.patient_email,
      reason:        'Tu sesión fue reagendada',
      session_type:  booking.session_type,
      session_date,
      session_time,
      amount:        booking.amount,
    }).catch(console.error),
    sendRescheduleAdminAlert({
      patient_name:  booking.patient_name,
      patient_email: booking.patient_email,
      old_date:      booking.session_date,
      old_time:      booking.session_time,
      new_date:      session_date,
      new_time:      session_time,
    }, adminEmail).catch(console.error),
  ]);

  return json({ success: true, session_date, session_time });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
