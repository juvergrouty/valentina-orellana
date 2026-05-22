import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { createPaymentOrder } from '../../lib/flow';
import { pricingPlans } from '../../data/services';

export const prerender = false;

const SESSION_LABELS: Record<string, string> = {
  'online':            'Sesión Individual Online',
  'presencial':        'Sesión Individual Presencial',
  'pareja-online':     'Sesión de Pareja Online',
  'pareja-presencial': 'Sesión de Pareja Presencial',
};

const VALID_TYPES = Object.keys(SESSION_LABELS);

// ─── POST /api/bookings ───────────────────────────────────────────────────────
// Crea una reserva en BD (status=pending_payment) y devuelve la URL de pago de Flow
export const POST: APIRoute = async ({ request }) => {
  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body inválido.' }, 400);
  }

  const {
    session_type,
    session_date,
    session_time,
    patient_name,
    patient_email,
    patient_phone,
    notes,
  } = body as Record<string, string>;

  // ── Validación ───────────────────────────────────────────────────────────────
  if (!session_type || !session_date || !session_time || !patient_name || !patient_email || !patient_phone) {
    return json({ error: 'Faltan campos obligatorios.' }, 400);
  }

  if (!VALID_TYPES.includes(session_type)) {
    return json({ error: 'Tipo de sesión inválido.' }, 400);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(session_date) || !/^\d{2}:\d{2}$/.test(session_time)) {
    return json({ error: 'Formato de fecha u hora inválido.' }, 400);
  }

  const requested = new Date(`${session_date}T${session_time}:00`);
  if (requested <= new Date()) {
    return json({ error: 'No puedes reservar en una fecha pasada.' }, 400);
  }

  // ── Verificar disponibilidad ─────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('bookings')
    .select('id')
    .eq('session_date', session_date)
    .eq('session_time', session_time)
    .neq('status', 'cancelled')
    .maybeSingle();

  if (existing) {
    return json({ error: 'Ese horario ya fue reservado. Por favor elige otro.' }, 409);
  }

  // ── Obtener precio ───────────────────────────────────────────────────────────
  const plan = pricingPlans.find((p) => p.id === session_type);
  if (!plan) return json({ error: 'Plan no encontrado.' }, 400);

  // ── Crear reserva en Supabase ────────────────────────────────────────────────
  const { data: booking, error: insertError } = await supabase
    .from('bookings')
    .insert({
      session_type,
      session_date,
      session_time,
      patient_name:   patient_name.trim(),
      patient_email:  patient_email.trim().toLowerCase(),
      patient_phone:  patient_phone.trim(),
      notes:          notes?.trim() ?? null,
      status:         'pending_payment',
      payment_method: 'flow',
      amount:         plan.price,
    })
    .select('id')
    .single();

  if (insertError || !booking) {
    console.error('Error insertando reserva:', insertError);
    return json({ error: 'Error al crear la reserva. Intenta nuevamente.' }, 500);
  }

  // ── Crear orden de pago en Flow ──────────────────────────────────────────────
  const siteUrl = import.meta.env.PUBLIC_SITE_URL?.replace(/\/$/, '') ?? 'http://localhost:4321';

  let flowOrder;
  try {
    flowOrder = await createPaymentOrder({
      subject:         `${SESSION_LABELS[session_type]} — Ps. Valentina Orellana`,
      amount:          plan.price,
      email:           patient_email.trim().toLowerCase(),
      orderId:         booking.id,
      urlConfirmation: `${siteUrl}/api/flow/confirm`,
      urlReturn:       `${siteUrl}/confirmacion`,
    });
  } catch (err) {
    console.error('Error creando orden Flow:', err);
    // Eliminar la reserva creada para evitar slots bloqueados sin pago
    await supabase.from('bookings').delete().eq('id', booking.id);
    return json({ error: 'Error al conectar con el sistema de pago. Por favor contáctanos por WhatsApp.' }, 502);
  }

  // Guardar el token de Flow en la reserva (para luego recuperarla desde el webhook/confirmación)
  await supabase
    .from('bookings')
    .update({ mp_preference_id: flowOrder.token })
    .eq('id', booking.id);

  // La URL de pago es: flowOrder.url + '?token=' + flowOrder.token
  return json({
    bookingId:   booking.id,
    checkoutUrl: `${flowOrder.url}?token=${flowOrder.token}`,
  });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
