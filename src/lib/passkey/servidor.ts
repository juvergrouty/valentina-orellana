// Passkey (WebAuthn) del panel — base de datos y verificación (16 oct 2026).
// Reglas en ./nucleo.ts; tablas en supabase/migrations/0015_passkeys.sql.
// Librería: @simplewebauthn/server 14 (verifica firma, challenge, origin, RP ID,
// user verification y contador).

import type { AstroCookies } from 'astro';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { randomUUID } from 'node:crypto';
import { supabase } from '../supabase';
import { secreto as leerSecreto } from '../secretos';
import { COOKIE_ADMIN, DURACION_SESION_MS, crearTokenAdmin, nivelTokenAdmin, type NivelSesionAdmin } from '../adminSession';
import {
  CANTIDAD_CODIGOS, DURACION_PASO_MS, RP_NOMBRE, codigoCoincide, configRp, crearTokenPaso, generarCodigosRespaldo,
  hashCodigo, leerTokenPaso, nombrePasskey, normalizarCodigo, sesionSuficiente, type ConfigRp, type EstadoPasskeys,
} from './nucleo';

export const COOKIE_PASO = 'vo_admin_paso2';
export const SETTING_OBLIGATORIA = 'passkey_obligatoria';
const DURACION_DESAFIO_MS = 5 * 60 * 1000;
// Identificador fijo de la usuaria del panel (hay una sola). No es un dato personal.
const USER_ID = new TextEncoder().encode('vo-panel-admin');

const secreto = () => leerSecreto('ADMIN_SECRET') ?? '';
export const rpDe = (url: URL): ConfigRp | null => configRp(url, !!import.meta.env.DEV);

/** La tabla aún no existe (migración 0015 sin aplicar). */
function tablaFalta(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find the table/i.test(error.message ?? '');
}

// ── Estado (cacheado 30 s por instancia, como la lista de sesiones cerradas) ─
let cacheEstado: { estado: EstadoPasskeys; leido: number } | null = null;
export function invalidarEstadoPasskeys() { cacheEstado = null; }

/** Lanza si Supabase falla (quien llama decide: el login rechaza, el middleware deja pasar). */
export async function estadoPasskeys(): Promise<EstadoPasskeys> {
  if (cacheEstado && Date.now() - cacheEstado.leido < 30_000) return cacheEstado.estado;
  const [pk, cod, ajuste] = await Promise.all([
    supabase.from('admin_passkeys').select('id', { count: 'exact', head: true }),
    supabase.from('admin_codigos_respaldo').select('id', { count: 'exact', head: true }).is('usado_at', null).is('anulado_at', null),
    supabase.from('settings').select('value').eq('key', SETTING_OBLIGATORIA).maybeSingle(),
  ]);
  if (ajuste.error) throw new Error(ajuste.error.message);
  let estado: EstadoPasskeys;
  // Un conteo (HEAD) a una tabla inexistente vuelve 404 sin cuerpo, y
  // supabase-js lo convierte en "sin error y sin conteo": count null = tabla falta.
  if (tablaFalta(pk.error) || tablaFalta(cod.error) || (!pk.error && pk.count == null) || (!cod.error && cod.count == null)) {
    estado = { cantidad: 0, obligatoria: false, codigosRestantes: 0, migracionPendiente: true };
  } else {
    if (pk.error || cod.error) throw new Error((pk.error ?? cod.error)!.message);
    estado = { cantidad: pk.count ?? 0, obligatoria: ajuste.data?.value === 'true', codigosRestantes: cod.count ?? 0, migracionPendiente: false };
  }
  cacheEstado = { estado, leido: Date.now() };
  return estado;
}

/**
 * Para el middleware: ¿esta sesión basta? Si no se puede leer el estado: en el panel general sí
 * (no bloquear el panel); con { estricto: true } (rutas del transcriptor, revisión 16 oct M2)
 * se LANZA y el middleware falla cerrado.
 */
export async function sesionAceptada(token: string | undefined | null, opciones: { estricto?: boolean } = {}): Promise<boolean> {
  const nivel = nivelTokenAdmin(token);
  if (!nivel) return false;
  if (nivel === 'passkey') return true;
  try { return sesionSuficiente(nivel, await estadoPasskeys()); }
  catch (e) {
    if (opciones.estricto) throw e;
    return true;
  }
}

export interface PasskeyGuardada {
  id: string; credential_id: string; public_key: string; counter: number; transports: string[];
  device_type: string | null; backed_up: boolean; nombre: string; created_at: string; last_used_at: string | null;
}

