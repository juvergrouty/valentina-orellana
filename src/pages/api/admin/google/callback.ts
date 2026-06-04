import type { APIRoute } from 'astro';
import { exchangeCodeForTokens, getGoogleUserInfo, listCalendars } from '../../../../lib/googleCalendar';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/configuracion?google=error' },
    });
  }

  try {
    // Intercambiar código por tokens
    const tokens = await exchangeCodeForTokens(code);

    // Obtener info del usuario
    const userInfo = await getGoogleUserInfo(tokens.access_token);

    // Obtener calendario primario
    const calendars = await listCalendars(tokens.access_token);
    const primary   = calendars.find(c => c.primary) ?? calendars[0];

    // Calcular expiración
    const expiresAt = Date.now() + (tokens.expires_in * 1000);

    // Guardar tokens en settings
    const upserts = [
      { key: 'google_access_token',  value: tokens.access_token },
      { key: 'google_refresh_token', value: tokens.refresh_token },
      { key: 'google_token_expiry',  value: String(expiresAt) },
      { key: 'google_user_email',    value: userInfo.email },
      { key: 'google_user_name',     value: userInfo.name },
      { key: 'google_calendar_id',   value: primary?.id ?? 'primary' },
      { key: 'google_calendar_name', value: primary?.summary ?? 'Calendario principal' },
    ];

    for (const u of upserts) {
      await supabase.from('settings').upsert(
        { key: u.key, value: u.value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/configuracion?google=connected' },
    });

  } catch (err) {
    console.error('[google/callback]', err);
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/configuracion?google=error' },
    });
  }
};
