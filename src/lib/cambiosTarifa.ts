import { supabase } from './supabase';
import { todayCL } from './dateUtils';

// Cambios de tarifa de pacientes actuales (Valentina, 8 oct 2026): el panel
// recuerda a quién falta avisar y, cuando llega la fecha, que se agende con el
// monto nuevo. Los pacientes pueden no tener ficha en la página (se agendan por
// Encuadrado), por eso va por nombre. Se guarda en settings, como los rebotes.
const CLAVE = 'cambios_tarifa'; // JSON CambioTarifa[]

export type CambioTarifa = {
  id: string;
  nombre: string;
  anterior: number | null;
  nuevo: number;
  desde: string;      // YYYY-MM-DD (lunes en que empieza a regir)
  avisado: boolean;   // ya se le avisó a la paciente
  aplicado: boolean;  // Valentina ya lo aplicó (oculta el aviso de "desde esta semana")
};

export type AvisoTarifa = CambioTarifa & {
  fase: 'avisar' | 'proxima' | 'vigente';
  // 'avisar' con la fecha ya cumplida: el aviso se muestra como urgente.
  atrasado: boolean;
  // Sesiones ya agendadas en la página desde la fecha nueva con el monto antiguo.
  sesionesConMontoAntiguo: number;
};

export async function leerCambiosTarifa(): Promise<CambioTarifa[]> {
  const { data } = await supabase.from('settings').select('value').eq('key', CLAVE).maybeSingle();
  try { const a = JSON.parse(data?.value || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

export async function marcarCambioTarifa(id: string, campo: 'avisado' | 'aplicado'): Promise<void> {
  // Se lee con revisión de error: si la lectura falla, NO se escribe (escribir
  // una lista vacía borraría todos los cambios guardados).
  const { data, error: errLeer } = await supabase.from('settings').select('value').eq('key', CLAVE).maybeSingle();
  if (errLeer) throw new Error(errLeer.message);
  let actual: CambioTarifa[];
  try { actual = JSON.parse(data?.value || '[]'); } catch { throw new Error('cambios_tarifa ilegible'); }
  if (!Array.isArray(actual)) throw new Error('cambios_tarifa ilegible');
  const lista = actual.map((c) => (c.id === id ? { ...c, [campo]: true } : c));
  const { error } = await supabase.from('settings').upsert(
    { key: CLAVE, value: JSON.stringify(lista), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) throw new Error(error.message);
}

const sumarDias = (iso: string, d: number) => {
  const x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10);
};

/** Qué mostrar hoy en el panel. */
export async function avisosCambioTarifa(): Promise<AvisoTarifa[]> {
  const hoy = todayCL();
  const out: AvisoTarifa[] = [];
  for (const c of await leerCambiosTarifa()) {
    let fase: AvisoTarifa['fase'] | null = null;
    // Sin avisar manda siempre, también desde la fecha nueva (8 oct 2026):
    // antes, al llegar "desde" pasaba a 'vigente' y se perdía el "Falta
    // avisarle", aunque nunca se le hubiera avisado.
    if (!c.avisado) fase = 'avisar';                         // desde ya, hasta que avise
    else if (hoy >= c.desde) fase = c.aplicado ? null : 'vigente';
    // Desde el lunes de la semana anterior: Valentina agenda con una semana de
    // anticipación, así que lo que agende desde ese día para la fecha nueva ya
    // va con el monto nuevo (pedido explícito, 8 oct 2026).
    else if (hoy >= sumarDias(c.desde, -7)) fase = 'proxima';
    if (!fase) continue;

    // Sesiones agendadas en la página desde la fecha nueva que siguen con el monto antiguo.
    let sesionesConMontoAntiguo = 0;
    // Las vocales van como comodín de una letra: "María" calza con "Maria" y viceversa.
    const palabras = c.nombre.split(/\s+/).filter((p) => p.length >= 3).map((p) => p.replace(/[aeiouáéíóú]/gi, '_'));
    // Con una sola palabra (ej. solo "Ana" → "_n_") el patrón calzaba con
    // muchas pacientes y el conteo era falso (8 oct 2026): se exigen al menos
    // dos palabras de 3+ letras (nombre y apellido); si no, no se cuenta.
    if (palabras.length >= 2) {
      const patron = `%${palabras.join('%')}%`;
      const { count } = await supabase.from('bookings').select('id', { count: 'exact', head: true })
        .gte('session_date', c.desde).neq('session_date', '2099-12-31')
        .not('status', 'in', '(cancelled,expired)')
        .lt('amount', c.nuevo)
        .ilike('patient_name', patron);
      sesionesConMontoAntiguo = count ?? 0;
    }
    out.push({ ...c, fase, atrasado: fase === 'avisar' && hoy >= c.desde, sesionesConMontoAntiguo });
  }
  return out;
}
