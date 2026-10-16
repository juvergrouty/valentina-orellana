// Transcriptor IA — robot de Meet con CUENTA DE GOOGLE PROPIA (decisión G, 16 oct noche).
// Investigación, recomendación y pasos para Vale: docs/transcriptor/85-robot-meet.md.
//
// Idea: el robot ("Notas Ps. Valentina Orellana") tiene su propia cuenta de Gmail. El sitio lo
// agrega como invitado al evento de Calendar de la sesión online (sin avisar a nadie) y el bot
// entra a Meet CON la sesión iniciada de esa cuenta: como invitado del calendario de una reunión
// de cuenta personal (acceso "Trusted" por defecto), entra sin pedir permiso, con su nombre y
// foto, y sin el aviso de "no ha iniciado sesión".
//
// Seguridad:
//  - Nunca hay contraseñas en el sitio ni en el repo. Vale inicia sesión UNA vez, a mano, en un
//    navegador de una máquina efímera de Fly (modo "iniciar_sesion" del bot, vista por noVNC con
//    `fly proxy`). Esa máquina sube el estado de sesión (cookies de Google) al sitio.
//  - La sesión se guarda CIFRADA (AES-256-GCM) en transcriptor_bot_sesion (0022, solo service
//    role). La llave se deriva con HKDF de BOT_TOKEN_SECRET (separación de dominio: info
//    'vo-bot-sesion-google-v1'), así no hay otra llave que administrar.
//  - Solo se entrega a un bot con token vigente, cuya grabación está en `bot_lanzando`, y a UNO a la
//    vez (candado en la fila). El bot devuelve la sesión renovada al salir (Google rota cookies).
//  - Si la sesión falla (vencida, desafío de Google), el bot entra como invitado anónimo (como
//    siempre: Vale lo admite) y la sesión queda marcada "vencida" para que Vale la renueve.
//  - Modo por defecto 'invitado' hasta que exista la cuenta (ajuste transcriptor_bot_modo).
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Ajuste (settings): 'cuenta' | 'invitado'. Por defecto 'invitado' (mientras no exista la cuenta). */
export const AJUSTE_BOT_MODO = 'transcriptor_bot_modo';
export type ModoBot = 'cuenta' | 'invitado';
export const MODO_BOT_DEFECTO: ModoBot = 'invitado';

export const TABLA_SESION_BOT = 'transcriptor_bot_sesion';
/** Estado de sesión máximo aceptado (las cookies de Google pesan ~10–60 KB). */
export const MAX_SESION_BYTES = 400_000;
/**
 * El candado de la sesión vence solo (bot caído sin devolverla): al tope duro del bot
 * (fin previsto + 45 min, igual que el vigilante del sitio) o, sin hora de fin, en 3 h.
 */
export const USO_SESION_TRAS_FIN_MS = 45 * 60_000;
export const USO_SESION_SIN_FIN_MS = 3 * 60 * 60_000;
export function venceUsoSesion(ahora: Date, horaFinPrevista?: string | null): Date {
  const fin = horaFinPrevista ? Date.parse(horaFinPrevista) : NaN;
  return Number.isNaN(fin) ? new Date(ahora.getTime() + USO_SESION_SIN_FIN_MS) : new Date(Math.max(fin + USO_SESION_TRAS_FIN_MS, ahora.getTime() + 60_000));
}
/** Variable de Vercel con el secreto de aprovisionamiento (lo genera Vale; mínimo 32 caracteres). */
export const ENV_APROVISIONAR = 'BOT_APROVISIONAR_SECRET';

const FORMATO = 'VOS1';
const CORREO_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62})@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** Solo cookies y almacenamiento de dominios de Google (lo único que Meet necesita). */
const DOMINIO_GOOGLE_RE = /^\.?(?:[a-z0-9-]+\.)*google\.com$/i;
const ORIGEN_GOOGLE_RE = /^https:\/\/(?:[a-z0-9-]+\.)*google\.com$/i;
/** Cookies que prueban una sesión de Google iniciada. */
const COOKIES_SESION = ['SID', '__Secure-1PSID', '__Secure-3PSID'];

// ─── Puras ───────────────────────────────────────────────────────────────────

export function normalizarModoBot(v: unknown): ModoBot {
  return v === 'cuenta' ? 'cuenta' : 'invitado';
}

