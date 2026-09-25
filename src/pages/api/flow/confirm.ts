/**
 * POST /api/flow/confirm
 *
 * Webhook que Flow llama automáticamente cuando un pago cambia de estado.
 * Flow envía un POST con: token=XXXXX (form-encoded)
 *
 * Este endpoint:
 *  1. Consulta el estado real del pago con la API de Flow
 *  2. Si está pagado (status=2), marca la reserva como 'confirmed'
 *  3. Si fue rechazado/anulado (status=3/4), marca como 'cancelled'
 *  4. Devuelve 200 (Flow reintenta si recibe otro código)
 *
 * NOTA PARA DESARROLLO LOCAL:
 * Flow no puede llamar a localhost. Para pruebas locales usa:
 *   npx ngrok http 4321
 * y pon la URL pública de ngrok en PUBLIC_SITE_URL del .env
 */

import type { APIRoute } from 'astro';
import { getPaymentStatus } from '../../../lib/flow';
import { supabase } from '../../../lib/supabase';
import { sendConfirmationToClient, sendNotificationToAdmin } from '../../../lib/email';
import { syncBookingToCalendar } from '../../../lib/syncCalendar';
import { upsertPatientFromBooking } from '../../../lib/patients';
import { emitBoletaParaReserva } from '../../../lib/apigateway';
import { ADMIN_EMAIL_FALLBACK } from '../../../lib/email';
import { logError, logWarn } from '../../../lib/logger';
import { tagBookingsWithPaymentToken } from '../../../lib/debt';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Flow envía el token como form-encoded
  let token: string | null = null;

  const contentType = request.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      token = form.get('token') as string | null;
    } else {
      // fallback: intentar leer como texto
      const text = await request.text();
      token = new URLSearchParams(text).get('token');
    }
  } catch {
    return new Response('Error leyendo body', { status: 400 });
  }

  if (!token) {
    console.warn('[Flow webhook] Token ausente');
    return new Response('Token requerido', { status: 400 });
  }

  try {
    // Leer entorno Flow desde settings (sandbox o producción)
    const { data: settingsRows } = await supabase.from('settings').select('key, value');
    const cfg: Record<string, string> = {};
    (settingsRows ?? []).forEach((r: { key: string; value: string }) => { cfg[r.key] = r.value; });
    const flowBaseUrl = cfg['flow_env'] === 'production'
      ? 'https://www.flow.cl/api'
      : cfg['flow_env'] === 'sandbox'
      ? 'https://sandbox.flow.cl/api'
      : undefined;

    const status = await getPaymentStatus(token, flowBaseUrl);
    console.log(`[Flow webhook] token=${token} status=${status.status} order=${status.flowOrder} env=${cfg['flow_env'] ?? 'default'}`);

    if (status.status === 2) {
      // ✅ Pagado — confirmar la(s) reserva(s) cubiertas por este token.
      // Normalmente es UNA sola (el flujo de siempre: agendar y pagar). Pero
      // desde /pagar/[id] (cobro de deuda combinada) un mismo pago de Flow
      // puede cubrir VARIAS reservas a la vez — todas comparten el mismo
      // mp_preference_id porque pagar-deuda.ts las marcó juntas al crear la
      // orden. Por eso esto ya no asume una sola fila.
      //
      // Idempotencia: se usa paid_at IS NULL (no status='pending_payment')
      // como guardia — así cubre tanto una reserva nueva (pending_payment)
      // como una reserva de deuda que ya estaba 'confirmed' pero sin pagar.
      // Un reintento de Flow no vuelve a matchear nada porque paid_at ya quedó
      // seteado la primera vez.
      let { data: candidates, error: selErr } = await supabase
        .from('bookings').select('*')
        .eq('mp_preference_id', token)
        .is('paid_at', null);

      if (selErr?.code === '42703') {
        // Migración de paid_at todavía no aplicada — degrada al comportamiento
        // anterior (una sola fila, por status).
        const retry = await supabase
          .from('bookings').select('*')
          .eq('mp_preference_id', token)
          .eq('status', 'pending_payment');
        candidates = retry.data;
        selErr = retry.error;
      }

      // Fallback: mp_preference_id solo guarda el ÚLTIMO token de una reserva. Si
      // se mandó un link individual y después uno combinado ("Cobrar todo"), el
      // combinado sobrescribe mp_preference_id de esa reserva y el link viejo
      // queda huérfano — si el paciente paga con ESE link viejo, no aparece acá.
      // Se busca en el historial guardado en notes (ver tagBookingsWithPaymentToken)
      // antes de darlo por "ya procesado" o "huérfano de verdad".
      if (!selErr && (!candidates || !candidates.length)) {
        const likeToken = token.replace(/[%_]/g, c => `\\${c}`);
        const { data: historicos } = await supabase
          .from('bookings').select('*')
          .ilike('notes', `%PagoToken ${likeToken}%`)
          .is('paid_at', null);
        if (historicos && historicos.length) candidates = historicos;
      }

      if (selErr) {
        console.error('[Flow webhook] Error buscando reservas:', selErr);
        await logError('flow/confirmar-reserva', 'Pago recibido pero no se pudo buscar la(s) reserva(s) a marcar', { token, flowOrder: status.flowOrder, error: selErr.message });
      } else if (candidates && candidates.length) {
        const ids = candidates.map((c: { id: string }) => c.id);
        const wasNew = new Set(candidates.filter((c: { status: string }) => c.status === 'pending_payment').map((c: { id: string }) => c.id));

        let { data: updated, error } = await supabase
          .from('bookings')
          .update({ status: 'confirmed', mp_payment_id: String(status.flowOrder), paid_at: new Date().toISOString(), payment_note: 'Flow' })
          .in('id', ids)
          .is('paid_at', null) // guardia de carrera: solo toma las que sigan sin pagar
          .select();

        if (error?.code === '42703') {
          const retry = await supabase
            .from('bookings')
            .update({ status: 'confirmed', mp_payment_id: String(status.flowOrder) })
            .in('id', ids)
            .select();
          updated = retry.data;
          error   = retry.error;
        }

        if (error) {
          // Crítico: el pago llegó de verdad (Flow ya confirmó status=2) pero
          // la(s) reserva(s) no quedaron marcadas como pagadas — antes esto solo
          // se veía en los logs de Vercel, que nadie revisa; ahora queda visible
          // en /admin/logs.
          console.error('[Flow webhook] Error confirmando reserva(s):', error);
          await logError('flow/confirmar-reserva', 'Pago recibido pero la(s) reserva(s) no se pudieron marcar como confirmadas', { token, flowOrder: status.flowOrder, ids, error: error.message });
        }

        for (const updatedRow of updated ?? []) {
          // Solo las reservas nuevas (pending_payment → confirmed) llevan el
          // flujo completo de "tu sesión quedó agendada" — correo de
          // confirmación, aviso a Valentina, evento en Google Calendar. Una
          // reserva de deuda (ya estaba 'confirmed', la sesión ya ocurrió) solo
          // necesita quedar marcada como pagada y con su boleta — el correo de
          // la boleta ya cumple el rol de "recibo de tu pago".
          if (wasNew.has(updatedRow.id)) {
            const adminEmail = cfg['notification_email'] || ADMIN_EMAIL_FALLBACK;
            const emailData = {
              patient_name:   updatedRow.patient_name,
              patient_email:  updatedRow.patient_email,
              patient_phone:  updatedRow.patient_phone,
              session_type:   updatedRow.session_type,
              session_date:   updatedRow.session_date,
              session_time:   updatedRow.session_time,
              amount:         updatedRow.amount,
              payment_method: 'flow',
            };
            // AWAIT: es un webhook; si no esperamos, la función serverless
            // termina y mata la sincronización con Google Calendar / los correos.
            await Promise.all([
              sendConfirmationToClient(emailData).catch(console.error),
              sendNotificationToAdmin(emailData, adminEmail).catch(console.error),
              syncBookingToCalendar(updatedRow).catch(console.error),
              upsertPatientFromBooking({ ...emailData, rut: updatedRow.patient_rut }).catch(console.error),
            ]);
          }

          // Boleta de honorarios automática al confirmarse el pago online, una
          // por reserva (si el pago cubrió 2 sesiones, salen 2 boletas — igual
          // que Encuadrado). IMPORTANTE (corregido): antes esto se saltaba por
          // completo si la reserva no traía patient_rut, y solo quedaba un
          // console.warn invisible. emitBoletaParaReserva ya sabe buscar el RUT
          // en la ficha del paciente si la reserva no trae uno propio.
          try {
            const boletaRes = await emitBoletaParaReserva(updatedRow.id, {
              rutOverride: updatedRow.patient_rut || undefined,
              enviarEmail: true,
            });
            if (!boletaRes.ok) {
              const esFaltaRut = (boletaRes.error ?? '').toLowerCase().includes('rut');
              await logWarn('flow/boleta-automatica', esFaltaRut
                ? `Boleta no emitida: falta el RUT de ${updatedRow.patient_name} (${updatedRow.patient_email}). Agrégalo en su ficha y emite la boleta manualmente desde el calendario.`
                : `Boleta no emitida automáticamente: ${boletaRes.error}`,
                { bookingId: updatedRow.id, patientEmail: updatedRow.patient_email, error: boletaRes.error });
            }
          } catch (e) {
            console.error('[Flow webhook] boleta automática:', e);
            await logError('flow/boleta-automatica', 'Excepción al emitir la boleta automática tras el pago', { bookingId: updatedRow.id, error: e instanceof Error ? e.message : String(e) });
          }
        }
      } else {
        // candidates vacío: puede ser (a) un reintento de Flow sobre un pago ya
        // procesado (inofensivo), o (b) un pago real cuyo token quedó huérfano
        // porque el mp_preference_id de esa reserva se sobrescribió después
        // (ej.: se mandó un link individual, el paciente no pagó, luego se generó
        // un link combinado nuevo con "Cobrar todo" para la misma reserva, y el
        // paciente termina pagando con el link viejo que aún tenía guardado en un
        // correo o WhatsApp). Se distingue viendo si este pago exacto ya quedó
        // registrado; si no, se avisa para revisar manualmente en Flow — mejor
        // que asumir en silencio que "no es nada".
        const { data: yaRegistrado } = await supabase
          .from('bookings').select('id').eq('mp_payment_id', String(status.flowOrder)).maybeSingle();
        if (!yaRegistrado) {
          await logWarn('flow/pago-huerfano', 'Flow confirmó un pago pero ninguna reserva coincide con ese token — puede ser un link de pago antiguo que ya fue reemplazado por uno nuevo. Revisar en Flow y conciliar manualmente.', { token, flowOrder: status.flowOrder, amount: status.amount, payer: status.payer });
        }
      }

    } else if (status.status === 3 || status.status === 4) {
      // ❌ Rechazado o anulado — cancelar SOLO si era una reserva nueva sin pagar
      // (status='pending_payment'). Nunca tocar una reserva de deuda que ya
      // estaba 'confirmed' (la sesión ya ocurrió) — cancelarla borraría una
      // sesión real de su historial solo porque el reintento de pago falló.
      const { error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('mp_preference_id', token)
        .eq('status', 'pending_payment');

      if (error) {
        console.error('[Flow webhook] Error cancelando reserva:', error);
        await logError('flow/cancelar-reserva', 'No se pudo marcar la reserva como cancelada tras rechazo/anulación del pago', { token, error: error.message });
      }
    }
    // status=1 (pendiente) → no hacemos nada, esperamos otro webhook

  } catch (err) {
    console.error('[Flow webhook] Error consultando estado:', err);
    await logError('flow/webhook', 'Excepción al consultar/procesar el estado del pago en Flow', { token, error: err instanceof Error ? err.message : String(err) });
    // Devolvemos 500 para que Flow reintente más tarde
    return new Response('Error interno', { status: 500 });
  }

  // Flow requiere exactamente HTTP 200 para considerar el webhook exitoso
  return new Response('OK', { status: 200 });
};
