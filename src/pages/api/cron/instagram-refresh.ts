import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// Renueva el token de larga duración de Instagram (válido 60 días).
// Vercel Cron lo llama mensualmente con cabecera Authorization: Bearer <CRON_SECRET>.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const { data } = await supabase
    .from('settings').select('value').eq('key', 'instagram_access_token').maybeSingle();
  const token = data?.value;

  if (!token) {
    return json({ ok: false, reason: 'no_token' });
  }

  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`,
    );
    const j = await res.json();

    if (j.access_token) {
      await supabase.from('settings')
        .upsert({ key: 'instagram_access_token', value: j.access_token }, { onConflict: 'key' });
      return json({ ok: true, expires_in: j.expires_in });
    }

    console.error('[instagram-refresh]', j.error);
    return json({ ok: false, error: j.error?.message ?? 'refresh_failed' });
  } catch (e) {
    console.error('[instagram-refresh] exception:', e);
    return json({ ok: false, error: 'exception' });
  }
};

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
}
