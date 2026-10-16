// Transcriptor IA — contratos compartidos (paquete P0).
// Solo tipos, interfaces y constantes. Cada paquete (P1…P8) implementa las
// interfaces que le corresponden con ESTAS firmas; si necesita otra cosa, se
// pide un cambio aquí (no se redefine localmente).
// Diseño: docs/transcriptor/50-arquitectura.md (§2 datos, §3 archivos, §4 estados)
// + 30-seguridad.md (cifrado por sobre, bitácora) + 10-etica-legal.md §4 + 20-clinico.md.

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Nombre visible del bot en Google Meet (Vale lo admite a mano). */
export const BOT_NOMBRE = 'Notas de Ps. Valentina Orellana';

/** Rótulo fijo del resumen IA: interfaz, exportaciones y PDF (10-etica-legal §4.6). */
export const ROTULO_RESUMEN = 'Resumen automático (IA) — no revisado';
/** Rótulo fijo de cada respuesta de Q&A. */
export const ROTULO_RESPUESTA = 'Respuesta generada por IA';

/** Prefijos de llaves en los buckets. Las llaves son opacas: sin nombre, RUT, fecha ni id de paciente. */
export const PREFIJO_AUDIO = 'a/';          // bucket R2_BUCKET_AUDIO (ciclo de vida: 1 día)
export const PREFIJO_TRANSCRIPCION = 't/';  // bucket R2_BUCKET_TRANSCRIPCIONES y copia en B2

/** Magia y versión del formato binario de objetos cifrados (30-seguridad §3.3). */
export const FORMATO_CIFRADO_MAGIA = 'VOT1';
export const FORMATO_CIFRADO_VERSION = 1;

/** Modelos (nombres exactos verificados en 50-arquitectura §9). */
export const MODELO_U2 = 'universal-2';
export const MODELO_U35_PRO = 'universal-3-5-pro';
export const MODELO_RESUMEN = 'claude-sonnet-5-5';
export const MODELO_PREGUNTAS = 'claude-haiku-5-5';

/** Cabecera con la que AssemblyAI firma el webhook (valor = ASSEMBLYAI_WEBHOOK_SECRET). */
export const WEBHOOK_HEADER_ASSEMBLYAI = 'X-VO-Webhook';

/** Rutas (P0 fija los nombres; cada paquete crea su archivo). */
export const RUTAS = {
  grabador: '/admin/grabar',
  webhookAssemblyAI: '/api/transcriptor/webhook-assemblyai',
  botEvento: '/api/transcriptor/bot-evento',
  cron: '/api/cron/transcriptor',
  cronSalud: '/api/cron/transcriptor-salud',
} as const;

/** Tiempos del sistema (ms salvo que diga otra cosa). */
export const TIEMPOS = {
  leaseTomaMs: 10 * 60_000,
  urlSubidaSeg: 15 * 60,
  urlLecturaAssemblyAISeg: 6 * 60 * 60,
  segmentoBotMs: 15 * 60_000,
  solapamientoBotMs: 3_000,
  esperaAdmisionMs: 20 * 60_000,
  soloMs: 60_000,
  extraTrasFinMs: 30 * 60_000,
  vigilanteTrasFinMs: 45 * 60_000,
} as const;

/** Tope de tokens de contexto para una pregunta con Haiku (sobre 100k cobra 5×). */
export const MAX_TOKENS_PREGUNTA = 95_000;

// ─── Enumeraciones ───────────────────────────────────────────────────────────

export type Origen = 'presencial' | 'online';
export type TipoSesion = 'individual' | 'pareja' | 'sin_tipo';
export type ModeloTranscripcion = typeof MODELO_U2 | typeof MODELO_U35_PRO;
export type SessionTypeBooking = 'online' | 'presencial' | 'pareja-online' | 'pareja-presencial';

export const ESTADOS = [
  'creada', 'sin_consentimiento',
  'bot_lanzando', 'bot_en_lobby', 'bot_no_admitido',
  'grabando', 'pausada', 'subiendo', 'subida',
  'transcribiendo', 'transcrita', 'resumiendo', 'lista',
  'sin_audio', 'cancelada', 'error',
] as const;
export type EstadoGrabacion = (typeof ESTADOS)[number];

