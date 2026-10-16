// Transcriptor IA — contenido de resumenes_ia CIFRADO (81-revision-etica-clinica H7; 10-etica-legal §4.8:
// "si el resumen se guarda en Supabase, cifrarlo igual"). Columna nueva de 0019:
//   resumenes_ia.contenido_cifrado bytea   (formato VOT1 de cifrado.ts, DEK propia por resumen)
//   resumenes_ia.contenido_kek_v   smallint
// La llave del objeto (va en el AAD) es `resumenes_ia/<id>/contenido` y el tipo 'resumen': un
// resumen copiado a otra fila o leído como otro tipo no se descifra.
// Compatibilidad: las filas viejas (antes de 0019) tienen `contenido` en claro y se siguen leyendo;
// todo lo nuevo se escribe cifrado y con `contenido = null`.
import { cifrado as cifradoPorDefecto, type ContextoCifrado, type CifradoVOT1 } from './cifrado';

type Cif = Pick<CifradoVOT1, 'cifrar' | 'descifrar'>;

export function ctxResumen(resumenId: string): ContextoCifrado {
  return { claveObjeto: `resumenes_ia/${resumenId}/contenido`, tipo: 'resumen' };
}

const aHex = (b: Uint8Array) => `\\x${Buffer.from(b).toString('hex')}`;

/** bytea que devuelve PostgREST ('\x…' en hex) → bytes. También acepta base64 y Uint8Array. */
export function bytesDeBytea(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof v !== 'string' || !v) return null;
  if (/^\\x[0-9a-f]*$/i.test(v)) return Uint8Array.from(Buffer.from(v.slice(2), 'hex'));
  return Uint8Array.from(Buffer.from(v, 'base64'));
}

/** Columnas para insert/update de un resumen listo: contenido en claro NUNCA se guarda. */
export async function columnasContenidoCifrado(resumenId: string, texto: string, cif: Cif = cifradoPorDefecto): Promise<{
  contenido: null; contenido_cifrado: string; contenido_kek_v: number;
}> {
  const r = await cif.cifrar(new TextEncoder().encode(texto), ctxResumen(resumenId));
  return { contenido: null, contenido_cifrado: aHex(r.datos), contenido_kek_v: r.kekV };
}

export interface FilaConContenido { id: string; contenido?: string | null; contenido_cifrado?: unknown }

/** Texto del resumen (descifra si está cifrado; si es una fila antigua, su `contenido`). Lanza si no se puede descifrar. */
export async function leerContenidoResumen(f: FilaConContenido, cif: Cif = cifradoPorDefecto): Promise<string | null> {
  const datos = bytesDeBytea(f.contenido_cifrado);
  if (datos && datos.length) {
    const claro = await cif.descifrar(datos, ctxResumen(f.id));
    return new TextDecoder('utf-8', { fatal: true }).decode(claro);
  }
  return typeof f.contenido === 'string' ? f.contenido : null;
}

/**
 * Descifra en lote y deja el texto en `contenido` (para el código que ya lee `contenido`).
 * Las que fallan quedan con contenido = null y se cuentan (sin registrar contenido ni llaves).
 */
export async function conContenidoClaro<T extends FilaConContenido>(filas: T[], cif: Cif = cifradoPorDefecto): Promise<{ filas: (T & { contenido: string | null })[]; fallidas: number }> {
  let fallidas = 0;
  const out = await Promise.all(filas.map(async (f) => {
    try {
      return { ...f, contenido: await leerContenidoResumen(f, cif) };
    } catch {
      fallidas++;
      return { ...f, contenido: null };
    }
  }));
  return { filas: out, fallidas };
}

/** Columnas a pedir en un select de resumenes_ia cuando se necesita el texto. */
export const COLUMNAS_CONTENIDO = 'contenido, contenido_cifrado';
