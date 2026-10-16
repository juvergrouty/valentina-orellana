// Passkey (WebAuthn) del panel — reglas puras (16 oct 2026, decisión 3 de
// docs/transcriptor/01-decisiones-16oct.md). Sin Supabase ni import.meta.env:
// se prueban con `npx -y tsx@4.23.15 --test src/lib/passkey/*.test.ts`.
//
// Niveles de sesión:
//   'contrasena' → token v1 (solo contraseña; así eran todas antes de este cambio)
//   'passkey'    → token v2 (contraseña + passkey, o contraseña + código de respaldo)
//
// Regla para no dejar fuera a Vale nunca:
//   - Sin passkeys registradas, la contraseña basta (el panel muestra un aviso).
//   - Con passkeys y passkey_obligatoria = false: se pide la passkey, pero puede
//     "entrar sin passkey esta vez".
//   - Con passkeys y passkey_obligatoria = true: passkey o código de respaldo.
//   - Si quedara obligatoria sin ninguna passkey (no se puede llegar desde el
//     panel, solo editando la base), se deja entrar con contraseña y se avisa.

import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';

export type NivelSesion = 'contrasena' | 'passkey';

export interface EstadoPasskeys {
  /** Passkeys registradas. */
  cantidad: number;
  /** Ajuste passkey_obligatoria = 'true'. */
  obligatoria: boolean;
  /** Códigos de respaldo vigentes (sin usar ni anular). */
  codigosRestantes: number;
  /** La migración 0015 aún no está aplicada (las tablas no existen). */
  migracionPendiente: boolean;
}

/** ¿Esta sesión puede usar el panel? */
export function sesionSuficiente(nivel: NivelSesion, e: Pick<EstadoPasskeys, 'cantidad' | 'obligatoria'>): boolean {
  if (nivel === 'passkey') return true;
  return !e.obligatoria || e.cantidad === 0;
}

/** Después de una contraseña correcta: ¿sesión directa o paso de passkey? */
export function pasoDespuesDeContrasena(e: Pick<EstadoPasskeys, 'cantidad'>): 'sesion' | 'pedir_passkey' {
  return e.cantidad > 0 ? 'pedir_passkey' : 'sesion';
}

/** ¿Se ofrece "Entrar sin passkey esta vez"? */
export function puedeOmitirPasskey(e: Pick<EstadoPasskeys, 'cantidad' | 'obligatoria'>): boolean {
  return !e.obligatoria || e.cantidad === 0;
}

/**
 * ¿Puede agregar/eliminar passkeys, cambiar la obligatoriedad o regenerar
 * códigos? Si ya hay passkeys, solo con sesión confirmada con passkey: así
 * alguien que solo tiene la contraseña no puede registrar su propia passkey.
 */
export function puedeGestionar(nivel: NivelSesion, e: Pick<EstadoPasskeys, 'cantidad'>): boolean {
  return nivel === 'passkey' || e.cantidad === 0;
}

// ── Límite de intentos del paso 2 (passkey / código de respaldo) ────────────
// Revisión de seguridad 16 oct (B8): además del tope global (10 en 15 min, protege los códigos de
// respaldo de un ataque repartido entre muchas IP) hay un tope por IP más bajo (5 en 15 min), así
// una sola IP no consume el cupo global entero de una vez. Fallar la lectura del conteo = bloqueado.
export const MAX_FALLOS_PASO2 = 10;
export const MAX_FALLOS_PASO2_IP = 5;

export function pasoDosBloqueado(fallosGlobal: number | null, fallosIp: number | null, errorLectura = false): boolean {
  if (errorLectura || fallosGlobal == null || fallosIp == null) return true;
  return fallosGlobal > MAX_FALLOS_PASO2 || fallosIp > MAX_FALLOS_PASO2_IP;
}

/** ¿Se puede eliminar una passkey? (no la última mientras sea obligatoria) */
export function puedeEliminar(e: Pick<EstadoPasskeys, 'cantidad' | 'obligatoria'>): boolean {
  return !(e.obligatoria && e.cantidad <= 1);
}

// ── Relying Party (dominio dueño de la passkey) ─────────────────────────────
export const RP_ID_PRODUCCION = 'valentinaorellana.cl';
export const ORIGENES_PRODUCCION = ['https://valentinaorellana.cl', 'https://www.valentinaorellana.cl'];
export const RP_NOMBRE = 'Panel Ps. Valentina Orellana';

export interface ConfigRp { rpID: string; origenes: string[] }

