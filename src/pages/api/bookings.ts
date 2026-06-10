import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { createPaymentOrder } from '../../lib/flow';
import { pricingPlans } from '../../data/services';
import { sendConfirmationToClient, sendNotificationToAdmin } from '../../lib/email';

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

  // ── Cargar settings primero ──────────────────────────────────────────────────
  const { data: settingsRows } = await supabase.from('settings').select('key, value');
  const settings: Record<string, string> = {};
  (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { settings[key] = value; });

  // ── Buscar precio y duración desde services_catalog ────────────────────────
  const plan = pricingPlans.find((p) => p.id === session_type);
  if (!plan) return json({ error: 'Plan no encontrado.' }, 400);

  const typeMap: Record<string, { type: string; modality: string }> = {
    'online':            { type: 'individual', modality: 'online' },
    'presencial':        { type: 'individual', modality: 'presencial' },
    'pareja-online':     { type: 'pareja',     modality: 'online' },
    'pareja-presencial': { type: 'pareja',     modality: 'presencial' },
  };
  const typeInfo = typeMap[session_type];

  let durationMin   = 50;
  let catalogPrice: number | null = null;

  if (typeInfo) {
    // select('*') evita errores si las columnas nuevas aún no existen en DB
    const { data: svcs, error: svcsErr } = await supabase
      .from('services_catalog')
      .select('*')
      .eq('type', typeInfo.type)
      .in('modality', [typeInfo.modality, 'ambos'])
      .eq('visible', true)
      .order('sort_order');

    if (svcsErr) console.warn('[bookings] service lookup:', svcsErr.message);

    const list = svcs ?? [];
    const priceCol = typeInfo.modality === 'online' ? 'price_online' : 'price_presencial';
    const durCol   = typeInfo.modality === 'online' ? 'duration_min_online' : 'duration_min_presencial';

    // Prioridad: 1) modalidad exacta  2) "ambos" con la columna de precio específica rellena  3) cualquier "ambos"
    const svc = list.find((s: any) => s.modality === typeInfo.modality)
             ?? list.find((s: any) => s.modality === 'ambos' && s[priceCol] != null)
             ?? list.find((s: any) => s.modality === 'ambos')
             ?? null;

    if (svc) {
      if (svc.modality === 'ambos') {
        // Usar columna específica (price_online / price_presencial) si existe,
        // si no caer a la columna price principal (servicios guardados antes del dual-price)
        durationMin  = svc[durCol]             ?? svc.duration_min ?? 50;
        catalogPrice = svc[priceCol] ?? svc.price ?? null;
      } else {
        durationMin  = svc.duration_min ?? 50;
        catalogPrice = svc.price        ?? null;
      }
    }
  }

  const finalPrice = (catalogPrice && catalogPrice > 0) ? catalogPrice : plan.price;

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
      amount:         finalPrice,
      duration_min:   durationMin,
    })
    .select('id')
    .single();

  if (insertError || !booking) {
    console.error('Error insertando reserva:', insertError);
    return json({ error: 'Error al crear la reserva. Intenta nuevamente.' }, 500);
  }

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

  // ── Crear orden de pago en Flow ──────────────────────────────────────────────
  const siteUrl = import.meta.env.PUBLIC_SITE_URL?.replace(/\/$/, '') ?? 'http://localhost:4321';

  let flowOrder;
  try {
    flowOrder = await createPaymentOrder({
      subject:         `${SESSION_LABELS[session_type]} — Ps. Valentina Orellana`,
      amount:          finalPrice,
      email:           patient_email.trim().toLowerCase(),
      orderId:         booking.id,
      urlConfirmation: `${siteUrl}/api/flow/confirm`,
      urlReturn:       `${siteUrl}/api/flow/return`,
      baseUrl:         flowBaseUrl,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Error creando orden Flow:', errMsg);
    // Eliminar la reserva creada para evitar slots bloqueados sin pago
    await supabase.from('bookings').delete().eq('id', booking.id);
    return json({ error: 'Error al conectar con el sistema de pago.', detail: errMsg }, 502);
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
