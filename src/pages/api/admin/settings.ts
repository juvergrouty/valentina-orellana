import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// Claves boolean: si no vienen en el form → desmarcado → 'false'
const BOOLEAN_KEYS = ['manual_payment_enabled', 'flow_enabled'];

// GET — obtener todas las settings
export const GET: APIRoute = async () => {
  const { data, error } = await supabase.from('settings').select('key, value');
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const settings: Record<string, string> = {};
  (data ?? []).forEach(({ key, value }) => { settings[key] = value; });
  return new Response(JSON.stringify(settings), { headers: { 'Content-Type': 'application/json' } });
};

// POST — guardar settings usando UPDATE o INSERT explícitos
export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const redirect = (form.get('redirect') as string) ?? '/admin/configuracion';

  const updates: Record<string, string> = {};

  for (const [key, value] of form.entries()) {
    if (key === 'redirect') continue;
    updates[key] = String(value);
  }

  // Checkboxes desmarcados no se envían — guardar 'false' explícitamente
  for (const boolKey of BOOLEAN_KEYS) {
    if (!(boolKey in updates)) updates[boolKey] = 'false';
  }

  // Obtener qué claves ya existen
  const { data: existing } = await supabase
    .from('settings')
    .select('key')
    .in('key', Object.keys(updates));

  const existingKeys = new Set((existing ?? []).map((r: { key: string }) => r.key));

  for (const [key, value] of Object.entries(updates)) {
    if (existingKeys.has(key)) {
      // UPDATE
      const { error } = await supabase
        .from('settings')
        .update({ value, updated_at: new Date().toISOString() })
        .eq('key', key);
      if (error) console.error(`[settings] UPDATE ${key}:`, error.message, error.code);
    } else {
      // INSERT
      const { error } = await supabase
        .from('settings')
        .insert({ key, value });
      if (error) console.error(`[settings] INSERT ${key}:`, error.message, error.code);
    }
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
