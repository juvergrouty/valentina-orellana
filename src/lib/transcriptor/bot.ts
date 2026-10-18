// Transcriptor IA — bot de Meet, lado del sitio (paquete P5).
// Diseño: 50-arquitectura.md §1.3, §3.6, §5 y 30-seguridad.md §5.
//
//  - sesionesOnlineProximas: lee Google Calendar (token ya conectado) y cruza con bookings /
//    patients. El enlace de Meet sale SOLO del calendario/reserva de Vale (nunca del cliente).
//  - lanzarBot: crea una máquina efímera en Fly con la Machines API (deploy token SOLO de la
//    app del bot), región iad, config.auto_destroy = true, restart.policy = "no".
//  - Token del bot: 32 bytes aleatorios (base64url), uno por grabación; en la base se guarda
//    SOLO HMAC-SHA256(BOT_TOKEN_SECRET, token) en grabaciones.bot_token_sha256 (la columna se
//    llama así desde P0; guarda el HMAC, no un SHA-256 simple) y vence al terminar la sesión
//    + 2 h. Se revoca (vence ya) al recibir `fin`.
//  - procesarEventoBot: lógica de /api/transcriptor/bot-evento. El bot solo puede avanzar SU
//    grabación y pedir URLs PUT de SU audio; ninguna respuesta trae datos de pacientes.
//  - Modo 'cuenta' (decisión G, docs/transcriptor/85-robot-meet.md): el robot entra con su propia
//    cuenta de Google, invitada al evento por el sitio; la sesión cifrada la entrega `pide_sesion`
//    (botCuenta.ts). Por defecto 'invitado' (anónimo, Vale lo admite), como siempre.
//
// Las funciones puras van arriba y tienen pruebas en bot.test.ts (sin red ni base).
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { repararMojibake } from './texto';
import { tipoDesdeSessionType } from './reglas';
import { secreto } from '../secretos';
import {
  cuentaRobotVigente, guardarSesionRenovada, leerModoBot, liberarSesion, marcarSesionVencida, tomarSesion, type ModoBot,
} from './botCuenta';
import { alertaDeAvisoRobot, alertaDeErrorBot, esMotivoSinSesion } from './avisosRobot';
import type { NuevaAlerta } from './alertas';
import {
  BOT_NOMBRE, PREFIJO_AUDIO, RUTAS, TIEMPOS,
  type Almacenamiento, type Bot, type EventoBot, type Grabacion, type LineaHablante, type SesionOnline, type TipoSesion,
} from './tipos';

// ─── Constantes ───────────────────────────────────────────────────────────────

export const FLY_API = 'https://api.machines.dev/v1';
export const FLY_REGION = 'iad';
/** El token vence al terminar la sesión + 2 h (30-seguridad §5.2). */
export const VIGENCIA_TOKEN_TRAS_FIN_MS = 2 * 60 * 60_000;
export const MIME_SEGMENTO_BOT = 'audio/webm';
/** Máximo de segmentos por grabación (15 min c/u → 50 h; tope anti-abuso). */
export const MAX_SEQ_BOT = 200;
export const MAX_LINEA_HABLANTES = 20_000;
/** Cuerpo máximo aceptado en bot-evento (la línea de hablantes de 1 h cabe holgada). */
export const MAX_CUERPO_EVENTO = 1_000_000;
/**
 * Tope por segmento del bot (revisión de seguridad 16 oct, B7): 15 min de audio Opus a 32 kbps son
 * ~4 MB; 300 MB deja margen de sobra y evita que un token robado suba GB que luego se mandan a
 * AssemblyAI (costo). Un segmento más grande se rechaza y su objeto se borra de R2.
 */
export const MAX_BYTES_SEGMENTO_BOT = 300 * 1024 * 1024;

/**
 * Sanea el texto de error que manda el bot (revisión 16 oct, B8): el mensaje crudo de Playwright puede
 * traer el enlace de Meet o su código (abc-defg-hij). Se quitan URLs, códigos de Meet y caracteres de
 * control antes de guardarlo en grabaciones.ultimo_error o en la bitácora.
 */
export function sanearErrorBot(m: unknown, max = 300): string {
  const t = String(m ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:https?|wss?):\/\/\S+/gi, '[url]')
    .replace(/\bmeet\.google\.com\/\S*/gi, '[url]')
    .replace(/\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/gi, '[código]')
    .replace(/\s+/g, ' ').trim();
  return t.slice(0, max);
}

/** Bloqueo por IP: 10 tokens inválidos en 15 min (como el login). */
export const MAX_FALLOS_IP = 10;
export const VENTANA_FALLOS_MS = 15 * 60_000;

/**
 * Ajuste (settings) con los nombres visibles de Vale en Meet, separados por "|".
 * Sirve para la regla "sale cuando Vale sale". Si no está, se usa NOMBRES_VALE_DEFECTO.
 * (Clave nueva de P5: no está en AJUSTES de tipos.ts.)
 */
export const AJUSTE_NOMBRES_VALE = 'transcriptor_bot_nombres_vale';
export const NOMBRES_VALE_DEFECTO = 'Valentina Orellana|Vínculos que sostienen';

const MEET_RE = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Token del bot (puro) ────────────────────────────────────────────────────

/** 32 bytes aleatorios en base64url (43 caracteres). Viaja solo a la máquina del bot. */
export function generarTokenBot(): string {
  return randomBytes(32).toString('base64url');
}

/** Lo único que se guarda en la base: HMAC-SHA256(secreto, token) en hex. */
export function hmacTokenBot(token: string, secreto: string): string {
  if (!secreto || secreto.length < 32) throw new Error('BOT_TOKEN_SECRET ausente o demasiado corto (mínimo 32 caracteres)');
  return createHmac('sha256', secreto).update(token, 'utf8').digest('hex');
}

/** Fin previsto de la sesión + 2 h. */
export function venceTokenBot(horaFinPrevista: string | Date): Date {
  const t = new Date(horaFinPrevista).getTime();
  if (Number.isNaN(t)) throw new Error('hora_fin_prevista inválida');
  return new Date(t + VIGENCIA_TOKEN_TRAS_FIN_MS);
}

