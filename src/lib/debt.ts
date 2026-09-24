import { supabase } from './supabase';

// "Deuda real" = misma definición usada en el calendario (agenda.astro, evClass)
// y en /admin/deudas: reserva CONFIRMADA (la sesión se dio o se va a dar) sin
// paid_at (nadie registró que se cobró) y sin deuda anulada. Único lugar que
// define esto — /admin/deudas, finanzas.astro y /pagar/[id] lo usan todos.
export interface DebtBooking {
  id: string;
  session_type: string;
  session_date: string;
  session_time: string | null;
  amount: number;
}

export async function getPendingDebtByEmail(email: string): Promise<DebtBooking[]> {
  const { data } = await supabase
    .from('bookings')
    .select('id, session_type, session_date, session_time, amount')
    .eq('patient_email', email.toLowerCase())
    .eq('status', 'confirmed')
    .is('paid_at', null)
    .or('debt_voided.is.null,debt_voided.eq.false')
    .gt('amount', 0)
    .order('session_date', { ascending: true });
  return data ?? [];
}
