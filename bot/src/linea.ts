// Línea de tiempo de quién habla (pura; probada en linea.test.ts).
// La página avisa "X empezó/dejó de hablar" (tile iluminado de Meet) con t relativo al
// inicio de la grabación. Aquí se limpia: se descartan bots, se ignoran repeticiones, se
// cierran los intervalos abiertos al terminar y se acota el tamaño (el evento `fin` viaja
// en un POST al sitio). Formato = LineaHablante de src/lib/transcriptor/tipos.ts.
import { esNombreDeBot } from './config.js';

export interface LineaHablante { t_ms: number; nombre: string; on: boolean }

export const MAX_ENTRADAS = 20_000;
const MAX_NOMBRE = 60;

export class LineaHablantes {
  private readonly entradas: LineaHablante[] = [];
  private readonly hablando = new Set<string>();
  private ultimoT = 0;

  constructor(private readonly botNombre: string) {}

  registrar(tMs: number, nombreCrudo: string, on: boolean): void {
    const nombre = (nombreCrudo || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOMBRE);
    if (!nombre || esNombreDeBot(nombre, this.botNombre)) return;
    if (!Number.isFinite(tMs) || tMs < 0) return;
    // Orden monótono: un aviso que llega "antes" del último se pega al último t.
    const t = Math.max(Math.round(tMs), this.ultimoT);
    if (on === this.hablando.has(nombre)) return; // sin cambio de estado
    if (this.entradas.length >= MAX_ENTRADAS - this.hablando.size) return; // deja espacio para cerrar
    if (on) this.hablando.add(nombre); else this.hablando.delete(nombre);
    this.entradas.push({ t_ms: t, nombre, on });
    this.ultimoT = t;
  }

  /** Cierra los intervalos abiertos en `tFinMs` y devuelve una copia. */
  cerrar(tFinMs: number): LineaHablante[] {
    const t = Math.max(Math.round(tFinMs), this.ultimoT);
    for (const nombre of [...this.hablando]) {
      this.entradas.push({ t_ms: t, nombre, on: false });
      this.hablando.delete(nombre);
    }
    this.ultimoT = t;
    return this.entradas.map((e) => ({ ...e }));
  }

  get largo(): number { return this.entradas.length; }
}
