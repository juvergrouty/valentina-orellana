/**
 * POST /api/vitrina/flow-confirm
 *
 * Aviso de pago de Flow para la VITRINA (talleres, charlas, contenido). Es
 * independiente del webhook de las reservas (/api/flow/confirm), que no se
 * toca: cada orden de la vitrina se crea con este urlConfirmation.
 * Consulta el estado real en Flow (getStatus), marca pagada, envía la
 * confirmación una sola vez y responde 200. Si algo falla, 500 para que Flow
 * reintente (procesarPagoFlow es idempotente).
 */
import type { APIRoute } from 'astro';
import { procesarPagoFlow } from '../../../lib/vitrina';
import { logError } from '../../../lib/logger';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let token: string | null = null;
  try {
    const text = await request.text();
    token = new URLSearchParams(text).get('token');
  } catch {
    return new Response('Error leyendo body', { status: 400 });
  }
  if (!token) return new Response('Token requerido', { status: 400 });

  try {
    const { resultado, status, correoFallido } = await procesarPagoFlow(token);
    console.log(`[Flow vitrina] status=${status?.status} order=${status?.flowOrder} resultado=${resultado}`);
    // Pago registrado pero el correo no salió: 500 para que Flow reintente el aviso.
    if (correoFallido) return new Response('Correo pendiente', { status: 500 });
  } catch (err) {
    await logError('vitrina/webhook', 'Excepción al consultar/procesar el pago de la vitrina en Flow', { token, error: err instanceof Error ? err.message : String(err) });
    return new Response('Error interno', { status: 500 });
  }
  return new Response('OK', { status: 200 });
};
