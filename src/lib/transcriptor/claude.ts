// Transcriptor IA — cliente de Claude (paquete P3).
// Decisiones de Vale del 16 oct (01-decisiones-16oct.md, mandan sobre 50-arquitectura):
//   • Messages API normal (streaming + finalMessage). NADA de Batch: con la cuenta en modo
//     HIPAA, Batch responde 400. Los métodos de Batch del contrato existen solo para que el
//     orquestador compile y lanzan un error explicativo.
//   • Sin datos del paciente en metadatos: no se envía `metadata`, ni ids, ni nombres fuera
//     del contenido estrictamente necesario del mensaje.
//   • Se registran los tokens de cada llamada (y su costo en USD) para la vista de costos.
// Nunca se escribe en logs ni en mensajes de error el texto enviado o recibido.
import Anthropic from '@anthropic-ai/sdk';
import {
  MODELO_PREGUNTAS, MODELO_RESUMEN,
  type ClienteClaude, type PeticionResumen, type ResultadoBatch,
} from './tipos';

// ─── Configuración de cada uso (costo vs. calidad) ───────────────────────────
// Sonnet 5.5 no acepta thinking 'disabled' (400); para apagarlo se usa 'between_tools'
// (solo con esfuerzo ≤ high). El resumen es una tarea de registro fiel, no de
// razonamiento largo: el pensamiento adaptativo agrega tokens de salida (US$10/MTok)
// sin mejora clara, así que va APAGADO y con esfuerzo 'medium'. Si las pruebas lado a
// lado muestran que falta calidad, cambiar a { type: 'adaptive' } + esfuerzo 'low'.
// Haiku 5.5 acepta 'disabled' con esfuerzo ≤ high: las preguntas van sin pensamiento.

export type Esfuerzo = 'low' | 'medium' | 'high';

export interface ConfigUso {
  modelo: string;
  maxTokens: number;
  thinking: Anthropic.ThinkingConfigParam;
  esfuerzo: Esfuerzo;
}

export const CONFIG_RESUMEN: ConfigUso = {
  modelo: MODELO_RESUMEN,
  maxTokens: 8_000,             // un resumen de pareja + Atención cabe holgado; tope de costo
  thinking: { type: 'between_tools' },
  esfuerzo: 'medium',
};

export const CONFIG_PREGUNTAS: ConfigUso = {
  modelo: MODELO_PREGUNTAS,
  maxTokens: 2_000,             // respuestas de ~200 palabras con citas
  thinking: { type: 'disabled' },
  esfuerzo: 'medium',
};

// ─── Precios (USD por millón de tokens, API normal, 16 oct 2026) ─────────────
// Sonnet 5.5: 2 / 10, escritura de caché 1,25× la entrada, lectura 0,20.
// Haiku 5.5: 0,10 / 0,50 si el prompt total ≤ 100k tokens; sobre 100k, 0,50 / 2,50.
interface Tarifa { entrada: number; salida: number; cacheEscritura: number; cacheLectura: number }
const TARIFAS: Record<string, { normal: Tarifa; sobre100k?: Tarifa }> = {
  [MODELO_RESUMEN]: { normal: { entrada: 2, salida: 10, cacheEscritura: 2.5, cacheLectura: 0.2 } },
  [MODELO_PREGUNTAS]: {
    normal:    { entrada: 0.10, salida: 0.50, cacheEscritura: 0.125, cacheLectura: 0.01 },
    sobre100k: { entrada: 0.50, salida: 2.50, cacheEscritura: 0.625, cacheLectura: 0.05 },
  },
};

export interface UsoTokens {
  entrada: number;          // input_tokens (sin caché)
  salida: number;           // output_tokens (incluye pensamiento, si lo hubo)
  cacheEscritura: number;   // cache_creation_input_tokens
  cacheLectura: number;     // cache_read_input_tokens
}

/** Costo en USD de una llamada (sin IVA). Redondeado a 5 decimales como numeric(10,5). */
export function costoUsd(modelo: string, uso: UsoTokens): number {
  const t = TARIFAS[modelo];
  if (!t) throw new Error(`Modelo sin tarifa registrada: ${modelo}`);
  const promptTotal = uso.entrada + uso.cacheEscritura + uso.cacheLectura;
  const tarifa = promptTotal > 100_000 && t.sobre100k ? t.sobre100k : t.normal;
  const usd = (uso.entrada * tarifa.entrada + uso.salida * tarifa.salida
    + uso.cacheEscritura * tarifa.cacheEscritura + uso.cacheLectura * tarifa.cacheLectura) / 1_000_000;
  return Math.round(usd * 100_000) / 100_000;
}

