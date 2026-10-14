import { supabase } from './supabase';
import { todayCL } from './dateUtils';

// Recordatorio mensual de impuestos (Valentina, 14 oct 2026): desde el día 16
// de cada mes el panel avisa "Pagar impuestos" con el link al SII, hasta que
// ella aprieta "Ya lo hice". Si un mes queda sin marcar, sigue apareciendo el
// mes siguiente (nunca se pierde). Un registro por mes en settings:
// "impuestos_ok:2026-10".
const PREFIJO = 'impuestos_ok:';
const PRIMER_MES = '2026-10'; // meses anteriores no se avisan
export const DIA_IMPUESTOS = 16;
export const URL_SII = 'https://www.sii.cl';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export type MesImpuestos = { mes: string; nombre: string };

/** Meses con impuestos por pagar (normalmente uno; dos si quedó uno atrás). */
export async function avisosImpuestos(): Promise<MesImpuestos[]> {
  const hoy = todayCL();
  const [y, m, d] = hoy.split('-').map(Number);
  const anterior = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const actual = `${y}-${String(m).padStart(2, '0')}`;
  const candidatos = [anterior, ...(d >= DIA_IMPUESTOS ? [actual] : [])].filter((x) => x >= PRIMER_MES);
  if (!candidatos.length) return [];
  const { data, error } = await supabase.from('settings').select('key').in('key', candidatos.map((c) => PREFIJO + c));
  if (error) throw new Error(error.message);
  const hechos = new Set((data ?? []).map((r) => String(r.key).slice(PREFIJO.length)));
  return candidatos.filter((c) => !hechos.has(c)).map((c) => {
    const [cy, cm] = c.split('-').map(Number);
    return { mes: c, nombre: `${MESES[cm - 1]}${cy !== y ? ` ${cy}` : ''}` };
  });
}

export async function marcarImpuestosPagados(mes: string): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('mes inválido');
  const { error } = await supabase.from('settings').upsert(
    { key: PREFIJO + mes, value: JSON.stringify({ hecho: new Date().toISOString() }), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) throw new Error(error.message);
}
