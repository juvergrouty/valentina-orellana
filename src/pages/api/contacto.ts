import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { sendContactFormEmail, ADMIN_EMAIL_FALLBACK } from '../../lib/email';
import { logInfo, logWarn } from '../../lib/logger';
import { dominioRecibeCorreo } from '../../lib/correoDominio';

export const prerender = false;

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  // El cuerpo se lee una sola vez (8 oct 2026): antes request.json() lo
  // consumía y el respaldo con formData() fallaba siempre. Se acepta JSON
  // (el formulario con JavaScript) o formulario codificado (sin JavaScript).
  let body: Record<string, string> = {};
  const texto = await request.text().catch(() => '');
  try {
    const j = JSON.parse(texto);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      for (const [k, v] of Object.entries(j)) if (v != null) body[k] = String(v);
    }
  } catch {
    new URLSearchParams(texto).forEach((v, k) => { body[k] = v; });
  }

  const nombre  = (body.nombre ?? '').trim();
  const email   = (body.email ?? '').trim();
  const motivo  = (body.motivo ?? '').trim();
  const mensaje = (body.mensaje ?? '').trim();

  // Campo trampa (invisible para personas): si viene lleno es un bot. Se responde
  // "ok" sin enviar nada, para que no sepa que fue descartado.
  if ((body.website ?? '').trim()) return json({ ok: true });
  // Enviado menos de 3 segundos después de empezar a usar el formulario: un
  // bot. Igual "ok". Sin "t" (o "t" no numérico) también se trata como bot
  // (8 oct 2026): antes bastaba con no mandarlo para saltarse la revisión.
  const tiempo = body.t != null && String(body.t).trim() !== '' ? Number(body.t) : NaN;
  if (!Number.isFinite(tiempo) || tiempo < 3000) return json({ ok: true });
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
  // Correo con un dominio que no recibe correos (ej. "@gmail.con"): Valentina
  // no podría responder. Mismo control que la agenda (8 oct 2026).
  if (!(await dominioRecibeCorreo(email))) {
    const dom = email.split('@').pop();
    return json({ ok: false, error: `Revisa tu correo: "@${dom}" no recibe correos. Corrígelo para que pueda responderte.` }, 400);
  }

  // reCAPTCHA v3, igual que /api/bookings (8 oct 2026). Si no hay clave
  // secreta en Configuración, no se exige nada.
  const { data: secretRow } = await supabase.from('settings').select('value').eq('key', 'recaptcha_secret_key').maybeSingle();
  const recaptchaSecret = secretRow?.value;
  if (recaptchaSecret) {
    const token = (body.recaptcha_token ?? '').trim();
    // Sin token (script de Google bloqueado o lento): se acepta igual — un
    // contacto real perdido vale más que un spam, y quedan el campo trampa, el
    // tiempo mínimo y el límite por hora. Con token, se exige el puntaje.
    if (!token) {
      await logWarn('contacto', 'Mensaje sin verificación reCAPTCHA (script bloqueado o lento); se envió igual', {});
    } else {
    let verifyData: { success?: boolean; score?: number; action?: string; 'error-codes'?: string[] } = {};
    try {
      const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: recaptchaSecret, response: token }),
      });
      verifyData = await verifyRes.json();
    } catch { verifyData = { success: false }; }
    // Umbral típico para v3: 0.5 (el mismo de la agenda).
    if (!verifyData.success || (typeof verifyData.score === 'number' && verifyData.score < 0.5)) {
      await logWarn('contacto', 'reCAPTCHA rechazado', { score: verifyData.score, errors: verifyData['error-codes'] });
      return json({ ok: false, error: 'No pude verificar que eres una persona. Intenta de nuevo o escríbeme por WhatsApp.' }, 400);
    }
    }
  }

  const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const adminEmail = notifRow?.value || ADMIN_EMAIL_FALLBACK;

  const res = await sendContactFormEmail({ nombre, email, motivo, mensaje }, adminEmail);
  if (!res.sent) return json({ ok: false, error: 'No se pudo enviar el mensaje. Intenta por WhatsApp.' }, 502);
  await logInfo('contacto/enviado', `Mensaje de contacto de ${nombre}`, { ip });

  return json({ ok: true });
};
