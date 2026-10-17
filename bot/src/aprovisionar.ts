// Lógica PURA del modo MODO=iniciar_sesion (docs/transcriptor/85-robot-meet.md §6.2–§6.3).
// Sin red, sin navegador ni disco: se prueba en aprovisionar.test.ts. El que la usa es
// iniciar-sesion.ts.
//
// Reglas: nunca se manejan contraseñas (Vale las escribe con sus manos en la pantalla de Google);
// nunca se registran cookies ni el secreto de aprovisionamiento; solo viaja lo de google.com.
import { correoValido } from './config.js';
import { COOKIES_SESION_GOOGLE, soloGoogle, type CookieSesion, type EstadoSesion } from './sesion.js';

/** Tope de tamaño que acepta el sitio (MAX_SESION_BYTES de src/lib/transcriptor/botCuenta.ts). */
export const MAX_SESION_BYTES = 400_000;
/** Plazo por defecto para que Vale termine de iniciar sesión. */
export const PLAZO_DEFECTO_MS = 15 * 60_000;
/** Página donde se abre el navegador (en inglés, igual que el bot; luego a Mi cuenta). */
export const URL_INICIO = 'https://accounts.google.com/ServiceLogin?hl=en&continue=https%3A%2F%2Fmyaccount.google.com%2F%3Fhl%3Den';
/** Lista de cuentas con sesión (la misma que usa Chromium). Se pide desde Node, no desde la página. */
export const URL_LISTA_CUENTAS = 'https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard';
/** Respaldo para confirmar la cuenta: el HTML de Mi cuenta muestra el correo de la cuenta activa. */
export const URL_MI_CUENTA = 'https://myaccount.google.com/?hl=en';

const DOMINIO_GOOGLE_RE = /^\.?(?:[a-z0-9-]+\.)*google\.com$/i;

export interface ConfigInicio {
  correo: string;
  eventoUrl: string;
  secreto: string;
  plazoMs: number;
}

