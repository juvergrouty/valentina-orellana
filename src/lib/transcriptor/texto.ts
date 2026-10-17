// Transcriptor IA — reparación de texto con "mojibake" Mac Roman (17 oct 2026).
//
// Síntoma en producción: la ficha mostraba "Resumen autom√°tico (IA) ‚Äî no revisado". Es el texto UTF-8
// correcto ("automático", "—") leído byte a byte como Mac Roman (á = C3 A1 → "√°"; — = E2 80 94 → "‚Äî").
// Verificado: todos los archivos de src/ y supabase/migrations/ son UTF-8 válido y no contienen "√"; ese
// rótulo NO lo escribe el código: sale del DEFAULT de resumenes_ia.rotulo (0014_transcriptor.sql), o sea,
// el texto se corrompió al pegar la migración en el SQL Editor de Supabase. Lo mismo afecta a los demás
// textos con tildes que solo existen en la base por migración (semilla de instrucciones_ia, el ajuste
// transcriptor_bot_nombres_vale de 0016). La migración 0024 los corrige en la base; esta función es la red
// de seguridad al LEER (los resúmenes 'listo' no se pueden modificar por el trigger de inmutabilidad).

/** Bytes 0x80–0xFF en Mac Roman (Unicode), en orden. */
const MAC_ROMAN_ALTO =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

const BYTE_DE = new Map<string, number>([...MAC_ROMAN_ALTO].map((c, i) => [c, 0x80 + i]));

/** Señales típicas: lead bytes de UTF-8 de 2 bytes (C2/C3 → "¬"/"√") o de 3 bytes (E2 → "‚"). */
const SOSPECHA = /[√¬]|‚Ä/;

/**
 * Si `texto` es UTF-8 leído como Mac Roman, devuelve el original; si no, lo devuelve igual.
 * Conservador: solo cambia si TODOS los caracteres existen en Mac Roman y el resultado es UTF-8 válido.
 */
export function repararMojibake(texto: string): string;
export function repararMojibake(texto: string | null | undefined): string | null | undefined;
export function repararMojibake(texto: string | null | undefined): string | null | undefined {
  if (typeof texto !== 'string' || !SOSPECHA.test(texto)) return texto;
  const bytes: number[] = [];
  for (const c of texto) {
    const cp = c.codePointAt(0)!;
    if (cp < 0x80) { bytes.push(cp); continue; }
    const b = BYTE_DE.get(c);
    if (b === undefined) return texto; // no es Mac Roman puro: no se toca
    bytes.push(b);
  }
  try {
    const out = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    return out === texto ? texto : out;
  } catch {
    return texto;
  }
}