/** Extrae el token de "Authorization: Bearer <token>"; null si falta o tiene otro formato. */
export function extraerBearer(cabecera: string | null | undefined): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec((cabecera ?? '').trim());
  return m && TOKEN_RE.test(m[1]) ? m[1] : null;
}

/** ¿El token guardado sigue vigente? (no vencido ni revocado: revocar = vencer ya). */
export function tokenVigente(venceAt: string | null, ahora: Date = new Date()): boolean {
  if (!venceAt) return false;
  const t = Date.parse(venceAt);
  return !Number.isNaN(t) && t > ahora.getTime();
}

// ─── Eventos del bot (puro) ──────────────────────────────────────────────────

/**
 * Eventos del bot = EventoBot de tipos.ts + los del modo 'cuenta' (P-bot, decisión G). Se definen
 * aquí para no tocar el contrato de tipos.ts; el bot (bot/src/sitio.ts) usa los mismos.
 *  - pide_sesion: el bot pide la sesión de Google del robot (solo en bot_lanzando, uno a la vez).
 *  - sesion_actualizada: al salir, devuelve la sesión renovada (Google rota cookies).
 *  - sesion_invalida: la sesión no sirvió; el bot entró como invitado y la sesión queda vencida.
 */
export type EventoBotCuenta =
  | { tipo: 'pide_sesion' }
  | { tipo: 'sesion_actualizada'; sesion: unknown }
  | { tipo: 'sesion_invalida'; motivo: string };
export type EventoBotSitio = EventoBot | EventoBotCuenta;

export type ResultadoParseo = { ok: true; evento: EventoBotSitio } | { ok: false; error: string };

const MOTIVOS = new Set(['vale_salio', 'solo', 'hora_fin', 'no_admitido', 'expulsado', 'participantes_extra', 'error']);
const esEntero = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

function lineaValida(x: unknown): LineaHablante[] | null {
  if (!Array.isArray(x) || x.length > MAX_LINEA_HABLANTES) return null;
  const out: LineaHablante[] = [];
  for (const e of x) {
    if (!e || typeof e !== 'object') return null;
    const { t_ms, nombre, on } = e as Record<string, unknown>;
    if (!esEntero(t_ms, 0, 24 * 60 * 60_000) || typeof on !== 'boolean') return null;
    if (typeof nombre !== 'string' || !nombre.trim() || nombre.length > 60) return null;
    out.push({ t_ms, nombre: nombre.trim(), on });
  }
  return out;
}

/** Valida estrictamente el cuerpo (ya parseado como JSON). Ignora campos extra. */
export function parsearEventoBot(cuerpo: unknown): ResultadoParseo {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return { ok: false, error: 'cuerpo no es un objeto' };
  const c = cuerpo as Record<string, unknown>;
  switch (c.tipo) {
    case 'lobby':
    case 'activo':
      return { ok: true, evento: { tipo: c.tipo } };
    case 'pide_url':
      if (!esEntero(c.seq, 0, MAX_SEQ_BOT)) return { ok: false, error: 'seq inválido' };
      return { ok: true, evento: { tipo: 'pide_url', seq: c.seq } };
    case 'segmento_subido':
      if (!esEntero(c.seq, 0, MAX_SEQ_BOT)) return { ok: false, error: 'seq inválido' };
      if (!esEntero(c.bytes, 1, 5 * 1024 ** 3)) return { ok: false, error: 'bytes inválido' };
      if (!esEntero(c.offset_ms, 0, 24 * 60 * 60_000)) return { ok: false, error: 'offset_ms inválido' };
      if (!esEntero(c.duracion_ms, 0, 24 * 60 * 60_000)) return { ok: false, error: 'duracion_ms inválido' };
      return { ok: true, evento: { tipo: 'segmento_subido', seq: c.seq, bytes: c.bytes, offset_ms: c.offset_ms, duracion_ms: c.duracion_ms } };
    case 'fin': {
      if (typeof c.motivo !== 'string' || !MOTIVOS.has(c.motivo)) return { ok: false, error: 'motivo inválido' };
      const linea = lineaValida(c.linea_hablantes ?? []);
      if (!linea) return { ok: false, error: 'linea_hablantes inválida' };
      return { ok: true, evento: { tipo: 'fin', motivo: c.motivo as Extract<EventoBot, { tipo: 'fin' }>['motivo'], linea_hablantes: linea } };
    }
    case 'error':
      if (typeof c.detalle !== 'string') return { ok: false, error: 'detalle inválido' };
      return { ok: true, evento: { tipo: 'error', detalle: sanearErrorBot(c.detalle) } };
    case 'pide_sesion':
      return { ok: true, evento: { tipo: 'pide_sesion' } };
    case 'sesion_actualizada':
      if (!c.sesion || typeof c.sesion !== 'object') return { ok: false, error: 'sesion inválida' };
      return { ok: true, evento: { tipo: 'sesion_actualizada', sesion: c.sesion } };
    case 'sesion_invalida':
      return { ok: true, evento: { tipo: 'sesion_invalida', motivo: sanearErrorBot(typeof c.motivo === 'string' ? c.motivo : '', 200) } };
    default:
      return { ok: false, error: 'tipo desconocido' };
  }
}

/**
 * evento_id para transcriptor_webhooks (idempotencia): '<grabacion_id>:<tipo>:<seq>'.
 * pide_url no se deduplica (es idempotente por sí mismo y el bot lo repite al reintentar).
 */
export function idEventoBot(grabacionId: string, e: EventoBotSitio): string | null {
  switch (e.tipo) {
    case 'pide_url': return null;
    case 'pide_sesion': return null; // el candado de la sesión ya lo hace idempotente
    case 'segmento_subido': return `${grabacionId}:segmento_subido:${e.seq}`;
    case 'error': return `${grabacionId}:error:${createHash('sha256').update(e.detalle).digest('hex').slice(0, 12)}`;
    default: return `${grabacionId}:${e.tipo}:`;
  }
}

