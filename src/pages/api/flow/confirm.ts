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
      // ✅ Pagado — confirmar la reserva
      const { data: updated, error } = await supabase
        .from('bookings')
        .update({
          status:         'confirmed',
          mp_payment_id:  String(status.flowOrder),
        })
        .eq('mp_preference_id', token)
        .select()
        .single();

      if (error) {
        console.error('[Flow webhook] Error confirmando reserva:', error);
      } else if (updated) {
        const adminEmail = cfg['notification_email'] ?? 'juver@grouty.cl';

        const emailData = {
          patient_name:   updated.patient_name,
          patient_email:  updated.patient_email,
          patient_phone:  updated.patient_phone,
          session_type:   updated.session_type,
          session_date:   updated.session_date,
          session_time:   updated.session_time,
          amount:         updated.amount,
          payment_method: 'flow',
        };
        Promise.all([
          sendConfirmationToClient(emailData).catch(console.error),
          sendNotificationToAdmin(emailData, adminEmail).catch(console.error),
          syncBookingToCalendar(updated).catch(console.error),
        ]);
      }

    } else if (status.status === 3 || status.status === 4) {
      // ❌ Rechazado o anulado — cancelar la reserva
      const { error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('mp_preference_id', token);

      if (error) console.error('[Flow webhook] Error cancelando reserva:', error);
    }
    // status=1 (pendiente) → no hacemos nada, esperamos otro webhook

  } catch (err) {
    console.error('[Flow webhook] Error consultando estado:', err);
    // Devolvemos 500 para que Flow reintente más tarde
    return new Response('Error interno', { status: 500 });
  }

  // Flow requiere exactamente HTTP 200 para considerar el webhook exitoso
  return new Response('OK', { status: 200 });
};