export async function listarPasskeys(): Promise<PasskeyGuardada[]> {
  const { data, error } = await supabase.from('admin_passkeys')
    .select('id, credential_id, public_key, counter, transports, device_type, backed_up, nombre, created_at, last_used_at')
    .order('created_at', { ascending: true });
  if (tablaFalta(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []) as PasskeyGuardada[];
}

// ── Cookies ─────────────────────────────────────────────────────────────────
export function ponerSesion(cookies: AstroCookies, nivel: NivelSesionAdmin) {
  cookies.set(COOKIE_ADMIN, crearTokenAdmin(nivel), {
    path: '/', httpOnly: true,
    sameSite: 'lax', // 'lax' permite que la cookie viaje en el redirect de vuelta de Google OAuth
    secure: import.meta.env.PROD, maxAge: DURACION_SESION_MS / 1000,
  });
}

export function ponerPaso(cookies: AstroCookies) {
  cookies.set(COOKIE_PASO, crearTokenPaso(secreto()), {
    path: '/', httpOnly: true, sameSite: 'strict', secure: import.meta.env.PROD, maxAge: DURACION_PASO_MS / 1000,
  });
}

export function borrarPaso(cookies: AstroCookies) { cookies.delete(COOKIE_PASO, { path: '/' }); }

/** Nonce del paso intermedio si la cookie es válida; si no, null. */
export function leerPaso(cookies: AstroCookies): string | null {
  return leerTokenPaso(secreto(), cookies.get(COOKIE_PASO)?.value);
}

// ── Desafíos (challenge): un solo uso, 5 minutos, ligados a quien los pidió ─
async function guardarDesafio(challenge: string, tipo: 'registro' | 'acceso', vinculo: string) {
  // Limpieza de los vencidos hace más de un día (no son datos, solo números al azar).
  await supabase.from('admin_webauthn_desafios').delete().lt('vence', new Date(Date.now() - 86400e3).toISOString());
  const { error } = await supabase.from('admin_webauthn_desafios').insert({
    challenge, tipo, vinculo, vence: new Date(Date.now() + DURACION_DESAFIO_MS).toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** Marca el desafío como usado; true solo si existía, era de este tipo y vínculo, no estaba usado ni vencido. */
async function consumirDesafio(challenge: string, tipo: 'registro' | 'acceso', vinculo: string): Promise<boolean> {
  const { data, error } = await supabase.from('admin_webauthn_desafios')
    .update({ usado_at: new Date().toISOString() })
    .eq('challenge', challenge).eq('tipo', tipo).eq('vinculo', vinculo)
    .is('usado_at', null).gt('vence', new Date().toISOString())
    .select('id');
  return !error && (data?.length ?? 0) === 1;
}

// ── Registro de una passkey nueva ───────────────────────────────────────────
export async function opcionesRegistro(rp: ConfigRp, vinculo: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existentes = await listarPasskeys();
  const opciones = await generateRegistrationOptions({
    rpName: RP_NOMBRE,
    rpID: rp.rpID,
    userID: USER_ID,
    userName: 'panel',
    userDisplayName: 'Valentina Orellana (panel)',
    attestationType: 'none',
    timeout: 120_000,
    excludeCredentials: existentes.map(p => ({ id: p.credential_id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  await guardarDesafio(opciones.challenge, 'registro', vinculo);
  return opciones;
}

export type ResultadoRegistro = { ok: true; codigos: string[] | null } | { ok: false; error: string; detalle?: string };

export async function verificarRegistro(rp: ConfigRp, vinculo: string, respuesta: RegistrationResponseJSON, nombre: unknown): Promise<ResultadoRegistro> {
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: respuesta,
      expectedChallenge: (c) => consumirDesafio(c, 'registro', vinculo),
      expectedOrigin: rp.origenes,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    if (!v.verified) return { ok: false, error: 'No se pudo verificar la passkey.' };
    info = v.registrationInfo;
  } catch (e) {
    return { ok: false, error: 'No se pudo verificar la passkey. Intenta de nuevo.', detalle: (e as Error).message };
  }
  const antes = await listarPasskeys();
  const { error } = await supabase.from('admin_passkeys').insert({
    credential_id: info.credential.id,
    public_key: Buffer.from(info.credential.publicKey).toString('base64url'),
    counter: info.credential.counter,
    transports: info.credential.transports ?? [],
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp,
    aaguid: info.aaguid,
    nombre: nombrePasskey(nombre),
  });
  invalidarEstadoPasskeys();
  if (error) return { ok: false, error: error.code === '23505' ? 'Esa passkey ya estaba registrada.' : `No se pudo guardar la passkey: ${error.message}` };
  // Primera passkey: se generan los códigos de respaldo (si no había vigentes).
  let codigos: string[] | null = null;
  if (antes.length === 0) {
    const { count } = await supabase.from('admin_codigos_respaldo').select('id', { count: 'exact', head: true }).is('usado_at', null).is('anulado_at', null);
    if (!count) codigos = await nuevosCodigosRespaldo();
  }
  return { ok: true, codigos };
}

/** Anula los códigos vigentes y crea un lote nuevo. Devuelve los códigos en claro (se muestran una vez). */
export async function nuevosCodigosRespaldo(): Promise<string[]> {
  const codigos = generarCodigosRespaldo(CANTIDAD_CODIGOS);
  const lote = randomUUID();
  const filas = await Promise.all(codigos.map(async c => ({ lote, hash: await hashCodigo(c) })));
  const { error: errAnular } = await supabase.from('admin_codigos_respaldo')
    .update({ anulado_at: new Date().toISOString() }).is('usado_at', null).is('anulado_at', null);
  if (errAnular) throw new Error(errAnular.message);
  const { error } = await supabase.from('admin_codigos_respaldo').insert(filas);
  invalidarEstadoPasskeys();
  if (error) throw new Error(error.message);
  return codigos;
}

// ── Acceso con passkey ──────────────────────────────────────────────────────
export async function opcionesAcceso(rp: ConfigRp, vinculo: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const existentes = await listarPasskeys();
  const opciones = await generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: 120_000,
    userVerification: 'required',
    allowCredentials: existentes.map(p => ({ id: p.credential_id, transports: p.transports })),
  });
  await guardarDesafio(opciones.challenge, 'acceso', vinculo);
  return opciones;
}

export async function verificarAcceso(rp: ConfigRp, vinculo: string, respuesta: AuthenticationResponseJSON): Promise<{ ok: true; nombre: string } | { ok: false; error: string; detalle?: string }> {
  if (!respuesta || typeof respuesta.id !== 'string') return { ok: false, error: 'Respuesta inválida.' };
  const { data: pk, error } = await supabase.from('admin_passkeys')
    .select('id, credential_id, public_key, counter, transports, nombre').eq('credential_id', respuesta.id).maybeSingle();
  if (error) return { ok: false, error: 'No pude revisar la passkey. Intenta en unos minutos.' };
  if (!pk) return { ok: false, error: 'Esa passkey no está registrada en este panel.' };
  try {
    const v = await verifyAuthenticationResponse({
      response: respuesta,
      expectedChallenge: (c) => consumirDesafio(c, 'acceso', vinculo),
      expectedOrigin: rp.origenes,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: pk.credential_id,
        publicKey: new Uint8Array(Buffer.from(pk.public_key, 'base64url')),
        counter: Number(pk.counter) || 0,
        transports: pk.transports ?? [],
      },
    });
    if (!v.verified) return { ok: false, error: 'No se pudo verificar la passkey.' };
    // Contador: solo sube (si otra petición ya lo subió más, no se pisa).
    await supabase.from('admin_passkeys')
      .update({ counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
      .eq('id', pk.id).lte('counter', v.authenticationInfo.newCounter);
    return { ok: true, nombre: pk.nombre };
  } catch (e) {
    return { ok: false, error: 'No se pudo verificar la passkey. Intenta de nuevo.', detalle: (e as Error).message };
  }
}

// ── Código de respaldo ──────────────────────────────────────────────────────
/** true si el código es uno vigente; queda marcado como usado (un solo uso, también con dos envíos simultáneos). */
export async function usarCodigoRespaldo(entrada: string): Promise<boolean> {
  if (!normalizarCodigo(entrada)) return false;
  const { data, error } = await supabase.from('admin_codigos_respaldo').select('id, hash').is('usado_at', null).is('anulado_at', null);
  if (error || !data) return false;
  for (const fila of data) {
    if (await codigoCoincide(entrada, fila.hash)) {
      const { data: marcada } = await supabase.from('admin_codigos_respaldo')
        .update({ usado_at: new Date().toISOString() }).eq('id', fila.id).is('usado_at', null).select('id');
      invalidarEstadoPasskeys();
      return (marcada?.length ?? 0) === 1;
    }
  }
  return false;
}

// ── Aviso en el panel (franja arriba, en todas las páginas del panel) ───────
export interface AvisoPasskey { texto: string; urgente: boolean }

/** null si no hay nada que avisar o si no se pudo leer el estado (no se bloquea la página). */
export async function avisoPasskey(token: string | undefined | null): Promise<AvisoPasskey | null> {
  let e: EstadoPasskeys;
  try { e = await estadoPasskeys(); } catch { return null; }
  if (e.migracionPendiente) return null;
  if (e.cantidad === 0) {
    return e.obligatoria
      ? { urgente: true, texto: 'La passkey está marcada como obligatoria, pero no hay ninguna registrada: se está entrando solo con la contraseña. Registra una ahora en Seguridad →' }
      : { urgente: false, texto: 'Protege tu panel: registra una passkey (Face ID o huella) para que la contraseña sola no baste para entrar. Registrar en Seguridad →' };
  }
  if (e.codigosRestantes <= 2) {
    return { urgente: true, texto: `Te quedan ${e.codigosRestantes} códigos de respaldo. Genera códigos nuevos en Seguridad →` };
  }
  if (!e.obligatoria) {
    return { urgente: false, texto: nivelTokenAdmin(token) === 'contrasena'
      ? 'Entraste sin passkey. Cuando tengas tu iPhone y tu Mac registrados, activa "Passkey obligatoria" en Seguridad →'
      : 'Tu passkey ya funciona. Activa "Passkey obligatoria" en Seguridad para que la contraseña sola no baste →' };
  }
  return null;
}
