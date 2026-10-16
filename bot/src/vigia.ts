// Regla de salida del bot (pura, sin navegador; probada en vigia.test.ts).
// Idea tomada de Vexa (core/meetings/services/bot/src/aloneness.ts, Apache-2.0), reescrita:
// se decide con los participantes VISIBLES en Meet (tiles), no con silencio de audio.
//
// Sale con lo primero que ocurra (50-arquitectura §5 + 10-etica-legal §4.1):
//  - hora_fin            : se pasó HORA_FIN + MAX_EXTRA_MS.
//  - vale_salio          : Vale estuvo en la llamada y lleva `graciaValeMs` sin aparecer.
//  - solo                : no queda ningún humano (solo bots) durante `soloMs`.
//  - participantes_extra : hay más humanos de los esperados durante `graciaExtraMs`
//                          (el bot se niega a seguir grabando a un tercero sin consentimiento).
import { esNombreDeBot, esVale } from './config.js';

export type MotivoFin = 'vale_salio' | 'solo' | 'hora_fin' | 'no_admitido' | 'expulsado' | 'participantes_extra' | 'error';

export interface OpcionesVigia {
  botNombre: string;
  valeNombres: string[];
  soloMs: number;
  maxHumanos: number;
  /** Instante (ms epoch) en que el bot debe salir sí o sí. */
  limiteMs: number;
  /** Ausencia de Vale tolerada (parpadeos del DOM, reconexión). Default 20 s. */
  graciaValeMs?: number;
  /** Exceso de humanos tolerado (alguien que entra por error y sale). Default 15 s. */
  graciaExtraMs?: number;
}

export class Vigia {
  private valeVista = false;
  private valeAusenteDesde: number | null = null;
  private soloDesde: number | null = null;
  private extraDesde: number | null = null;
  private readonly graciaVale: number;
  private readonly graciaExtra: number;

  constructor(private readonly o: OpcionesVigia) {
    this.graciaVale = o.graciaValeMs ?? 20_000;
    this.graciaExtra = o.graciaExtraMs ?? 15_000;
  }

  /** Humanos = nombres visibles que no son bots (el propio tile ya viene excluido). */
  humanos(nombres: string[]): string[] {
    const vistos = new Set<string>();
    for (const n of nombres) if (n && !esNombreDeBot(n, this.o.botNombre)) vistos.add(n.trim());
    return [...vistos];
  }

  /** Registra una observación; devuelve el motivo de salida o null para seguir. */
  observar(ahora: number, nombresVisibles: string[]): MotivoFin | null {
    if (ahora >= this.o.limiteMs) return 'hora_fin';
    const humanos = this.humanos(nombresVisibles);

    const valeAhora = humanos.some((n) => esVale(n, this.o.valeNombres));
    if (valeAhora) { this.valeVista = true; this.valeAusenteDesde = null; }
    else if (this.valeVista) {
      this.valeAusenteDesde ??= ahora;
      if (ahora - this.valeAusenteDesde >= this.graciaVale) return 'vale_salio';
    }

    if (humanos.length === 0) {
      this.soloDesde ??= ahora;
      if (ahora - this.soloDesde >= this.o.soloMs) return 'solo';
    } else this.soloDesde = null;

    if (humanos.length > this.o.maxHumanos) {
      this.extraDesde ??= ahora;
      if (ahora - this.extraDesde >= this.graciaExtra) return 'participantes_extra';
    } else this.extraDesde = null;

    return null;
  }
}
