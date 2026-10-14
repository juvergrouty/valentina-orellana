import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { limpiarOrigen } from '../../lib/origen';
import { createHash } from 'node:crypto';

export const prerender = false;

// Clic en un botón de WhatsApp del sitio (14 oct 2026). El navegador agrega un
// código corto al mensaje prellenado (ej. "G-7K3Q") y lo manda aquí junto con su
// origen (gclid/utm/referrer). Valentina ve el código en el WhatsApp y, cuando
// esa persona paga, lo marca en /admin/whatsapp-codigos: así se sabe qué canal
// y qué anuncio trajo a cada paciente, y se puede subir a Google Ads.
// No se guarda nombre ni teléfono (el sitio no los conoce en este momento).
// Se guarda en admin_logs (context 'wa/clic') para no requerir una tabla nueva.

const CODIGO = /^[A-Z]-[A-HJ-NP-Z2-9]{4}$/;
const ok = () => new Response(null, { status: 204 });

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown> = {};
  try {
    const j = JSON.parse(await request.text());
    if (j && typeof j === 'object' && !Array.isArray(j)) body = j;
  } catch { return ok(); }

  const codigo = typeof body.codigo === 'string' ? body.codigo.trim().toUpperCase() : '';
  if (!CODIGO.test(codigo)) return ok();
  const path = typeof body.path === 'string' ? body.path.replace(/[<>]/g, '').slice(0, 200) : '';
  const origen = limpiarOrigen(body.origen);

  // Un mismo código se registra una sola vez (la persona puede tocar el botón varias veces).
  const { count } = await supabase.from('admin_logs').select('id', { count: 'exact', head: true })
    .eq('context', 'wa/clic').eq('message', codigo);
  if ((count ?? 0) > 0) return ok();

  // Límite simple contra abuso: máximo 30 códigos nuevos por conexión por hora.
  // Solo un hash corto de la IP (para el límite de abuso), nunca la IP (dato personal).
  const ipRaw = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'desconocida';
  const ip = createHash('sha256').update('vo-wa:' + ipRaw).digest('hex').slice(0, 12);
  const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recientes } = await supabase.from('admin_logs').select('id', { count: 'exact', head: true })
    .eq('context', 'wa/clic').gt('created_at', desde).eq('data->>ip_h', ip);
  if ((recientes ?? 0) >= 30) return ok();

  await supabase.from('admin_logs').insert({
    level: 'info',
    context: 'wa/clic',
    message: codigo,
    data: { codigo, path, ip_h: ip, canal: origen.canal, first: origen.first, last: origen.last },
  });
  return ok();
};
