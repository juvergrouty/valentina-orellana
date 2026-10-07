import type { APIRoute } from 'astro';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { agregarRebote } from '../../../lib/rebotes';
import { logError, logWarn } from '../../../lib/logger';

export const prerender = false;

// Webhook de Resend: avisa cuando un correo rebotó (la dirección no existe o
// el servidor del destinatario lo rechazó). Queda como alerta en el panel.
// Firma (Svix, ver docs.svix.com/receiving/verifying-payloads/how-manual):
// HMAC-SHA256 de "<svix-id>.<svix-timestamp>.<cuerpo>" con el secreto
// "whsec_<base64>" que entrega Resend al crear el webhook (RESEND_WEBHOOK_SECRET).
const TOLERANCIA_S = 5 * 60;

function firmaValida(secreto: string, id: string, ts: string, cuerpo: string, cabecera: string): boolean {
  const clave = Buffer.from(secreto.startsWith('whsec_') ? secreto.slice(6) : secreto, 'base64');
  const esperada = Buffer.from(createHmac('sha256', clave).update(`${id}.${ts}.${cuerpo}`).digest('base64'));
  return cabecera.split(' ').some((parte) => {
    const firma = Buffer.from(parte.split(',')[1] ?? '');
    return firma.length === esperada.length && timingSafeEqual(firma, esperada);
  });
}

export const POST: APIRoute = async ({ request }) => {
  const secreto = import.meta.env.RESEND_WEBHOOK_SECRET;
  if (!secreto) {
    await logError('correo/webhook', 'Falta RESEND_WEBHOOK_SECRET en Vercel: no se pueden recibir avisos de rebote');
    return new Response('No configurado', { status: 503 });
  }
  const cuerpo = await request.text();
  const id = request.headers.get('svix-id') ?? '';
  const ts = request.headers.get('svix-timestamp') ?? '';
  const firma = request.headers.get('svix-signature') ?? '';
  const edad = Math.abs(Date.now() / 1000 - Number(ts));
  if (!id || !ts || !firma || !Number.isFinite(edad) || edad > TOLERANCIA_S || !firmaValida(secreto, id, ts, cuerpo, firma)) {
    return new Response('Firma inválida', { status: 401 });
  }

  let evento: { type?: string; created_at?: string; data?: { to?: string[] | string; subject?: string; bounce?: { message?: string; type?: string } } };
  try { evento = JSON.parse(cuerpo); } catch { return new Response('JSON inválido', { status: 400 }); }

  // bounced: el servidor del destinatario lo rechazó para siempre.
  // suppressed: Resend no lo envió porque esa dirección ya había rebotado antes.
  if (evento.type === 'email.bounced' || evento.type === 'email.suppressed') {
    const destinos = ([] as string[]).concat(evento.data?.to ?? []);
    for (const d of destinos) {
      const correo = String(d).replace(/^.*<([^>]+)>.*$/, '$1').trim().toLowerCase();
      if (!correo.includes('@')) continue;
      try {
        await agregarRebote({
          correo,
          fecha: evento.created_at ?? new Date().toISOString(),
          asunto: String(evento.data?.subject ?? '').slice(0, 200),
          motivo: String(evento.data?.bounce?.message ?? (evento.type === 'email.suppressed' ? 'La dirección ya había rebotado antes.' : '')).slice(0, 300),
        });
      } catch (e) {
        await logError('correo/rebote', 'No se pudo guardar el aviso de rebote', { correo, error: e instanceof Error ? e.message : String(e) });
        return new Response('Error', { status: 500 }); // Resend reintenta
      }
      await logWarn('correo/rebote', 'Un correo rebotó', { correo, asunto: evento.data?.subject });
    }
  }
  return new Response('ok');
};
