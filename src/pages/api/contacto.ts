import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { sendContactFormEmail, ADMIN_EMAIL_FALLBACK } from '../../lib/email';
import { logInfo } from '../../lib/logger';

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

  // Campo trampa (invisible para personas): si viene lleno es un bot. Se responde
  // "ok" sin enviar nada, para que no sepa que fue descartado.
  if ((body.website ?? '').trim()) return json({ ok: true });
  // Enviado menos de 3 segundos después de abrir la página: un bot. Igual "ok".
  const tiempo = Number(body.t);
  if (Number.isFinite(tiempo) && tiempo < 3000) return json({ ok: true });
  // Máximo 5 mensajes por conexión cada hora (antes, sin límite: alguien podía
  // llenar el correo de Valentina en bucle).
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'desconocida';
  {
    const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('admin_logs').select('id', { count: 'exact', head: true })
      .eq('context', 'contacto/enviado').gt('created_at', desde).eq('data->>ip', ip);
    if ((count ?? 0) >= 5) return json({ ok: false, error: 'Recibí varios mensajes seguidos desde tu conexión. Escríbeme por WhatsApp, por favor.' }, 429);
  }

  if (!nombre || !email) {
    return json({ ok: false, error: 'Faltan el nombre o el correo.' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ ok: false, error: 'El correo no parece válido.' }, 400);
  }
  if (nombre.length > 100 || email.length > 200 || motivo.length > 100 || mensaje.length > 3000) {
    return json({ ok: false, error: 'El mensaje es demasiado largo.' }, 400);
  }

  const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const adminEmail = notifRow?.value || ADMIN_EMAIL_FALLBACK;

  const res = await sendContactFormEmail({ nombre, email, motivo, mensaje }, adminEmail);
  if (!res.sent) return json({ ok: false, error: 'No se pudo enviar el mensaje. Intenta por WhatsApp.' }, 502);
  await logInfo('contacto/enviado', `Mensaje de contacto de ${nombre}`, { ip });

  return json({ ok: true });
};