export function correoRobotValido(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const c = s.trim().toLowerCase();
  return c.length <= 120 && CORREO_RE.test(c) ? c : null;
}

export interface CookieSesion {
  name: string; value: string; domain: string; path: string;
  expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
}
export interface EstadoSesion {
  cookies: CookieSesion[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

const texto = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;

/**
 * Valida y filtra un estado de sesión (formato storageState de Playwright). Deja SOLO lo de
 * google.com. null si no es válido, es demasiado grande o no trae una sesión iniciada.
 */
export function filtrarEstadoSesion(x: unknown): EstadoSesion | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.cookies) || o.cookies.length > 500) return null;
  const cookies: CookieSesion[] = [];
  for (const k of o.cookies) {
    if (!k || typeof k !== 'object') return null;
    const c = k as Record<string, unknown>;
    if (!texto(c.name, 200) || !texto(c.value, 8192) || !texto(c.domain, 255) || !texto(c.path ?? '/', 1024)) return null;
    if (!DOMINIO_GOOGLE_RE.test(c.domain)) continue;
    const sameSite = c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax';
    cookies.push({
      name: c.name, value: c.value, domain: c.domain, path: (c.path as string | undefined) ?? '/',
      expires: typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : -1,
      httpOnly: c.httpOnly === true, secure: c.secure === true, sameSite,
    });
  }
  const origins: EstadoSesion['origins'] = [];
  for (const k of Array.isArray(o.origins) ? o.origins.slice(0, 50) : []) {
    if (!k || typeof k !== 'object') continue;
    const r = k as Record<string, unknown>;
    if (!texto(r.origin, 255) || !ORIGEN_GOOGLE_RE.test(r.origin) || !Array.isArray(r.localStorage)) continue;
    const ls = r.localStorage
      .filter((e): e is { name: string; value: string } => !!e && texto((e as Record<string, unknown>).name, 500) && texto((e as Record<string, unknown>).value, 100_000))
      .map((e) => ({ name: e.name, value: e.value }));
    origins.push({ origin: r.origin, localStorage: ls });
  }
  if (!cookies.some((c) => COOKIES_SESION.includes(c.name))) return null;
  const estado = { cookies, origins };
  if (Buffer.byteLength(JSON.stringify(estado)) > MAX_SESION_BYTES) return null;
  return estado;
}

function llaveSesion(secreto: string): Buffer {
  if (!secreto || secreto.length < 32) throw new Error('BOT_TOKEN_SECRET ausente o demasiado corto (mínimo 32 caracteres)');
  return Buffer.from(hkdfSync('sha256', secreto, 'vo-transcriptor', 'vo-bot-sesion-google-v1', 32));
}

/** "VOS1.<iv>.<cifrado+tag>" (base64url). AAD = "VOS1|<correo>": no se descifra para otra cuenta. */
export function cifrarSesion(estado: EstadoSesion, correo: string, secreto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', llaveSesion(secreto), iv);
  c.setAAD(Buffer.from(`${FORMATO}|${correo.toLowerCase()}`));
  const ct = Buffer.concat([c.update(JSON.stringify(estado), 'utf8'), c.final(), c.getAuthTag()]);
  return `${FORMATO}.${iv.toString('base64url')}.${ct.toString('base64url')}`;
}

export function descifrarSesion(cifrado: string, correo: string, secreto: string): EstadoSesion {
  const [magia, ivB, ctB] = cifrado.split('.');
  if (magia !== FORMATO || !ivB || !ctB) throw new Error('Formato de sesión desconocido');
  const iv = Buffer.from(ivB, 'base64url');
  const todo = Buffer.from(ctB, 'base64url');
  if (iv.length !== 12 || todo.length < 17) throw new Error('Sesión cifrada dañada');
  const d = createDecipheriv('aes-256-gcm', llaveSesion(secreto), iv);
  d.setAAD(Buffer.from(`${FORMATO}|${correo.toLowerCase()}`));
  d.setAuthTag(todo.subarray(todo.length - 16));
  const claro = Buffer.concat([d.update(todo.subarray(0, todo.length - 16)), d.final()]).toString('utf8');
  const estado = filtrarEstadoSesion(JSON.parse(claro));
  if (!estado) throw new Error('La sesión guardada no es válida');
  return estado;
}

