// Configuración del bot: TODO llega por variables de entorno de la máquina efímera
// (las arma src/lib/transcriptor/bot.ts del sitio al crear la máquina en Fly).
// La app de Fly no tiene secretos permanentes: el único dato sensible es BOT_TOKEN,
// que solo sirve para hablar con /api/transcriptor/bot-evento de UNA grabación y vence.

/** Nombre visible del robot (decisión G, 16 oct noche). Igual a BOT_NOMBRE de src/lib/transcriptor/tipos.ts. */
export const NOMBRE_ROBOT = 'Notas Ps. Valentina Orellana';

/** 'cuenta': entra con la cuenta de Google del robot (sesión que entrega el sitio). 'invitado': anónimo. */
export type ModoBot = 'cuenta' | 'invitado';

export interface ConfigBot {
  grabacionId: string;
  meetUrl: string;
  botNombre: string;
  modo: ModoBot;
  /** Correo de la cuenta del robot (solo en modo 'cuenta'). */
  cuentaEmail: string | null;
  eventoUrl: string;
  token: string;
  /** Hora de término prevista de la sesión. */
  horaFin: Date;
  /** Máximo de espera en la sala de espera (20 min). */
  esperaAdmisionMs: number;
  /** Tiempo solo (sin humanos) antes de salir (60 s). */
  soloMs: number;
  /** Margen después de horaFin antes de salir sí o sí (30 min). */
  maxExtraMs: number;
  /** Humanos máximos permitidos en la llamada (individual 2, pareja 3). */
  maxHumanos: number;
  /** Nombres con que puede aparecer Vale en Meet (comparación normalizada). */
  valeNombres: string[];
  /** Largo de cada segmento de audio (15 min) y solapamiento (3 s). */
  segmentoMs: number;
  solapamientoMs: number;
  /** Bitrate de MediaRecorder. */
  bitsPorSegundo: number;
  /** Espera máxima a que haya alguien antes de salir sin grabar (30 min; robot de reemplazo: 5 min). */
  esperaLlegadaMs: number;
  /** Ausencia de Vale tolerada con el paciente en la llamada (3 min). */
  graciaValeMs: number;
  /** Robot de reemplazo (r2): primer seq de sus segmentos (sigue la numeración del anterior). */
  seqInicial: number;
  /** Robot de reemplazo (r2): origen común de los tiempos (ms epoch = inicio_at); null = el propio. */
  origenMs: number | null;
  /** Robot de reemplazo (r2): Vale ya estuvo en la sesión → graba solo con Vale presente. */
  valeVista: boolean;
}

export const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes en base64url sin relleno

