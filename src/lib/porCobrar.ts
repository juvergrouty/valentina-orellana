import { supabase } from './supabase';
import { todayCL, hoursUntilSessionCL } from './dateUtils';
import { esCobrable, type Cobrable } from './debt';

// Sesiones sin pagar, separadas en DOS listas que no se tocan (14 oct 2026),
// según si la sesión ya empezó (hora de Chile):
//  - "Por cobrar" (/admin/por-cobrar y su tarjeta del Inicio): aún no empieza.
//  - "Te deben"   (/admin/deudas y su tarjeta del Inicio): ya empezó.
// Regla común: sin pagar (paid_at vacío), confirmada o esperando pago (no
// cancelada ni vencida), sin deuda anulada y con monto. Los cobros manuales sin
// sesión (2099-12-31) ya se deben: van solo en "Te deben".
// OJO: esto NO cambia lo que cobra /pagar/[id] (src/lib/debt.ts), que sigue
// cobrando todo lo pendiente del paciente, también lo que aún no ocurre.

/** ¿La sesión ya empezó? (los cobros sin fecha, 2099-12-31, cuentan como ya debidos). */
export function sesionYaEmpezo(fecha: string, hora: string | null): boolean {
  if (fecha === '2099-12-31') return true;
  const hoy = todayCL();
  if (fecha !== hoy) return fecha < hoy;
  return !hora || hoursUntilSessionCL(fecha, String(hora).slice(0, 5)) <= 0;
}

export type SesionSinPagar = {
  id: string;
  patient_name: string;
  patient_email: string | null;
  patient_phone: string | null;
  session_type: string;
  session_date: string;
  session_time: string | null;
  amount: number;
  mp_preference_id: string | null;
  created_at: string | null;
  notes: string | null;
  status: string;
};
export type SesionPorCobrar = SesionSinPagar;
export type SesionAdeudada = SesionSinPagar;

const COLUMNAS = 'id, patient_name, patient_email, patient_phone, session_type, session_date, session_time, amount, mp_preference_id, created_at, notes, status, paid_at, debt_voided, created_by_admin, payment_method';

async function sinPagar(desde?: string): Promise<SesionSinPagar[]> {
  let q = supabase
    .from('bookings')
    .select(COLUMNAS)
    .is('paid_at', null)
    .in('status', ['confirmed', 'pending_payment'])
    .or('debt_voided.is.null,debt_voided.eq.false')
    .gt('amount', 0);
  if (desde) q = q.gte('session_date', desde);
  const { data, error } = await q.order('session_date', { ascending: true }).order('session_time', { ascending: true });
  if (error) throw new Error(error.message);
  // Misma regla que Finanzas, Pacientes y /pagar (src/lib/debt.ts, esCobrable):
  // sin las que Flow ya informó pagadas.
  return ((data ?? []) as (SesionSinPagar & Cobrable)[]).filter(esCobrable);
}

/** Por cobrar: sin pagar y la sesión todavía no empieza. */
export async function sesionesPorCobrar(): Promise<SesionPorCobrar[]> {
  return (await sinPagar(todayCL())).filter((b) => !sesionYaEmpezo(b.session_date, b.session_time));
}

/** Te deben: sin pagar y la sesión ya empezó (o es un cobro manual sin fecha). */
export async function sesionesQueTeDeben(): Promise<SesionAdeudada[]> {
  return (await sinPagar()).filter((b) => sesionYaEmpezo(b.session_date, b.session_time));
}
