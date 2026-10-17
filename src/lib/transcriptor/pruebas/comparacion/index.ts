// Casos sintéticos (inventados) de la prueba ciega Sonnet vs Haiku, en el orden en que se muestran.
import { INDIVIDUAL_25 } from './individual25';
import { PAREJA_25 } from './pareja25';
import { CORTA_15 } from './corta15';
import type { CasoSintetico } from './tipos';

export type { CasoSintetico, EsperadoCaso } from './tipos';
export { tramosDeGuion } from './tipos';

export const CASOS_SINTETICOS: readonly CasoSintetico[] = [INDIVIDUAL_25, PAREJA_25, CORTA_15];

export function casoSintetico(clave: string): CasoSintetico | null {
  return CASOS_SINTETICOS.find((c) => c.clave === clave) ?? null;
}
