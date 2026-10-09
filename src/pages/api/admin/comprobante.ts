import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { quitarLineasNotas } from '../../../lib/apigateway';
import { BUCKET_COMPROBANTES, MARCA_COMPROBANTE, comprobanteDe } from '../../../lib/comprobantes';

export const prerender = false;

// GET /api/admin/comprobante?b=<bookingId> — abre el comprobante de
// transferencia de esa sesión (link temporal al archivo privado).
export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('b') ?? '';
  const { data: b } = await supabase.from('bookings').select('notes').eq('id', id).maybeSingle();
  const c = comprobanteDe(b?.notes ?? null);
  if (!c) return new Response('Esta sesión no tiene comprobante.', { status: 404 });
  const { data, error } = await supabase.storage.from(BUCKET_COMPROBANTES).createSignedUrl(c.path, 300);
  if (error || !data?.signedUrl) return new Response('No se pudo abrir el comprobante.', { status: 500 });
  return new Response(null, { status: 302, headers: { Location: data.signedUrl } });
};

// POST /api/admin/comprobante {action:'descartar', ids:[...]} — quita el aviso
// cuando el comprobante no corresponde (las sesiones siguen sin pagar).
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'string') : [];
  if (body.action !== 'descartar' || !ids.length) return Response.json({ ok: false, error: 'Solicitud inválida.' }, { status: 400 });
  // Se revisa cada resultado (8 oct 2026): antes respondía ok aunque no se
  // hubiera quitado la marca, y el aviso volvía a aparecer al recargar.
  const fallidas: string[] = [];
  for (const id of ids) {
    const ok = await quitarLineasNotas(id, [MARCA_COMPROBANTE]).catch(() => false);
    if (!ok) fallidas.push(id);
  }
  if (fallidas.length) return Response.json({ ok: false, error: `No se pudo quitar el aviso en ${fallidas.length} de ${ids.length} sesión(es). Intenta de nuevo.` }, { status: 500 });
  return Response.json({ ok: true });
};
