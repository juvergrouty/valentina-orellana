import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// GET — obtener todas las settings
export const GET: APIRoute = async () => {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value');

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const settings: Record<string, string> = {};
  (data ?? []).forEach(({ key, value }) => { settings[key] = value; });

  return new Response(JSON.stringify(settings), {
    headers: { 'Content-Type': 'application/json' },
  });
};

// POST — actualizar una o varias settings
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const redirect = form.get('redirect') as string ?? '/admin/configuracion';

  const updates: { key: string; value: string }[] = [];

  // Recoger todos los campos excepto 'redirect'
  for (const [key, value] of form.entries()) {
    if (key === 'redirect') continue;
    updates.push({ key, value: String(value) });
  }

  for (const { key, value } of updates) {
    await supabase
      .from('settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: redirect },
  });
};
