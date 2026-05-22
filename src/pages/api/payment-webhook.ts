import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { getPaymentById } from '../../lib/mercadopago';

export const prerender = false;

// POST /api/payment-webhook
// MercadoPago llama a esta URL al actualizarse el estado de un pago
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown>;

  try {
    body = await request.json();
  } catch {
    return new Response('OK', { status: 200 });
  }

  // MP envía notificaciones de tipo "payment"
  if (body.type !== 'payment' || !body.data) {
    return new Response('OK', { status: 200 });
  }

  const paymentId = String((body.data as Record<string, unknown>).id);

  try {
    const payment = await getPaymentById(paymentId);

    if (!payment.external_reference) {
      return new Response('OK', { status: 200 });
    }

    const bookingId = payment.external_reference;
    const mpStatus  = payment.status; // 'approved' | 'rejected' | 'pending' | etc.

    const newStatus =
      mpStatus === 'approved' ? 'confirmed' :
      mpStatus === 'rejected' ? 'cancelled' :
      'pending_payment';

    await supabase
      .from('bookings')
      .update({
        status:        newStatus,
        mp_payment_id: paymentId,
      })
      .eq('id', bookingId);

  } catch (err) {
    console.error('Error procesando webhook MP:', err);
  }

  // MP espera un 200 OK sin importar lo que pase internamente
  return new Response('OK', { status: 200 });
};