export type EstadoSegmentoAAI = 'enviado' | 'queued' | 'processing' | 'completed' | 'error';
export type EstadoResumen = 'pendiente' | 'en_batch' | 'listo' | 'error';
export type CreadaPor = 'vale' | 'bot' | 'cron';
export type PrioridadAtencion = 'ALTA' | 'REVISAR';

// ─── Ajustes en `settings` (valores de texto) ────────────────────────────────

export type GrabacionRequisito = 'obligatoria' | 'opcional';
export type ResumenModo = 'batch' | 'directo';

export const AJUSTES = {
  activo: 'transcriptor_activo',                    // 'true' | 'false' (default 'false')
  botActivo: 'transcriptor_bot_activo',             // 'true' | 'false' (default 'false')
  grabacionRequisito: 'transcriptor_grabacion_requisito', // GrabacionRequisito (default 'opcional')
  resumenModo: 'transcriptor_resumen_modo',         // ResumenModo (default 'directo' — decisión 16 oct)
  alertaRiesgo: 'transcriptor_alerta_riesgo',       // 'true' | 'false' (default 'false')
  presupuestoClp: 'transcriptor_presupuesto_clp',   // '35000'
  usdClp: 'transcriptor_usd_clp',                   // '950'
  latido: 'transcriptor_latido',                    // ISO; lo escribe el cron cada minuto
} as const;

export interface AjustesTranscriptor {
  activo: boolean;
  botActivo: boolean;
  grabacionRequisito: GrabacionRequisito;
  resumenModo: ResumenModo;
  alertaRiesgo: boolean;
  presupuestoClp: number;
  usdClp: number;
}

// ─── Filas de las tablas (0014_transcriptor.sql) ─────────────────────────────
// Fechas como string ISO (lo que devuelve supabase-js). bytea llega como string '\\x…'.

export interface Grabacion {
  id: string;
  patient_id: string | null;
  booking_id: string | null;
  google_event_id: string | null;
  consent_ids: string[];
  origen: Origen;
  tipo: TipoSesion;
  lugar_con_ruido: boolean;
  modelo: ModeloTranscripcion;
  diarizacion: boolean;
  estado: EstadoGrabacion;
  estado_antes_error: EstadoGrabacion | null;
  session_date: string;            // YYYY-MM-DD
  inicio_at: string | null;
  fin_at: string | null;
  hora_fin_prevista: string | null;
  duracion_seg: number | null;
  pausas: PausaGrabacion[];
  meet_url: string | null;
  bot_machine_id: string | null;
  bot_token_sha256: string | null;
  bot_token_vence_at: string | null;
  linea_hablantes: LineaHablante[] | null;
  mapa_hablantes: Record<string, string> | null;
  intentos: number;
  ultimo_error: string | null;
  tomada_en: string | null;
  audio_borrado_at: string | null;
  nota_sistema: string | null;
  creada_por: CreadaPor;
  created_at: string;
  updated_at: string;
}

export interface PausaGrabacion { desde_ms: number; hasta_ms: number }

/** Online: Meet ilumina el tile de quien habla; el bot registra on/off relativo al inicio. */
export interface LineaHablante { t_ms: number; nombre: string; on: boolean }

export interface Segmento {
  id: string;
  grabacion_id: string;
  seq: number;
  r2_key: string;
  mime: string;
  bytes: number | null;
  sha256: string | null;
  offset_ms: number;
  duracion_ms: number | null;
  subido_at: string | null;
  aai_transcript_id: string | null;
  aai_estado: EstadoSegmentoAAI | null;
  aai_enviado_at: string | null;
  aai_completado_at: string | null;
  aai_error: string | null;
  aai_audio_seg: number | null;
  aai_borrado_at: string | null;
  audio_borrado_at: string | null;
  created_at: string;
}

