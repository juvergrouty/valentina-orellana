import { supabase } from './supabase';
import { todayCL, hoursUntilSessionCL } from './dateUtils';

// Encuadrado al día (Valentina, 15 oct 2026): cada sesión de la página tiene que
// existir también en Encuadrado (ahí corre el transcriptor), y nada se pasa
// solo. El panel avisa cuando hay que agendar, reagendar o eliminar una sesión
// en Encuadrado, con un botón "Listo" para cuando ya lo hizo.
//
// No depende de cada camino que crea o mueve sesiones (panel, reserva web,
// pago de Flow, reagendar de la paciente, /recuperar): se compara el estado
// actual de las reservas con lo último que Valentina marcó como hecho en
// Encuadrado. Un registro por sesión en settings
// ("encuadrado:<id de reserva>" → { fecha, hora, paciente }), igual que el box
// de Espacio Cala, para que dos clics seguidos no se pisen.
const PREFIJO = 'encuadrado:';
// Punto de partida: las sesiones que ya existían cuando se activó el aviso se
// dan por agendadas en Encuadrado (ella ya las tenía ahí).
const CLAVE_INICIO = 'encuadrado_inicio';
const SIN_FECHA = '2099-12-31'; // cobro manual sin sesión

export type SesionEncuadrado = { id: string; paciente: string; fecha: string; hora: string; tipo: string };
export type CambioEncuadrado = SesionEncuadrado & { antes: { fecha: string; hora: string } };
export type AvisosEncuadrado = {
  agendar: SesionEncuadrado[];
  reagendar: CambioEncuadrado[];
  eliminar: SesionEncuadrado[];
};

type Registro = { fecha: string; hora: string; paciente: string; tipo: string };
type Fila = {
  id: string; patient_name: string | null; session_date: string; session_time: string;
  session_type: string | null; status: string; created_by_admin?: boolean | null; notes?: string | null;
};

const TIPOS: Record<string, string> = {
  online: 'Individual online',
  presencial: 'Individual presencial',
  'pareja-online': 'Pareja online',
  'pareja-presencial': 'Pareja presencial',
};
const tipoDe = (t: string | null) => TIPOS[String(t ?? '')] ?? 'Sesión';
const hhmm = (t: string) => String(t).slice(0, 5);

// Sesión que de verdad va a ocurrir: pagada, agendada por Valentina (aunque
// espere el pago) o con pago informado. Una reserva web sin pagar todavía no
// (se libera sola a los 30 min si no paga).
function esReal(b: Fila): boolean {
  if (b.status === 'cancelled' || b.status === 'expired') return false;
  if (String(b.session_date) === SIN_FECHA) return false;
  if (b.status === 'confirmed' || b.created_by_admin) return true;
  return /ComprobanteTransferencia|PagoSinAviso/.test(b.notes ?? '');
}

const registroDe = (b: Fila): Registro => ({
  fecha: String(b.session_date), hora: hhmm(b.session_time),
  paciente: String(b.patient_name ?? '').trim(), tipo: tipoDe(b.session_type),
});

async function leerRegistros(): Promise<Map<string, Registro>> {
  const { data, error } = await supabase.from('settings').select('key, value').like('key', `${PREFIJO}%`);
  if (error) throw new Error(error.message);
  const out = new Map<string, Registro>();
  for (const f of data ?? []) {
    let v: Partial<Registro> = {};
    try { v = JSON.parse(f.value || '{}') ?? {}; } catch { /* ilegible: queda sin fecha */ }
    out.set(String(f.key).slice(PREFIJO.length), {
      fecha: String(v.fecha ?? ''), hora: String(v.hora ?? ''),
      paciente: String(v.paciente ?? ''), tipo: String(v.tipo ?? 'Sesión'),
    });
  }
  return out;
}

async function sesionesFuturas(hoy: string): Promise<Fila[]> {
  const { data, error } = await supabase.from('bookings')
    .select('id, patient_name, session_date, session_time, session_type, status, created_by_admin, notes')
    .gte('session_date', hoy).neq('session_date', SIN_FECHA).neq('status', 'cancelled')
    .order('session_date').order('session_time');
  if (error) throw new Error(error.message);
  return (data ?? []) as Fila[];
}

