import type { APIRoute } from 'astro';

export const prerender = false;

// GET /api/admin/google/auth
// Inicia el flujo OAuth redirigiendo a Google
export const GET: APIRoute = async () => {
  const clientId    = import.meta.env.GOOGLE_CLIENT_ID;
  const redirectUri = import.meta.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return new Response('GOOGLE_CLIENT_ID o GOOGLE_REDIRECT_URI no configurados en Vercel.', { status: 500 });
  }

  const params = new URLSearchParams({
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