function entero(env: Record<string, string | undefined>, nombre: string, defecto: number, min: number, max: number): number {
  const crudo = env[nombre];
  if (crudo === undefined || crudo === '') return defecto;
  const n = Number(crudo);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nombre} inválido: debe ser un entero entre ${min} y ${max}`);
  return n;
}

/** Lee y valida la configuración. Lanza con un mensaje en español si falta algo. */
export function leerConfig(env: Record<string, string | undefined> = process.env): ConfigBot {
  const faltan = ['GRABACION_ID', 'MEET_URL', 'EVENTO_URL', 'BOT_TOKEN', 'HORA_FIN'].filter((k) => !env[k]);
  if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);

  const grabacionId = env.GRABACION_ID!;
  if (!UUID_RE.test(grabacionId)) throw new Error('GRABACION_ID no es un uuid');

  const meetUrl = env.MEET_URL!;
  if (!MEET_URL_RE.test(meetUrl)) throw new Error('MEET_URL no es un enlace de Google Meet válido');

  const eventoUrl = env.EVENTO_URL!;
  let u: URL;
  try { u = new URL(eventoUrl); } catch { throw new Error('EVENTO_URL no es una URL'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('EVENTO_URL debe ser https');

  const token = env.BOT_TOKEN!;
  if (!TOKEN_RE.test(token)) throw new Error('BOT_TOKEN con formato inválido');

  const horaFin = new Date(env.HORA_FIN!);
  if (Number.isNaN(horaFin.getTime())) throw new Error('HORA_FIN no es una fecha ISO');

  const botNombre = (env.BOT_NOMBRE || NOMBRE_ROBOT).slice(0, 60);
  const cuentaEmail = correoValido(env.BOT_CUENTA_EMAIL);
  if (env.BOT_MODO === 'cuenta' && !cuentaEmail) throw new Error('BOT_MODO=cuenta requiere BOT_CUENTA_EMAIL válido');
  const modo: ModoBot = env.BOT_MODO === 'cuenta' ? 'cuenta' : 'invitado';
  const valeNombres = (env.VALE_NOMBRES || 'Valentina Orellana')
    .split('|').map((s) => s.trim()).filter(Boolean);

  return {
    grabacionId,
    meetUrl,
    botNombre,
    modo,
    cuentaEmail: modo === 'cuenta' ? cuentaEmail : null,
    eventoUrl,
    token,
    horaFin,
    esperaAdmisionMs: entero(env, 'ESPERA_ADMISION_MS', 20 * 60_000, 10_000, 60 * 60_000),
    soloMs: entero(env, 'SOLO_MS', 60_000, 5_000, 30 * 60_000),
    maxExtraMs: entero(env, 'MAX_EXTRA_MS', 30 * 60_000, 0, 3 * 60 * 60_000),
    maxHumanos: entero(env, 'MAX_HUMANOS', 2, 1, 10),
    valeNombres,
    segmentoMs: entero(env, 'SEGMENTO_MS', 15 * 60_000, 30_000, 60 * 60_000),
    solapamientoMs: entero(env, 'SOLAPAMIENTO_MS', 3_000, 0, 30_000),
    bitsPorSegundo: entero(env, 'BITS_POR_SEGUNDO', 32_000, 16_000, 128_000),
    esperaLlegadaMs: entero(env, 'ESPERA_LLEGADA_MS', 30 * 60_000, 60_000, 60 * 60_000),
    graciaValeMs: entero(env, 'GRACIA_VALE_MS', 3 * 60_000, 5_000, 10 * 60_000),
    seqInicial: entero(env, 'SEQ_INICIAL', 0, 0, 190),
    origenMs: origen(env.ORIGEN_MS),
    valeVista: env.VALE_VISTA === '1',
  };
}

/** ORIGEN_MS: un instante en ms (2023–2100) o nada. */
function origen(crudo: string | undefined): number | null {
  if (crudo === undefined || crudo === '') return null;
  const n = Number(crudo);
  if (!Number.isInteger(n) || n < 1_700_000_000_000 || n > 4_102_444_800_000) throw new Error('ORIGEN_MS inválido: debe ser un instante en ms');
  return n;
}

const CORREO_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62})@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
export function correoValido(s: string | undefined): string | null {
  const c = (s ?? '').trim().toLowerCase();
  return c.length <= 120 && CORREO_RE.test(c) ? c : null;
}

/** Normaliza un nombre visible para comparar (minúsculas, sin tildes ni espacios dobles). */
export function normalizarNombre(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Nombres típicos de otros bots/asistentes de notas (no cuentan como humanos). */
const BOT_RE = /\b(notetaker|note taker|notas de|notas ps|notes|bot|assistant|asistente|otter|fireflies|read\.ai|tl;dv|tldv|fathom|gemini|recorder|grabadora)\b/i;

export function esNombreDeBot(nombre: string, botNombre: string): boolean {
  const n = normalizarNombre(nombre);
  if (!n) return true;
  if (n === normalizarNombre(botNombre)) return true;
  return BOT_RE.test(n);
}

export function esVale(nombre: string, valeNombres: string[]): boolean {
  const n = normalizarNombre(nombre);
  return valeNombres.some((v) => normalizarNombre(v) === n);
}
