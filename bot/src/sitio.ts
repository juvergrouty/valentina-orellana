// Cliente del sitio: el bot SOLO habla con /api/transcriptor/bot-evento (Bearer de un uso).
// Ningún endpoint le devuelve datos de pacientes: a lo más una URL PUT prefirmada de R2.
// Formato de eventos = EventoBot de src/lib/transcriptor/tipos.ts.
import type { LineaHablante } from './linea.js';
import type { MotivoFin } from './vigia.js';
import { sanearError } from './saneo.js';

export type EventoBot =
  | { tipo: 'lobby' }
  | { tipo: 'activo' }
  | { tipo: 'pide_url'; seq: number }
  | { tipo: 'segmento_subido'; seq: number; bytes: number; offset_ms: number; duracion_ms: number }
  | { tipo: 'fin'; motivo: MotivoFin; linea_hablantes: LineaHablante[] }
  | { tipo: 'error'; detalle: string };

/** El sitio respondió 404/401: el token no sirve (vencido, revocado o falso). No reintentar. */
export class TokenRechazadoError extends Error {
  constructor() { super('El sitio rechazó el token del bot'); this.name = 'TokenRechazadoError'; }
}

export interface OpcionesSitio {
  eventoUrl: string;
  token: string;
  fetch?: typeof fetch;
  intentos?: number;
  esperaBaseMs?: number;
  log?: (m: string) => void;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Sitio {
  private readonly f: typeof fetch;
  private readonly intentos: number;
  private readonly espera: number;
  private readonly log: (m: string) => void;

  constructor(private readonly o: OpcionesSitio) {
    this.f = o.fetch ?? fetch;
    this.intentos = o.intentos ?? 5;
    this.espera = o.esperaBaseMs ?? 1000;
    this.log = o.log ?? (() => {});
  }

  /** Envía un evento con reintentos (red/5xx/429). Devuelve el JSON de respuesta. */
  async enviar(evento: EventoBot): Promise<Record<string, unknown>> {
    // Nunca sale el enlace de Meet en un error (B8).
    if (evento.tipo === 'error') evento = { tipo: 'error', detalle: sanearError(evento.detalle) };
    let ultimo = '';
    for (let i = 0; i < this.intentos; i++) {
      try {
        const res = await this.f(this.o.eventoUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.o.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(evento),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404 || res.status === 401) throw new TokenRechazadoError();
        if (res.ok) return (await res.json().catch(() => ({}))) as Record<string, unknown>;
        ultimo = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          // Error del pedido (no se arregla reintentando).
          throw new Error(`El sitio rechazó el evento ${evento.tipo}: ${ultimo}`);
        }
      } catch (e) {
        if (e instanceof TokenRechazadoError) throw e;
        if (e instanceof Error && e.message.startsWith('El sitio rechazó')) throw e;
        ultimo = e instanceof Error ? e.message : String(e);
      }
      this.log(`evento ${evento.tipo}: intento ${i + 1} falló (${ultimo})`);
      await dormir(this.espera * 2 ** i);
    }
    throw new Error(`No se pudo enviar el evento ${evento.tipo}: ${ultimo}`);
  }

  /** Pide la URL PUT prefirmada para el segmento `seq`. */
  async pedirUrl(seq: number): Promise<string> {
    const r = await this.enviar({ tipo: 'pide_url', seq });
    if (typeof r.url !== 'string' || !r.url.startsWith('https://')) throw new Error('El sitio no entregó una URL de subida');
    return r.url;
  }
}
