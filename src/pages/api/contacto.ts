import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { sendContactFormEmail, ADMIN_EMAIL_FALLBACK } from '../../lib/email';

export const prerender = false;

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, string> = {};
  try { body = await request.json(); } catch { /* form fallback below */ }
  if (!body.nombre && !body.email) {
    const form = await request.formData().catch(() => null);
    if (form) form.forEach((v, k) => { body[k] = String(v); });
  }

  const nombre  = (body.nombre ?? '').trim();
  const email   = (body.email ?? '').trim();
  const motivo  = (body.motivo ?? '').trim();
  const mensaje = (body.mensaje ?? '').trim();

  if (!nombre || !email) {
    return json({ ok: false, error: 'Faltan el nombre o el correo.' }, 400);
  }

  const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const adminEmail = notifRow?.value || ADMIN_EMAIL_FALLBACK;

  const res = await sendContactFormEmail({ nombre, email, motivo, mensaje }, adminEmail);
  if (!res.sent) return json({ ok: false, error: 'No se pudo enviar el mensaje. Intenta por WhatsApp.' }, 502);

  return json({ ok: true });
};