/** Compara el Bearer de aprovisionamiento con el secreto en tiempo constante. */
export function aprovisionamientoValido(cabecera: string | null | undefined, secreto: string | undefined): boolean {
  if (!secreto || secreto.length < 32) return false;
  const m = /^Bearer (\S{32,200})$/.exec((cabecera ?? '').trim());
  if (!m) return false;
  const a = createHmac('sha256', 'vo-aprovisionar').update(m[1]).digest();
  const b = createHmac('sha256', 'vo-aprovisionar').update(secreto).digest();
  return timingSafeEqual(a, b);
}

// ─── Con base ────────────────────────────────────────────────────────────────

type Cliente = SupabaseClient;
interface FilaSesion {
  id: number;
  cuenta_email: string | null;
  sesion_cifrada: string | null;
  estado: 'vigente' | 'vencida' | null;
  version: number | null;
  en_uso_por: string | null;
  en_uso_hasta: string | null;
}

const COLUMNAS = 'id, cuenta_email, sesion_cifrada, estado, version, en_uso_por, en_uso_hasta';

async function leerFila(c: Cliente): Promise<FilaSesion | null> {
  const { data, error } = await c.from(TABLA_SESION_BOT).select(COLUMNAS).eq('id', 1).maybeSingle();
  if (error) return null; // tabla ausente (0022 sin aplicar) = no hay cuenta: modo invitado
  return (data as FilaSesion | null) ?? null;
}

/** Modo del robot (ajuste) — 'invitado' si no está o no es válido. */
export async function leerModoBot(c: Cliente): Promise<ModoBot> {
  const { data } = await c.from('settings').select('value').eq('key', AJUSTE_BOT_MODO).maybeSingle();
  return normalizarModoBot((data?.value as string | undefined)?.trim());
}

/** Correo de la cuenta del robot si hay una sesión VIGENTE guardada; null si no. */
export async function cuentaRobotVigente(c: Cliente): Promise<string | null> {
  const f = await leerFila(c);
  if (!f || f.estado !== 'vigente' || !f.sesion_cifrada) return null;
  return correoRobotValido(f.cuenta_email);
}

export type ResultadoTomar =
  | { ok: true; correo: string; estado: EstadoSesion }
  | { ok: false; motivo: 'sin_sesion' | 'ocupada' | 'carrera' | 'dañada' };

/**
 * Toma la sesión para la grabación `grabacionId` (candado con versión: si dos bots la piden a la
 * vez, solo uno gana; Google trata una misma sesión en dos IP a la vez como señal de riesgo).
 */
export async function tomarSesion(
  c: Cliente, grabacionId: string, ahora: Date, secreto: string, horaFinPrevista?: string | null,
): Promise<ResultadoTomar> {
  const f = await leerFila(c);
  const correo = correoRobotValido(f?.cuenta_email);
  if (!f || f.estado !== 'vigente' || !f.sesion_cifrada || !correo) return { ok: false, motivo: 'sin_sesion' };
  const ocupada = f.en_uso_por && f.en_uso_por !== grabacionId && f.en_uso_hasta && Date.parse(f.en_uso_hasta) > ahora.getTime();
  if (ocupada) return { ok: false, motivo: 'ocupada' };
  const version = f.version ?? 0;
  const { data: tomada } = await c.from(TABLA_SESION_BOT)
    .update({ en_uso_por: grabacionId, en_uso_hasta: venceUsoSesion(ahora, horaFinPrevista).toISOString(), version: version + 1 })
    .eq('id', 1).eq('version', version).select('id').maybeSingle();
  if (!tomada) return { ok: false, motivo: 'carrera' };
  try {
    return { ok: true, correo, estado: descifrarSesion(f.sesion_cifrada, correo, secreto) };
  } catch {
    await marcarSesionVencida(c, grabacionId, 'no se pudo descifrar');
    return { ok: false, motivo: 'dañada' };
  }
}

/** Guarda la sesión renovada que devuelve el bot al salir. Solo el bot que la tiene tomada. */
export async function guardarSesionRenovada(c: Cliente, grabacionId: string, crudo: unknown, ahora: Date, secreto: string): Promise<boolean> {
  const f = await leerFila(c);
  const correo = correoRobotValido(f?.cuenta_email);
  if (!f || !correo || f.en_uso_por !== grabacionId) return false;
  const estado = filtrarEstadoSesion(crudo);
  if (!estado) return false;
  const version = f.version ?? 0;
  const { data } = await c.from(TABLA_SESION_BOT).update({
    sesion_cifrada: cifrarSesion(estado, correo, secreto), estado: 'vigente', actualizada_at: ahora.toISOString(),
    en_uso_por: null, en_uso_hasta: null, version: version + 1,
  }).eq('id', 1).eq('version', version).select('id').maybeSingle();
  return !!data;
}

