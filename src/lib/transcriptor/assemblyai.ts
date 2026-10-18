// Transcriptor IA — cliente de AssemblyAI (paquete P2). Solo `fetch`, sin SDK.
//
// Documentación oficial verificada el 16 oct 2026:
//  - Crear transcripción: POST https://api.assemblyai.com/v2/transcript, cabecera `authorization: <API key>`.
//    https://www.assemblyai.com/docs/api-reference/transcripts/submit
//    · `audio_url` (obligatorio). · `speech_models` (arreglo; valores 'universal-3-5-pro' y 'universal-2';
//      `speech_model` está marcado deprecated: "replaced with the `speech_models` parameter").
//    · `language_code` ('es' está en el enum TranscriptLanguageCode; "Cannot be used together with
//      `language_detection`" → no se envía language_detection).
//    · `speaker_labels` (boolean, default false; requiere `punctuate` = true).
//    · `speakers_expected` (entero positivo; requiere speaker_labels; no se combina con speaker_options).
//    · `webhook_url`, `webhook_auth_header_name` (1–1000 caracteres ASCII letras/números/-/_),
//      `webhook_auth_header_value` (1–1000 caracteres, sin saltos de línea).
//    · Respuesta: `id`, `status` ∈ queued|processing|completed|error, `error`, `audio_duration` (SEGUNDOS),
//      `words[]` {text,start,end,confidence,speaker} con start/end en MILISEGUNDOS,
//      `utterances[]` {speaker,start,end,text,…}; hablantes = letras mayúsculas secuenciales (A, B, C…).
//  - Modelos: Universal-3.5 Pro y Universal-2 soportan español ('es').
//    https://www.assemblyai.com/docs/getting-started/models
//  - Webhook: cuerpo JSON { transcript_id, status: 'completed' | 'error' } (sin texto); responder 2xx en
//    < 10 s; hasta 10 intentos; "If at any point your endpoint returns a 4xx status code, the webhook call
//    is considered failed and will not be retried". IPs de origen: 44.238.19.20 (US), 54.220.25.36 (EU).
//    https://www.assemblyai.com/docs/deployment/webhooks
//  - Borrar: DELETE /v2/transcript/{transcript_id} — "Remove the data from the transcript and mark it as
//    deleted"; 200 devuelve el objeto borrado. https://www.assemblyai.com/docs/api-reference/transcripts/delete
//
// Reglas de privacidad: nunca se envía `metadata` ni datos del paciente; nunca se registra la URL firmada
// ni el texto; los mensajes de error se sanean (sin URLs) antes de guardarlos.
import { createHash, timingSafeEqual } from 'node:crypto';
import { secreto } from '../secretos';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MODELO_U35_PRO, RUTAS, WEBHOOK_HEADER_ASSEMBLYAI,
  type AssemblyAI, type DecisionModelo, type EstadoSegmentoAAI, type PalabraAAI, type ResultadoTranscripcion,
} from './tipos';

export const AAI_BASE = 'https://api.assemblyai.com';
export const IDIOMA = 'es';

// ─── Errores ─────────────────────────────────────────────────────────────────

export class ErrorAssemblyAI extends Error {
  constructor(
    mensaje: string,
    /** HTTP status (0 = red / tiempo agotado). */
    public readonly status: number,
    /** true = vale la pena reintentar más tarde (red, 429, 5xx). false = 4xx: hay que cambiar algo. */
    public readonly recuperable: boolean,
  ) {
    super(mensaje);
    this.name = 'ErrorAssemblyAI';
  }
}

