import type { APIRoute } from 'astro';
import { supabase } from '../../../../../../../lib/supabase';

export const prerender = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /admin/pacientes/<ficha>/consentimiento/<firma>/anexo/<anexo>[?descargar=1]
// Anexo del consentimiento (decisión E del 16 oct noche): la copia fiel del correo con el aviso de
// cambio de herramienta, tal como se entregó a Resend (consent_anexos, 0021). Se devuelve el HTML
// guardado SIN cambiar un byte (su SHA-256 se verifica en la constancia). Protegido por la sesión
// del panel (middleware). CSP "sandbox": el HTML del correo no puede ejecutar nada en el panel.
export const GET: APIRoute = async ({ params, url }) => {
  const { id, cid, aid } = params;
  const noEncontrado = () => new Response('No encontrado', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (!UUID.test(id ?? '') || !UUID.test(cid ?? '') || !UUID.test(aid ?? '')) return noEncontrado();
  const [{ data: c }, { data: a, error }] = await Promise.all([
    supabase.from('consents').select('id, patient_id').eq('id', cid!).eq('patient_id', id!).maybeSingle(),
    supabase.from('consent_anexos').select('id, consent_id, tipo, enviado_at, html').eq('id', aid!).eq('consent_id', cid!).maybeSingle(),
  ]);
  if (error || !c || !a) return noEncontrado();
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (url.searchParams.get('descargar') === '1') {
    const fecha = String(a.enviado_at ?? '').slice(0, 10) || 'sin-fecha';
    headers['Content-Disposition'] = `attachment; filename="anexo-${a.tipo === 'aviso_v2' ? 'aviso-cambio-herramienta' : 'consentimiento'}-${fecha}.html"`;
  }
  return new Response(String(a.html ?? ''), { status: 200, headers });
};
