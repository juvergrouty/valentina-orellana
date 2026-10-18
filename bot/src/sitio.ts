// Cliente del sitio: el bot SOLO habla con /api/transcriptor/bot-evento (Bearer de un uso).
// Ningún endpoint le devuelve datos de pacientes: a lo más una URL PUT prefirmada de R2.
// Formato de eventos = EventoBot de src/lib/transcriptor/tipos.ts.
import type { LineaHablante } from './linea.js';
import type { MotivoFin } from './vigia.js';
import { sanearError } from './saneo.js';
import { estadoSesionValido, type EstadoSesion } from './sesion.js';

export type EventoBot =
  | { tipo: 'lobby' }
  | { tipo: 'activo' }
  | { tipo: 'pide_url'; seq: number }
  | { tipo: 'segmento_subido'; seq: number; bytes: number; offset_ms: number; duracion_ms: number }
  | { tipo: 'fin'; motivo: MotivoFin; linea_hablantes: LineaHablante[] }
  | { tipo: 'error'; detalle: string }
  // Modo 'cuenta' (EventoBotCuenta de src/lib/transcriptor/bot.ts).
  | { tipo: 'pide_sesion' }
  | { tipo: 'sesion_actualizada'; sesion: EstadoSesion }
  | { tipo: 'sesion_invalida'; motivo: string };

/** El sitio respondió 404/401: el token no sirve (vencido, revocado o falso). No reintentar. */
export class TokenRechazadoError extends Error {
  constructor() { super('El sitio rechazó el token del bot'); this.name = 'TokenRechazadoError'; }
}

/**
 * El sitio respondió 403 con codigo 'sin_consentimiento' (a `activo` o `pide_url`): no hay
 * consentimiento de grabación vigente. El bot deja de grabar, descarta lo que tiene en memoria y sale
 * de la reunión al tiro (r2, punto 2). No se reintenta.
 */
export class SinConsentimientoError extends Error {
  constructor() { super('El sitio no autoriza grabar: falta el consentimiento'); this.name = 'SinConsentimientoError'; }
}

export interface OpcionesSitio {
  eventoUrl: string;
  token: string;
  fetch?: typeof fetch;
  intentos?: number;
  esperaBaseMs?: number;
  log?: (m: string) => void;
  /** Cada respuesta OK del sitio (r2: trae `hora_fin` si Vale movió el evento). */
  alResponder?: (r: Record<string, unknown>) => void;
}

/**
 * `hora_fin` de una respuesta del sitio, si es una fecha válida y distinta de la actual (r2, punto 7).
 * Acotada a ±12 h de la actual: una respuesta rara no puede dejar al robot dentro para siempre.
 */
export function horaFinDeRespuesta(r: Record<string, unknown>, actual: Date): Date | null {
  if (typeof r.hora_fin !== 'string') return null;
  const t = Date.parse(r.hora_fin);
  if (Number.isNaN(t) || t === actual.getTime() || Math.abs(t - actual.getTime()) > 12 * 60 * 60_000) return null;
  return new Date(t);
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
        if (res.ok) {
          const r = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          try { this.o.alResponder?.(r); } catch { /* un aviso mal formado no rompe el evento */ }
          return r;
        }
        if (res.status === 403) {
          const r = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (r?.codigo === 'sin_consentimiento') throw new SinConsentimientoError();
        }
        ultimo = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          // Error del pedido (no se arregla reintentando).
          throw new Error(`El sitio rechazó el evento ${evento.tipo}: ${ultimo}`);
        }
      } catch (e) {
        if (e instanceof TokenRechazadoError || e instanceof SinConsentimientoError) throw e;
        if (e instanceof Error && e.message.startsWith('El sitio rechazó')) throw e;
        ultimo = e instanceof Error ? e.message : String(e);
      }
      this.log(`evento ${evento.tipo}: intento ${i + 1} falló (${ultimo})`);
      await dormir(this.espera * 2 ** i);
    }
    throw new Error(`No se pudo enviar el evento ${evento.tipo}: ${ultimo}`);
  }

  /**
   * Pide la sesión de Google del robot (modo 'cuenta'). null si el sitio no tiene una vigente, está
   * en uso o no es de la cuenta esperada: el bot entra como invitado.
   */
  async pedirSesion(cuentaEsperada: string): Promise<EstadoSesion | null> {
    const r = await this.enviar({ tipo: 'pide_sesion' });
    if (typeof r.correo !== 'string' || r.correo.toLowerCase() !== cuentaEsperada.toLowerCase()) return null;
    return estadoSesionValido(r.sesion) ? r.sesion : null;
  }

  /** Pide la URL PUT prefirmada para el segmento `seq`. */
  async pedirUrl(seq: number): Promise<string> {
    const r = await this.enviar({ tipo: 'pide_url', seq });
    if (typeof r.url !== 'string' || !r.url.startsWith('https://')) throw new Error('El sitio no entregó una URL de subida');
    return r.url;
  }
}
