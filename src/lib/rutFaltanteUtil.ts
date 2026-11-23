// Aviso obligatorio de RUT (23 nov 2026, Vale: «el sistema me debe avisar siempre que no haya rut»).
// Regla pura (sin base de datos) para poder probarla: rutFaltanteUtil.test.ts.
import { rutValido } from './rut';

/** Desde cuántos días atrás se revisan los pagos (los muy antiguos ya se resolvieron por otro lado). */
export const DIAS_RUT_FALTANTE = 60;

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
  if (tieneBoletaVigente(b.notes)) return false;
  if (rutValido(b.patient_rut) || rutValido(ficha?.rut) || ficha?.sin_rut === true) return false;
  return true;
}