/** Payload que se guarda del evento: sin nombres ni línea de hablantes (sin contenido clínico). */
export function payloadSeguro(e: EventoBotSitio): Record<string, unknown> {
  switch (e.tipo) {
    // Nunca se guardan las cookies del robot en la bitácora de eventos.
    case 'sesion_actualizada': return { tipo: e.tipo };
    case 'sesion_invalida': return { tipo: e.tipo, motivo: e.motivo };
    case 'fin': return { tipo: e.tipo, motivo: e.motivo, entradas_linea: e.linea_hablantes.length };
    case 'segmento_subido': return { tipo: e.tipo, seq: e.seq, bytes: e.bytes, offset_ms: e.offset_ms, duracion_ms: e.duracion_ms };
    case 'pide_url': return { tipo: e.tipo, seq: e.seq };
    case 'error': return { tipo: e.tipo, detalle: e.detalle };
    default: return { tipo: e.tipo };
  }
}

/** Texto de nota_sistema según cómo terminó el bot (visible en el panel). */
export function notaFinBot(motivo: Extract<EventoBot, { tipo: 'fin' }>['motivo'], minutos: number): string | null {
  switch (motivo) {
    case 'error': return `Grabación incompleta (el asistente de notas se cayó a los ${minutos} min)`;
    case 'participantes_extra': return 'El asistente de notas salió porque había más participantes de los esperados (no graba a terceros sin consentimiento)';
    case 'expulsado': return 'El asistente de notas fue retirado de la reunión; se conserva lo grabado hasta ese momento';
    case 'hora_fin': return 'El asistente de notas salió al llegar al máximo de duración de la sesión';
    default: return null;
  }
}

// ─── Calendario → sesiones online (puro) ─────────────────────────────────────

/** Deja solo https://meet.google.com/xxx-xxxx-xxx (sin parámetros). null si no es de Meet. */
export function normalizarMeetUrl(url: string | null | undefined): string | null {
  const m = MEET_RE.exec((url ?? '').trim());
  return m ? `https://meet.google.com/${m[1].toLowerCase()}` : null;
}

/** "Meet: <url>" dentro de bookings.notes (syncCalendar.ts lo escribe así). */
export function meetUrlDesdeNotas(notas: string | null | undefined): string | null {
  const m = /(?:^|\n)\s*Meet:\s*(\S+)/.exec(notas ?? '');
  return m ? normalizarMeetUrl(m[1]) : null;
}

export interface EventoCalendario {
  id: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: { email?: string; self?: boolean; organizer?: boolean; responseStatus?: string; resource?: boolean }[];
}

export function meetUrlDesdeEvento(ev: EventoCalendario): string | null {
  const directo = normalizarMeetUrl(ev.hangoutLink);
  if (directo) return directo;
  for (const ep of ev.conferenceData?.entryPoints ?? []) {
    if (ep.entryPointType === 'video') { const u = normalizarMeetUrl(ep.uri); if (u) return u; }
  }
  return null;
}

/** Id de evento de una reserva del sitio = booking.id sin guiones → uuid con guiones. */
export function uuidDesdeEventId(eventId: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(eventId)) return null;
  const u = `${eventId.slice(0, 8)}-${eventId.slice(8, 12)}-${eventId.slice(12, 16)}-${eventId.slice(16, 20)}-${eventId.slice(20)}`;
  return UUID_RE.test(u) ? u : null;
}

/** Correos de los invitados que no son Vale ni recursos (para cruzar con patients.email). */
export function correosInvitados(ev: EventoCalendario): string[] {
  return [...new Set((ev.attendees ?? [])
    .filter((a) => a.email && !a.self && !a.resource && a.responseStatus !== 'declined')
    .map((a) => a.email!.trim().toLowerCase()))];
}

