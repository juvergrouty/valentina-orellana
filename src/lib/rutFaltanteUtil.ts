// Aviso obligatorio de RUT (23 nov 2026, Vale: «el sistema me debe avisar siempre que no haya rut»).
// Regla pura (sin base de datos) para poder probarla: rutFaltanteUtil.test.ts.
import { rutValido } from './rut';

/** «Marcar como pagado» con la casilla de boleta desmarcada: Vale no quiere boleta para esa sesión. */
export const MARCA_SIN_BOLETA_A_PROPOSITO = 'SinBoletaAProposito';

/**
 * Desde cuándo se revisan los pagos: el 1° del mes anterior (hora de Chile). Es el mismo límite que
 * acepta el SII para fechar la boleta con el día del pago (fechaEmisionBoleta en apigateway.ts):
 * así «sale con la fecha del pago» siempre es verdad.
 */
export function desdeRutFaltante(hoyChile: string): string {
  const [y, m] = hoyChile.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
}

export type SesionParaRut = {
  paid_at?: string | null; amount?: number | null; status?: string | null; payment_note?: string | null;
  notes?: string | null; debt_voided?: boolean | null; patient_rut?: string | null;
};
export type FichaParaRut = { rut?: string | null; sin_rut?: boolean | null } | null | undefined;

/** ¿La boleta de esta sesión ya salió (último folio no anulado)? Misma regla que folioVigente (apigateway.ts). */
export function tieneBoletaVigente(notes: string | null | undefined): boolean {
  const lineas = [...String(notes ?? '').matchAll(/Boleta\s+Folio\s+(\d+)[^\n]*/gi)];
  const ultima = lineas.at(-1);
  return !!ultima && !/ANULADA/i.test(ultima[0]);
}

/**
 * ¿Falta el RUT para la boleta? Sí si la sesión está pagada, tiene monto, no es «Sin costo», no está
 * anulada ni vencida, su boleta no salió y no hay RUT válido ni en la sesión ni en la ficha (ni la
 * ficha dice «no tiene RUT»: ahí la boleta sale con el RUT del SII para extranjeros).
 * Excepción: cobro de SumUp «asociado sin boleta», que Vale eligió a propósito sin boleta.
 */
export function faltaRutParaBoleta(b: SesionParaRut, ficha?: FichaParaRut): boolean {
  if (!b.paid_at || !((b.amount ?? 0) > 0) || b.debt_voided === true) return false;
  if (b.status === 'cancelled' || b.status === 'expired') return false;
  if (b.payment_note === 'Sin costo') return false;
  if (/asociado sin boleta/i.test(b.notes ?? '')) return false;
  if (new RegExp(`^${MARCA_SIN_BOLETA_A_PROPOSITO}\\b`, 'm').test(b.notes ?? '')) return false;
  if (tieneBoletaVigente(b.notes)) return false;
  if (rutValido(b.patient_rut) || rutValido(ficha?.rut) || ficha?.sin_rut === true) return false;
  return true;
}
