/** Una URL de vuelta ("redirect") solo puede ser una ruta de este mismo sitio
 *  (empieza con "/" y no con "//"); si no, se usa la de respaldo. Evita que un
 *  link armado mande al panel a otra página. */
export function rutaInterna(valor: unknown, respaldo: string): string {
  const v = typeof valor === 'string' ? valor.trim() : '';
  // Sin caracteres de control ni espacios (8 oct 2026): el navegador borra
  // tabs/saltos de línea de las URLs, así "/\t/evil.com" terminaba como
  // //evil.com (otro sitio). También se rechaza cualquier barra invertida.
  if (/[\x00-\x20\\]/.test(v)) return respaldo;
  return /^\/(?![/\\])/.test(v) ? v : respaldo;
}