export async function avisosEncuadrado(): Promise<AvisosEncuadrado> {
  const hoy = todayCL();
  const [{ data: inicio, error: inicioErr }, registros, futuras] = await Promise.all([
    supabase.from('settings').select('value').eq('key', CLAVE_INICIO).maybeSingle(),
    leerRegistros(),
    sesionesFuturas(hoy),
  ]);
  if (inicioErr) throw new Error(inicioErr.message);
  const reales = futuras.filter(esReal);

  // Primera vez: todo lo que ya estaba agendado se da por hecho en Encuadrado.
  if (!inicio) {
    const filas = reales.map((b) => ({ key: PREFIJO + b.id, value: JSON.stringify(registroDe(b)), updated_at: new Date().toISOString() }));
    for (let i = 0; i < filas.length; i += 200) {
      const { error } = await supabase.from('settings').upsert(filas.slice(i, i + 200), { onConflict: 'key', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
    const { error } = await supabase.from('settings').upsert({ key: CLAVE_INICIO, value: new Date().toISOString() }, { onConflict: 'key', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return { agendar: [], reagendar: [], eliminar: [] };
  }

  const out: AvisosEncuadrado = { agendar: [], reagendar: [], eliminar: [] };
  const vistos = new Set<string>();
  for (const b of reales) {
    vistos.add(b.id);
    const actual = registroDe(b);
    // Ya empezó (p. ej. una sesión de hoy anotada después para cobrarla): el
    // transcriptor ya no sirve, no hay nada que hacer en Encuadrado.
    if (hoursUntilSessionCL(actual.fecha, actual.hora) <= 0) continue;
    const sesion = { id: b.id, ...actual };
    const reg = registros.get(b.id);
    if (!reg) out.agendar.push(sesion);
    else if (reg.fecha !== actual.fecha || reg.hora !== actual.hora || reg.tipo !== actual.tipo) out.reagendar.push({ ...sesion, antes: { fecha: reg.fecha, hora: reg.hora } });
  }

  // Registradas en Encuadrado que ya no son una sesión futura de la página:
  // anuladas, borradas o vencidas sin pagar → hay que eliminarlas allá. Si la
  // sesión se movió a una fecha pasada o el registro ya es de una fecha pasada,
  // no hay nada que hacer en Encuadrado: se limpia el registro.
  const sueltos = [...registros.entries()].filter(([id]) => !vistos.has(id));
  const viejos: string[] = [];
  for (const [id, reg] of sueltos) {
    const sigueFutura = futuras.some((b) => b.id === id); // futura pero no real (p. ej. vencida sin pagar)
    if (reg.fecha && reg.fecha >= hoy && hoursUntilSessionCL(reg.fecha, reg.hora || '23:59') > 0) out.eliminar.push({ id, paciente: reg.paciente, fecha: reg.fecha, hora: reg.hora, tipo: reg.tipo });
    else if (!sigueFutura && (!reg.fecha || reg.fecha < hoy)) viejos.push(PREFIJO + id);
  }
  if (viejos.length) await supabase.from('settings').delete().in('key', viejos.slice(0, 200));

  const orden = (a: { fecha: string; hora: string }, b: { fecha: string; hora: string }) => `${a.fecha}T${a.hora}`.localeCompare(`${b.fecha}T${b.hora}`);
  out.agendar.sort(orden); out.reagendar.sort(orden); out.eliminar.sort(orden);
  return out;
}

/** "Listo" de agendar o reagendar: guarda la sesión tal como la mostraba el
 *  aviso (fecha/hora del botón). Si se movió entre que se abrió la página y el
 *  clic, el aviso vuelve a salir con la hora nueva. */
export async function marcarEncuadradoListo(id: string, fecha: string, hora: string): Promise<void> {
  const { data, error } = await supabase.from('bookings')
    .select('id, patient_name, session_date, session_time, session_type, status, created_by_admin, notes')
    .eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('sesión no encontrada');
  const reg = { ...registroDe(data as Fila), fecha, hora };
  const { error: e2 } = await supabase.from('settings').upsert(
    { key: PREFIJO + id, value: JSON.stringify(reg), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (e2) throw new Error(e2.message);
}

/** "Listo" de eliminar: ya no está en Encuadrado. */
export async function marcarEncuadradoEliminado(id: string): Promise<void> {
  const { error } = await supabase.from('settings').delete().eq('key', PREFIJO + id);
  if (error) throw new Error(error.message);
}
