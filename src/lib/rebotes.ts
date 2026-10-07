import { supabase } from './supabase';

// Correos que rebotaron (la dirección no existe o rechazó el correo). Los
// avisa Resend por webhook (src/pages/api/webhooks/resend.ts) y se muestran
// en el panel hasta que Valentina aprieta "Listo".
const CLAVE = 'correos_rebotados'; // JSON [{ correo, fecha, asunto, motivo }]

export type Rebote = { correo: string; fecha: string; asunto: string; motivo: string };

export async function leerRebotes(): Promise<Rebote[]> {
  const { data } = await supabase.from('settings').select('value').eq('key', CLAVE).maybeSingle();
  try { const a = JSON.parse(data?.value || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function guardar(lista: Rebote[]) {
  const { error } = await supabase.from('settings').upsert(
    { key: CLAVE, value: JSON.stringify(lista.slice(-50)), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) throw new Error(error.message);
}

export async function agregarRebote(r: Rebote) {
  const lista = (await leerRebotes()).filter((x) => x.correo !== r.correo);
  lista.push(r);
  await guardar(lista);
}

export async function quitarRebote(correo: string) {
  await guardar((await leerRebotes()).filter((x) => x.correo !== correo.trim().toLowerCase()));
}
