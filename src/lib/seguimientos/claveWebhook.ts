import { secreto } from '../secretos';
import { supabase } from '../supabase';

// Clave de verificación del aviso (webhook) de WhatsApp en Meta. Si existe la variable de Vercel
// WHATSAPP_WEBHOOK_VERIFY_TOKEN, manda esa. Si no, se usa la que generó la propia base al aplicar la
// migración 0027 (settings.whatsapp_webhook_verify_token), así nadie tiene que escribir la clave a mano.
// /admin/seguimientos la muestra para copiarla en Meta. Sin ninguna de las dos, devuelve null (falla cerrado).
export async function claveVerificacionWebhook(): Promise<string | null> {
  const env = secreto('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
  if (env) return env;
  try {
    const { data, error } = await supabase.from('settings').select('value').eq('key', 'whatsapp_webhook_verify_token').maybeSingle();
    if (error) return null;
    const v = typeof data?.value === 'string' ? data.value.trim() : '';
    return v.length >= 24 ? v : null;
  } catch {
    return null;
  }
}