export interface Transcripcion {
  id: string;
  grabacion_id: string;
  r2_key: string;
  b2_key: string | null;
  b2_copiada_at: string | null;
  formato_v: number;
  kek_v: number;
  dek_envuelta: string | null;
  sha256_cifrado: string;
  bytes: number;
  palabras: number;
  tokens_aprox: number | null;
  duracion_s: number | null;
  modelo: string;
  idioma: string;
  deleted_at: string | null;
  motivo_borrado: string | null;
  created_at: string;
}

export interface InstruccionIA {
  id: string;
  uso: 'resumen' | 'preguntas';
  texto: string;
  activa: boolean;
  created_at: string;
}

/** Anexo de la ficha, separado de session_notes. Nunca se pisa: editar/regenerar = fila nueva. */
export interface ResumenIA {
  id: string;
  grabacion_id: string;
  patient_id: string | null;
  booking_id: string | null;
  transcripcion_id: string | null;
  version: number;
  autor: 'ia' | 'vale';
  basado_en: string | null;
  plantilla: 'individual' | 'pareja';
  rotulo: string;                  // default ROTULO_RESUMEN
  instrucciones_id: string | null;
  prompt_version: string | null;
  modelo: string;
  modo: ResumenModo;
  estado: EstadoResumen;
  batch_id: string | null;
  custom_id: string | null;        // ^[A-Za-z0-9_-]{1,64}$, id opaco
  batch_borrado_at: string | null;
  intentos: number;
  ultimo_error: string | null;
  contenido: string | null;
  atencion_prioridad: PrioridadAtencion | null;
  atencion_revisada_at: string | null;
  tokens_entrada: number | null;
  tokens_salida: number | null;
  costo_usd: number | null;
  oculto_at: string | null;
  created_at: string;
  listo_at: string | null;
}

/** Texto de pregunta y respuesta CIFRADO (formato VOT1). Nunca en claro en Supabase. */
export interface PreguntaIA {
  id: string;
  patient_id: string | null;
  grabacion_ids: string[];
  pregunta_cifrada: string;
  respuesta_cifrada: string | null;
  pregunta_largo: number;
  kek_v: number;
  modelo: string;
  tokens_entrada: number | null;
  tokens_salida: number | null;
  tokens_cache: number | null;
  costo_usd: number | null;
  error: string | null;
  created_at: string;
}

export interface WebhookRecibido {
  id: number;
  proveedor: 'assemblyai' | 'bot';
  evento_id: string;
  payload: unknown;
  recibido_at: string;
  procesado_at: string | null;
}

export type ActorAuditoria = 'vale' | 'sistema' | 'bot' | 'assemblyai' | 'anthropic' | 'cron';
export type ResultadoAuditoria = 'ok' | 'denegado' | 'error';
export type AccionAuditoria =
  | 'grabar_inicio' | 'grabar_pausa' | 'grabar_continuar' | 'grabar_fin' | 'subida_completa'
  | 'bot_lanzar' | 'bot_lobby' | 'bot_admitido' | 'bot_no_admitido' | 'bot_salio' | 'bot_sacar'
  | 'webhook_recibido' | 'transcripcion_guardada' | 'copia_b2'
  | 'borrar_audio' | 'borrar_aai' | 'borrar_batch' | 'borrar_transcripcion'
  | 'ver_transcripcion' | 'ver_resumen' | 'editar_resumen' | 'ocultar_resumen' | 'regenerar_resumen'
  | 'preguntar' | 'descargar' | 'exportar'
  | 'asignar_paciente' | 'renombrar_hablantes' | 'reintentar' | 'cambiar_ajuste' | 'cambiar_instrucciones'
  | 'consentimiento_faltante' | 'alerta' | 'rotar_llave';

export interface RegistroAuditoria {
  id: number;
  at: string;
  actor: ActorAuditoria;
  accion: AccionAuditoria;
  resultado: ResultadoAuditoria;
  grabacion_id: string | null;
  patient_id: string | null;
  ip: string | null;
  user_agent: string | null;
  detalle: Record<string, unknown> | null;   // SIN contenido clínico
}