/** Evento descartable: cancelado, de día completo, Vale lo rechazó o sin Meet. */
export function eventoUtil(ev: EventoCalendario): boolean {
  if (ev.status === 'cancelled') return false;
  if (!ev.start?.dateTime || !ev.end?.dateTime) return false;
  if ((ev.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined')) return false;
  return meetUrlDesdeEvento(ev) !== null;
}

/** Humanos permitidos en la llamada: Vale + 1 (individual) o Vale + 2 (pareja). */
export function maxHumanosPorTipo(tipo: TipoSesion): number {
  return tipo === 'pareja' ? 3 : 2;
}

// ─── Máquina de Fly (puro) ───────────────────────────────────────────────────

export interface ParamsMaquina {
  grabacion: Pick<Grabacion, 'id' | 'meet_url' | 'hora_fin_prevista' | 'tipo'>;
  token: string;
  imagen: string;
  eventoUrl: string;
  nombresVale: string;
  sufijo?: string;
  /** 'cuenta': el bot pide la sesión del robot (pide_sesion) y entra con ella. Default 'invitado'. */
  modo?: ModoBot;
  /** Correo de la cuenta del robot (el bot comprueba que la sesión sea de esa cuenta). */
  cuentaEmail?: string | null;
}

/** Cuerpo de POST /v1/apps/{app}/machines (docs.fly.io/machines/api/machines-resource). */
export function cuerpoMaquina(p: ParamsMaquina): Record<string, unknown> {
  const meet = normalizarMeetUrl(p.grabacion.meet_url);
  if (!meet) throw new Error('La grabación no tiene un enlace de Meet válido');
  if (!p.grabacion.hora_fin_prevista) throw new Error('La grabación no tiene hora_fin_prevista');
  if (!/^registry\.fly\.io\/[a-z0-9-]+:[A-Za-z0-9._-]+$/.test(p.imagen) || p.imagen.endsWith(':latest')) {
    throw new Error('FLY_IMAGEN debe ser registry.fly.io/<app>:<tag fijo> (no latest)');
  }
  if (!p.eventoUrl.startsWith('https://')) throw new Error('La URL de eventos del bot debe ser https');
  return {
    name: `bot-${p.grabacion.id.slice(0, 8)}-${p.sufijo ?? Date.now().toString(36)}`,
    region: FLY_REGION,
    config: {
      image: p.imagen,
      env: {
        GRABACION_ID: p.grabacion.id,
        MEET_URL: meet,
        BOT_NOMBRE,
        EVENTO_URL: p.eventoUrl,
        BOT_TOKEN: p.token,
        HORA_FIN: new Date(p.grabacion.hora_fin_prevista).toISOString(),
        ESPERA_ADMISION_MS: String(TIEMPOS.esperaAdmisionMs),
        SOLO_MS: String(TIEMPOS.soloMs),
        MAX_EXTRA_MS: String(TIEMPOS.extraTrasFinMs),
        SEGMENTO_MS: String(TIEMPOS.segmentoBotMs),
        SOLAPAMIENTO_MS: String(TIEMPOS.solapamientoBotMs),
        MAX_HUMANOS: String(maxHumanosPorTipo(p.grabacion.tipo)),
        VALE_NOMBRES: p.nombresVale,
        BOT_MODO: p.modo === 'cuenta' && p.cuentaEmail ? 'cuenta' : 'invitado',
        ...(p.modo === 'cuenta' && p.cuentaEmail ? { BOT_CUENTA_EMAIL: p.cuentaEmail } : {}),
      },
      guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
      // "If true, the Machine destroys itself once it's complete." (Machines API)
      auto_destroy: true,
      restart: { policy: 'no' },
    },
  };
}

// ─── Implementación con red y base ───────────────────────────────────────────

type Cliente = SupabaseClient;
async function clientePorDefecto(): Promise<Cliente> {
  return (await import('../supabase')).supabase;
}

/** Registra un aviso (alertas.ts). */
export type Alertar = (a: NuevaAlerta) => Promise<void>;

/**
 * Aviso INMEDIATO de un problema del robot (avisosRobot.ts), con la misma base `c` que el resto del
 * evento. Nunca lanza: un aviso que no se pudo guardar no cambia la respuesta al robot.
 */
async function avisarRobot(c: Cliente, a: NuevaAlerta, propio?: Alertar): Promise<void> {
  try {
    if (propio) { await propio(a); return; }
    const m = await import('./alertas');
    await m.crearAlertas({
      repo: m.repoAlertasSupabase(c),
      auditarNueva: async (f) => {
        const { auditar } = await import('./auditoria');
        await auditar('sistema', 'alerta', { grabacionId: f.grabacion_id, detalle: { op: 'nueva', tipo: f.tipo, clave_alerta: f.clave }, cliente: c });
      },
    }).registrarAlerta(a);
  } catch (e) {
    console.warn('[transcriptor/bot] no se pudo registrar el aviso:', e instanceof Error ? e.message : e);
  }
}

export interface DepsBot {
  db?: Cliente;
  fetch?: typeof fetch;
  env?: Partial<Record<'FLY_API_TOKEN' | 'FLY_APP_BOT' | 'FLY_IMAGEN' | 'BOT_TOKEN_SECRET' | 'PUBLIC_SITE_URL', string | undefined>>;
  /** Para pruebas: token de Google y calendario. */
  calendario?: () => Promise<{ token: string; calendarId: string } | null>;
  /** Para pruebas: agrega el robot como invitado del evento (por defecto googleCalendar.agregarInvitadoSinAviso). */
  invitar?: (token: string, calendarId: string, eventId: string, correo: string) => Promise<string>;
  /** Para pruebas: registro de avisos (por defecto alertas.ts con la misma base). */
  alertar?: Alertar;
}

// Llaves (FLY_API_TOKEN, BOT_TOKEN_SECRET) SOLO en runtime vía secretos.ts. Nunca leer
// `import.meta.env` como objeto: Vite lo incrusta entero en el bundle (revisión 16 oct, A2/M1).
function envNoSecreta(n: 'FLY_APP_BOT' | 'FLY_IMAGEN' | 'PUBLIC_SITE_URL'): string | undefined {
  const p = typeof process !== 'undefined' ? process.env?.[n] : undefined;
  if (p) return p;
  try {
    switch (n) {
      case 'FLY_APP_BOT': return import.meta.env.FLY_APP_BOT;
      case 'FLY_IMAGEN': return import.meta.env.FLY_IMAGEN;
      case 'PUBLIC_SITE_URL': return import.meta.env.PUBLIC_SITE_URL;
    }
  } catch { return undefined; } // fuera de Vite (pruebas) no hay import.meta.env
}

function envBot(deps: DepsBot) {
  return {
    FLY_API_TOKEN: deps.env?.FLY_API_TOKEN ?? secreto('FLY_API_TOKEN'),
    FLY_APP_BOT: deps.env?.FLY_APP_BOT ?? envNoSecreta('FLY_APP_BOT'),
    FLY_IMAGEN: deps.env?.FLY_IMAGEN ?? envNoSecreta('FLY_IMAGEN'),
    BOT_TOKEN_SECRET: deps.env?.BOT_TOKEN_SECRET ?? secreto('BOT_TOKEN_SECRET'),
    PUBLIC_SITE_URL: deps.env?.PUBLIC_SITE_URL ?? envNoSecreta('PUBLIC_SITE_URL') ?? 'https://www.valentinaorellana.cl',
  };
}

function nombreAppValido(app: string | undefined): string {
  if (!app || !/^[a-z0-9-]{2,63}$/.test(app)) throw new Error('Falta FLY_APP_BOT o no es un nombre de app válido');
  return app;
}

export function crearBot(deps: DepsBot = {}): Bot {
  const f = deps.fetch ?? fetch;
  const db = async () => deps.db ?? (await clientePorDefecto());

  async function sesionesOnlineProximas(desde: Date, hasta: Date): Promise<SesionOnline[]> {
    const auth = deps.calendario
      ? await deps.calendario()
      : await (await import('../syncCalendar')).getValidAccessToken();
    if (!auth) throw new Error('Google Calendar no está conectado');
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`
      + `?singleEvents=true&orderBy=startTime&maxResults=50`
      + `&timeMin=${encodeURIComponent(new Date(desde.getTime() - 6 * 60 * 60_000).toISOString())}`
      + `&timeMax=${encodeURIComponent(hasta.toISOString())}`;
    const res = await f(url, { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Google Calendar events.list respondió ${res.status}`);
    const datos = (await res.json()) as { items?: EventoCalendario[] };
    const eventos = (datos.items ?? []).filter((ev) => {
      if (!eventoUtil(ev)) return false;
      const t = Date.parse(ev.start!.dateTime!);
      return t >= desde.getTime() && t <= hasta.getTime();
    });
    if (!eventos.length) return [];

    const c = await db();
    // Reservas del sitio: google_event_id = id del booking sin guiones (o el id real guardado).
    const ids = eventos.map((e) => e.id);
    const { data: reservas, error: e1 } = await c.from('bookings')
      .select('id, google_event_id, session_type, status, patient_email, notes')
      .in('google_event_id', ids);
    if (e1) throw new Error(`bookings: ${e1.message}`);
    const porEvento = new Map<string, { id: string; session_type: string; status: string; patient_email: string | null; notes: string | null }>();
    for (const r of reservas ?? []) porEvento.set(String(r.google_event_id), r as never);
    const faltan = eventos.filter((e) => !porEvento.has(e.id)).map((e) => uuidDesdeEventId(e.id)).filter((x): x is string => !!x);
    if (faltan.length) {
      const { data: r2, error: e2 } = await c.from('bookings')
        .select('id, google_event_id, session_type, status, patient_email, notes').in('id', faltan);
      if (e2) throw new Error(`bookings: ${e2.message}`);
      for (const r of r2 ?? []) porEvento.set(String(r.id).replace(/-/g, ''), r as never);
    }

    const correos = new Set<string>();
    for (const ev of eventos) {
      const b = porEvento.get(ev.id);
      if (b?.patient_email) correos.add(b.patient_email.trim().toLowerCase());
      else correosInvitados(ev).forEach((x) => correos.add(x));
    }
    const pacientePorCorreo = new Map<string, string>();
    if (correos.size) {
      const { data: pacs, error: e3 } = await c.from('patients').select('id, email, active').in('email', [...correos]);
      if (e3) throw new Error(`patients: ${e3.message}`);
      for (const p of pacs ?? []) if (p.email && p.active !== false) pacientePorCorreo.set(String(p.email).toLowerCase(), String(p.id));
    }

    const salida = new Map<string, SesionOnline>();
    for (const ev of eventos) {
      const b = porEvento.get(ev.id);
      if (b && b.status !== 'confirmed') continue;                         // pendiente/cancelada/vencida
      if (b && !String(b.session_type ?? '').includes('online')) continue; // reserva presencial con Meet: no
      let patientId: string | null = null;
      if (b?.patient_email) patientId = pacientePorCorreo.get(b.patient_email.trim().toLowerCase()) ?? null;
      else {
        // Evento sin reserva del sitio (p. ej. Encuadrado): solo si calza EXACTAMENTE una ficha.
        const calzan = [...new Set(correosInvitados(ev).map((x) => pacientePorCorreo.get(x)).filter((x): x is string => !!x))];
        patientId = calzan.length === 1 ? calzan[0] : null;
      }
      const meetUrl = (b ? meetUrlDesdeNotas(b.notes) : null) ?? meetUrlDesdeEvento(ev)!;
      const sesion: SesionOnline = {
        googleEventId: ev.id,
        meetUrl,
        inicio: new Date(ev.start!.dateTime!).toISOString(),
        fin: new Date(ev.end!.dateTime!).toISOString(),
        bookingId: b?.id ?? null,
        patientId,
        tipo: b ? tipoDesdeSessionType(b.session_type) : 'sin_tipo',
      };
      // Encuadrado duplica eventos a propósito: se deduplica por enlace + hora (gana la reserva del sitio).
      const clave = `${meetUrl}|${sesion.inicio}`;
      const previa = salida.get(clave);
      if (!previa || (!previa.bookingId && sesion.bookingId) || (!previa.patientId && sesion.patientId)) salida.set(clave, sesion);
    }
    return [...salida.values()];
  }

  /**
   * Modo del robot para esta grabación. En 'cuenta' agrega el correo del robot como invitado del
   * evento (sin avisar a nadie) para que Meet lo deje entrar sin pedir permiso. Si algo falla, el
   * bot igual entra con su cuenta (pedirá unirse y Vale lo admite) o, sin sesión, como invitado.
   * Nunca impide lanzar el bot.
   */
  async function prepararCuenta(grabacion: Grabacion, c: Cliente): Promise<{ modo: ModoBot; cuentaEmail: string | null }> {
    const { auditar } = await import('./auditoria');
    const aviso = (detalle: Record<string, unknown>) => auditar('cron', 'alerta', { grabacionId: grabacion.id, patientId: grabacion.patient_id, resultado: 'error', detalle, cliente: c });
    try {
      if ((await leerModoBot(c)) !== 'cuenta') return { modo: 'invitado', cuentaEmail: null };
      const correo = await cuentaRobotVigente(c);
      if (!correo) {
        await aviso({ aviso: 'robot_sin_sesion', texto: 'El robot de Meet no tiene una sesión de Google vigente: entra como invitado (Vale lo admite).' });
        await avisarRobot(c, alertaDeAvisoRobot('robot_sin_sesion'), deps.alertar);
        return { modo: 'invitado', cuentaEmail: null };
      }
      if (grabacion.google_event_id) {
        try {
          const auth = deps.calendario ? await deps.calendario() : await (await import('../syncCalendar')).getValidAccessToken();
          if (!auth) throw new Error('Google Calendar no está conectado');
          const invitar = deps.invitar ?? (await import('../googleCalendar')).agregarInvitadoSinAviso;
          const r = await invitar(auth.token, auth.calendarId, grabacion.google_event_id, correo);
          if (r !== 'agregado' && r !== 'ya_estaba') {
            await aviso({ aviso: 'robot_no_invitado', resultado: r });
            await avisarRobot(c, alertaDeAvisoRobot('robot_no_invitado', { grabacionId: grabacion.id }), deps.alertar);
          }
        } catch (e) {
          await aviso({ aviso: 'robot_no_invitado', error: sanearErrorBot(e instanceof Error ? e.message : e, 160) });
          await avisarRobot(c, alertaDeAvisoRobot('robot_no_invitado', { grabacionId: grabacion.id }), deps.alertar);
        }
      }
      return { modo: 'cuenta', cuentaEmail: correo };
    } catch {
      return { modo: 'invitado', cuentaEmail: null };
    }
  }

  async function lanzarBot(grabacion: Grabacion): Promise<{ machineId: string }> {
    const env = envBot(deps);
    if (!env.FLY_API_TOKEN) throw new Error('Falta FLY_API_TOKEN');
    if (!env.FLY_IMAGEN) throw new Error('Falta FLY_IMAGEN');
    const app = nombreAppValido(env.FLY_APP_BOT);
    if (grabacion.origen !== 'online') throw new Error('Solo se lanza el bot para sesiones online');
    if (!grabacion.hora_fin_prevista) throw new Error('La grabación no tiene hora_fin_prevista');
    const c = await db();

    const { data: ajuste } = await c.from('settings').select('value').eq('key', AJUSTE_NOMBRES_VALE).maybeSingle();
    const nombresVale = repararMojibake((ajuste?.value as string | undefined)?.trim()) || NOMBRES_VALE_DEFECTO;

    // 0) Modo 'cuenta': solo si hay una sesión vigente del robot; si no, invitado (y queda en la bitácora).
    const { modo, cuentaEmail } = await prepararCuenta(grabacion, c);

    // 1) Token nuevo: se guarda SOLO su HMAC, y únicamente si la grabación sigue en bot_lanzando.
    const token = generarTokenBot();
    const cuerpo = cuerpoMaquina({
      grabacion, token, imagen: env.FLY_IMAGEN, nombresVale, modo, cuentaEmail,
      eventoUrl: new URL(RUTAS.botEvento, env.PUBLIC_SITE_URL).toString(),
    });
    const { data: fila, error } = await c.from('grabaciones')
      .update({
        bot_token_sha256: hmacTokenBot(token, env.BOT_TOKEN_SECRET ?? ''),
        bot_token_vence_at: venceTokenBot(grabacion.hora_fin_prevista).toISOString(),
      })
      .eq('id', grabacion.id).eq('estado', 'bot_lanzando')
      .select('id').maybeSingle();
    if (error) throw new Error(`No se pudo guardar el token del bot: ${error.message}`);
    if (!fila) throw new Error('La grabación ya no está en bot_lanzando; no se lanza el bot');

    // 2) Máquina efímera.
    const res = await f(`${FLY_API}/apps/${app}/machines`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.FLY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const texto = (await res.text().catch(() => '')).slice(0, 300);
      // El token no sirve sin máquina: se revoca.
      await c.from('grabaciones').update({ bot_token_vence_at: new Date().toISOString() }).eq('id', grabacion.id);
      throw new Error(`Fly Machines API respondió ${res.status}: ${texto}`);
    }
    const maquina = (await res.json()) as { id?: string };
    if (!maquina.id) throw new Error('Fly no devolvió el id de la máquina');
    await c.from('grabaciones').update({ bot_machine_id: maquina.id }).eq('id', grabacion.id);
    const { auditar } = await import('./auditoria');
    await auditar('cron', 'bot_lanzar', { grabacionId: grabacion.id, patientId: grabacion.patient_id, detalle: { machine_id: maquina.id, region: FLY_REGION }, cliente: c });
    return { machineId: maquina.id };
  }

  async function matarBot(machineId: string): Promise<void> {
    const env = envBot(deps);
    if (!env.FLY_API_TOKEN) throw new Error('Falta FLY_API_TOKEN');
    const app = nombreAppValido(env.FLY_APP_BOT);
    if (!/^[a-z0-9]{6,40}$/i.test(machineId)) throw new Error('machineId inválido');
    const res = await f(`${FLY_API}/apps/${app}/machines/${machineId}?force=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.FLY_API_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    // 404 = ya no existe (se autodestruyó): es el resultado buscado.
    if (!res.ok && res.status !== 404) throw new Error(`Fly no pudo destruir la máquina (${res.status})`);
    // Revoca el token de esa grabación (el bot ya no debe poder subir nada).
    const c = await db();
    await c.from('grabaciones').update({ bot_token_vence_at: new Date().toISOString() }).eq('bot_machine_id', machineId);
  }

  return { sesionesOnlineProximas, lanzarBot, matarBot };
}

// ─── Eventos del bot (con base) ──────────────────────────────────────────────

export type AlmacenamientoBot = Pick<Almacenamiento, 'urlSubida' | 'head'> & Partial<Pick<Almacenamiento, 'borrar'>>;

export interface EntradaEvento {
  authorization: string | null;
  cuerpoTexto: string;
  request?: Request | null;
  clientAddress?: string | null;
}

export interface DepsEvento {
  db?: Cliente;
  secreto?: string;
  /** Se carga solo si hace falta (pide_url / segmento_subido). null = no disponible. */
  almacenamiento?: () => Promise<AlmacenamientoBot | null>;
  ahora?: () => Date;
  /** Para pruebas: registro de avisos (por defecto alertas.ts con la misma base). */
  alertar?: Alertar;
  /** Para pruebas: chequeo de consentimiento (por defecto evaluarEnBase de consentimiento.ts con la misma base). */
  puedeGrabar?: (patientId: string | null, tipo: TipoSesion) => Promise<{ puede: boolean; motivo?: string }>;
}

export interface RespuestaEvento { status: number; cuerpo: Record<string, unknown> }

const NO_ENCONTRADO: RespuestaEvento = { status: 404, cuerpo: { error: 'No encontrado' } };
const ok = (extra: Record<string, unknown> = {}): RespuestaEvento => ({ status: 200, cuerpo: { ok: true, ...extra } });

type FilaBot = Pick<Grabacion, 'id' | 'patient_id' | 'estado' | 'inicio_at' | 'bot_token_vence_at' | 'bot_machine_id' | 'hora_fin_prevista'> & { tipo?: TipoSesion | null };

/**
 * Lógica completa de POST /api/transcriptor/bot-evento. Nunca devuelve datos de pacientes:
 * solo {ok:true} o {ok:true, url} (PUT prefirmado de SU segmento). Token inválido, vencido o
 * revocado → 404 genérico (no revela si la sesión existe).
 */
export async function procesarEventoBot(entrada: EntradaEvento, deps: DepsEvento = {}): Promise<RespuestaEvento> {
  const ahora = deps.ahora?.() ?? new Date();
  const token = extraerBearer(entrada.authorization);
  if (!token) return NO_ENCONTRADO; // rechazo temprano, sin tocar la base
  const secretoBot = deps.secreto ?? secreto('BOT_TOKEN_SECRET');
  if (!secretoBot) return { status: 503, cuerpo: { error: 'No configurado' } };
  if (entrada.cuerpoTexto.length > MAX_CUERPO_EVENTO) return { status: 413, cuerpo: { error: 'Demasiado grande' } };

  const c = deps.db ?? (await clientePorDefecto());
  const { auditar, ipDeRequest } = await import('./auditoria');
  const ip = ipDeRequest(entrada.request, entrada.clientAddress);

  // Bloqueo por IP tras 10 tokens inválidos en 15 min.
  if (ip) {
    const { count } = await c.from('transcriptor_auditoria').select('id', { count: 'exact', head: true })
      .eq('actor', 'bot').eq('accion', 'webhook_recibido').eq('resultado', 'denegado').eq('ip', ip)
      .gte('at', new Date(ahora.getTime() - VENTANA_FALLOS_MS).toISOString());
    if ((count ?? 0) >= MAX_FALLOS_IP) return NO_ENCONTRADO;
  }

  const hmac = hmacTokenBot(token, secretoBot);
  const { data: g, error: eG } = await c.from('grabaciones')
    .select('id, patient_id, estado, inicio_at, bot_token_vence_at, bot_machine_id, hora_fin_prevista, tipo')
    .eq('bot_token_sha256', hmac).maybeSingle();
  if (eG) return { status: 503, cuerpo: { error: 'Intenta de nuevo' } };
  if (!g || !tokenVigente((g as FilaBot).bot_token_vence_at, ahora)) {
    await auditar('bot', 'webhook_recibido', { resultado: 'denegado', request: entrada.request, clientAddress: entrada.clientAddress, detalle: { via: 'bot-evento' }, cliente: c });
    return NO_ENCONTRADO;
  }
  const grab = g as FilaBot;

  let crudo: unknown;
  try { crudo = JSON.parse(entrada.cuerpoTexto); } catch { return { status: 400, cuerpo: { error: 'JSON inválido' } }; }
  const p = parsearEventoBot(crudo);
  if (!p.ok) return { status: 400, cuerpo: { error: p.error } };
  const ev = p.evento;
  const auditoria = { grabacionId: grab.id, patientId: grab.patient_id, request: entrada.request, clientAddress: entrada.clientAddress, cliente: c };

  // Idempotencia: si este evento ya se procesó, responder igual sin repetir efectos.
  const eventoId = idEventoBot(grab.id, ev);
  if (eventoId) {
    const { data: previo } = await c.from('transcriptor_webhooks').select('procesado_at')
      .eq('proveedor', 'bot').eq('evento_id', eventoId).maybeSingle();
    if (previo?.procesado_at) return ok();
  }
  const marcar = async () => {
    if (!eventoId) return;
    await c.from('transcriptor_webhooks').upsert(
      { proveedor: 'bot', evento_id: eventoId, payload: payloadSeguro(ev), procesado_at: ahora.toISOString() },
      { onConflict: 'proveedor,evento_id' },
    );
  };

  const { transicionar, marcarError } = await import('./estados');

  switch (ev.tipo) {
    case 'lobby': {
      await transicionar(grab.id, ['bot_lanzando'], 'bot_en_lobby', {}, c);
      await auditar('bot', 'bot_lobby', auditoria);
      await marcar();
      return ok();
    }
    case 'activo': {
      if (grab.estado === 'bot_lanzando') await transicionar(grab.id, ['bot_lanzando'], 'bot_en_lobby', {}, c);
      await transicionar(grab.id, ['bot_en_lobby'], 'grabando', { inicio_at: ahora.toISOString() }, c);
      await auditar('bot', 'bot_admitido', auditoria);
      await marcar();
      return ok();
    }
    case 'pide_url': {
      if (grab.estado !== 'grabando') return { status: 409, cuerpo: { error: 'La grabación no está activa' } };
      // Auditoría de seguridad (17 oct): igual que subida-url en presencial, el consentimiento se revisa antes
      // de entregar cada URL de subida (el retiro corta lo que sigue). Falla cerrado si no se puede leer.
      let permiso: { puede: boolean; motivo?: string };
      try {
        const verificar = deps.puedeGrabar
          ?? (async (pid: string | null, t: TipoSesion) => (await import('./consentimiento')).evaluarEnBase(pid, t, c));
        permiso = await verificar(grab.patient_id, (grab.tipo ?? 'sin_tipo') as TipoSesion);
      } catch { return { status: 503, cuerpo: { error: 'Intenta de nuevo' } }; }
      if (!permiso.puede) {
        await auditar('bot', 'consentimiento_faltante', { ...auditoria, resultado: 'denegado', detalle: { fase: 'bot_subida', motivo: permiso.motivo ?? null } });
        return { status: 403, cuerpo: { error: 'Sin consentimiento de grabación vigente' } };
      }
      const alm = await deps.almacenamiento?.();
      if (!alm) return { status: 503, cuerpo: { error: 'Almacenamiento no disponible' } };
      const { data: seg } = await c.from('grabacion_segmentos').select('r2_key, subido_at')
        .eq('grabacion_id', grab.id).eq('seq', ev.seq).maybeSingle();
      if (seg?.subido_at) return { status: 409, cuerpo: { error: 'Segmento ya subido' } };
      let key = seg?.r2_key as string | undefined;
      if (!key) {
        key = `${PREFIJO_AUDIO}${randomUUID()}.webm`;
        const { error: eI } = await c.from('grabacion_segmentos')
          .insert({ grabacion_id: grab.id, seq: ev.seq, r2_key: key, mime: MIME_SEGMENTO_BOT, offset_ms: 0 });
        if (eI) {
          // Carrera con otro pedido del mismo seq: se usa la llave que quedó.
          const { data: otra } = await c.from('grabacion_segmentos').select('r2_key')
            .eq('grabacion_id', grab.id).eq('seq', ev.seq).maybeSingle();
          if (!otra?.r2_key) return { status: 503, cuerpo: { error: 'Intenta de nuevo' } };
          key = otra.r2_key as string;
        }
      }
      const url = await alm.urlSubida(key, MIME_SEGMENTO_BOT, TIEMPOS.urlSubidaSeg);
      return ok({ url });
    }
    case 'segmento_subido': {
      if (grab.estado !== 'grabando') return { status: 409, cuerpo: { error: 'La grabación no está activa' } };
      const alm = await deps.almacenamiento?.();
      if (!alm) return { status: 503, cuerpo: { error: 'Almacenamiento no disponible' } };
      const { data: seg } = await c.from('grabacion_segmentos').select('id, r2_key, subido_at')
        .eq('grabacion_id', grab.id).eq('seq', ev.seq).maybeSingle();
      if (!seg) return { status: 409, cuerpo: { error: 'Segmento desconocido' } };
      if (!seg.subido_at) {
        const h = await alm.head('audio', seg.r2_key as string);
        if (!h || h.bytes !== ev.bytes) return { status: 409, cuerpo: { error: 'El objeto en R2 no calza con lo informado' } };
        if (h.bytes > MAX_BYTES_SEGMENTO_BOT) {
          // Tope por segmento (B7): se borra el objeto y no se marca como subido (no va a AssemblyAI).
          try { await alm.borrar?.('audio', seg.r2_key as string); } catch { /* lo borra el ciclo de vida de 1 día */ }
          await auditar('bot', 'alerta', { ...auditoria, resultado: 'denegado', detalle: { aviso: 'segmento_demasiado_grande', seq: ev.seq, bytes: h.bytes } });
          return { status: 413, cuerpo: { error: 'Segmento demasiado grande' } };
        }
        await c.from('grabacion_segmentos')
          .update({ subido_at: ahora.toISOString(), bytes: ev.bytes, offset_ms: ev.offset_ms, duracion_ms: ev.duracion_ms })
          .eq('id', seg.id).is('subido_at', null);
      }
      await marcar();
      return ok();
    }
    case 'fin': {
      await liberarSesion(c, grab.id).catch(() => {}); // por si el bot no alcanzó a devolverla
      const finAt = ahora.toISOString();
      const revocar = { bot_token_vence_at: finAt };
      if (grab.estado === 'bot_lanzando' || grab.estado === 'bot_en_lobby') {
        if (ev.motivo === 'no_admitido') {
          if (grab.estado === 'bot_lanzando') await transicionar(grab.id, ['bot_lanzando'], 'bot_en_lobby', {}, c);
          await transicionar(grab.id, ['bot_en_lobby'], 'bot_no_admitido', { ...revocar, fin_at: finAt }, c);
          await auditar('bot', 'bot_no_admitido', auditoria);
        } else {
          await c.from('grabaciones').update(revocar).eq('id', grab.id);
          await marcarError(grab.id, grab.estado, `El asistente de notas terminó antes de grabar (${ev.motivo})`, c);
          await auditar('bot', 'bot_salio', { ...auditoria, resultado: 'error', detalle: { motivo: ev.motivo } });
        }
        await marcar();
        return ok();
      }
      if (grab.estado === 'grabando') {
        const inicio = grab.inicio_at ? Date.parse(grab.inicio_at) : ahora.getTime();
        const duracionSeg = Math.max(0, Math.round((ahora.getTime() - inicio) / 1000));
        const movida = await transicionar(grab.id, ['grabando'], 'subiendo', {
          ...revocar, fin_at: finAt, duracion_seg: duracionSeg, linea_hablantes: ev.linea_hablantes,
          nota_sistema: notaFinBot(ev.motivo, Math.round(duracionSeg / 60)),
        }, c);
        if (movida) {
          // Segmentos pedidos pero nunca confirmados: fuera (el ciclo de vida de R2 borra el objeto).
          await c.from('grabacion_segmentos').delete().eq('grabacion_id', grab.id).is('subido_at', null);
          const { count } = await c.from('grabacion_segmentos').select('id', { count: 'exact', head: true })
            .eq('grabacion_id', grab.id).not('subido_at', 'is', null);
          await transicionar(grab.id, ['subiendo'], (count ?? 0) > 0 ? 'subida' : 'sin_audio', {}, c);
        }
        await auditar('bot', 'bot_salio', { ...auditoria, detalle: { motivo: ev.motivo, duracion_seg: duracionSeg } });
        await marcar();
        return ok();
      }
      // Ya terminó por otro camino (repetido o vigilante): solo revocar.
      await c.from('grabaciones').update(revocar).eq('id', grab.id);
      return ok();
    }
    case 'error': {
      await auditar('bot', 'alerta', { ...auditoria, resultado: 'error', detalle: { aviso: ev.detalle } });
      await c.from('grabaciones').update({ ultimo_error: `Bot: ${ev.detalle}` }).eq('id', grab.id);
      // Aviso al instante (antes quedaba solo en la bitácora hasta el chequeo diario).
      await avisarRobot(c, alertaDeErrorBot(grab.id, grab.estado, ev.detalle), deps.alertar);
      await marcar();
      return ok();
    }
    // ── Modo 'cuenta' (botCuenta.ts). La sesión es del ROBOT (sin datos de pacientes). ──
    case 'pide_sesion': {
      if (grab.estado !== 'bot_lanzando') return { status: 409, cuerpo: { error: 'La sesión solo se entrega antes de entrar' } };
      const r = await tomarSesion(c, grab.id, ahora, secretoBot, grab.hora_fin_prevista);
      if (!r.ok) {
        await auditar('bot', 'alerta', { ...auditoria, resultado: 'error', detalle: { aviso: 'robot_sin_sesion', motivo: r.motivo } });
        // 'ocupada'/'carrera' = otro bot la usa en este momento: no es un problema de la sesión.
        if (esMotivoSinSesion(r.motivo)) await avisarRobot(c, alertaDeAvisoRobot('robot_sin_sesion'), deps.alertar);
        return ok({ sesion: null, motivo: r.motivo });
      }
      return ok({ correo: r.correo, sesion: r.estado });
    }
    case 'sesion_actualizada': {
      const guardada = await guardarSesionRenovada(c, grab.id, ev.sesion, ahora, secretoBot);
      await marcar();
      return ok({ guardada });
    }
    case 'sesion_invalida': {
      await marcarSesionVencida(c, grab.id, ev.motivo || 'Google pidió iniciar sesión de nuevo');
      await auditar('bot', 'alerta', { ...auditoria, resultado: 'error', detalle: { aviso: 'robot_sesion_vencida', motivo: ev.motivo } });
      await avisarRobot(c, alertaDeAvisoRobot('robot_sesion_vencida', { motivo: ev.motivo }), deps.alertar);
      await marcar();
      return ok();
    }
  }
}
