// Avisos que Valentina pospone ("Recordar mañana") o marca como atendidos (rediseño del panel, 22 nov 2026:
// "para todas las alertas necesito un botón que me pueda hacer esconderlas o que ya las atendí").
// Solo esconde el aviso en la pantalla Hoy: no cambia la sesión, el pago, la boleta ni nada de fondo.
// Se guarda en una sola fila de settings: { [idAviso]: 'YYYY-MM-DD' (escondido hasta ese día) | 'atendido' }.
import { supabase } from './supabase';
import { todayCL } from './dateUtils';

const CLAVE = 'avisos_pospuestos';
type Mapa = Record<string, string>;

const sumarDias = (iso: string, n: number) => { const x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function leerMapa(): Promise<Mapa> {
  const { data, error } = await supabase.from('settings').select('value').eq('key', CLAVE).maybeSingle();
  if (error || !data?.value) return {};
  try { const v = JSON.parse(String(data.value)); return v && typeof v === 'object' ? v as Mapa : {}; } catch { return {}; }
}

async function guardarMapa(m: Mapa): Promise<void> {
  const { error } = await supabase.from('settings').upsert(
    { key: CLAVE, value: JSON.stringify(m), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) throw new Error(error.message);
}

/** Ids de avisos que hoy no se muestran (pospuestos hasta después de hoy, o atendidos). Si falla la lectura, no esconde nada. */
export async function avisosEscondidos(): Promise<Set<string>> {
  const hoy = todayCL();
  const m = await leerMapa().catch(() => ({} as Mapa));
  return new Set(Object.entries(m).filter(([, v]) => v === 'atendido' || v > hoy).map(([k]) => k));
}

const idValido = (id: string) => /^[a-z]+:[\w:.\-@]{1,160}$/i.test(id);

/** "Recordar mañana": lo esconde hasta mañana. "atendido": lo esconde para siempre (solo avisos informativos). "deshacer": lo vuelve a mostrar. */
export async function cambiarAviso(id: string, accion: 'manana' | 'atendido' | 'deshacer'): Promise<void> {
  if (!idValido(id)) throw new Error('aviso inválido');
  const m = await leerMapa();
  const hoy = todayCL();
  // Limpieza: se borran los pospuestos que ya vencieron.
  for (const [k, v] of Object.entries(m)) if (v !== 'atendido' && v <= hoy) delete m[k];
  if (accion === 'deshacer') delete m[id];
  else m[id] = accion === 'atendido' ? 'atendido' : sumarDias(hoy, 1);
  await guardarMapa(m);
}
