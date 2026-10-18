// Regla de salida del bot (pura, sin navegador; probada en unidad.test.ts).
// Idea tomada de Vexa (core/meetings/services/bot/src/aloneness.ts, Apache-2.0), reescrita:
// se decide con los participantes VISIBLES en Meet (tiles), no con silencio de audio.
//
// Sale con lo primero que ocurra (50-arquitectura §5 + 10-etica-legal §4.1; segunda ronda 18 oct):
//  - hora_fin            : se pasó HORA_FIN + MAX_EXTRA_MS (el sitio puede mover HORA_FIN: fijarLimite).
//  - nadie_llego         : el robot entra antes de la hora y NO graba mientras no haya nadie; si en
//                          `esperaLlegadaMs` (30 min; 5 min para un robot de reemplazo) no aparece
//                          ningún humano, sale sin haber grabado nada.
//  - vale_salio          : Vale estuvo y no está, y SÍ queda el paciente: se tolera `graciaValeMs`
//                          (3 min) para que una reconexión de Vale no corte la sesión. Es el máximo que
//                          se graba al paciente solo: aunque Vale haya colgado a propósito, a los 3 min
//                          el robot sale. También vale_salio si Vale era la ÚLTIMA en la llamada y se fue
//                          (fin normal de la sesión): en ese caso tras `soloMs` (60 s), no 3 min.
//  - solo                : la llamada quedó sin humanos durante `soloMs` y no fue "Vale cerró al final"
//                          (p. ej. desaparecieron todos a la vez: falla de la página o de la red del
//                          robot). El sitio puede mandar un robot de reemplazo si queda tiempo.
//  - participantes_extra : hay más humanos de los esperados durante `graciaExtraMs`
//                          (el bot se niega a seguir grabando a un tercero sin consentimiento). El
//                          recuadro de pantalla compartida NO cuenta como persona (nombreVisible).
import { esNombreDeBot, esVale } from './config.js';

export type MotivoFin =
  | 'vale_salio' | 'solo' | 'hora_fin' | 'no_admitido' | 'expulsado' | 'participantes_extra' | 'error'
  | 'nadie_llego' | 'sin_consentimiento';

export interface OpcionesVigia {
  botNombre: string;
  valeNombres: string[];
  soloMs: number;
  maxHumanos: number;
  /** Instante (ms epoch) en que el bot debe salir sí o sí. */
  limiteMs: number;
  /** Ausencia de Vale tolerada con el paciente en la llamada (reconexión). Default 3 min. */
  graciaValeMs?: number;
  /** Exceso de humanos tolerado (alguien que entra por error y sale). Default 15 s. */
  graciaExtraMs?: number;
  /** Espera máxima a que llegue el primer humano. Default 30 min. */
  esperaLlegadaMs?: number;
  /**
   * Robot de reemplazo: Vale ya estuvo en la sesión. Su ausencia se cuenta desde que este robot
   * entra (con el paciente presente, a los 3 min sale con vale_salio), sin esperar a "verla" primero.
   */
  valeVistaInicial?: boolean;
}

export const GRACIA_VALE_MS = 3 * 60_000;
export const ESPERA_LLEGADA_MS = 30 * 60_000;

// Meet muestra la pantalla compartida como un recuadro aparte con el nombre de quien presenta
// ("Valentina Orellana (Presentation)", "Presentation from …", "You are presenting"; en español
// "(Presentación)", "Presentación de …", "Estás presentando"). No es otra persona: se reduce al nombre
// de quien presenta (y el recuadro propio "You are presenting" no es nadie).
const PRESENTA_SUFIJO = /\s*[([]\s*(?:presentation|presenting|screen|pantalla|presentaci[oó]n|presentando)\s*[)\]]\s*$/i;
const PRESENTA_PREFIJO = /^\s*(?:presentation\s+(?:from|by)|presentaci[oó]n\s+de|pantalla\s+de)\s+/i;
const PRESENTA_FRASE = /\s+(?:is\s+presenting|est[aá]\s+presentando)\s*$/i;
const PRESENTA_PROPIA = /^\s*(?:you\s+are\s+presenting|est[aá]s\s+presentando|presenting|presentando)\s*$/i;

