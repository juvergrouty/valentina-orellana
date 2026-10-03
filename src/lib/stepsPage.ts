import { randomBytes } from 'node:crypto';
import { supabase } from './supabase';

// Clave secreta del link de la página "Pasos a seguir" (/pasos-a-seguir/<clave>).
// Se genera una sola vez y queda en settings (`steps_page_key`); si alguna vez
// hay que invalidar los links ya enviados, basta con borrar ese setting.
export async function getStepsPageKey(): Promise<string> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'steps_page_key').maybeSingle();
  if (data?.value) return data.value;
  const key = randomBytes(12).toString('base64url');
  await supabase.from('settings').upsert({ key: 'steps_page_key', value: key, updated_at: new Date().toISOString() }, { onConflict: 'key', ignoreDuplicates: true });
  // Releer por si otra petición la creó al mismo tiempo.
  const { data: again } = await supabase.from('settings').select('value').eq('key', 'steps_page_key').maybeSingle();
  return again?.value ?? key;
}

export async function stepsPageUrl(origin: string): Promise<string> {
  return `${origin.replace(/\/$/, '')}/pasos-a-seguir/${await getStepsPageKey()}`;
}
