import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { getTotalOwedByEmail, tagBookingsWithPaymentToken } from '../../lib/debt';
import { createPaymentOrder, FLOW_URLS } from '../../lib/flow';
import { logError } from '../../lib/logger';

export const prerender = false;

const SESSION_LABELS: Record<string, string> = {
  'online': 'Individual Online', 'presencial': 'Individual Presencial',
  'pareja-online': 'Pareja Online', 'pareja-presencial': 'Pareja Presencial',
};

// Crea UNA orden de Flow por TODO lo que el paciente deba en este momento
// (puede ser 1 o varias sesiones) y marca esas reservas con el mismo token de
// Flow (mp_preference_id) — así, cuando Flow confirme el pago, el webhook
// (flow/confirm.ts) encuentra todas las reservas cubiertas por ese pago y las
// marca pagadas a la vez, cada una con su propia boleta.
export const POST: APIRoute = async ({ request }) => {
  try {
    const { patientId } = await request.json();
    if (!patientId) return Response.json({ error: 'Falta patientId.' }, { status: 400 });

    const { data: patient } = await supabase
      .from('patients').select('id, name, email').eq('id', patientId).maybeSingle();
    if (!patient?.email) return Response.json({ error: 'Paciente no encontrado.' }, { status: 404 });

    // Se vuelve a consultar la deuda AHORA, no se confía en lo que la página
    // mostraba al cargar — evita cobrar de más o de menos si algo cambió entre
    // que el paciente abrió el link y presionó "Ir a pagar".
    const pending = await getTotalOwedByEmail(patient.email);
    if (!pending.length) {
      return Response.json({ error: 'Ya no tienes pagos pendientes. Si crees que esto es un error, escríbele a Valentina.' }, { status: 400 });
    }

    const amount = pending.reduce((s, b) => s + b.amount, 0);
    const subject = pending.length === 1
      ? `${SESSION_LABELS[pending[0].session_type] ?? pending[0].session_type} — Ps. Valentina Orellana`
      : `${pending.length} sesiones pendientes — Ps. Valentina Orellana`;

    const { data: settingsRows } = await supabase
      .from('settings').select('key, value').in('key', ['flow_env', 'flow_enabled']);
    const cfg = Object.fromEntries((settingsRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    if (cfg['flow_enabled'] === 'false') {
      return Response.json({ error: 'Flow está deshabilitado en la configuración.' }, { status: 400 });
    }
    const baseUrl = cfg['flow_env'] === 'production' ? FLOW_URLS.production : FLOW_URLS.sandbox;

    const reqUrl  = new URL(request.url);
    const siteUrl = `${reqUrl.protocol}//${reqUrl.host}`;

    const order = await createPaymentOrder({
      subject,
      amount,
      email:           patient.email,
      // Flow exige que commerceOrder tenga máximo 45 caracteres — un UUID de
      // paciente + timestamp se pasaba (56). Solo necesita ser único: el
      // webhook nunca busca por esto, busca por el token real de Flow
      // (mp_preference_id), así que un id corto basta.
      orderId:         `deuda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      urlConfirmation: `${siteUrl}/api/flow/confirm`,
      urlReturn:       `${siteUrl}/api/flow/return`,
      baseUrl,
    });

    const paymentUrl = `${order.url}?token=${order.token}`;
    const ids = pending.map(b => b.id);

    const { error: tagErr } = await supabase
      .from('bookings').update({ mp_preference_id: order.token }).in('id', ids);
    if (tagErr) {
      await logError('pagar-deuda', 'Se creó la orden de Flow pero no se pudo asociar a las reservas — el pago no se podrá conciliar', { patientId, ids, token: order.token, error: tagErr.message });
      return Response.json({ error: 'Error al preparar el pago. Intenta de nuevo o contacta a Valentina.' }, { status: 500 });
    }
    try { await tagBookingsWithPaymentToken(ids, order.token); } catch (e) {
      await logError('pagar-deuda', 'No se pudo guardar el historial de token de pago (no bloquea el pago)', { patientId, ids, error: e instanceof Error ? e.message : String(e) });
    }

    return Response.json({ ok: true, paymentUrl });
  } catch (err) {
    console.error('[pagar-deuda] error:', err);
    return Response.json({ error: err instanceof Error ? err.message : 'Error interno del servidor.' }, { status: 500 });
  }
};
