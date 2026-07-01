import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

// Proxy seguro: el token vive solo en el servidor, nunca llega al navegador.
export const GET: APIRoute = async () => {
  const { data } = await supabase
    .from('settings').select('value').eq('key', 'instagram_access_token').maybeSingle();
  const token = data?.value || import.meta.env.INSTAGRAM_ACCESS_TOKEN;

  if (!token) {
    return json({ configured: false, items: [], username: null });
  }

  try {
    const fields = 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp';
    const [mediaRes, userRes] = await Promise.all([
      fetch(`https://graph.instagram.com/me/media?fields=${fields}&limit=8&access_token=${token}`),
      fetch(`https://graph.instagram.com/me?fields=username&access_token=${token}`),
    ]);
    const media = await mediaRes.json();
    const user  = await userRes.json();

    if (media.error) {
      return json({ configured: true, items: [], username: user?.username ?? null, error: media.error.message });
    }

    const items = (media.data ?? []).map((m: Record<string, string>) => ({
      id:        m.id,
      caption:   m.caption ?? '',
      type:      m.media_type,
      image:     m.media_type === 'VIDEO' ? (m.thumbnail_url ?? m.media_url) : m.media_url,
      permalink: m.permalink,
      timestamp: m.timestamp,
    }));

    return new Response(JSON.stringify({ configured: true, items, username: user?.username ?? null }), {
      headers: {
        'Content-Type': 'application/json',
        // Cache CDN 1h, sirve viejo mientras revalida — evita golpear la API en cada visita
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch (e) {
    console.error('[instagram] fetch error:', e);
    return json({ configured: true, items: [], username: null, error: 'fetch_failed' });
  }
};

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
}
