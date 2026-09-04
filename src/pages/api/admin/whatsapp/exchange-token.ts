import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

// POST /api/admin/whatsapp/exchange-token
// Recibe el `code` que devuelve el flujo de Embedded Signup (Coexistence) de
// WhatsApp en el navegador, lo cambia por un token de acceso (con la duración
// configurada en la plantilla de Meta — 60 días) y guarda todo en `settings`,
// siguiendo el mismo patrón que la conexión de Google Calendar.
export const POST: APIRoute = async ({ request }) => {
  try {
    const { code, wabaId, phoneNumberId } = await request.json();
    if (!code) return json({ error: 'Falta el código de autorización.' }, 400);

    const appId     = import.meta.env.PUBLIC_META_APP_ID;
    const appSecret = import.meta.env.META_APP_SECRET;
    if (!appId || !appSecret) return json({ error: 'META_APP_SECRET / PUBLIC_META_APP_ID no configurados en Vercel.' }, 500);

    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[whatsapp/exchange-token] Graph error:', tokenData);
      return json({ error: tokenData.error?.message ?? 'No se pudo canjear el código por un token.' }, 502);
    }

    const upserts: Array<{ key: string; value: string }> = [
      { key: 'whatsapp_access_token', value: tokenData.access_token },
      { key: 'whatsapp_connected_at', value: new Date().toISOString() },
    ];
    if (wabaId)        upserts.push({ key: 'whatsapp_waba_id',         value: String(wabaId) });
    if (phoneNumberId) upserts.push({ key: 'whatsapp_phone_number_id', value: String(phoneNumberId) });

    for (const u of upserts) {
      await supabase.from('settings').upsert(
        { key: u.key, value: u.value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }

    return json({ ok: true });
  } catch (err) {
    console.error('[whatsapp/exchange-token]', err);
    return json({ error: 'Error interno al conectar WhatsApp.' }, 500);
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
