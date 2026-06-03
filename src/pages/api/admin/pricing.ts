import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const redirect = form.get('redirect') as string ?? '/admin/precios?saved=1';

  const keys = ['price_online', 'price_presencial', 'price_pareja_online', 'price_pareja_presencial'];

  for (const key of keys) {
    const value = form.get(key) as string;
    if (value && !isNaN(parseInt(value))) {
      await supabase.from('settings').upsert(
        { key, value: String(parseInt(value)), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
