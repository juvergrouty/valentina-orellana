import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { horaPorToken } from '../../lib/horaLink';
import { tokenValido, correoValido } from '../../lib/horaLinkUtil';
import { createPaymentOrder, FLOW_URLS } from '../../lib/flow';
import { tagBookingsWithPaymentToken, esCobrable } from '../../lib/debt';
import { comprobanteEnRevision } from '../../lib/comprobantes';
import { crearLinkSumUp, revisarLinkSumUpDeSesion, sumupConfigurado } from '../../lib/sumup';
import { upsertPatientFromBooking } from '../../lib/patients';
import { limpiarOrigen } from '../../lib/origen';
import { logError } from '../../lib/logger';
import { rutValido, limpiarRut } from '../../lib/rut';
import { normalizarComuna } from '../../data/comunas';
import { folioVigente } from '../../lib/apigateway';
import { encolarYEjecutar } from '../../lib/tareasEnvio';
import { getOrCreatePendingConsent, consentUrl, vigente, type ConsentRow } from '../../lib/consent';
import { MARCA_ESPERA_BANCO, MARCA_BANCO_OK } from '../../lib/gmailBancoUtil';
import { tieneMarca } from '../../lib/horaLinkUtil';
import { MARCA_TRANSFERENCIA_REVISADA } from '../../lib/comprobantes';

export const prerender = false;

