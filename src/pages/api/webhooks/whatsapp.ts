import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { claveVerificacionWebhook } from '../../../lib/seguimientos/claveWebhook';
import { logError } from '../../../lib/logger';
import { firmaWhatsappValida, leerEventosWhatsapp } from '../../../lib/seguimientos/webhookWhatsapp';
import { registrarEventosWhatsapp } from '../../../lib/seguimientos/motor';

export const prerender = false;

// Aviso (webhook) de WhatsApp Cloud API para los seguimientos automáticos (18 nov 2026).
// En el App Dashboard de Meta: URL https://www.valentinaorellana.cl/api/webhooks/whatsapp, clave de
// verificación = la que muestra /admin/seguimientos (WHATSAPP_WEBHOOK_VERIFY_TOKEN o, si no está, la
// que generó la base en settings.whatsapp_webhook_verify_token, migración 0027), campos "messages" y "smb_message_echoes".
// - GET: verificación de Meta (hub.mode=subscribe, hub.verify_token, hub.challenge).
// - POST: firma X-Hub-Signature-256 (HMAC-SHA256 del cuerpo con el secreto de la app, META_APP_SECRET,
//   la misma app de /admin/whatsapp-conectar). Falla cerrado: sin secreto o con firma inválida, 503/401.
// Privacidad: no se guarda el texto de ningún mensaje, solo teléfono, nombre de perfil, fechas y
// de dónde llegó (anuncio o código del sitio). Ver src/lib/seguimientos/motor.ts.

const igual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export const GET: APIRoute = async ({ url }) => {
  const clave = await claveVerificacionWebhook();
  const modo = url.searchParams.get('hub.mode');
  const dada = url.searchParams.get('hub.verify_token') ?? '';
  const desafio = url.searchParams.get('hub.challenge') ?? '';
  if (!clave) return new Response('No configurado', { status: 503 });
  if (modo !== 'subscribe' || !igual(dada, clave) || !/^[\w-]{1,200}$/.test(desafio)) return new Response('Forbidden', { status: 403 });
  return new Response(desafio, { status: 200, headers: { 'Content-Type': 'text/plain' } });
};

export const POST: APIRoute = async ({ request }) => {
  const appSecret = secreto('META_APP_SECRET');
  if (!appSecret) {
    await logError('whatsapp/webhook', 'Falta META_APP_SECRET en Vercel: no se pueden recibir avisos de WhatsApp');
    return new Response('No configurado', { status: 503 });
  }
  const cuerpo = await request.text();
  if (!firmaWhatsappValida(cuerpo, request.headers.get('x-hub-signature-256'), appSecret)) {
    return new Response('Firma inválida', { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(cuerpo); } catch { return new Response('JSON inválido', { status: 400 }); }
  try {
    await registrarEventosWhatsapp(leerEventosWhatsapp(payload));
  } catch (e) {
    await logError('whatsapp/webhook', 'No se pudo guardar un aviso de WhatsApp', { motivo: e instanceof Error ? e.message : String(e) });
    return new Response('Error', { status: 500 }); // Meta reintenta
  }
  return new Response('ok');
};