export type ChequeoSalud =
  | 'assemblyai' | 'anthropic' | 'r2' | 'b2' | 'clave' | 'fly' | 'calendar' | 'pg_cron'
  | 'atascadas' | 'cobertura_online' | 'audio_borrado' | 'copias_b2' | 'respaldo_supabase'
  | 'gasto' | 'resumenes';

export interface SaludFila {
  chequeo: ChequeoSalud;
  ok: boolean;
  revisado_at: string;
  ultimo_ok_at: string | null;
  fallo_desde: string | null;
  detalle: Record<string, unknown> | null;
  alertado_at: string | null;
}

export interface ReporteMensual {
  mes: string;
  generado_at: string;
  datos: Record<string, unknown>;
  revisado_por_claude_at: string | null;
  notas_revision: string | null;
}

// ─── Reglas (implementadas en reglas.ts, P0) ─────────────────────────────────

export interface EntradaModelo { tipo: TipoSesion; origen: Origen; lugarConRuido: boolean }
export interface DecisionModelo {
  modelo: ModeloTranscripcion;
  /** speaker_labels de AssemblyAI (solo pareja presencial). */
  diarizacion: boolean;
  /** speakers_expected (pareja presencial: 2 pacientes + Vale = 3). */
  hablantesEsperados: number | null;
  motivo: string;
}

// ─── Contratos de los demás paquetes (solo firmas) ───────────────────────────

/** P1 — almacenamiento.ts (R2 + B2 vía S3). */
export interface Almacenamiento {
  urlSubida(key: string, contentType: string, vigenciaSeg?: number): Promise<string>;
  urlLectura(key: string, vigenciaSeg?: number): Promise<string>;
  put(bucket: BucketLogico, key: string, datos: Uint8Array, contentType?: string): Promise<{ sha256: string; bytes: number }>;
  get(bucket: BucketLogico, key: string): Promise<Uint8Array>;
  head(bucket: BucketLogico, key: string): Promise<{ bytes: number } | null>;
  borrar(bucket: BucketLogico, key: string): Promise<void>;
  /** Copia un objeto de transcripciones R2 → B2 y verifica sha256. */
  copiarAB2(key: string): Promise<{ b2Key: string; sha256: string }>;
  /** B2: borra TODAS las versiones. */
  borrarDeB2(key: string): Promise<void>;
}
export type BucketLogico = 'audio' | 'transcripciones' | 'b2';

/** P1 — cifrado.ts (AES-256-GCM, KEK/DEK, formato VOT1; 30-seguridad §3). */
export interface ContextoCifrado {
  /** Llave del objeto (p. ej. 't/<uuid>.bin'); va en el AAD. */
  claveObjeto: string;
  tipo: 'transcripcion' | 'pregunta' | 'respuesta';
}
export interface Cifrado {
  cifrar(claro: Uint8Array, ctx: ContextoCifrado): Promise<{ datos: Uint8Array; kekV: number; dekEnvuelta: Uint8Array }>;
  descifrar(datos: Uint8Array, ctx: ContextoCifrado): Promise<Uint8Array>;
}

/** Contenido en claro de una transcripción (antes de gzip + cifrar). */
export interface TranscripcionClara {
  v: 1;
  idioma: string;
  modelo: ModeloTranscripcion;
  duracion_s: number;
  hablantes: string[];
  segmentos: TramoTranscrito[];
}
export interface TramoTranscrito { inicio_ms: number; fin_ms: number; hablante: string; texto: string }

/** P2 — assemblyai.ts (fetch, sin SDK). */
export interface PalabraAAI { text: string; start: number; end: number; confidence?: number; speaker?: string | null }
export interface ResultadoTranscripcion {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  error?: string;
  audio_duration?: number;
  words?: PalabraAAI[];
  utterances?: { speaker: string; start: number; end: number; text: string }[];
}
export interface AssemblyAI {
  enviar(params: { audioUrl: string; decision: DecisionModelo }): Promise<{ id: string }>;
  obtener(id: string): Promise<ResultadoTranscripcion>;
  borrar(id: string): Promise<void>;
}

