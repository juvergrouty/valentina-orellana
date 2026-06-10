import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { createPaymentOrder } from '../../lib/flow';
import { sendConfirmationToClient, sendNotificationToAdmin } from '../../lib/email';
import { logInfo, logWarn, logError } from '../../lib/logger';

export const prerender = false;

// ─── POST /api/bookings ───────────────────────────────────────────────────────
// Crea una reserva en BD (status=pending_payment) y devuelve la URL de pago de Flow
export const POST: APIRoute = async ({ request }) => {
  try {
    return await handleBooking(request);
  } catch (fatal) {
    const msg = fatal instanceof Error ? fatal.message : String(fatal);
    console.error('[bookings] Error fatal:', msg);
    return json({ error: 'Error interno del servidor.', detail: msg }, 500);
  }
};

async function handleBooking(request: Request) {
  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body inválido.' }, 400);
  }

  const {
    service_id,
    modality_choice,
    session_date,
    session_time,
    patient_name,
    patient_email,
    patient_phone,
    notes,
  } = body as Record<string, string>;

  // ── Validación ───────────────────────────────────────────────────────────────
  if (!service_id || !modality_choice || !session_date || !session_time || !patient_name || !patient_email || !patient_phone) {
    return json({ error: 'Faltan campos obligatorios.' }, 400);
  }

  if (!['online', 'presencial'].includes(modality_choice)) {
    return json({ error: 'Modalidad inválida.' }, 400);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(session_date) || !/^\d{2}:\d{2}$/.test(session_time)) {
    return json({ error: 'Formato de fecha u hora inválido.' }, 400);
  }

  const requested = new Date(`${session_date}T${session_time}:00`);
  if (requested <= new Date()) {
    return json({ error: 'No puedes reservar en una fecha pasada.' }, 400);
  }

  // ── Limpiar reservas pending_payment expiradas (>30 min) ─────────────────────
  const expiry = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await supabase.from('bookings').delete()
    .eq('status', 'pending_payment')
    .lt('created_at', expiry);

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

  // ── Cargar settings ──────────────────────────────────────────────────────────
  const { data: settingsRows } = await supabase.from('settings').select('key, value');
  const settings: Record<string, string> = {};
  (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { settings[key] = value; });

  // ── Buscar servicio por ID ────────────────────────────────────────────────────
  const { data: svc, error: svcErr } = await supabase
    .from('services_catalog')
    .select('*')
    .eq('id', service_id)
    .eq('visible', true)
    .single();

  if (svcErr || !svc) {
    await logError('bookings', 'Servicio no encontrado', { service_id, error: svcErr?.message });
    return json({ error: 'Servicio no encontrado.' }, 400);
  }

  // Derivar session_type para la tabla bookings (compatibilidad admin)
  const session_type = svc.type === 'pareja'
    ? `pareja-${modality_choice}`
    : modality_choice;

  // Precio y duración según modalidad elegida
  let finalPrice: number;
  let durationMin: number;

  if (svc.modality === 'ambos') {
    finalPrice  = modality_choice === 'online'
      ? (svc.price_online     ?? svc.price)
      : (svc.price_presencial ?? svc.price);
    durationMin = modality_choice === 'online'
      ? (svc.duration_min_online     ?? svc.duration_min ?? 50)
      : (svc.duration_min_presencial ?? svc.duration_min ?? 50);
  } else {
    finalPrice  = svc.price;
    durationMin = svc.duration_min ?? 50;
  }

  await logInfo('bookings', 'Servicio y precio', {
    service_id, name: svc.name, modality_choice, session_type, finalPrice, durationMin,
  });

  // ── Crear reserva en Supabase ────────────────────────────────────────────────
  const bookingPayload: Record<string, unknown> = {
    session_type,
    service_id,
    session_date,
    session_time,
    patient_name:   patient_name.trim(),
    patient_email:  patient_email.trim().toLowerCase(),
    patient_phone:  patient_phone.trim(),
    notes:          notes?.trim() ?? null,
    status:         'pending_payment',
    payment_method: 'flow',
    amount:         finalPrice,
    duration_min:   durationMin,
  };

  let booking: { id: string } | null = null;

  const tryInsert = async (payload: Record<string, unknown>) => {
    const { data, error } = await supabase.from('bookings').insert(payload).select('id').single();
    return { data, error };
  };

  let { data: bookingData, error: insertError } = await tryInsert(bookingPayload);

  // Si falla por columna inexistente, reintentar quitando columnas opcionales
  if (insertError?.code === '42703') {
    await logWarn('bookings', 'Columna desconocida, reintentando sin columnas opcionales', { error: insertError.message });
    const { duration_min, ...withoutDur } = bookingPayload;
    let retry = await tryInsert(withoutDur);
    if (retry.error?.code === '42703') {
      // service_id column also missing
      const { service_id: _sid, ...withoutBoth } = withoutDur as Record<string, unknown>;
      retry = await tryInsert(withoutBoth);
    }
    bookingData = retry.data;
    insertError = retry.error;
  }

  if (insertError || !bookingData) {
    await logError('bookings', 'Error insertando reserva', { error: insertError?.message, code: insertError?.code, session_type, session_date, session_time });
    console.error('Error insertando reserva:', insertError);
    return json({ error: 'Error al crear la reserva. Intenta nuevamente.' }, 500);
  }
  booking = bookingData;

  // ── Leer config desde settings ───────────────────────────────────────────────
  const notificationEmail  = settings['notification_email'] ?? 'juver@grouty.cl';
  const manualEnabled      = settings['manual_payment_enabled'] !== 'false';
  const flowEnabled        = settings['flow_enabled'] !== 'false';
  const flowEnvSetting     = settings['flow_env']; // 'sandbox' | 'production' | undefined
  const flowBaseUrl        = flowEnvSetting === 'production'
    ? 'https://www.flow.cl/api'
    : flowEnvSetting === 'sandbox'
    ? 'https://sandbox.flow.cl/api'
    : undefined; // usa el valor del env var FLOW_ENV

  const emailData = {
    patient_name:   patient_name.trim(),
    patient_email:  patient_email.trim().toLowerCase(),
    patient_phone:  patient_phone.trim(),
    session_type,
    session_date,
    session_time,
    amount:         finalPrice,
    payment_method: 'flow',
  };

  // ── Pago en consulta (manual) ─────────────────────────────────────────────────
  const isManual = (body as Record<string, string>).payment_method === 'manual';

  if (isManual && manualEnabled) {
    // Confirmar directamente sin pasar por Flow
    await supabase
      .from('bookings')
      .update({ status: 'confirmed', payment_method: 'manual' })
      .eq('id', booking.id);

    // Enviar emails (sin bloquear la respuesta)
    const ed = { ...emailData, payment_method: 'manual' };
    Promise.all([
      sendConfirmationToClient(ed).catch(console.error),
      sendNotificationToAdmin(ed, notificationEmail).catch(console.error),
    ]);

    return json({ bookingId: booking.id, confirmed: true });
  }

  // ── Flow deshabilitado desde admin ────────────────────────────────────────────
  if (!flowEnabled) {
    await supabase.from('bookings').delete().eq('id', booking.id);
    return json({ error: 'El pago online está temporalmente deshabilitado. Por favor coordina tu sesión por WhatsApp.' }, 503);
  }

  // ── Validar precio antes de llamar a Flow ────────────────────────────────────
  if (!finalPrice || isNaN(finalPrice) || finalPrice < 100) {
    await logError('bookings', 'Precio inválido antes de Flow', { finalPrice, catalogPrice, session_type });
    await supabase.from('bookings').delete().eq('id', booking.id);
    return json({ error: `Precio inválido (${finalPrice}). Actualiza el precio del servicio en el admin.` }, 400);
  }

  // ── Crear orden de pago en Flow ──────────────────────────────────────────────
  const siteUrl = import.meta.env.PUBLIC_SITE_URL?.replace(/\/$/, '') ?? 'http://localhost:4321';

  await logInfo('bookings', 'Creando orden Flow', { bookingId: booking.id, amount: finalPrice, email: patient_email.trim().toLowerCase() });

  let flowOrder;
  try {
    flowOrder = await createPaymentOrder({
      subject:         `${svc.name} — Ps. Valentina Orellana`,
      amount:          finalPrice,
      email:           patient_email.trim().toLowerCase(),
      orderId:         booking.id,
      urlConfirmation: `${siteUrl}/api/flow/confirm`,
      urlReturn:       `${siteUrl}/api/flow/return`,
      baseUrl:         flowBaseUrl,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isEmailError = errMsg.includes('1620') || errMsg.toLowerCase().includes('useremail') || errMsg.toLowerCase().includes('email');

    await logError('bookings/flow', 'Error creando orden Flow', {
      bookingId: booking?.id,
      amount: finalPrice,
      session_type,
      isEmailError,
      error: errMsg,
    });

    // Siempre eliminar la reserva para no dejar slots bloqueados
    if (booking?.id) {
      const { error: delErr } = await supabase.from('bookings').delete().eq('id', booking.id);
      if (delErr) await logError('bookings', 'Error eliminando reserva fallida', { bookingId: booking.id, error: delErr.message });
    }

    if (isEmailError) {
      return json({
        error: 'El correo electrónico no es válido para el sistema de pago. Por favor usa un correo real.',
        detail: errMsg,
        errorType: 'invalid_email',
      }, 400);
    }

    return json({ error: 'Error al conectar con el sistema de pago.', detail: errMsg, errorType: 'flow_error' }, 502);
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
