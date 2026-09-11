import { supabase } from './supabase';

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
      return { sent: false, reason: data?.error?.message ?? `graph_error_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error('[whatsapp] send exception:', e);
    return { sent: false, reason: e instanceof Error ? e.message : 'unknown' };
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
      return { sent: false, reason: data?.error?.error_user_msg ?? data?.error?.message ?? `graph_error_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error('[whatsapp] send template exception:', e);
    return { sent: false, reason: e instanceof Error ? e.message : 'unknown' };
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
        category: 'UTILITY',
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