/**
 * RP ID y orígenes aceptados según el sitio donde se abrió el panel.
 * Producción: valentinaorellana.cl (sirve para www y sin www). Desarrollo:
 * localhost (solo si permitirLocal). Otro dominio (p. ej. *.vercel.app): null,
 * no se puede usar passkey ahí (sí el código de respaldo).
 */
export function configRp(url: URL, permitirLocal: boolean): ConfigRp | null {
  const host = url.hostname.toLowerCase();
  if (host === RP_ID_PRODUCCION || host === `www.${RP_ID_PRODUCCION}`) {
    return { rpID: RP_ID_PRODUCCION, origenes: ORIGENES_PRODUCCION };
  }
  if (permitirLocal && host === 'localhost') {
    return { rpID: 'localhost', origenes: [url.origin] };
  }
  return null;
}

// ── Códigos de respaldo ─────────────────────────────────────────────────────
// 10 códigos de 10 caracteres (alfabeto de 32 sin 0/O/1/I: 50 bits cada uno),
// mostrados como XXXXX-XXXXX. Se guardan solo como hash scrypt con sal propia.
export const CANTIDAD_CODIGOS = 10;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generarCodigoRespaldo(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function generarCodigosRespaldo(n = CANTIDAD_CODIGOS): string[] {
  const set = new Set<string>();
  while (set.size < n) set.add(generarCodigoRespaldo());
  return [...set];
}

/** Quita espacios y guiones y pasa a mayúsculas. Devuelve '' si no tiene forma de código. */
export function normalizarCodigo(entrada: string): string {
  const s = entrada.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{10}$/.test(s) ? s : '';
}

const SCRYPT = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function scrypt(clave: string, sal: Buffer): Promise<Buffer> {
  return new Promise((ok, mal) => scryptCb(clave, sal, 32, SCRYPT, (e, k) => (e ? mal(e) : ok(k))));
}

/** Hash para guardar: 'scrypt$<sal>$<hash>' (base64url). Recibe el código tal como se muestra o normalizado. */
export async function hashCodigo(codigo: string): Promise<string> {
  const norm = normalizarCodigo(codigo);
  if (!norm) throw new Error('Código de respaldo inválido');
  const sal = randomBytes(16);
  return `scrypt$${sal.toString('base64url')}$${(await scrypt(norm, sal)).toString('base64url')}`;
}

export async function codigoCoincide(codigo: string, guardado: string): Promise<boolean> {
  const norm = normalizarCodigo(codigo);
  const [alg, sal, hash] = guardado.split('$');
  if (!norm || alg !== 'scrypt' || !sal || !hash) return false;
  const esperado = Buffer.from(hash, 'base64url');
  const calculado = await scrypt(norm, Buffer.from(sal, 'base64url'));
  return esperado.length === calculado.length && timingSafeEqual(esperado, calculado);
}

// ── Token del paso intermedio (contraseña correcta, falta la passkey) ───────
// "p1.<vence>.<nonce>.<firma>", 10 minutos. NO es una sesión: el middleware no
// lo acepta para nada del panel; solo sirve en /api/admin/passkey/acceso.
export const DURACION_PASO_MS = 10 * 60 * 1000;

function firmarPaso(secreto: string, payload: string): string {
  return createHmac('sha256', `paso-passkey:${secreto}`).update(payload).digest('hex');
}

export function crearTokenPaso(secreto: string, ahora = Date.now()): string {
  if (!secreto) throw new Error('Falta ADMIN_SECRET');
  const payload = `p1.${ahora + DURACION_PASO_MS}.${randomBytes(12).toString('base64url')}`;
  return `${payload}.${firmarPaso(secreto, payload)}`;
}

/** Devuelve el nonce (sirve de vínculo para el desafío) si el token es válido; si no, null. */
export function leerTokenPaso(secreto: string, token: string | undefined | null, ahora = Date.now()): string | null {
  if (!secreto || !token) return null;
  const p = token.split('.');
  if (p.length !== 4 || p[0] !== 'p1') return null;
  const vence = Number(p[1]);
  if (!Number.isFinite(vence) || vence < ahora) return null;
  const esperada = Buffer.from(firmarPaso(secreto, `p1.${p[1]}.${p[2]}`));
  const recibida = Buffer.from(p[3]);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  return p[2];
}

/** Nombre visible de la passkey: lo que escribió Vale, recortado; o uno por defecto. */
export function nombrePasskey(entrada: unknown): string {
  const s = String(entrada ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  return s || 'Passkey';
}