/** Nombre de la PERSONA detrás de un tile (quita las marcas de pantalla compartida). '' = no es nadie. */
export function nombreVisible(nombre: string): string {
  const t = (nombre || '').replace(/\s+/g, ' ').trim();
  if (!t || PRESENTA_PROPIA.test(t)) return '';
  return t.replace(PRESENTA_SUFIJO, '').replace(PRESENTA_PREFIJO, '').replace(PRESENTA_FRASE, '').trim();
}

export class Vigia {
  private valeVista = false;
  private valeAusenteDesde: number | null = null;
  private soloDesde: number | null = null;
  private vaciadaPorVale = false;
  private extraDesde: number | null = null;
  private humanoVisto = false;
  private otroVisto = false;
  private inicio: number | null = null;
  private previos: { humanos: number; vale: boolean } = { humanos: 0, vale: false };
  private limite: number;
  private readonly esperaLlegada: number;
  private readonly graciaVale: number;
  private readonly graciaExtra: number;

  constructor(private readonly o: OpcionesVigia) {
    this.graciaVale = o.graciaValeMs ?? GRACIA_VALE_MS;
    this.graciaExtra = o.graciaExtraMs ?? 15_000;
    this.esperaLlegada = o.esperaLlegadaMs ?? ESPERA_LLEGADA_MS;
    this.limite = o.limiteMs;
    this.valeVista = o.valeVistaInicial === true;
  }

  /** ¿Está Vale entre los nombres visibles? */
  hayVale(nombres: string[]): boolean {
    return this.humanos(nombres).some((n) => esVale(n, this.o.valeNombres));
  }

  /** El sitio informó otra hora de término (Vale movió el evento). */
  fijarLimite(ms: number): void { if (Number.isFinite(ms)) this.limite = ms; }
  get limiteMs(): number { return this.limite; }

  /** Humanos = personas visibles que no son bots (sin el propio tile ni la pantalla compartida). */
  humanos(nombres: string[]): string[] {
    const vistos = new Map<string, string>();
    for (const crudo of nombres) {
      const n = nombreVisible(crudo);
      if (!n || esNombreDeBot(n, this.o.botNombre)) continue;
      const clave = n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (!vistos.has(clave)) vistos.set(clave, n);
    }
    return [...vistos.values()];
  }

  /** Registra una observación; devuelve el motivo de salida o null para seguir. */
  observar(ahora: number, nombresVisibles: string[]): MotivoFin | null {
    if (ahora >= this.limite) return 'hora_fin';
    const humanos = this.humanos(nombresVisibles);
    const valeAhora = humanos.some((n) => esVale(n, this.o.valeNombres));
    const previos = this.previos;
    this.previos = { humanos: humanos.length, vale: valeAhora };

    this.inicio ??= ahora;
    if (humanos.length > 0) this.humanoVisto = true;
    if (humanos.some((n) => !esVale(n, this.o.valeNombres))) this.otroVisto = true;
    if (!this.humanoVisto) return ahora - this.inicio >= this.esperaLlegada ? 'nadie_llego' : null;

    if (humanos.length === 0) {
      if (this.soloDesde == null) {
        this.soloDesde = ahora;
        // Vale era la única que quedaba y se fue DESPUÉS de que estuvo el paciente: fin normal de la
        // sesión. (Si Vale esperaba sola y se le cortó, es 'solo': el sitio puede mandar reemplazo.)
        this.vaciadaPorVale = previos.humanos === 1 && previos.vale && this.otroVisto;
      }
      if (ahora - this.soloDesde >= this.o.soloMs) return this.vaciadaPorVale ? 'vale_salio' : 'solo';
      return null;
    }
    this.soloDesde = null;

    if (valeAhora) { this.valeVista = true; this.valeAusenteDesde = null; }
    else if (this.valeVista) {
      this.valeAusenteDesde ??= ahora;
      if (ahora - this.valeAusenteDesde >= this.graciaVale) return 'vale_salio';
    }

    if (humanos.length > this.o.maxHumanos) {
      this.extraDesde ??= ahora;
      if (ahora - this.extraDesde >= this.graciaExtra) return 'participantes_extra';
    } else this.extraDesde = null;

    return null;
  }
}
