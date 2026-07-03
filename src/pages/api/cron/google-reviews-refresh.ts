import type { APIRoute } from 'astro';
import { refreshGoogleReviewsCache } from '../../../lib/googleReviews';

export const prerender = false;

// Vercel Cron lo llama a diario con cabecera Authorization: Bearer <CRON_SECRET>.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }
  const result = await refreshGoogleReviewsCache();
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
};
