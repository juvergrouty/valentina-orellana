// Derivado de Vexa (Apache-2.0): core/meetings/modules/join/src/googlemeet/removal.ts (commit f1a62fb).
// Detecta, estando dentro, que sacaron al bot o que la llamada terminó.
import type { Pagina } from '../navegador.js';
import { indicadoresExpulsion } from './selectores.js';

/** 'expulsado' = alguien lo sacó (se toma como "Vale detuvo la grabación"); 'termino' = fin de la llamada. */
export type Expulsion = 'expulsado' | 'termino' | null;

export async function revisarExpulsion(p: Pagina): Promise<Expulsion> {
  if (p.isClosed()) return 'termino';
  for (const sel of indicadoresExpulsion) {
    try {
      if (await p.locator(sel).first().isVisible()) return /removed/i.test(sel) ? 'expulsado' : 'termino';
    } catch { /* sigue */ }
  }
  return null;
}
