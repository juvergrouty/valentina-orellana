import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async () => {
  const googleKeys = [
    'google_access_token', 'google_refresh_token', 'google_token_expiry',
    'google_user_email', 'google_user_name', 'google_calendar_id', 'google_calendar_name',
  ];
  for (const key of googleKeys) {
    await supabase.from('settings').delete().eq('key', key);
  }
  return new Response(null, { status: 302, headers: { Location: '/admin/configuracion?google=disconnected' } });
};
