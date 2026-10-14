import { supabase } from './supabase';
import { todayCL, hoursUntilSessionCL } from './dateUtils';

// "Por cobrar" (14 oct 2026): UNA sola definición para la tarjeta del Inicio
// y la página /admin/por-cobrar (antes no calzaban: la tarjeta contaba solo
// "pending_payment" desde hoy y la página incluía también sesiones pasadas).
// Es: sesión que todavía no empieza, sin pagar (paid_at vacío), no cancelada
// ni vencida, sin deuda anulada, con monto, y con fecha real (no los cobros
// manuales sin sesión, que van en /admin/cobros). Lo ya ocurrido y sin pagar
// es deuda: /admin/deudas.
export type SesionPorCobrar = {
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
  status: string;
};

export async function sesionesPorCobrar(): Promise<SesionPorCobrar[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, patient_name, patient_email, patient_phone, session_type, session_date, session_time, amount, mp_preference_id, created_at, status')
    .is('paid_at', null)
    .not('status', 'in', '(cancelled,expired)')
    .or('debt_voided.is.null,debt_voided.eq.false')
    .gte('session_date', todayCL())
    .neq('session_date', '2099-12-31')
    .gt('amount', 0)
    .order('session_date', { ascending: true })
    .order('session_time', { ascending: true });
  if (error) throw new Error(error.message);
  // Las de hoy que ya empezaron dejan de estar "por cobrar".
  return ((data ?? []) as SesionPorCobrar[]).filter((b) =>
    !b.session_time || hoursUntilSessionCL(b.session_date, String(b.session_time).slice(0, 5)) > 0);
}
