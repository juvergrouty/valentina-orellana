import { supabase } from './supabase';
import { agregarLineaNotas } from './apigateway';
import { comprobanteEnRevision } from './comprobantes';

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
  notes?: string | null;
}

// Los "cobros manuales" (monto/descripción libre desde /admin/cobros) se guardan
// con session_date='2099-12-31' como marcador de "no es una sesión con fecha" —
// su descripción real vive en notes: "Cobro manual generado desde admin · <texto>".
const MANUAL_CHARGE_PREFIX = 'Cobro manual generado desde admin · ';
export function manualChargeLabel(notes: string | null | undefined): string | null {
  const line = (notes ?? '').split('\n').find((l) => l.startsWith(MANUAL_CHARGE_PREFIX));
  return line ? line.slice(MANUAL_CHARGE_PREFIX.length).trim() || null : null;
}

// ¿Esta sesión se le debe cobrar a la paciente? ÚNICA regla para el panel
// (Inicio, Deudas, Por cobrar, Finanzas, Pacientes) y el link /pagar
// (auditoría 15 oct 2026: antes había tres reglas distintas y los totales no
// cuadraban entre páginas). Se cobra si no está pagada ni anulada, tiene monto
// y es una sesión de verdad: confirmada, agendada por Valentina (aunque espere
// el pago) o con comprobante de transferencia. NO se cobra:
// - una reserva web recién apartada sin pagar (la paciente está pagando en su
//   pestaña de Flow; si no paga, vence sola a los 30 min);
// - una que Flow ya informó como pagada (PagoSinAviso: solo falta su aviso).
export type Cobrable = {
  status: string; paid_at?: string | null; debt_voided?: boolean | null; amount?: number | null;
  created_by_admin?: boolean | null; notes?: string | null;
};
export function esCobrable(b: Cobrable): boolean {
  if (b.paid_at || b.debt_voided === true || !((b.amount ?? 0) > 0)) return false;
  const notas = b.notes ?? '';
  if (notas.includes('PagoSinAviso')) return false;
  if (b.status === 'confirmed') return true;
  return b.status === 'pending_payment' && (b.created_by_admin === true || notas.includes('ComprobanteTransferencia'));
}

export async function getPendingDebtByEmail(email: string): Promise<DebtBooking[]> {
  const { data } = await supabase
    .from('bookings')
    .select('id, session_type, session_date, session_time, amount, notes, status, paid_at, debt_voided, created_by_admin')
    .eq('patient_email', email.toLowerCase())
    .eq('status', 'confirmed')
    .is('paid_at', null)
    .or('debt_voided.is.null,debt_voided.eq.false')
    .gt('amount', 0)
    .order('session_date', { ascending: true });
  // Misma regla única (esCobrable): sin las que Flow ya informó pagadas.
  return (data ?? []).filter(esCobrable).map(({ status: _s, paid_at: _p, debt_voided: _d, created_by_admin: _c, ...b }) => b);
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
  // agregarLineaNotas: escritura atómica, no pisa otra marca escrita al mismo tiempo.
  await Promise.all(bookingIds.map((id) => agregarLineaNotas(id, `PagoToken ${token}`)));
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
      .select('id, session_type, session_date, session_time, amount, notes, status, paid_at, debt_voided, created_by_admin')
      .eq('patient_email', email.toLowerCase())
      .eq('status', 'pending_payment')
      // Antes se excluían acá los cobros manuales (session_date='2099-12-31'):
      // no aparecían nunca en el link combinado /pagar/[id], así que ese cobro
      // solo se podía pagar con el link crudo de Flow que /admin/cobros
      // mandaba aparte — inconsistente con el resto ("Cobrar" siempre junta
      // TODO lo pendiente). Ahora se incluyen; /pagar/[id] los muestra con su
      // descripción real (ver manualChargeLabel) en vez de un tipo de sesión.
      .gt('amount', 0)
      .order('session_date', { ascending: true })
      // Sin reservas web recién apartadas ni pagadas sin aviso (esCobrable):
      // antes el link /pagar las arrastraba y se podía cobrar dos veces.
      .then(r => (r.data ?? []).filter(esCobrable).map(({ status: _s, paid_at: _p, debt_voided: _d, created_by_admin: _c, ...b }) => b)),
  ]);
  return [...deuda, ...porCobrar].sort((a, b) => a.session_date.localeCompare(b.session_date));
}

/** Monto que /pagar/[id] le cobra HOY a la paciente: todo lo que debe
 *  (getTotalOwedByEmail) menos lo que tiene un comprobante de transferencia en
 *  revisión — el mismo cálculo de /pagar y pagar-deuda.ts. Lo usan los mensajes
 *  del link de pago, para que digan el total real y no solo el cobro nuevo (8 oct 2026). */
export async function totalACobrarPorEmail(email: string): Promise<number> {
  const todo = await getTotalOwedByEmail(email);
  return todo.filter(b => !comprobanteEnRevision(b.notes)).reduce((s, b) => s + (b.amount ?? 0), 0);
}
