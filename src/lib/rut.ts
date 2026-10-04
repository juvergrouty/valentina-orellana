// RUT chileno: formato y dígito verificador (módulo 11).

/** RUT genérico que el SII indica usar en una boleta de honorarios a un
 *  extranjero sin RUT, junto con su nombre (SII en X, 2019 y 2022). */
export const RUT_EXTRANJERO_SII = '44444446-0';

/** "12.345.678-k" → "12345678-K" (sin validar). */
export function limpiarRut(rut: string | null | undefined): string {
  return String(rut ?? '').trim().toUpperCase().replace(/[.\s]/g, '');
}

/** ¿Formato 12345678-9 con dígito verificador correcto? */
export function rutValido(rut: string | null | undefined): boolean {
  const r = limpiarRut(rut);
  const m = /^(\d{7,8})-([\dK])$/.exec(r);
  if (!m) return false;
  let suma = 0, mult = 2;
  for (let i = m[1].length - 1; i >= 0; i--) {
    suma += Number(m[1][i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const resto = 11 - (suma % 11);
  const dv = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  return dv === m[2];
}

export const TIPOS_DOCUMENTO = ['Pasaporte', 'Documento de identidad', 'Otro'] as const;
