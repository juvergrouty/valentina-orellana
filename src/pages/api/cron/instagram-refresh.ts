import { timingSafeEqual } from 'node:crypto';
import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { logError, logWarn } from '../../../lib/logger';

export const prerender = false;

// Comparación en tiempo constante (8 oct 2026): con !== el tiempo de respuesta
// delataba cuántos caracteres del secreto calzaban. Sin secreto, falla cerrado.
function secretoValido(auth: string | null, secret: string | undefined): boolean {
  if (!secret || !auth) return false;
  const dado = Buffer.from(auth), esperado = Buffer.from(`Bearer ${secret}`);
  return dado.length === esperado.length && timingSafeEqual(dado, esperado);
}

// Renueva el token de larga duración de Instagram (válido 60 días).
// Vercel Cron lo llama mensualmente con cabecera Authorization: Bearer <CRON_SECRET>.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  // Falla cerrado: si CRON_SECRET no está configurado, nadie puede llamar al cron.
  {
    const auth = request.headers.get('authorization');
    if (!secretoValido(auth, secret)) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  // El token del panel tiene prioridad; si está vacío se usa el de Vercel.
  // El token renovado siempre se guarda en el panel, así la variable de Vercel
  // deja de ser necesaria después de la primera renovación.
  const { data } = await supabase
    .from('settings').select('value').eq('key', 'instagram_access_token').maybeSingle();
  const token = data?.value?.trim() || import.meta.env.INSTAGRAM_ACCESS_TOKEN;

  if (!token) {
    await logWarn('instagram/refresh-token', 'No hay token de Instagram configurado (ni en el panel ni en Vercel)');
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

    await logError('instagram/refresh-token', 'apigateway de Instagram respondió sin access_token', { response: JSON.stringify(j).slice(0, 800) });
    return json({ ok: false, error: j.error?.message ?? 'refresh_failed' });
  } catch (e) {
    await logError('instagram/refresh-token', 'Excepción al renovar el token de Instagram', { error: String(e) });
    return json({ ok: false, error: 'exception' });
  }
};

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
}
