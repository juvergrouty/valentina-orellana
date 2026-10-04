/** Una URL de vuelta ("redirect") solo puede ser una ruta de este mismo sitio
 *  (empieza con "/" y no con "//"); si no, se usa la de respaldo. Evita que un
 *  link armado mande al panel a otra página. */
export function rutaInterna(valor: unknown, respaldo: string): string {
  const v = typeof valor === 'string' ? valor.trim() : '';
  return /^\/(?![/\\])/.test(v) && !v.includes('\\') ? v : respaldo;
}
