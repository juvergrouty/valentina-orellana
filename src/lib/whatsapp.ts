import { supabase } from './supabase';
import { logError } from './logger';
import { claveVerificacionWebhook } from './seguimientos/claveWebhook';

export interface WhatsappCfg {
  accessToken:   string;
  phoneNumberId: string;
  wabaId?:       string;
}

let cache: { cfg: WhatsappCfg | null; at: number } | null = null;
const CACHE_MS = 60_000;

export function clearWhatsappCache() { cache = null; }

// Lee el token, el phone_number_id y el waba_id guardados por el flujo de
// conexión de /admin/whatsapp-conectar (Embedded Signup de Meta). Si Vale no
// ha conectado WhatsApp Business todavía, esto vuelve null — quien llame debe
// manejarlo como "no enviado"/"no disponible", nunca como error fatal.
export async function getWhatsappConfig(): Promise<WhatsappCfg | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  const { data: rows } = await supabase.from('settings').select('key, value')
    .in('key', ['whatsapp_access_token', 'whatsapp_phone_number_id', 'whatsapp_waba_id']);
  const map: Record<string, string> = {};
  (rows ?? []).forEach((r: { key: string; value: string }) => { map[r.key] = r.value; });

  const cfg = map['whatsapp_access_token'] && map['whatsapp_phone_number_id']
    ? { accessToken: map['whatsapp_access_token'], phoneNumberId: map['whatsapp_phone_number_id'], wabaId: map['whatsapp_waba_id'] }
    : null;
  cache = { cfg, at: Date.now() };
  return cfg;
}

// Normaliza a dígitos con código de país (formato que exige la API), asumiendo
// Chile (+56) cuando el número viene sin código de país.
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('56')) return digits;
  if (digits.length === 9 && digits.startsWith('9')) return `56${digits}`;
  return digits;
}

// Envía un mensaje de texto libre por WhatsApp Cloud API (Meta).
//
// OJO — límite real de la plataforma, no de este código: Meta solo permite
// texto libre dentro de la "ventana de servicio" de 24h (si el paciente le
// escribió a este número en las últimas 24h). Para enviar un recordatorio de
// forma proactiva —como este caso— fuera de esa ventana, Meta exige usar una
// "plantilla de mensaje" pre-aprobada por ellos (se crea gratis en el Business
// Manager, la aprobación suele tardar minutos a un día). Si eso pasa, la API
// devuelve un error explícito (se registra en los logs) en vez de fallar en
// silencio — no hay forma de saber de antemano si tu cuenta ya tiene una
// plantilla aprobada sin revisar el Business Manager.
export async function sendWhatsappText(toPhone: string, body: string): Promise<{ sent: boolean; reason?: string }> {
  const cfg = await getWhatsappConfig();
  if (!cfg) return { sent: false, reason: 'whatsapp_not_connected' };

  const to = normalizePhone(toPhone);
  if (!to) return { sent: false, reason: 'no_phone' };

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.accessToken}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body, preview_url: false },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[whatsapp] send error:', JSON.stringify(data));
      const reason = data?.error?.message ?? `graph_error_${res.status}`;
      await logError('whatsapp/texto', 'Falló el envío de WhatsApp', { to, reason });
      return { sent: false, reason };
    }
    return { sent: true };
  } catch (e) {
    console.error('[whatsapp] send exception:', e);
    const reason = e instanceof Error ? e.message : 'unknown';
    await logError('whatsapp/texto', 'Excepción al enviar WhatsApp', { to, reason });
    return { sent: false, reason };
  }
}

// Envía un mensaje usando una plantilla ya aprobada por Meta — el único tipo
// de mensaje que Meta permite enviar de forma proactiva (fuera de la ventana
// de servicio de 24h). Si la plantilla todavía no fue aprobada (o el nombre
// no existe), Meta devuelve un error explícito acá — no falla en silencio.
export async function sendWhatsappTemplate(
  toPhone: string,
  templateName: string,
  language: string,
  bodyParams: string[],
): Promise<{ sent: boolean; reason?: string }> {
  const cfg = await getWhatsappConfig();
  if (!cfg) return { sent: false, reason: 'whatsapp_not_connected' };

  const to = normalizePhone(toPhone);
  if (!to) return { sent: false, reason: 'no_phone' };

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.accessToken}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
          components: bodyParams.length
            ? [{ type: 'body', parameters: bodyParams.map(p => ({ type: 'text', text: p })) }]
            : undefined,
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[whatsapp] send template error:', JSON.stringify(data));
      const reason = data?.error?.error_user_msg ?? data?.error?.message ?? `graph_error_${res.status}`;
      await logError('whatsapp/plantilla', 'Falló el envío de WhatsApp por plantilla', { to, templateName, reason });
      return { sent: false, reason };
    }
    return { sent: true };
  } catch (e) {
    console.error('[whatsapp] send template exception:', e);
    const reason = e instanceof Error ? e.message : 'unknown';
    await logError('whatsapp/plantilla', 'Excepción al enviar WhatsApp por plantilla', { to, templateName, reason });
    return { sent: false, reason };
  }
}

