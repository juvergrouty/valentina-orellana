import type { APIRoute } from 'astro';
import { dominioRecibeCorreo } from '../../lib/correoDominio';

export const prerender = false;

// GET /api/correo-dominio?correo=… → { ok }: si lo que va después de la @
// recibe correos. Lo usan los formularios para avisar al salir del campo.
export const GET: APIRoute = async ({ url }) => {
  const correo = (url.searchParams.get('correo') ?? '').trim().slice(0, 200);
  const ok = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(correo) ? await dominioRecibeCorreo(correo) : false;
  return new Response(JSON.stringify({ ok }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
};
