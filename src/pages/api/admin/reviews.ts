import type { APIRoute } from 'astro';
import { refreshGoogleReviewsCache } from '../../../lib/googleReviews';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let action = '';
  try { action = (await request.json()).action; } catch { /* */ }

  if (action === 'refresh') {
    const result = await refreshGoogleReviewsCache();
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: false, error: 'Acción no válida.' }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  });
};