/** Lee y valida la configuración del modo. Los mensajes de error nunca incluyen el secreto. */
export function leerConfigInicio(env: Record<string, string | undefined>): ConfigInicio {
  const faltan = ['BOT_CUENTA_EMAIL', 'EVENTO_URL', 'BOT_APROVISIONAR'].filter((k) => !env[k]);
  if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
  const correo = correoValido(env.BOT_CUENTA_EMAIL);
  if (!correo) throw new Error('BOT_CUENTA_EMAIL no es un correo válido');
  let u: URL;
  try { u = new URL(env.EVENTO_URL!); } catch { throw new Error('EVENTO_URL no es una URL'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('EVENTO_URL debe ser https');
  const secreto = env.BOT_APROVISIONAR!.trim();
  // Igual que aprovisionamientoValido del sitio: Bearer de 32 a 200 caracteres sin espacios.
  if (!/^\S{32,200}$/.test(secreto)) throw new Error('BOT_APROVISIONAR con formato inválido (32 a 200 caracteres, sin espacios)');
  let plazoMs = PLAZO_DEFECTO_MS;
  if (env.PLAZO_INICIO_MS) {
    const n = Number(env.PLAZO_INICIO_MS);
    if (!Number.isInteger(n) || n < 60_000 || n > 60 * 60_000) throw new Error('PLAZO_INICIO_MS inválido: entre 60000 y 3600000');
    plazoMs = n;
  }
  return { correo, eventoUrl: u.toString(), secreto, plazoMs };
}

/**
 * Banderas del Chromium NORMAL (sin automatización) donde Vale inicia sesión. Sin
 * --remote-debugging*, --enable-automation ni --disable-blink-features=AutomationControlled:
 * Google bloquea el inicio de sesión en navegadores automatizados. --password-store=basic es el
 * mismo almacén que usa Playwright, para que luego pueda leer las cookies del mismo perfil.
 */
export function argumentosChromeNormal(dirPerfil: string, o: { sandbox?: boolean; ancho?: number; alto?: number } = {}): string[] {
  return [
    `--user-data-dir=${dirPerfil}`,
    ...(o.sandbox === false ? ['--no-sandbox'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-gpu',
    '--lang=en-US',
    '--accept-lang=en-US,en',
    '--window-position=0,0',
    `--window-size=${o.ancho ?? 1280},${o.alto ?? 720}`,
    URL_INICIO,
  ];
}

/** Banderas que delatan automatización (las pruebas verifican que no estén en el Chromium normal). */
export const BANDERAS_AUTOMATIZACION = ['--remote-debugging-port', '--remote-debugging-pipe', '--enable-automation', 'AutomationControlled', '--headless'];

/**
 * Señal barata, sin automatización, de que ya hay sesión: el archivo SQLite "Cookies" del perfil
 * guarda el nombre y el dominio de cada cookie en texto plano (el valor va cifrado y aquí no se
 * lee). Solo dispara el paso siguiente; la verificación real (nombres exactos y correo) se hace
 * después con el estado exportado.
 */
export function archivoTieneCookiesDeSesion(contenido: Buffer): boolean {
  return contenido.includes('google.com') && contenido.includes('__Secure-1PSID') && contenido.includes('__Secure-3PSID');
}

/** Cookies de sesión requeridas que faltan (deben estar TODAS, en un dominio google.com). */
export function faltanCookiesRequeridas(e: EstadoSesion): string[] {
  return COOKIES_SESION_GOOGLE.filter((n) => !e.cookies.some((c) => c.name === n && DOMINIO_GOOGLE_RE.test(c.domain)));
}

/**
 * Convierte el storageState crudo de Playwright en lo que se sube: solo google.com, solo los campos
 * del formato (CookieSesion), y dentro del tope de tamaño. null si no sirve.
 */
export function prepararSesion(crudo: unknown): EstadoSesion | null {
  if (!crudo || typeof crudo !== 'object') return null;
  const o = crudo as Record<string, unknown>;
  if (!Array.isArray(o.cookies)) return null;
  const cookies: CookieSesion[] = [];
  for (const k of o.cookies) {
    if (!k || typeof k !== 'object') continue;
    const c = k as Record<string, unknown>;
    if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') continue;
    cookies.push({
      name: c.name, value: c.value, domain: c.domain, path: typeof c.path === 'string' ? c.path : '/',
      expires: typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : -1,
      httpOnly: c.httpOnly === true, secure: c.secure === true,
      sameSite: c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax',
    });
  }
  const origins: EstadoSesion['origins'] = [];
  for (const k of Array.isArray(o.origins) ? o.origins : []) {
    if (!k || typeof k !== 'object') continue;
    const r = k as Record<string, unknown>;
    if (typeof r.origin !== 'string' || !Array.isArray(r.localStorage)) continue;
    const ls = r.localStorage
      .filter((x): x is { name: string; value: string } => !!x && typeof (x as Record<string, unknown>).name === 'string' && typeof (x as Record<string, unknown>).value === 'string')
      .map((x) => ({ name: x.name, value: x.value }));
    origins.push({ origin: r.origin, localStorage: ls });
  }
  const estado = soloGoogle({ cookies, origins });
  if (faltanCookiesRequeridas(estado).length) return null;
  if (Buffer.byteLength(JSON.stringify(estado)) > MAX_SESION_BYTES) {
    // Lo pesado suele ser localStorage; Meet entra con las cookies.
    const sinLs = { cookies: estado.cookies, origins: [] };
    return Buffer.byteLength(JSON.stringify(sinLs)) > MAX_SESION_BYTES ? null : sinLs;
  }
  return estado;
}

/** Para el mensaje de error: qué cookies requeridas faltan en un estado crudo (solo nombres). */
export function cookiesFaltantesEnCrudo(crudo: unknown): string[] {
  const o = (crudo && typeof crudo === 'object' ? crudo : {}) as { cookies?: unknown };
  const cookies = (Array.isArray(o.cookies) ? o.cookies : [])
    .filter((c): c is CookieSesion => !!c && typeof c === 'object' && typeof (c as CookieSesion).name === 'string' && typeof (c as CookieSesion).domain === 'string');
  return faltanCookiesRequeridas({ cookies, origins: [] });
}

/**
 * ¿La respuesta (ListAccounts o Mi cuenta) trae el correo esperado? Se buscan los correos que aparecen en el
 * texto (el formato exacto del JSON de Google no está documentado, así que no se depende de él).
 */
export function correoEnListaCuentas(texto: string, correo: string): boolean {
  const esperado = correo.trim().toLowerCase();
  const encontrados = texto.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? ([] as string[]);
  return encontrados.includes(esperado);
}

/** Cuerpo exacto que espera procesarSesionInicial (src/lib/transcriptor/botCuenta.ts). */
export function armarCuerpoSesionInicial(correo: string, sesion: EstadoSesion): string {
  return JSON.stringify({ tipo: 'sesion_inicial', correo: correo.trim().toLowerCase(), sesion });
}

/** Cabeceras de la subida: X-VO-Aprovisionar: 1 (ruta de bot-evento) + Bearer del secreto. */
export function cabecerasAprovisionar(secreto: string): Record<string, string> {
  return { 'X-VO-Aprovisionar': '1', Authorization: `Bearer ${secreto}`, 'Content-Type': 'application/json' };
}

/** Quita el secreto (si apareciera) y valores de cookies de un mensaje antes de registrarlo. */
export function mensajeSeguro(m: unknown, secreto: string, sesion?: EstadoSesion | null, max = 300): string {
  let t = String(m ?? '');
  if (secreto) t = t.split(secreto).join('[secreto]');
  for (const c of sesion?.cookies ?? []) if (c.value.length >= 8) t = t.split(c.value).join('[cookie]');
  return t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Mensaje claro según la respuesta del sitio a la subida. */
export function explicarRespuesta(status: number, error?: unknown): string {
  if (status === 404) return 'El sitio rechazó el secreto (404): BOT_APROVISIONAR no coincide con BOT_APROVISIONAR_SECRET de Vercel, o esa variable no existe / falta el redeploy.';
  if (status === 400) return `El sitio rechazó la sesión (400): ${typeof error === 'string' ? error.slice(0, 120) : 'formato inválido'}.`;
  if (status === 413) return 'El sitio rechazó la sesión por tamaño (413).';
  if (status === 503) return `El sitio no pudo guardar (503): ${typeof error === 'string' ? error.slice(0, 120) : 'reintenta'}.`;
  return `El sitio respondió HTTP ${status}.`;
}