// POST /api/hora — página pública /hora/<token> (22 nov 2026, src/lib/horaLink.ts).
// { token, accion: 'flow' | 'sumup' | 'estado' | 'datos', ... }
// - flow: crea la orden de Flow por ESA sesión. Flow exige un correo: si la reserva no tiene, la
//   página lo pide (necesitaCorreo) y se guarda en la reserva.
// - sumup: link de pago de SumUp (el mismo del panel, crearLinkSumUp).
// - estado: ¿ya está pagada? (y revisa el link de SumUp para no esperar al cron).
// - datos: formulario OPCIONAL después de pagar (RUT, dirección, comuna, correo). Con RUT y la
//   sesión pagada, emite la boleta (con la fecha del pago, fechaEmisionBoleta).
// Pago doble aceptado (regla de Vale): nada aquí impide pagar una sesión que todavía no figura pagada.
// Sondeo de 'estado' (la página pregunta cada 5 s al volver de SumUp): a SumUp se le pregunta como
// máximo cada 15 s por sesión (por instancia del servidor), para que nadie pueda saturarlo.
const ultimaRevisionSumUp = new Map<string, number>();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'Pedido no válido.' }, 400); }
  const token = String(body.token ?? '');
  if (!tokenValido(token)) return json({ error: 'Link no válido.' }, 404);
  const h = await horaPorToken(token);
  if (!h) return json({ error: 'Link no válido. Escríbele a Valentina para que te mande uno nuevo.' }, 404);
  const accion = String(body.accion ?? '');
  const site = new URL(request.url).origin;

  if (accion === 'estado') {
    let pagada = !!h.paid_at;
    if (!pagada && /SumUpCheckout/.test(h.notes ?? '') && Date.now() - (ultimaRevisionSumUp.get(h.id) ?? 0) > 15_000) {
      ultimaRevisionSumUp.set(h.id, Date.now());
      pagada = await revisarLinkSumUpDeSesion(h.id).catch(() => false);
    }
    return json({ pagada, enRevision: comprobanteEnRevision(h.notes), estado: h.status });
  }

  if (accion === 'flow' || accion === 'sumup') {
    if (h.paid_at) return json({ pagada: true });
    if (h.status === 'cancelled' || h.status === 'expired') return json({ error: 'Esta hora ya no está reservada. Escríbele a Valentina y buscamos otra.' }, 400);
    if (!esCobrable(h)) return json({ error: 'Esta hora no tiene un pago pendiente. Si crees que es un error, escríbele a Valentina.' }, 400);

    if (accion === 'sumup') {
      if (!sumupConfigurado()) return json({ error: 'Esta opción no está disponible ahora. Usa otra forma de pago.' }, 400);
      try {
        const r = await crearLinkSumUp(h.id);
        if (!r.ok || !r.url) return json({ error: r.error ?? 'No se pudo preparar el pago. Intenta de nuevo.' }, 400);
        return json({ ok: true, paymentUrl: r.url });
      } catch (e) {
        await logError('hora/sumup', 'No se pudo crear el link de SumUp de una hora con link', { bookingId: h.id, error: e instanceof Error ? e.message : String(e) });
        return json({ error: 'No se pudo preparar el pago. Intenta de nuevo o usa otra forma de pago.' }, 500);
      }
    }

    // Flow: el correo de la reserva o el que escribe la paciente aquí.
    let correo = (h.patient_email ?? '').trim().toLowerCase();
    const nuevo = String(body.correo ?? '').trim().toLowerCase();
    if (!correo) {
      if (!nuevo) return json({ necesitaCorreo: true });
      if (!correoValido(nuevo)) return json({ error: 'Revisa tu correo: no parece válido.', necesitaCorreo: true }, 400);
      const { error } = await supabase.from('bookings').update({ patient_email: nuevo, reminder_email_enabled: true }).eq('id', h.id).or('patient_email.is.null,patient_email.eq.');
      if (error) return json({ error: 'No se pudo guardar tu correo. Intenta de nuevo.' }, 500);
      correo = nuevo;
      await upsertPatientFromBooking({ patient_name: h.patient_name, patient_email: correo, patient_phone: h.patient_phone, rut: h.patient_rut }).catch(() => null);
    }

    const { data: rows } = await supabase.from('settings').select('key, value').in('key', ['flow_env', 'flow_enabled']);
    const cfg = Object.fromEntries((rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    if (cfg['flow_enabled'] === 'false') return json({ error: 'El pago con tarjeta no está disponible ahora. Usa otra forma de pago.' }, 400);
    const baseUrl = cfg['flow_env'] === 'production' ? FLOW_URLS.production : cfg['flow_env'] === 'sandbox' ? FLOW_URLS.sandbox : undefined;
    try {
      const order = await createPaymentOrder({
        subject: `Sesión ${String(h.session_type).startsWith('pareja') ? 'de pareja' : 'individual'} — Ps. Valentina Orellana`,
        amount: h.amount, email: correo,
        orderId: `hora-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        urlConfirmation: `${site}/api/flow/confirm`, urlReturn: `${site}/api/flow/return`, baseUrl,
        // El link de Flow vence con la hora retenida (mínimo 30 min): un pago muy tardío no revive una hora liberada.
        timeoutSeconds: Math.max(1800, Math.round((Date.parse(h.link_vence_at ?? '') - Date.now()) / 1000) || 1800),
      });
      const { error: tagErr } = await supabase.from('bookings').update({ mp_preference_id: order.token }).eq('id', h.id);
      if (tagErr) {
        await logError('hora/flow', 'Se creó la orden de Flow pero no se pudo asociar a la hora con link', { bookingId: h.id, error: tagErr.message });
        return json({ error: 'No se pudo preparar el pago. Intenta de nuevo.' }, 500);
      }
      await tagBookingsWithPaymentToken([h.id], order.token).catch(() => {});
      // De qué anuncio llegó (vo_origen del navegador), como /pagar: solo si la reserva no tenía.
      try {
        const o = limpiarOrigen(body.origen);
        if (o.first || o.last) await supabase.from('bookings').update({ origen: o }).eq('id', h.id).is('origen', null);
      } catch { /* sin origen no pasa nada */ }
      return json({ ok: true, paymentUrl: `${order.url}?token=${order.token}` });
    } catch (e) {
      await logError('hora/flow', 'No se pudo iniciar el pago con Flow de una hora con link', { bookingId: h.id, error: e instanceof Error ? e.message : String(e) });
      return json({ error: 'No se pudo preparar el pago. Intenta de nuevo o usa otra forma de pago.' }, 500);
    }
  }

  if (accion === 'datos') {
    // Opcional: la paciente puede no mandarlos nunca (Vale los pide en la consulta).
    const t = (k: string, max = 120) => String(body[k] ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
    const rutRaw = t('rut', 14);
    const sinRut = body.sin_rut === true;
    const direccion = t('direccion', 160);
    const comuna = normalizarComuna(t('comuna', 60)) ?? t('comuna', 60);
    const correoNuevo = t('correo', 200).toLowerCase();
    if (rutRaw && !rutValido(rutRaw)) return json({ error: 'Revisa tu RUT: el número o el dígito verificador no calzan.' }, 400);
    if (correoNuevo && !correoValido(correoNuevo)) return json({ error: 'Revisa tu correo: no parece válido.' }, 400);
    const rut = rutRaw ? limpiarRut(rutRaw) : '';

    const cambios: Record<string, unknown> = {};
    if (rut && !h.patient_rut) cambios.patient_rut = rut;
    if (correoNuevo && !h.patient_email) { cambios.patient_email = correoNuevo; cambios.reminder_email_enabled = true; }
    // Correo escrito aquí que ya es de otra ficha: se guarda en la reserva, pero no se completa esa
    // ficha ni se muestra su consentimiento (no se puede saber si es la misma persona).
    let fichaAjena = false;
    if (correoNuevo && !h.patient_email) {
      const { data: ya } = await supabase.from('patients').select('id').eq('email', correoNuevo).maybeSingle();
      fichaAjena = !!ya;
    }
    if (Object.keys(cambios).length) {
      const { error } = await supabase.from('bookings').update(cambios).eq('id', h.id);
      if (error) return json({ error: 'No se pudieron guardar tus datos. Intenta de nuevo.' }, 500);
    }
    const correo = (h.patient_email || correoNuevo || '').toLowerCase();
    let fichaId: string | null = null;
    if (correo && !fichaAjena) {
      fichaId = await upsertPatientFromBooking({
        patient_name: h.patient_name, patient_email: correo, patient_phone: h.patient_phone,
        rut: rut || h.patient_rut, address: direccion, comuna, sin_rut: sinRut && !rut,
      }).catch(() => null);
    }
    // Boleta: con RUT y la sesión pagada (si es transferencia, solo cuando el banco ya la confirmó).
    let boleta: 'emitida' | 'pendiente' | 'no' = 'no';
    const rutFinal = rut || h.patient_rut || '';
    const esperaBanco = tieneMarca(h.notes, MARCA_ESPERA_BANCO) && !tieneMarca(h.notes, MARCA_BANCO_OK) && !tieneMarca(h.notes, MARCA_TRANSFERENCIA_REVISADA);
    if (h.paid_at && rutFinal && (h.amount ?? 0) > 0 && !folioVigente(h.notes)) {
      if (esperaBanco) boleta = 'pendiente';
      else {
        const r = await encolarYEjecutar(h.id, 'boleta', `datos-${Date.now()}`).catch(() => null);
        boleta = r?.ok && !r.descartada && !r.nota ? 'emitida' : 'pendiente';
      }
    }
    // Consentimiento: el mismo link de firma de siempre (/consentimiento/<token>), si hay ficha.
    let consentimiento: string | null = null;
    if (fichaId) {
      try {
        const { data: filas } = await supabase.from('consents').select('*').eq('patient_id', fichaId);
        if (!vigente((filas ?? []) as ConsentRow[])) consentimiento = consentUrl(site, (await getOrCreatePendingConsent(fichaId)).token);
      } catch { consentimiento = null; }
    }
    return json({ ok: true, boleta, consentimiento });
  }

  return json({ error: 'Pedido no válido.' }, 400);
};
