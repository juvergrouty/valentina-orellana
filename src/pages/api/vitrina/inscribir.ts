import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { createPaymentOrder, PUBLIC_PAY_TIMEOUT_SECONDS } from '../../../lib/flow';
import { dominioRecibeCorreo } from '../../../lib/correoDominio';
import { limpiarOrigen } from '../../../lib/origen';
import { logInfo, logWarn, logError } from '../../../lib/logger';
import { vitrinaPublica, esAdmin, flowBaseDesdeSettings, expirarPendientes, cuposDe, enviarConfirmacion, type VitrinaItem } from '../../../lib/vitrina';
import { validarNombre, validarCorreo, validarTelefono, yaPaso, ordenFlow, TIPO_LABEL } from '../../../lib/vitrinaUtils';

export const prerender = false;

// ─── POST /api/vitrina/inscribir ─────────────────────────────────────────────
// Inscripción a un taller/charla o compra de contenido digital (vitrina).
// - Gratis: queda 'free' y se envía la confirmación al tiro.
// - Pagado: queda 'pending_payment' y se crea la orden de Flow con las mismas
//   funciones de las reservas (orden "VT-<id>", endpoints propios). El cupo se
//   guarda 30 min; después se libera (ver expirarPendientes).
// Mismas defensas que /api/contacto y /api/bookings: campo trampa, tiempo
// mínimo, límite por conexión y reCAPTCHA v3 si está configurado.

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    return await inscribir(request, cookies);
  } catch (fatal) {
    const msg = fatal instanceof Error ? fatal.message : String(fatal);
    await logError('vitrina/fatal', 'Excepción no controlada al inscribir en la vitrina', { error: msg });
    return json({ ok: false, error: 'No pudimos completar tu inscripción. Intenta de nuevo o escríbeme por WhatsApp.' }, 500);
  }
};

