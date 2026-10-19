// "Pago en consulta" (decisión de Vale, 19 oct 2026; ella dice que nadie paga en consulta, así que el
// cambio es mínimo): una hora agendada desde el panel con "Pago en consulta" NO es una hora por pagar con
// link. No muestra "pago vence 24 h antes" ni "si no paga, mueve el box", no ofrece el link de pago y se
// ve distinta: "Paga en consulta" (agenda, ficha y avisos de cobro).
//
// Cómo se reconoce: desde hoy, "Agendar hora" con "Pago en consulta" deja la marca "PagoEnConsulta" en
// las notas de la reserva (igual que BoletaProgramada o MontoAntesDeSinCosto; sin migración). Las horas
// antiguas con payment_method 'manual' NO se reinterpretan: hasta el 19 oct "Pago en consulta" era la
// opción por defecto del panel y esas horas se cobran por link/transferencia, así que siguen igual.
// Función pura (la usan el servidor y, con la misma regla, el script de la agenda).
export const MARCA_PAGO_EN_CONSULTA = 'PagoEnConsulta';
export const ETIQUETA_PAGO_EN_CONSULTA = 'Paga en consulta';

export type ReservaPago = { status?: string | null; paid_at?: string | null; debt_voided?: boolean | null; notes?: string | null; payment_method?: string | null };

/** ¿Tiene la marca de "Pago en consulta"? (aunque ya esté pagada) */
export function tieneMarcaPagoEnConsulta(notes: string | null | undefined): boolean {
  return String(notes ?? '').split('\n').some((l) => l.trim() === MARCA_PAGO_EN_CONSULTA);
}

/** Hora vigente, sin pagar, que se paga en la consulta (no se cobra por link ni vence). */
export function esPagoEnConsulta(b: ReservaPago): boolean {
  if (b.paid_at || b.debt_voided === true) return false;
  if (b.status === 'cancelled' || b.status === 'expired') return false;
  // Solo horas agendadas por el panel como "manual" (si no viene la columna, basta la marca; las notas de
  // la paciente no pueden imitarla: notasPaciente.ts la neutraliza).
  if (b.payment_method !== undefined && b.payment_method !== null && b.payment_method !== 'manual') return false;
  return tieneMarcaPagoEnConsulta(b.notes);
}