// Crea (envía a aprobación de Meta) una plantilla de mensaje — necesaria para
// que el recordatorio automático pueda enviarse fuera de la ventana de 24h.
// Se crea en categoría UTILITY (recordatorio de cita, no promocional), que es
// la que Meta aprueba más rápido y cobra más barato para este tipo de uso.
// bodyText puede traer variables {{1}}, {{2}}, ... — deben coincidir en
// cantidad y orden con sampleValues (Meta exige un ejemplo de cada variable
// para poder revisar la plantilla).
export async function createMessageTemplate(opts: {
  name:      string;
  language?: string; // código de idioma de plantilla de Meta, default 'es'
  bodyText:  string;
  sampleValues?: string[];
  // Por defecto UTILITY (recordatorio de cita). Los seguimientos que invitan a empezar o retomar
  // terapia van como MARKETING (reglas de categorías de Meta; ver src/lib/seguimientos/textos.ts).
  category?: 'UTILITY' | 'MARKETING';
}): Promise<{ ok: boolean; id?: string; status?: string; reason?: string }> {
  const cfg = await getWhatsappConfig();
  if (!cfg) return { ok: false, reason: 'whatsapp_not_connected' };
  if (!cfg.wabaId) return { ok: false, reason: 'missing_waba_id' };

  const component: Record<string, unknown> = { type: 'BODY', text: opts.bodyText };
  if (opts.sampleValues?.length) {
    component.example = { body_text: [opts.sampleValues] };
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.wabaId}/message_templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.accessToken}` },
      body: JSON.stringify({
        name:     opts.name,
        language: opts.language ?? 'es',
        category: opts.category ?? 'UTILITY',
        components: [component],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[whatsapp] create template error:', JSON.stringify(data));
      return { ok: false, reason: data?.error?.error_user_msg ?? data?.error?.message ?? `graph_error_${res.status}` };
    }
    return { ok: true, id: data.id, status: data.status };
  } catch (e) {
    console.error('[whatsapp] create template exception:', e);
    return { ok: false, reason: e instanceof Error ? e.message : 'unknown' };
  }
}

// Estado de las plantillas de la cuenta (APPROVED, PENDING, REJECTED, …) por nombre. null = no se
// pudo consultar (sin conexión o error de Meta): quien llama no debe enviar plantillas en ese caso.
export async function estadoPlantillas(): Promise<Map<string, string> | null> {
  const cfg = await getWhatsappConfig();
  if (!cfg?.wabaId) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.wabaId}/message_templates?fields=name,status,language&limit=200`, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      await logError('whatsapp/plantillas', 'No se pudo leer el estado de las plantillas de WhatsApp', { reason: data?.error?.message ?? res.status });
      return null;
    }
    const m = new Map<string, string>();
    for (const t of (data?.data ?? []) as { name: string; status: string }[]) m.set(t.name, t.status);
    return m;
  } catch (e) {
    await logError('whatsapp/plantillas', 'Excepción al leer las plantillas de WhatsApp', { reason: e instanceof Error ? e.message : 'unknown' });
    return null;
  }
}

// Suscribe la app del sitio a la cuenta de WhatsApp Business de Vale: sin esto Meta no manda los
// avisos (webhooks) de mensajes entrantes ni de sus respuestas desde la app (smb_message_echoes).
export const URL_WEBHOOK_WHATSAPP = 'https://www.valentinaorellana.cl/api/webhooks/whatsapp';

export async function suscribirAppAWhatsapp(): Promise<{ ok: boolean; reason?: string }> {
  const cfg = await getWhatsappConfig();
  if (!cfg) return { ok: false, reason: 'whatsapp_not_connected' };
  if (!cfg.wabaId) return { ok: false, reason: 'missing_waba_id' };
  try {
    // Con la clave de verificación (generada por la base, migración 0027) se registra además la URL del
    // aviso para esta cuenta (override_callback_uri, documentado en embedded-signup/webhooks/override),
    // así nadie tiene que escribir la URL ni la clave a mano en el panel de Meta.
    const clave = await claveVerificacionWebhook();
    const cuerpo = clave ? { override_callback_uri: URL_WEBHOOK_WHATSAPP, verify_token: clave } : null;
    const suscribir = async (body: object | null) => {
      const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.wabaId!)}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      return (!res.ok || data?.success === false) ? (data?.error?.message ?? `graph_error_${res.status}`) : null;
    };
    const error = await suscribir(cuerpo);
    if (!error) return { ok: true };
    // Si Meta no pudo verificar la URL propia, al menos queda suscrita como antes (sin override).
    if (cuerpo && !(await suscribir(null))) return { ok: false, reason: `suscrita, pero sin la URL del sitio: ${error}` };
    return { ok: false, reason: error };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'unknown' };
  }
}

// Coexistencia (app WhatsApp Business + Cloud API): justo después de conectar hay 24 horas para pedir
// la sincronización de contactos y luego del historial (cada una se puede pedir una sola vez). El sitio
// no guarda nada de eso: el webhook solo procesa los campos "messages" y "smb_message_echoes".
export async function sincronizarCoexistencia(): Promise<{ contactos: string; historial: string }> {
  const cfg = await getWhatsappConfig().catch(() => null);
  if (!cfg?.phoneNumberId) return { contactos: 'sin_numero', historial: 'sin_numero' };
  const pedir = async (sync_type: string) => {
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.phoneNumberId)}/smb_app_data`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', sync_type }),
      });
      const data = await res.json().catch(() => ({}));
      return res.ok ? 'ok' : (data?.error?.message ?? `graph_error_${res.status}`);
    } catch (e) { return e instanceof Error ? e.message : 'unknown'; }
  };
  const contactos = await pedir('smb_app_state_sync');
  const historial = await pedir('history');
  return { contactos, historial };
}