export function usoDesdeRespuesta(u: Partial<Anthropic.Usage> | null | undefined): UsoTokens {
  return {
    entrada: u?.input_tokens ?? 0,
    salida: u?.output_tokens ?? 0,
    cacheEscritura: u?.cache_creation_input_tokens ?? 0,
    cacheLectura: u?.cache_read_input_tokens ?? 0,
  };
}

// ─── Errores (sin contenido) ─────────────────────────────────────────────────

export type CodigoErrorClaude =
  | 'sin_llave' | 'rechazo' | 'peticion_invalida' | 'autenticacion' | 'limite'
  | 'sobrecarga' | 'servidor' | 'red' | 'tiempo' | 'vacio' | 'desconocido';

export class ErrorClaude extends Error {
  constructor(
    readonly codigo: CodigoErrorClaude,
    readonly recuperable: boolean,
    readonly status: number | null = null,
  ) {
    super(`Claude: ${codigo}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ErrorClaude';
  }
}

/** Clasifica un error del SDK por su estado HTTP (sin mirar el texto del mensaje). */
export function clasificarError(e: unknown): ErrorClaude {
  if (e instanceof ErrorClaude) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ErrorClaude('tiempo', true);
  if (e instanceof Anthropic.APIConnectionError) return new ErrorClaude('red', true);
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
  if (status === null) return new ErrorClaude('desconocido', false);
  if (status === 401 || status === 403) return new ErrorClaude('autenticacion', false, status);
  if (status === 408) return new ErrorClaude('tiempo', true, status);
  if (status === 409) return new ErrorClaude('servidor', true, status);
  if (status === 429) return new ErrorClaude('limite', true, status);
  if (status === 529) return new ErrorClaude('sobrecarga', true, status);
  if (status >= 500) return new ErrorClaude('servidor', true, status);
  return new ErrorClaude('peticion_invalida', false, status);
}

function segundosRetryAfter(e: unknown): number | null {
  const h = (e as { headers?: { get?: (k: string) => string | null } })?.headers;
  const v = typeof h?.get === 'function' ? h.get('retry-after') : null;
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ─── Llamada con reintentos ──────────────────────────────────────────────────

/** Lo mínimo del SDK que se usa (permite inyectar un falso en las pruebas). */
export interface ClienteMensajes {
  messages: {
    stream(params: Anthropic.MessageStreamParams, opciones?: { timeout?: number }): { finalMessage(): Promise<Anthropic.Message> };
  };
}

export interface OpcionesReintento {
  intentos: number;          // total de intentos (1 = sin reintentos)
  esperasMs: number[];       // espera antes del reintento n (se repite la última)
  maxEsperaMs: number;       // tope para retry-after
  timeoutMs: number;         // por intento
  dormir?: (ms: number) => Promise<void>;
}

export const REINTENTOS_POR_DEFECTO: OpcionesReintento = {
  intentos: 4,
  esperasMs: [2_000, 8_000, 20_000],
  maxEsperaMs: 30_000,
  timeoutMs: 120_000,
};

export interface PeticionClaude {
  uso: ConfigUso;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
}

export interface RespuestaClaude {
  texto: string;
  modelo: string;
  uso: UsoTokens;
  costoUsd: number;
  /** true si se cortó por max_tokens. */
  truncado: boolean;
  intentos: number;
}

let clientePorDefecto: Anthropic | null = null;

function llaveAnthropic(): string | undefined {
  if (typeof process !== 'undefined' && process.env?.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try { return import.meta.env.ANTHROPIC_API_KEY; } catch { return undefined; } // fuera de Vite (pruebas) no hay import.meta.env
}

export function clienteAnthropic(): Anthropic {
  if (clientePorDefecto) return clientePorDefecto;
  const apiKey = llaveAnthropic();
  if (!apiKey) throw new ErrorClaude('sin_llave', false);
  // maxRetries 0: los reintentos (con backoff y registro) los maneja `llamarClaude`.
  clientePorDefecto = new Anthropic({ apiKey, maxRetries: 0 });
  return clientePorDefecto;
}

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Arma los parámetros exactos que van a la API (exportado para probar que no hay metadatos). */
export function paramsMensaje(p: PeticionClaude): Anthropic.MessageStreamParams {
  return {
    model: p.uso.modelo,
    max_tokens: p.uso.maxTokens,
    thinking: p.uso.thinking,
    output_config: { effort: p.uso.esfuerzo },
    system: p.system,
    messages: p.messages,
  };
}

export async function llamarClaude(
  p: PeticionClaude,
  op: Partial<OpcionesReintento> & { cliente?: ClienteMensajes } = {},
): Promise<RespuestaClaude> {
  const cfg = { ...REINTENTOS_POR_DEFECTO, ...op };
  const dormir = cfg.dormir ?? dormirReal;
  const cliente = op.cliente ?? clienteAnthropic();
  const params = paramsMensaje(p);

  let ultimo: ErrorClaude | null = null;
  for (let intento = 1; intento <= cfg.intentos; intento++) {
    try {
      const msg = await cliente.messages.stream(params, { timeout: cfg.timeoutMs }).finalMessage();
      if (msg.stop_reason === 'refusal') throw new ErrorClaude('rechazo', false);
      const texto = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!texto) throw new ErrorClaude('vacio', true);
      const uso = usoDesdeRespuesta(msg.usage);
      return {
        texto,
        modelo: p.uso.modelo,
        uso,
        costoUsd: costoUsd(p.uso.modelo, uso),
        truncado: msg.stop_reason === 'max_tokens',
        intentos: intento,
      };
    } catch (e) {
      ultimo = clasificarError(e);
      if (!ultimo.recuperable || intento === cfg.intentos) break;
      const base = cfg.esperasMs[Math.min(intento - 1, cfg.esperasMs.length - 1)] ?? 2_000;
      const ra = segundosRetryAfter(e);
      const espera = Math.min(cfg.maxEsperaMs, Math.max(base, ra != null ? ra * 1000 : 0));
      // Solo código y estado: nunca contenido.
      console.warn(`[transcriptor/claude] intento ${intento} falló (${ultimo.codigo}); reintento en ${espera} ms`);
      await dormir(espera + Math.floor(Math.random() * 250));
    }
  }
  throw ultimo ?? new ErrorClaude('desconocido', false);
}

// ─── Implementación del contrato ClienteClaude (tipos.ts) ────────────────────

const SIN_BATCH = 'Batch está desactivado (decisión de Vale del 16 oct: modo HIPAA, Messages API directa).';

/**
 * Cliente con la forma del contrato de P0. `resumirDirecto` y `preguntar` delegan en
 * resumen.ts (que arma prompts y verifica citas); los métodos de Batch lanzan siempre.
 */
export function crearClienteClaude(): ClienteClaude {
  return {
    async crearBatch() { throw new Error(SIN_BATCH); },
    async revisarBatch() { throw new Error(SIN_BATCH); },
    async leerResultados() { throw new Error(SIN_BATCH); },
    async borrarBatch() { throw new Error(SIN_BATCH); },
    async resumirDirecto(peticion: PeticionResumen): Promise<ResultadoBatch> {
      const { resumirSesion } = await import('./resumen');
      try {
        const r = await resumirSesion(peticion);
        return {
          customId: peticion.customId,
          tipo: 'succeeded',
          contenido: r.contenido,
          tokensEntrada: r.uso.entrada + r.uso.cacheEscritura + r.uso.cacheLectura,
          tokensSalida: r.uso.salida,
        };
      } catch (e) {
        const err = clasificarError(e);
        return { customId: peticion.customId, tipo: 'errored', errorRecuperable: err.recuperable };
      }
    },
    async preguntar(params) {
      const { responderPregunta } = await import('./resumen');
      const r = await responderPregunta({
        pregunta: params.pregunta,
        instrucciones: params.instrucciones,
        sesiones: params.contexto.map((c) => ({ fecha: c.fecha, tipo: null, tramos: c.tramos })),
      });
      return {
        respuesta: r.respuesta,
        tokensEntrada: r.uso.entrada + r.uso.cacheEscritura + r.uso.cacheLectura,
        tokensSalida: r.uso.salida,
        tokensCache: r.uso.cacheLectura,
      };
    },
  };
}