/** P2 — hablantes.ts (une segmentos y asigna hablantes). */
export type UnirTranscripcion = (entrada: {
  grabacion: Pick<Grabacion, 'origen' | 'tipo' | 'linea_hablantes' | 'mapa_hablantes' | 'pausas'>;
  segmentos: { offset_ms: number; resultado: ResultadoTranscripcion }[];
}) => TramoTranscrito[];

/** P3 — claude.ts / resumen.ts. */
export interface PeticionResumen {
  resumenId: string;
  customId: string;
  plantilla: 'individual' | 'pareja';
  instrucciones: string;
  transcripcion: TramoTranscrito[];
  contextoPrevio?: string | null;
}
export interface ResultadoBatch {
  customId: string;
  tipo: 'succeeded' | 'errored' | 'canceled' | 'expired';
  contenido?: string;
  errorRecuperable?: boolean;
  tokensEntrada?: number;
  tokensSalida?: number;
}
export interface ClienteClaude {
  crearBatch(peticiones: PeticionResumen[]): Promise<{ batchId: string }>;
  revisarBatch(batchId: string): Promise<{ terminado: boolean }>;
  leerResultados(batchId: string): Promise<ResultadoBatch[]>;
  borrarBatch(batchId: string): Promise<void>;
  /** Modo 'directo' (Messages API sincrónica) o 4.º intento. */
  resumirDirecto(peticion: PeticionResumen): Promise<ResultadoBatch>;
  preguntar(params: { pregunta: string; instrucciones: string; contexto: { fecha: string; tramos: TramoTranscrito[] }[] }):
    Promise<{ respuesta: string; tokensEntrada: number; tokensSalida: number; tokensCache: number }>;
}

/** P4 — consentimiento.ts. */
export interface ResultadoPuedeGrabar {
  puede: boolean;
  motivo?: 'sin_consentimiento' | 'revocado' | 'version_antigua' | 'falta_segunda_firma' | 'menor_de_edad' | 'sin_ficha';
  consentIds: string[];
}
export type PuedeGrabar = (patientId: string | null, tipo: TipoSesion) => Promise<ResultadoPuedeGrabar>;

/** P5 — bot.ts. */
export interface SesionOnline {
  googleEventId: string;
  meetUrl: string;
  inicio: string;
  fin: string;
  bookingId: string | null;
  patientId: string | null;
  tipo: TipoSesion;
}
export interface Bot {
  sesionesOnlineProximas(desde: Date, hasta: Date): Promise<SesionOnline[]>;
  lanzarBot(grabacion: Grabacion): Promise<{ machineId: string }>;
  matarBot(machineId: string): Promise<void>;
}
export type EventoBot =
  | { tipo: 'lobby' }
  | { tipo: 'activo' }
  | { tipo: 'pide_url'; seq: number }
  | { tipo: 'segmento_subido'; seq: number; bytes: number; offset_ms: number; duracion_ms: number }
  | { tipo: 'fin'; motivo: 'vale_salio' | 'solo' | 'hora_fin' | 'no_admitido' | 'expulsado' | 'participantes_extra' | 'error'; linea_hablantes: LineaHablante[] }
  | { tipo: 'error'; detalle: string };

/** P6 — pipeline.ts: cada paso devuelve cuántas grabaciones tocó. */
export interface Pipeline {
  despacharBots(ahora: Date): Promise<number>;
  reintentarEnvios(ahora: Date): Promise<number>;
  procesarTranscripciones(ahora: Date): Promise<number>;
  crearBatchResumenes(ahora: Date): Promise<number>;
  revisarBatches(ahora: Date): Promise<number>;
  vigilar(ahora: Date): Promise<number>;
}

/** P8 — salud.ts / alertas.ts. Correos SIN contenido clínico ni nombre del paciente. */
export interface ResultadoChequeo { chequeo: ChequeoSalud; ok: boolean; detalle?: Record<string, unknown> }
export type Chequear = () => Promise<ResultadoChequeo[]>;
export type EnviarAlerta = (asunto: string, cuerpoSinDatosClinicos: string) => Promise<boolean>;
