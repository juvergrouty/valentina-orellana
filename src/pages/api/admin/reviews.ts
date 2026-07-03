import type { APIRoute } from 'astro';
import { refreshGoogleReviewsCache, findPlaceCandidates } from '../../../lib/googleReviews';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, string> = {};
  try { body = await request.json(); } catch { /* */ }
  const action = body.action;

  if (action === 'refresh') {
    const result = await refreshGoogleReviewsCache();
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (action === 'find') {
    const query = (body.query ?? '').trim();
    if (!query) return new Response(JSON.stringify({ ok: false, error: 'Escribe el nombre a buscar.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const result = await findPlaceCandidates(query);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: false, error: 'Acción no válida.' }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  });
};