async function inscribir(request: Request, cookies: Parameters<APIRoute>[0]['cookies']) {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const str = (k: string, max = 300) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '').slice(0, max);

  // Mientras la vitrina no sea pública, solo Valentina (sesión del panel) puede probarla.
  if (!(await vitrinaPublica()) && !(await esAdmin(cookies))) return json({ ok: false, error: 'No encontrado.' }, 404);

  // Campo trampa y tiempo mínimo (3 s): un bot recibe "ok" sin que se haga nada.
  if (str('website')) return json({ ok: true, free: true });
  const t = Number(body.t);
  if (!Number.isFinite(t) || t < 3000) return json({ ok: true, free: true });

  // Máximo 5 inscripciones por conexión cada hora.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'desconocida';
  {
    const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('admin_logs').select('id', { count: 'exact', head: true })
      .eq('context', 'vitrina/inscripcion').gt('created_at', desde).eq('data->>ip', ip);
    if ((count ?? 0) >= 5) {
      await logWarn('vitrina/limite', 'Demasiadas inscripciones desde la misma conexión en una hora: se rechazó', { ip });
      return json({ ok: false, error: 'Recibí varias inscripciones seguidas desde tu conexión. Escríbeme por WhatsApp y te ayudo, por favor.' }, 429);
    }
  }

  const nombre = str('name', 200);
  const correo = str('email', 250).toLowerCase();
  const telefono = str('phone', 40);
  if (!validarNombre(nombre)) return json({ ok: false, error: 'Revisa tu nombre.', campo: 'name' }, 400);
  if (!validarCorreo(correo)) return json({ ok: false, error: 'Revisa tu correo.', campo: 'email' }, 400);
  if (!validarTelefono(telefono)) return json({ ok: false, error: 'Revisa tu teléfono.', campo: 'phone' }, 400);
  if (!(await dominioRecibeCorreo(correo))) {
    return json({ ok: false, error: `Revisa tu correo: "@${correo.split('@').pop()}" no recibe correos.`, campo: 'email' }, 400);
  }

  // reCAPTCHA v3 (si hay clave en Configuración): obligatorio, como en contacto.
  const { data: secretRow } = await supabase.from('settings').select('value').eq('key', 'recaptcha_secret_key').maybeSingle();
  const recaptchaSecret = secretRow?.value;
  if (recaptchaSecret) {
    const token = str('recaptcha_token', 4000);
    if (!token) return json({ ok: false, error: 'No pude verificar que eres una persona: la verificación de Google no alcanzó a cargar. Recarga la página e intenta de nuevo, o escríbeme por WhatsApp.' }, 400);
    let v: { success?: boolean; score?: number; action?: string; hostname?: string; 'error-codes'?: string[] } = {};
    try {
      const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: recaptchaSecret, response: token }),
      });
      v = await r.json();
    } catch { v = { success: false }; }
    const host = String(v.hostname ?? '').toLowerCase();
    const hostOk = !host || host === 'valentinaorellana.cl' || host.endsWith('.valentinaorellana.cl') || host === 'localhost' || host === '127.0.0.1';
    if (!v.success || (typeof v.score === 'number' && v.score < 0.5) || (v.action && v.action !== 'submit_vitrina') || !hostOk) {
      await logWarn('vitrina', 'reCAPTCHA rechazado', { score: v.score, action: v.action, hostname: v.hostname, errors: v['error-codes'] });
      return json({ ok: false, error: 'No pude verificar que eres una persona. Intenta de nuevo o escríbeme por WhatsApp.' }, 400);
    }
  }

  // ── Item ──────────────────────────────────────────────────────────────────
  const itemId = str('item_id', 60);
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return json({ ok: false, error: 'Taller no encontrado.' }, 404);
  const admin = await esAdmin(cookies);
  const { data: itemRow } = await supabase.from('vitrina_items').select('*').eq('id', itemId).maybeSingle();
  const item = itemRow as VitrinaItem | null;
  if (!item || (!item.visible && !admin)) return json({ ok: false, error: 'Taller no encontrado.' }, 404);
  if (yaPaso(item)) return json({ ok: false, error: 'Este encuentro ya se realizó.' }, 409);

  await expirarPendientes(item.id);

  // ¿Ya inscrita? (pagada o gratis): no se cobra dos veces.
  const { data: previas } = await supabase.from('vitrina_inscripciones')
    .select('id, status').eq('item_id', item.id).eq('email', correo).in('status', ['paid', 'free', 'pending_payment']);
  if ((previas ?? []).some((p: { status: string }) => p.status === 'paid' || p.status === 'free')) {
    return json({ ok: false, error: item.type === 'contenido'
      ? 'Este correo ya tiene este contenido. Si no encuentras el correo con el enlace, escríbeme y te lo reenvío.'
      : 'Este correo ya está inscrito en este encuentro. Si no te llegó la confirmación, escríbeme y te la reenvío.', errorType: 'ya_inscrita' }, 409);
  }
  // Un intento anterior sin pagar de la misma persona se libera (si después
  // paga en esa pestaña vieja, el aviso de Flow igual la confirma).
  const pendientesPrevias = (previas ?? []).filter((p: { status: string }) => p.status === 'pending_payment').map((p: { id: string }) => p.id);
  if (pendientesPrevias.length) {
    await supabase.from('vitrina_inscripciones').update({ status: 'expired' }).in('id', pendientesPrevias).eq('status', 'pending_payment');
  }

  if (item.capacity) {
    const { restantes } = await cuposDe(item);
    if (!restantes) return json({ ok: false, error: 'Cupos agotados. Escríbeme por WhatsApp si quieres quedar en lista de espera.', errorType: 'agotado' }, 409);
  }

  const gratis = !item.price || item.price <= 0;
  const settingsFlow = gratis ? null : await supabase.from('settings').select('value').eq('key', 'flow_enabled').maybeSingle();
  if (!gratis && settingsFlow?.data?.value === 'false') {
    return json({ ok: false, error: 'El pago online está temporalmente deshabilitado. Escríbeme por WhatsApp para inscribirte.' }, 503);
  }
  if (!gratis && item.price < 100) {
    await logError('vitrina', 'Precio inválido para Flow', { itemId: item.id, price: item.price });
    return json({ ok: false, error: 'No pudimos preparar el pago. Escríbeme por WhatsApp, por favor.' }, 400);
  }

  const { data: nueva, error: insErr } = await supabase.from('vitrina_inscripciones').insert({
    item_id: item.id,
    name:    nombre,
    email:   correo,
    phone:   telefono,
    status:  gratis ? 'free' : 'pending_payment',
    amount:  gratis ? 0 : item.price,
    origen:  limpiarOrigen(body.origen),
  }).select('*').single();
  if (insErr || !nueva) {
    await logError('vitrina', 'No se pudo crear la inscripción', { itemId: item.id, error: insErr?.message, code: insErr?.code });
    return json({ ok: false, error: 'No pudimos guardar tu inscripción. Intenta de nuevo en un momento.' }, 500);
  }
  await logInfo('vitrina/inscripcion', `Inscripción ${gratis ? 'gratis' : 'iniciada'}: ${TIPO_LABEL[item.type]} "${item.title}"`, { ip, inscripcionId: nueva.id, itemId: item.id });

  // Dos personas tomando el último cupo al mismo tiempo: se revisa de nuevo y,
  // si se pasó, se retira esta (nunca se sobrevende).
  if (item.capacity) {
    const { ocupados } = await cuposDe(item);
    if (ocupados > item.capacity) {
      await supabase.from('vitrina_inscripciones').delete().eq('id', nueva.id);
      return json({ ok: false, error: 'Justo se tomó el último cupo. Escríbeme por WhatsApp si quieres quedar en lista de espera.', errorType: 'agotado' }, 409);
    }
  }

  if (gratis) {
    const r = await enviarConfirmacion(nueva.id, { avisarAdmin: true });
    return json({ ok: true, free: true, emailSent: r.sent });
  }

  // ── Orden de Flow ─────────────────────────────────────────────────────────
  // URL desde la propia petición (no PUBLIC_SITE_URL, mal configurada en Vercel; ver bookings.ts).
  const reqUrl  = new URL(request.url);
  const siteUrl = `${reqUrl.protocol}//${reqUrl.host}`;
  let orden;
  try {
    orden = await createPaymentOrder({
      subject:         `${TIPO_LABEL[item.type]}: ${item.title} — Ps. Valentina Orellana`.slice(0, 250),
      amount:          item.price,
      email:           correo,
      orderId:         ordenFlow(nueva.id),
      urlConfirmation: `${siteUrl}/api/vitrina/flow-confirm`,
      urlReturn:       `${siteUrl}/api/vitrina/flow-return`,
      baseUrl:         await flowBaseDesdeSettings(),
      timeoutSeconds:  PUBLIC_PAY_TIMEOUT_SECONDS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logError('vitrina/flow', 'Error creando la orden de Flow de la vitrina', { inscripcionId: nueva.id, amount: item.price, error: msg });
    await supabase.from('vitrina_inscripciones').delete().eq('id', nueva.id).eq('status', 'pending_payment');
    const esCorreo = msg.includes('1620') || /email/i.test(msg);
    return json({ ok: false, error: esCorreo
      ? 'El correo no es válido para el sistema de pago. Usa un correo real, por favor.'
      : 'Error al conectar con el sistema de pago. Intenta de nuevo en un momento o escríbeme por WhatsApp.', campo: esCorreo ? 'email' : undefined }, esCorreo ? 400 : 502);
  }

  // Sin el token guardado, el aviso de Flow igual la encuentra por la orden
  // "VT-<id>"; pero se exige para no dejar cabos sueltos.
  const { error: tokErr } = await supabase.from('vitrina_inscripciones').update({ flow_token: orden.token }).eq('id', nueva.id);
  if (tokErr) {
    await logError('vitrina/token', 'No se pudo guardar el token de Flow en la inscripción; se cancela', { inscripcionId: nueva.id, error: tokErr.message });
    await supabase.from('vitrina_inscripciones').update({ status: 'cancelled' }).eq('id', nueva.id);
    return json({ ok: false, error: 'No pudimos preparar el pago. Intenta de nuevo en unos segundos; no se te cobró nada.' }, 500);
  }

  return json({ ok: true, checkoutUrl: `${orden.url}?token=${orden.token}` });
}
