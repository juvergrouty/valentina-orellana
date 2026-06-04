import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// Claves que son checkboxes — si no vienen en el form se guardan como 'false'
const BOOLEAN_KEYS = ['manual_payment_enabled', 'flow_enabled'];

// GET — obtener todas las settings
export const GET: APIRoute = async () => {
  const { data, error } = await supabase.from('settings').select('key, value');
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const settings: Record<string, string> = {};
  (data ?? []).forEach(({ key, value }) => { settings[key] = value; });
  return new Response(JSON.stringify(settings), { headers: { 'Content-Type': 'application/json' } });
};

// POST — guardar settings
export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const redirect = (form.get('redirect') as string) ?? '/admin/configuracion';

  const updates: { key: string; value: string }[] = [];

  // Recoger todos los campos del form
  for (const [key, value] of form.entries()) {
    if (key === 'redirect') continue;
    updates.push({ key, value: String(value) });
  }

  // Para checkboxes: si no están en el form significa que están desmarcados → guardar 'false'
  for (const boolKey of BOOLEAN_KEYS) {
    if (!updates.find(u => u.key === boolKey)) {
      updates.push({ key: boolKey, value: 'false' });
    }
  }

  // Guardar cada setting con upsert
  for (const { key, value } of updates) {
    const { error } = await supabase
      .from('settings')
      .upsert(
        { key, value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (error) console.error(`[settings] Error guardando ${key}:`, error.message);
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
