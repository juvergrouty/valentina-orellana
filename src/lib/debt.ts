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

// Guarda un historial (en `notes`, sin pisar lo que ya había) de TODOS los
// tokens de Flow que alguna vez se generaron para una reserva. mp_preference_id
// solo guarda el ÚLTIMO — si se manda un link individual y después uno
// combinado (ej. "Cobrar todo"), el combinado sobrescribe mp_preference_id de
// esa reserva y el link individual anterior queda "huérfano". Con este
// historial, el webhook (flow/confirm.ts) puede encontrar la reserva aunque el
// paciente pague con CUALQUIERA de los links que se le hayan mandado, sin
// importar el orden en que se generaron ni cuál quedó como "el vigente".
export async function tagBookingsWithPaymentToken(bookingIds: string[], token: string): Promise<void> {
  const { data: rows } = await supabase.from('bookings').select('id, notes').in('id', bookingIds);
  await Promise.all((rows ?? []).map((r: { id: string; notes: string | null }) =>
    supabase.from('bookings').update({ notes: `${r.notes ? r.notes + '\n' : ''}PagoToken ${token}` }).eq('id', r.id)
  ));
}

// "Todo lo que el paciente debe pagar" = deuda real (arriba) MÁS las sesiones
// futuras con link de pago ya enviado pero aún sin pagar (pending_payment).
// Uso específico: el link de "Cobrar" (desde deudas, calendario o sesiones por
// cobrar) siempre debe juntar TODO en un solo pago — igual que Encuadrado, que
// "saca la totalidad de lo que el paciente debe y lo cobra" sin importar si es
// una sesión que ya pasó o una agendada a futuro. La distinción Deuda/Por
// cobrar se mantiene solo para cómo se LISTA en el admin (son conceptos
// distintos para Valentina); para cobrar, se combinan.
export async function getTotalOwedByEmail(email: string): Promise<DebtBooking[]> {
  const [deuda, porCobrar] = await Promise.all([
    getPendingDebtByEmail(email),
    supabase
      .from('bookings')
      .select('id, session_type, session_date, session_time, amount')
      .eq('patient_email', email.toLowerCase())
      .eq('status', 'pending_payment')
      .neq('session_date', '2099-12-31') // cobro manual sin fecha, no es una sesión
      .gt('amount', 0)
      .order('session_date', { ascending: true })
      .then(r => r.data ?? []),
  ]);
  return [...deuda, ...porCobrar].sort((a, b) => a.session_date.localeCompare(b.session_date));
}
