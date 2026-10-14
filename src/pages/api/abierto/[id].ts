import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// Imagen invisible de los correos masivos (Comunicaciones): cuando el correo
// se abre y carga las imágenes, se marca la apertura de ese destinatario
// (14 oct 2026). Siempre responde la imagen, aunque el id no exista, para no
// revelar nada. Ojo: Apple Mail precarga las imágenes, así que la tasa es
// aproximada (igual que en Encuadrado y cualquier herramienta de correo).
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));

export const GET: APIRoute = async ({ params }) => {
  const id = String(params.id ?? '').replace(/\.gif$/, '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    try { await supabase.rpc('marcar_apertura', { p_id: id }); } catch { /* sin medición, la imagen igual sale */ }
  }
  return new Response(GIF, {
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', 'Content-Length': String(GIF.length) },
  });
};
