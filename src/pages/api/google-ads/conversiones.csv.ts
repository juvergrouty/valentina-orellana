import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { csvConversiones, claveCsv, CSV_USUARIO } from '../../../lib/conversionesGoogle';

export const prerender = false;

// Archivo que Google Ads descarga solo cada día (subida programada por HTTPS,
// 14 oct 2026). Protegido con usuario y contraseña (Basic): la contraseña se
// guarda en settings y Valentina la ve en /admin/whatsapp-codigos.
// Solo GCLID, nombre de la conversión, hora, valor y moneda: ningún dato personal.

const noAutorizado = () => new Response('No autorizado', {
  status: 401,
  headers: { 'WWW-Authenticate': 'Basic realm="conversiones"', 'Cache-Control': 'private, no-store' },
});

function igual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const GET: APIRoute = async ({ request }) => {
  const clave = await claveCsv(false);
  if (!clave) return noAutorizado();
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Basic ')) return noAutorizado();
  let usuario = '', pass = '';
  try {
    const dec = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    usuario = dec.slice(0, i); pass = dec.slice(i + 1);
  } catch { return noAutorizado(); }
  if (!igual(usuario, CSV_USUARIO) || !igual(pass, clave)) return noAutorizado();

  try {
    return new Response(await csvConversiones(), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store' },
    });
  } catch {
    // Ya quedó en el registro de errores: Google marca la subida como fallida y avisa.
    return new Response('Error temporal', { status: 500, headers: { 'Cache-Control': 'private, no-store' } });
  }
};
