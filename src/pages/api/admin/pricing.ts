import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

const NUMERIC_KEYS = ['price_online', 'price_presencial', 'price_pareja_online', 'price_pareja_presencial'];
const TEXT_KEYS    = ['duration_individual', 'duration_pareja'];

export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const redirect = (form.get('redirect') as string) ?? '/admin/precios?saved=1';

  // Guardar precios (numéricos)
  for (const key of NUMERIC_KEYS) {
    const value = form.get(key) as string;
    if (value && !isNaN(parseInt(value))) {
      await supabase.from('settings').upsert(
        { key, value: String(parseInt(value)), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }
  }

  // Guardar duraciones (texto libre)
  for (const key of TEXT_KEYS) {
    const value = (form.get(key) as string)?.trim();
    if (value) {
      await supabase.from('settings').upsert(
        { key, value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
