// Países para el selector de teléfono (Chile primero y por defecto).
// cc: código telefónico sin "+". min/max: dígitos del número sin el código.
export type Pais = { iso: string; nombre: string; cc: string; min: number; max: number };

const p = (iso: string, nombre: string, cc: string, min = 6, max = 12): Pais => ({ iso, nombre, cc, min, max });

export const PAIS_DEFECTO = p('CL', 'Chile', '56', 9, 9);

export const PAISES: Pais[] = [
  PAIS_DEFECTO,
  p('AR', 'Argentina', '54', 10, 11),
  p('PE', 'Perú', '51', 8, 9),
  p('BO', 'Bolivia', '591', 8, 8),
  p('CO', 'Colombia', '57', 10, 10),
  p('VE', 'Venezuela', '58', 10, 10),
  p('EC', 'Ecuador', '593', 8, 9),
  p('UY', 'Uruguay', '598', 8, 8),
  p('PY', 'Paraguay', '595', 9, 9),
  p('BR', 'Brasil', '55', 10, 11),
  p('MX', 'México', '52', 10, 10),
  p('US', 'Estados Unidos', '1', 10, 10),
  p('CA', 'Canadá', '1', 10, 10),
  p('ES', 'España', '34', 9, 9),
  p('DE', 'Alemania', '49'),
  p('AU', 'Australia', '61', 9, 9),
  p('AT', 'Austria', '43'),
  p('BE', 'Bélgica', '32', 8, 9),
  p('CN', 'China', '86', 11, 11),
  p('CR', 'Costa Rica', '506', 8, 8),
  p('CU', 'Cuba', '53', 8, 8),
  p('DK', 'Dinamarca', '45', 8, 8),
  p('SV', 'El Salvador', '503', 8, 8),
  p('FR', 'Francia', '33', 9, 9),
  p('GT', 'Guatemala', '502', 8, 8),
  p('HT', 'Haití', '509', 8, 8),
  p('HN', 'Honduras', '504', 8, 8),
  p('IN', 'India', '91', 10, 10),
  p('IE', 'Irlanda', '353', 9, 9),
  p('IL', 'Israel', '972', 9, 9),
  p('IT', 'Italia', '39', 9, 11),
  p('JP', 'Japón', '81', 10, 10),
  p('NI', 'Nicaragua', '505', 8, 8),
  p('NO', 'Noruega', '47', 8, 8),
  p('NZ', 'Nueva Zelanda', '64', 8, 10),
  p('NL', 'Países Bajos', '31', 9, 9),
  p('PA', 'Panamá', '507', 8, 8),
  p('PT', 'Portugal', '351', 9, 9),
  p('GB', 'Reino Unido', '44', 10, 10),
  p('DO', 'República Dominicana', '1', 10, 10),
  p('SE', 'Suecia', '46', 7, 10),
  p('CH', 'Suiza', '41', 9, 9),
];

/** Bandera (emoji) a partir del código ISO del país. */
export const bandera = (iso: string) =>
  String.fromCodePoint(...[...iso.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));

/** País de un número completo "+<código>…": el de código más largo que calce (Chile si +56). */
export function paisDeNumero(completo: string): Pais | null {
  const d = completo.replace(/\D/g, '');
  let mejor: Pais | null = null;
  for (const pa of PAISES) {
    if (d.startsWith(pa.cc) && (!mejor || pa.cc.length > mejor.cc.length)) mejor = pa;
  }
  return mejor;
}

/** Número local con espacios, como se escribe en cada país. */
export function formatearNacional(pais: Pais, digitos: string): string {
  const d = digitos;
  if (pais.cc === '56') {
    if (d.length <= 1) return d;
    if (d.length <= 5) return `${d[0]} ${d.slice(1)}`;
    return `${d[0]} ${d.slice(1, 5)} ${d.slice(5)}`;
  }
  if (pais.cc === '1') {
    if (d.length <= 3) return d;
    if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
    return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  }
  // Resto de los países: grupos de 3 o 4, como suelen escribirse.
  const grupos: Record<number, number[]> = { 7: [3, 4], 8: [4, 4], 9: [3, 3, 3], 10: [3, 3, 4], 11: [3, 4, 4], 12: [4, 4, 4] };
  const g = grupos[d.length];
  if (!g) return d.replace(/(\d{3})(?=\d)/g, '$1 ');
  let i = 0;
  return g.map(n => d.slice(i, (i += n))).join(' ');
}