/** Suelta el candado (fin del bot). No toca la sesión. */
export async function liberarSesion(c: Cliente, grabacionId: string): Promise<void> {
  await c.from(TABLA_SESION_BOT).update({ en_uso_por: null, en_uso_hasta: null }).eq('id', 1).eq('en_uso_por', grabacionId);
}

/** La sesión no sirvió (Google pidió iniciar sesión de nuevo): queda "vencida" hasta que Vale la renueve. */
export async function marcarSesionVencida(c: Cliente, grabacionId: string, motivo: string): Promise<void> {
  await c.from(TABLA_SESION_BOT).update({
    estado: 'vencida', vencida_motivo: motivo.slice(0, 200), en_uso_por: null, en_uso_hasta: null,
  }).eq('id', 1).eq('en_uso_por', grabacionId);
}

export interface EntradaAprovisionar { authorization: string | null; cuerpoTexto: string }
export interface DepsAprovisionar { db?: Cliente; secretoBot?: string; secretoAprovisionar?: string; ahora?: () => Date }

/**
 * Sesión inicial: la sube la máquina "iniciar_sesion" después de que Vale inicia sesión a mano.
 * Autenticada con BOT_APROVISIONAR_SECRET (Bearer). Reemplaza la sesión guardada. Nunca devuelve
 * datos. Cualquier fallo de autenticación → 404 genérico (igual que bot-evento).
 */
export async function procesarSesionInicial(e: EntradaAprovisionar, deps: DepsAprovisionar = {}): Promise<{ status: number; cuerpo: Record<string, unknown> }> {
  const NO = { status: 404, cuerpo: { error: 'No encontrado' } };
  // Leído en runtime (process.env), nunca con import.meta.env: no queda en el bundle.
  const aprov = deps.secretoAprovisionar ?? (typeof process !== 'undefined' ? process.env?.[ENV_APROVISIONAR] : undefined);
  if (!aprovisionamientoValido(e.authorization, aprov)) return NO;
  const secretoBot = deps.secretoBot ?? (await import('../secretos')).secreto('BOT_TOKEN_SECRET');
  if (!secretoBot) return { status: 503, cuerpo: { error: 'No configurado' } };
  if (e.cuerpoTexto.length > MAX_SESION_BYTES * 2) return { status: 413, cuerpo: { error: 'Demasiado grande' } };
  let cuerpo: Record<string, unknown>;
  try { cuerpo = JSON.parse(e.cuerpoTexto); } catch { return { status: 400, cuerpo: { error: 'JSON inválido' } }; }
  if (cuerpo?.tipo !== 'sesion_inicial') return { status: 400, cuerpo: { error: 'tipo desconocido' } };
  const correo = correoRobotValido(cuerpo.correo);
  if (!correo) return { status: 400, cuerpo: { error: 'correo inválido' } };
  const estado = filtrarEstadoSesion(cuerpo.sesion);
  if (!estado) return { status: 400, cuerpo: { error: 'La sesión no trae un inicio de sesión de Google válido' } };

  const c = deps.db ?? (await import('../supabase')).supabase;
  const ahora = deps.ahora?.() ?? new Date();
  const previa = await leerFila(c);
  const fila = {
    id: 1, cuenta_email: correo, sesion_cifrada: cifrarSesion(estado, correo, secretoBot), estado: 'vigente',
    vencida_motivo: null, actualizada_at: ahora.toISOString(), verificada_at: ahora.toISOString(),
    en_uso_por: null, en_uso_hasta: null, version: (previa?.version ?? 0) + 1,
  };
  const { error } = await c.from(TABLA_SESION_BOT).upsert(fila, { onConflict: 'id' });
  if (error) return { status: 503, cuerpo: { error: 'No se pudo guardar (¿falta la migración 0022?)' } };
  const { auditar } = await import('./auditoria');
  await auditar('vale', 'cambiar_ajuste', { detalle: { ajuste: 'sesion_robot_meet', cookies: estado.cookies.length }, cliente: c });
  return { status: 200, cuerpo: { ok: true } };
}