/** Quita URLs (podrían ser la URL firmada del audio) y acorta. Para guardar en aai_error / ultimo_error. */
export function sanearMensaje(m: unknown, max = 300): string {
  const s = String(m ?? '').replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─── Configuración ───────────────────────────────────────────────────────────

export interface ConfigAssemblyAI {
  apiKey: string;
  /** Valor de la cabecera X-VO-Webhook (ASSEMBLYAI_WEBHOOK_SECRET). */
  webhookSecret: string;
  /** URL pública absoluta del webhook (https). */
  webhookUrl: string;
  base?: string;
  fetch?: typeof fetch;
  /** Reemplazable en pruebas (sin esperas reales). */
  dormir?: (ms: number) => Promise<void>;
  /** Intentos totales por petición ante red/429/5xx (default 3). */
  intentos?: number;
  /** Tiempo máximo por intento (default 20 s). */
  timeoutMs?: number;
}

function envVar(nombre: 'ASSEMBLYAI_API_KEY' | 'ASSEMBLYAI_WEBHOOK_SECRET' | 'PUBLIC_SITE_URL'): string | undefined {
  // Llaves SOLO en runtime (secretos.ts): con import.meta.env.X Vite las escribía en el bundle (A2/M1).
  if (nombre !== 'PUBLIC_SITE_URL') return secreto(nombre);
  let v: string | undefined;
  try { v = import.meta.env.PUBLIC_SITE_URL; } catch { v = undefined; } // fuera de Vite no hay import.meta.env
  return (typeof process !== 'undefined' ? process.env.PUBLIC_SITE_URL : undefined) || v || undefined;
}

export function urlWebhook(sitio: string): string {
  return `${sitio.replace(/\/+$/, '')}${RUTAS.webhookAssemblyAI}`;
}

/** Cliente con las variables de entorno. Lanza si falta alguna (falla cerrado). */
export function assemblyAIDesdeEnv(extra: Partial<ConfigAssemblyAI> = {}): AssemblyAI {
  const apiKey = envVar('ASSEMBLYAI_API_KEY');
  const webhookSecret = envVar('ASSEMBLYAI_WEBHOOK_SECRET');
  const sitio = envVar('PUBLIC_SITE_URL') || 'https://www.valentinaorellana.cl';
  if (!apiKey) throw new ErrorAssemblyAI('Falta ASSEMBLYAI_API_KEY en Vercel', 0, false);
  if (!webhookSecret) throw new ErrorAssemblyAI('Falta ASSEMBLYAI_WEBHOOK_SECRET en Vercel', 0, false);
  return crearClienteAssemblyAI({ apiKey, webhookSecret, webhookUrl: urlWebhook(sitio), ...extra });
}

// ─── Cuerpo del envío (función pura, con pruebas) ───────────────────────────

export interface CuerpoTranscripcion {
  audio_url: string;
  speech_models: string[];
  language_code: string;
  punctuate: true;
  format_text: true;
  speaker_labels: boolean;
  speakers_expected?: number;
  webhook_url: string;
  webhook_auth_header_name: string;
  webhook_auth_header_value: string;
}

export function cuerpoEnvio(
  audioUrl: string,
  decision: DecisionModelo,
  webhook: { url: string; secreto: string },
): CuerpoTranscripcion {
  if (!/^https:\/\//i.test(audioUrl)) throw new ErrorAssemblyAI('audio_url debe ser https', 0, false);
  if (!/^https:\/\//i.test(webhook.url)) throw new ErrorAssemblyAI('webhook_url debe ser https', 0, false);
  if (!webhook.secreto || webhook.secreto.length > 1000 || /[\r\n]/.test(webhook.secreto)) {
    throw new ErrorAssemblyAI('Secreto del webhook inválido (1–1000 caracteres, sin saltos de línea)', 0, false);
  }
  const cuerpo: CuerpoTranscripcion = {
    audio_url: audioUrl,
    speech_models: [decision.modelo],          // un solo modelo: la regla fija de reglas.ts, sin respaldo automático
    language_code: IDIOMA,
    punctuate: true,                            // obligatorio para speaker_labels
    format_text: true,
    speaker_labels: decision.diarizacion,
    webhook_url: webhook.url,
    webhook_auth_header_name: WEBHOOK_HEADER_ASSEMBLYAI,
    webhook_auth_header_value: webhook.secreto,
  };
  if (decision.diarizacion && decision.hablantesEsperados && decision.hablantesEsperados > 0) {
    cuerpo.speakers_expected = Math.trunc(decision.hablantesEsperados);
  }
  return cuerpo;
}

/**
 * 50-arquitectura §4 regla 4: status=error en AssemblyAI → 1 reintento con el mismo modelo, luego uno con
 * universal-3-5-pro, luego null (la grabación pasa a 'error'). `erroresPrevios` = cuántas veces ya falló.
 */
export function decisionTrasErrorAAI(decision: DecisionModelo, erroresPrevios: number): DecisionModelo | null {
  if (erroresPrevios <= 1) return decision;
  if (erroresPrevios === 2 && decision.modelo !== MODELO_U35_PRO) {
    return { ...decision, modelo: MODELO_U35_PRO, motivo: `${decision.motivo} Reintento con Universal-3.5 Pro tras error.` };
  }
  return null;
}

/**
 * Cuántos intentos hace en total el ciclo de decisionTrasErrorAAI para esta decisión (ronda 2, 18 oct):
 * 3 si el modelo base no es U3.5 Pro (mismo, mismo, Pro); 2 si ya lo es (pareja o "lugar con ruido").
 */
export function intentosAAI(decision: DecisionModelo): number {
  let n = 1;
  while (n < 10 && decisionTrasErrorAAI(decision, n)) n++;
  return n;
}

/** Texto del aviso cuando se agotan los intentos: dice cuántos fueron de verdad (antes decía siempre 3). */
export function textoErrorDefinitivoAAI(decision: DecisionModelo): { mensaje: string; detalle: string } {
  const n = intentosAAI(decision);
  const conPro = decision.modelo === MODELO_U35_PRO ? `todos con ${MODELO_U35_PRO}` : `el último con ${MODELO_U35_PRO}`;
  return {
    mensaje: `AssemblyAI no pudo transcribir el audio (${n} intentos, ${decision.modelo === MODELO_U35_PRO ? 'con' : 'incluido'} Universal-3.5 Pro)`,
    detalle: `AssemblyAI devolvió error en los ${n} intentos (${conPro}). El audio se borra solo a las 24 h: reintenta antes.`,
  };
}

// ─── Normalización de la respuesta ───────────────────────────────────────────

const ESTADOS_AAI = ['queued', 'processing', 'completed', 'error'] as const;

/** Se queda solo con lo que usamos (sin `text` completo ni otros campos). */
export function normalizarResultado(x: unknown): ResultadoTranscripcion {
  const r = (x ?? {}) as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const status = (ESTADOS_AAI as readonly string[]).includes(String(r.status)) ? (r.status as ResultadoTranscripcion['status']) : 'error';
  if (!id) throw new ErrorAssemblyAI('Respuesta de AssemblyAI sin id', 0, true);
  const out: ResultadoTranscripcion = { id, status };
  if (r.error != null) out.error = sanearMensaje(r.error);
  if (typeof r.audio_duration === 'number') out.audio_duration = r.audio_duration;
  if (Array.isArray(r.words)) {
    out.words = r.words
      .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
      .filter((w) => typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
      .map((w): PalabraAAI => ({
        text: w.text as string,
        start: w.start as number,
        end: w.end as number,
        ...(typeof w.confidence === 'number' ? { confidence: w.confidence } : {}),
        speaker: typeof w.speaker === 'string' ? w.speaker : null,
      }));
  }
  if (Array.isArray(r.utterances)) {
    out.utterances = r.utterances
      .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
      .filter((u) => typeof u.text === 'string' && Number.isFinite(u.start) && Number.isFinite(u.end))
      .map((u) => ({ speaker: String(u.speaker ?? ''), start: u.start as number, end: u.end as number, text: u.text as string }));
  }
  return out;
}

/** status de AssemblyAI → aai_estado del segmento. */
export function estadoSegmentoDesde(status: ResultadoTranscripcion['status']): EstadoSegmentoAAI {
  return status;
}

// ─── Cliente HTTP con reintentos ─────────────────────────────────────────────

const ID_VALIDO = /^[A-Za-z0-9_-]{1,100}$/;
export const esIdTranscript = (id: unknown): id is string => typeof id === 'string' && ID_VALIDO.test(id);

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function crearClienteAssemblyAI(cfg: ConfigAssemblyAI): AssemblyAI {
  const base = (cfg.base ?? AAI_BASE).replace(/\/+$/, '');
  const f = cfg.fetch ?? fetch;
  const dormir = cfg.dormir ?? dormirReal;
  const intentos = Math.max(1, cfg.intentos ?? 3);
  const timeoutMs = cfg.timeoutMs ?? 20_000;

  async function pedir(metodo: 'GET' | 'POST' | 'DELETE', ruta: string, cuerpo?: unknown, aceptar404 = false): Promise<unknown> {
    let ultimo: ErrorAssemblyAI | null = null;
    for (let n = 0; n < intentos; n++) {
      if (n > 0) await dormir(Math.min(8_000, 500 * 3 ** (n - 1)) + Math.floor(Math.random() * 200));
      const ctl = new AbortController();
      const reloj = setTimeout(() => ctl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await f(`${base}${ruta}`, {
          method: metodo,
          headers: { authorization: cfg.apiKey, ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
          signal: ctl.signal,
        });
      } catch (e) {
        clearTimeout(reloj);
        ultimo = new ErrorAssemblyAI(`AssemblyAI ${metodo}: sin respuesta (${sanearMensaje(e instanceof Error ? e.name : e)})`, 0, true);
        continue;
      }
      clearTimeout(reloj);
      if (res.ok) {
        const texto = await res.text();
        try { return texto ? JSON.parse(texto) : {}; } catch { throw new ErrorAssemblyAI(`AssemblyAI ${metodo}: respuesta no es JSON`, res.status, true); }
      }
      if (res.status === 404 && aceptar404) return null;
      let detalle = '';
      try { const j = await res.json() as { error?: unknown }; detalle = sanearMensaje(j?.error); } catch { /* sin cuerpo */ }
      const recuperable = res.status === 429 || res.status >= 500;
      ultimo = new ErrorAssemblyAI(`AssemblyAI ${metodo} ${res.status}${detalle ? `: ${detalle}` : ''}`, res.status, recuperable);
      if (!recuperable) throw ultimo;
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0 && n + 1 < intentos) await dormir(Math.min(ra, 5) * 1000);
    }
    throw ultimo ?? new ErrorAssemblyAI(`AssemblyAI ${metodo}: falló`, 0, true);
  }

  return {
    async enviar({ audioUrl, decision }) {
      const cuerpo = cuerpoEnvio(audioUrl, decision, { url: cfg.webhookUrl, secreto: cfg.webhookSecret });
      // Ojo: un POST reintentado tras un 5xx/red podría dejar un transcript duplicado en AssemblyAI (su id no
      // queda en ningún segmento, así que su webhook se ignora). Lo cubre el TTL de 1 día de la cuenta y
      // debería barrerlo el chequeo diario (P8: GET /v2/transcript no borrados > 2 h). Preferible a perder la sesión.
      const r = await pedir('POST', '/v2/transcript', cuerpo) as { id?: unknown };
      if (!esIdTranscript(r?.id)) throw new ErrorAssemblyAI('AssemblyAI no devolvió id de transcript', 0, true);
      return { id: r.id };
    },
    async obtener(id) {
      if (!esIdTranscript(id)) throw new ErrorAssemblyAI('Id de transcript inválido', 0, false);
      return normalizarResultado(await pedir('GET', `/v2/transcript/${id}`));
    },
    async borrar(id) {
      if (!esIdTranscript(id)) throw new ErrorAssemblyAI('Id de transcript inválido', 0, false);
      await pedir('DELETE', `/v2/transcript/${id}`, undefined, true); // 404 = ya no existe → idempotente
    },
  };
}

// ─── Borrado en AssemblyAI DESPUÉS de guardar (orden: dato clínico primero) ──

/**
 * 50-arquitectura §4 regla 5: solo se borra en AssemblyAI cuando la transcripción cifrada de la grabación
 * ya está guardada (fila en `transcripciones` con sha256_cifrado). Marca aai_borrado_at y audita.
 * Lo llama el orquestador (P6). Devuelve false si todavía no hay transcripción guardada (no borra nada).
 */
export async function borrarTranscriptTrasGuardar(
  segmento: { id: string; grabacion_id: string; aai_transcript_id: string | null; aai_borrado_at?: string | null },
  deps: { aai: AssemblyAI; db?: SupabaseClient; ahora?: Date },
): Promise<boolean> {
  if (!segmento.aai_transcript_id || segmento.aai_borrado_at) return true;
  const db = deps.db ?? (await import('../supabase')).supabase;
  const { data: t, error } = await db
    .from('transcripciones').select('id, sha256_cifrado')
    .eq('grabacion_id', segmento.grabacion_id).is('deleted_at', null).maybeSingle();
  if (error) throw new Error(`borrarTranscriptTrasGuardar: ${error.message}`);
  if (!t?.sha256_cifrado) return false;
  await deps.aai.borrar(segmento.aai_transcript_id);
  const { error: e2 } = await db.from('grabacion_segmentos')
    .update({ aai_borrado_at: (deps.ahora ?? new Date()).toISOString() })
    .eq('id', segmento.id).is('aai_borrado_at', null);
  if (e2) throw new Error(`borrarTranscriptTrasGuardar: ${e2.message}`);
  const { auditar } = await import('./auditoria');
  await auditar('sistema', 'borrar_aai', { grabacionId: segmento.grabacion_id, detalle: { segmento_id: segmento.id }, cliente: db });
  return true;
}

// ─── Webhook (lógica testeable; el endpoint es src/pages/api/transcriptor/webhook-assemblyai.ts) ──

/** Compara la cabecera en tiempo constante (sha256 de ambos lados → mismo largo siempre). */
export function cabeceraValida(recibida: string | null | undefined, secreto: string): boolean {
  if (!secreto || typeof recibida !== 'string' || recibida.length === 0) {
    // Igual se hace una comparación para no cortar antes en tiempo.
    timingSafeEqual(createHash('sha256').update('x').digest(), createHash('sha256').update('y').digest());
    return false;
  }
  const a = createHash('sha256').update(recibida, 'utf8').digest();
  const b = createHash('sha256').update(secreto, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export interface CuerpoWebhook { transcript_id: string; status: 'completed' | 'error' }

/** Solo acepta { transcript_id, status ∈ completed|error }. El resto del cuerpo se ignora. */
export function parsearCuerpoWebhook(texto: string): CuerpoWebhook | null {
  if (!texto || texto.length > 10_000) return null;
  let j: unknown;
  try { j = JSON.parse(texto); } catch { return null; }
  const o = (j ?? {}) as Record<string, unknown>;
  if (!esIdTranscript(o.transcript_id)) return null;
  if (o.status !== 'completed' && o.status !== 'error') return null;
  return { transcript_id: o.transcript_id, status: o.status };
}

export interface SegmentoWebhook {
  id: string;
  grabacion_id: string;
  seq: number;
  aai_estado: EstadoSegmentoAAI | null;
}

/** Acceso a datos que necesita el webhook (Supabase en producción, memoria en pruebas). */
export interface RepoWebhook {
  /** insert … on conflict (proveedor, evento_id) do nothing. `nuevo` = esta llamada lo insertó. */
  registrar(eventoId: string, payload: CuerpoWebhook): Promise<{ nuevo: boolean; procesado: boolean }>;
  marcarProcesado(eventoId: string): Promise<void>;
  segmentoPorTranscript(transcriptId: string): Promise<SegmentoWebhook | null>;
  /** update condicional `where id=? and aai_estado in (desde)`. true si cambió una fila. */
  actualizarSegmento(id: string, desde: readonly EstadoSegmentoAAI[], cambios: Record<string, unknown>): Promise<boolean>;
  /** Si la grabación quedó en 'subida' (carrera con el envío), la pasa a 'transcribiendo'. */
  asegurarTranscribiendo(grabacionId: string): Promise<void>;
  auditar(grabacionId: string, detalle: Record<string, unknown>): Promise<void>;
}

export type EfectoWebhook =
  | 'completado' | 'error_aai' | 'repetido' | 'desconocido' | 'sin_cambio' | 'aun_procesando'
  | 'cuerpo_invalido' | 'no_autorizado' | 'no_configurado' | 'reintentar';
export interface ResultadoWebhook { http: 200 | 400 | 401 | 503; efecto: EfectoWebhook }

/** Estados desde los que un webhook puede mover el segmento (nunca retrocede uno terminal). */
const DESDE_ACTIVO: readonly EstadoSegmentoAAI[] = ['enviado', 'queued', 'processing'];

/**
 * Procesa un webhook. Nunca confía en el cuerpo: solo toma `transcript_id`, verifica que pertenezca a un
 * segmento nuestro y vuelve a pedir el estado real a AssemblyAI con nuestra llave. NO guarda texto: el
 * texto lo descarga, cifra y guarda el orquestador (P6) en el minuto siguiente. Idempotente: la misma
 * pareja (transcript_id, status) produce a lo más un efecto, aunque llegue repetida o en paralelo.
 * La grabación queda (o se asegura) en 'transcribiendo'; P6 la pasa a 'transcrita' cuando TODOS sus
 * segmentos están 'completed' y la transcripción cifrada quedó guardada, o reintenta los 'error'.
 */
export async function procesarWebhookAssemblyAI(
  entrada: { cabecera: string | null; cuerpo: string; secreto: string | undefined },
  deps: { repo: RepoWebhook; aai: Pick<AssemblyAI, 'obtener'>; ahora?: () => Date },
): Promise<ResultadoWebhook> {
  if (!entrada.secreto) return { http: 503, efecto: 'no_configurado' };
  if (!cabeceraValida(entrada.cabecera, entrada.secreto)) return { http: 401, efecto: 'no_autorizado' };
  const cuerpo = parsearCuerpoWebhook(entrada.cuerpo);
  if (!cuerpo) return { http: 400, efecto: 'cuerpo_invalido' };

  const eventoId = `${cuerpo.transcript_id}:${cuerpo.status}`;
  const reg = await deps.repo.registrar(eventoId, cuerpo);
  if (!reg.nuevo && reg.procesado) return { http: 200, efecto: 'repetido' };
  // !nuevo && !procesado: un intento anterior se cortó a mitad (o va en paralelo) → se reprocesa;
  // las escrituras son condicionales, así que no hay doble efecto.

  const seg = await deps.repo.segmentoPorTranscript(cuerpo.transcript_id);
  if (!seg) {
    await deps.repo.marcarProcesado(eventoId);
    return { http: 200, efecto: 'desconocido' }; // no revela nada; 200 para que no reintente
  }

  let real: ResultadoTranscripcion;
  try {
    real = await deps.aai.obtener(cuerpo.transcript_id);
  } catch {
    // 503 → AssemblyAI reintenta (hasta 10 veces); además el cron sondea a los 30 min sin webhook.
    return { http: 503, efecto: 'reintentar' };
  }
  if (real.id !== cuerpo.transcript_id) return { http: 503, efecto: 'reintentar' };

  const ahora = (deps.ahora ?? (() => new Date()))().toISOString();
  let cambio: boolean;
  let efecto: EfectoWebhook;
  if (real.status === 'completed') {
    cambio = await deps.repo.actualizarSegmento(seg.id, DESDE_ACTIVO, {
      aai_estado: 'completed',
      aai_completado_at: ahora,
      aai_audio_seg: real.audio_duration ?? null,
      aai_error: null,
    });
    efecto = 'completado';
  } else if (real.status === 'error') {
    cambio = await deps.repo.actualizarSegmento(seg.id, DESDE_ACTIVO, {
      aai_estado: 'error',
      aai_error: sanearMensaje(real.error || 'AssemblyAI devolvió error sin detalle'),
    });
    efecto = 'error_aai';
  } else {
    // El cuerpo decía terminado pero la API dice queued/processing: no se marca procesado (vendrá otro
    // intento o el sondeo del cron).
    if (seg.aai_estado === 'enviado') await deps.repo.actualizarSegmento(seg.id, ['enviado'], { aai_estado: real.status });
    return { http: 200, efecto: 'aun_procesando' };
  }

  if (cambio) {
    await deps.repo.asegurarTranscribiendo(seg.grabacion_id);
    await deps.repo.auditar(seg.grabacion_id, { segmento_id: seg.id, seq: seg.seq, estado_aai: real.status });
  }
  await deps.repo.marcarProcesado(eventoId);
  return { http: 200, efecto: cambio ? efecto : 'sin_cambio' };
}

/** RepoWebhook sobre Supabase (service_role). */
export function repoWebhookSupabase(db: SupabaseClient): RepoWebhook {
  return {
    async registrar(eventoId, payload) {
      const { data, error } = await db.from('transcriptor_webhooks')
        .upsert({ proveedor: 'assemblyai', evento_id: eventoId, payload }, { onConflict: 'proveedor,evento_id', ignoreDuplicates: true })
        .select('id');
      if (error) throw new Error(`webhook registrar: ${error.message}`);
      if (data && data.length > 0) return { nuevo: true, procesado: false };
      const { data: f, error: e2 } = await db.from('transcriptor_webhooks')
        .select('procesado_at').eq('proveedor', 'assemblyai').eq('evento_id', eventoId).maybeSingle();
      if (e2) throw new Error(`webhook registrar: ${e2.message}`);
      return { nuevo: false, procesado: !!(f as { procesado_at?: string | null } | null)?.procesado_at };
    },
    async marcarProcesado(eventoId) {
      const { error } = await db.from('transcriptor_webhooks')
        .update({ procesado_at: new Date().toISOString() })
        .eq('proveedor', 'assemblyai').eq('evento_id', eventoId).is('procesado_at', null);
      if (error) throw new Error(`webhook procesado: ${error.message}`);
    },
    async segmentoPorTranscript(transcriptId) {
      const { data, error } = await db.from('grabacion_segmentos')
        .select('id, grabacion_id, seq, aai_estado').eq('aai_transcript_id', transcriptId).maybeSingle();
      if (error) throw new Error(`webhook segmento: ${error.message}`);
      return (data as SegmentoWebhook | null) ?? null;
    },
    async actualizarSegmento(id, desde, cambios) {
      const { data, error } = await db.from('grabacion_segmentos')
        .update(cambios).eq('id', id).in('aai_estado', [...desde]).select('id');
      if (error) throw new Error(`webhook actualizar segmento: ${error.message}`);
      return !!data && data.length > 0;
    },
    async asegurarTranscribiendo(grabacionId) {
      const { transicionar } = await import('./estados');
      await transicionar(grabacionId, ['subida'], 'transcribiendo', {}, db);
    },
    async auditar(grabacionId, detalle) {
      const { auditar } = await import('./auditoria');
      await auditar('assemblyai', 'webhook_recibido', { grabacionId, detalle, cliente: db });
    },
  };
}
