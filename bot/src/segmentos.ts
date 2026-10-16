// Segmentos de audio en memoria (nunca en disco) y su subida a R2 con URL prefirmada.
// La página entrega trozos de MediaRecorder (cada 10 s) por segmento; al cerrarse un
// segmento se une, se pide la URL al sitio, se hace PUT y se avisa `segmento_subido`.
// Las subidas van en fila (una a la vez) para no competir con el audio de la reunión.
import type { Sitio } from './sitio.js';

export const MIME_SEGMENTO = 'audio/webm';

interface SegmentoAbierto { trozos: Buffer[]; bytes: number }
export interface SegmentoCerrado { seq: number; datos: Buffer; offset_ms: number; duracion_ms: number }

export interface OpcionesSegmentos {
  sitio: Pick<Sitio, 'pedirUrl' | 'enviar'>;
  fetch?: typeof fetch;
  log?: (m: string) => void;
  intentosPut?: number;
  esperaBaseMs?: number;
  /** Tope de memoria por segmento (por si MediaRecorder se desboca). 64 MB. */
  maxBytesSegmento?: number;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Segmentos {
  private readonly abiertos = new Map<number, SegmentoAbierto>();
  private cola: Promise<void> = Promise.resolve();
  private readonly fallidos: SegmentoCerrado[] = [];
  readonly subidos: number[] = [];
  private readonly f: typeof fetch;
  private readonly log: (m: string) => void;

  constructor(private readonly o: OpcionesSegmentos) {
    this.f = o.fetch ?? fetch;
    this.log = o.log ?? (() => {});
  }

  agregarTrozo(seq: number, datos: Buffer): void {
    const s = this.abiertos.get(seq) ?? { trozos: [], bytes: 0 };
    if (s.bytes + datos.length > (this.o.maxBytesSegmento ?? 64 * 1024 * 1024)) {
      this.log(`segmento ${seq}: se superó el tope de memoria; se descarta un trozo`);
      return;
    }
    s.trozos.push(datos);
    s.bytes += datos.length;
    this.abiertos.set(seq, s);
  }

  /** Cierra el segmento y lo pone en la fila de subida. Segmentos vacíos se ignoran. */
  cerrar(seq: number, offsetMs: number, duracionMs: number): Promise<void> {
    const s = this.abiertos.get(seq);
    this.abiertos.delete(seq);
    if (!s || s.bytes === 0) { this.log(`segmento ${seq}: vacío, no se sube`); return this.cola; }
    const seg: SegmentoCerrado = { seq, datos: Buffer.concat(s.trozos), offset_ms: Math.round(offsetMs), duracion_ms: Math.round(duracionMs) };
    this.cola = this.cola.then(() => this.subir(seg)).catch(() => {});
    return this.cola;
  }

  private async subir(seg: SegmentoCerrado): Promise<void> {
    const intentos = this.o.intentosPut ?? 4;
    const base = this.o.esperaBaseMs ?? 2000;
    for (let i = 0; i < intentos; i++) {
      try {
        // URL nueva en cada intento (vence en 15 min).
        const url = await this.o.sitio.pedirUrl(seg.seq);
        const res = await this.f(url, {
          method: 'PUT',
          headers: { 'Content-Type': MIME_SEGMENTO },
          body: seg.datos,
          signal: AbortSignal.timeout(5 * 60_000),
        });
        if (!res.ok) throw new Error(`PUT R2 respondió ${res.status}`);
        await this.o.sitio.enviar({
          tipo: 'segmento_subido', seq: seg.seq, bytes: seg.datos.length, offset_ms: seg.offset_ms, duracion_ms: seg.duracion_ms,
        });
        this.subidos.push(seg.seq);
        this.log(`segmento ${seg.seq} subido (${seg.datos.length} bytes)`);
        return;
      } catch (e) {
        if (e instanceof Error && e.name === 'TokenRechazadoError') throw e;
        this.log(`segmento ${seg.seq}: intento ${i + 1} falló (${e instanceof Error ? e.message : e})`);
        await dormir(base * 2 ** i);
      }
    }
    this.fallidos.push(seg);
  }

  /** Espera la fila y reintenta una vez los que fallaron. Devuelve los que no se pudieron subir. */
  async vaciar(): Promise<number[]> {
    await this.cola;
    const pendientes = this.fallidos.splice(0);
    for (const seg of pendientes) {
      this.cola = this.cola.then(() => this.subir(seg)).catch(() => {});
    }
    await this.cola;
    return this.fallidos.map((s) => s.seq);
  }
}
