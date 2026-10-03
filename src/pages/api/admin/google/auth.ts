import type { APIRoute } from 'astro';

export const prerender = false;

// GET /api/admin/google/auth
// Inicia el flujo OAuth redirigiendo a Google
export const GET: APIRoute = async ({ cookies }) => {
  const clientId    = import.meta.env.GOOGLE_CLIENT_ID;
  const redirectUri = import.meta.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return new Response('GOOGLE_CLIENT_ID o GOOGLE_REDIRECT_URI no configurados en Vercel.', { status: 500 });
  }

  // Código aleatorio de un solo uso: el callback solo acepta la vuelta de
  // Google si trae este mismo código (evita que alguien inyecte su propia
  // autorización en el panel).
  const state = crypto.randomUUID();
  cookies.set('vo_google_state', state, {
    path: '/api/admin/google', httpOnly: true, sameSite: 'lax', secure: import.meta.env.PROD, maxAge: 10 * 60,
  });

  const params = new URLSearchParams({
    state,
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
    access_type:   'offline',   // necesario para obtener refresh_token
    prompt:        'consent',   // forzar para que dé siempre el refresh_token
  });

  return new Response(null, {
    status: 302,
    headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` },
  });
};
