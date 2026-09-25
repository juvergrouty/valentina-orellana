import type { APIRoute } from 'astro';
import { refreshGoogleReviewsCache } from '../../../lib/googleReviews';
import { logError } from '../../../lib/logger';

export const prerender = false;

// Vercel Cron lo llama a diario con cabecera Authorization: Bearer <CRON_SECRET>.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  // Falla cerrado: si CRON_SECRET no está configurado, nadie puede llamar al cron.
  {
    const auth = request.headers.get('authorization');
    if (!secret || auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }
  const result = await refreshGoogleReviewsCache();
  // "Falta el Place ID/API key" es un estado de configuración pendiente, no una
  // falla operativa — no vale la pena alertar por eso todos los días. Cualquier
  // otro error (Google rechazó la key, se cayó la conexión, falló el guardado)
  // sí debe quedar visible, porque antes no se registraba en ninguna parte.
  if (!result.ok && !result.error?.startsWith('Falta ')) {
    await logError('reviews/refresh-cache', 'Falló la actualización diaria de reseñas de Google', { error: result.error });
  }
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
};
