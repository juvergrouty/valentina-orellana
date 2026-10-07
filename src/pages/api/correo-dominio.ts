import type { APIRoute } from 'astro';
import { dominioRecibeCorreo } from '../../lib/correoDominio';

export const prerender = false;

// GET /api/correo-dominio?dominio=gmail.com → { ok }: si ese dominio recibe
// correos. Lo usan los formularios para avisar al salir del campo. Solo se
// manda el dominio, nunca el correo completo (dato personal).
export const GET: APIRoute = async ({ url }) => {
  const dominio = (url.searchParams.get('dominio') ?? '').trim().slice(0, 200);
  const ok = /^[^\s@<>]+\.[^\s@<>]+$/.test(dominio) ? await dominioRecibeCorreo(`x@${dominio}`) : false;
  return new Response(JSON.stringify({ ok }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
};
