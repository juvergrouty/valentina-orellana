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
    const status = await getPaymentStatus(token);
    console.log(`[Flow webhook] token=${token} status=${status.status} order=${status.flowOrder}`);

    if (status.status === 2) {
      // ✅ Pagado — confirmar la reserva
      const { error } = await supabase
        .from('bookings')
        .update({
          status:         'confirmed',
          mp_payment_id:  String(status.flowOrder),
        })
        .eq('mp_preference_id', token);

      if (error) console.error('[Flow webhook] Error confirmando reserva:', error);

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
