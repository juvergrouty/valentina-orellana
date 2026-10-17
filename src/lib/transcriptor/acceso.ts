// Transcriptor IA — control ÚNICO de acceso a contenido clínico (revisión de seguridad 16 oct,
// A1 y M2; decisión 3 de 01-decisiones-16oct.md).
//
// Toda ruta que descifra o muestra una transcripción, un resumen IA o respuestas de la IA exige:
//   1. cookie del panel válida (firma + vencimiento),
//   2. sesión de nivel PASSKEY (token v2: contraseña + Face ID/huella o código de respaldo),
//   3. sesión no cerrada, revisada FALLANDO CERRADO: si la lista de sesiones cerradas no se
//      puede leer (Supabase caído), no se muestra nada (503), a diferencia del panel general.
// Sin passkey → 401 con un mensaje que explica cómo confirmarla en Seguridad.
//
// Este archivo NO importa Supabase de forma estática (lo usa el middleware y las pruebas).
import type { APIContext, AstroCookies } from 'astro';
import { COOKIE_ADMIN, nivelTokenAdmin, tokenRevocado, type NivelSesionAdmin } from '../adminSession';
import type { AccionAuditoria } from './tipos';

/** Página donde Vale confirma la sesión con su passkey (botón "Confirmar con passkey"). */
export const URL_CONFIRMAR_PASSKEY = '/admin/seguridad';

/** Rutas del transcriptor: el middleware falla CERRADO en ellas si Supabase no responde (M2). */
export function esRutaTranscriptor(pathname: string): boolean {
  const p = (pathname.replace(/\/+$/, '') || '/').toLowerCase();
  return p === '/admin/grabar'
    || p === '/admin/transcriptor'
    || p === '/admin/transcriptor/comparar' // prueba ciega de modelos (muestra resúmenes)
    || p === '/api/admin/transcriptor' || p.startsWith('/api/admin/transcriptor/')
    || /^\/admin\/pacientes\/[^/]+\/sesion(\/|$)/.test(p);
}

export type MotivoAcceso = 'sesion' | 'passkey' | 'no_disponible';
export type ResultadoAcceso =
  | { ok: true }
  | { ok: false; motivo: MotivoAcceso; status: 401 | 503; error: string };

export const MENSAJES_ACCESO: Record<MotivoAcceso, string> = {
  sesion: 'Tu sesión del panel venció. Vuelve a entrar.',
  passkey: 'Para ver transcripciones y resúmenes, o preguntar a la IA, confirma esta sesión con tu passkey (Face ID o huella) en Seguridad.',
  no_disponible: 'No se pudo verificar tu sesión en este momento. Por seguridad no se muestra contenido clínico. Intenta de nuevo en unos minutos.',
};

const rechazo = (motivo: MotivoAcceso): ResultadoAcceso =>
  ({ ok: false, motivo, status: motivo === 'no_disponible' ? 503 : 401, error: MENSAJES_ACCESO[motivo] });

/** Regla pura. `revocado = 'error'` = no se pudo leer la lista de sesiones cerradas. */
export function decidirAccesoClinico(nivel: NivelSesionAdmin | null, revocado: boolean | 'error'): ResultadoAcceso {
  if (!nivel) return rechazo('sesion');
  if (revocado === 'error') return rechazo('no_disponible');
  if (revocado) return rechazo('sesion');
  if (nivel !== 'passkey') return rechazo('passkey');
  return { ok: true };
}

export interface DepsAcceso {
  /** Para pruebas. Por defecto: tokenRevocado en modo estricto (lanza si no puede leer). */
  revocado?: (token: string) => Promise<boolean>;
}

export async function accesoClinico(token: string | null | undefined, deps: DepsAcceso = {}): Promise<ResultadoAcceso> {
  const nivel = nivelTokenAdmin(token);
  if (!nivel) return decidirAccesoClinico(null, false);
  let rev: boolean | 'error';
  try { rev = await (deps.revocado ?? ((t: string) => tokenRevocado(t, { estricto: true })))(token as string); }
  catch { rev = 'error'; }
  return decidirAccesoClinico(nivel, rev);
}

export function accesoClinicoCookies(cookies: AstroCookies, deps: DepsAcceso = {}): Promise<ResultadoAcceso> {
  return accesoClinico(cookies.get(COOKIE_ADMIN)?.value ?? '', deps);
}

// ─── Ajustes reservados (revisión 16 oct, B2) ────────────────────────────────
// /api/admin/settings (formularios generales del panel) NO puede escribir estas claves: las del
// transcriptor solo cambian por /api/admin/transcriptor/ajustes (lista blanca + bitácora +
// decisión 3) y las de passkey solo por /api/admin/passkey/gestion (exige passkey).
const AJUSTES_RESERVADOS_EXACTOS = new Set(['cron_interno_secret', 'admin_tokens_revocados']);

/** true si el formulario general de ajustes debe IGNORAR esta clave. */
export function esAjusteReservado(clave: string): boolean {
  const k = String(clave ?? '').trim().toLowerCase();
  return k.startsWith('transcriptor_') || k.startsWith('passkey_') || AJUSTES_RESERVADOS_EXACTOS.has(k);
}

/** Respuesta JSON del rechazo (con `confirmar` cuando falta la passkey). */
export function respuestaRechazo(r: Exclude<ResultadoAcceso, { ok: true }>): Response {
  return new Response(JSON.stringify({
    ok: false, error: r.error, motivo: r.motivo,
    ...(r.motivo === 'passkey' ? { confirmar: URL_CONFIRMAR_PASSKEY } : {}),
  }), { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

/**
 * Para endpoints: null = puede seguir; Response = rechazo listo para devolver. El rechazo queda en
 * la bitácora del transcriptor (sin contenido). Llamar al INICIO del handler, antes de leer nada.
 */
export async function exigirAccesoClinico(ctx: APIContext, accion: AccionAuditoria): Promise<Response | null> {
  const r = await accesoClinicoCookies(ctx.cookies);
  if (r.ok) return null;
  try {
    const { auditar } = await import('./auditoria');
    let clientAddress: string | null = null;
    try { clientAddress = ctx.clientAddress ?? null; } catch { /* sin IP */ }
    await auditar('vale', accion, { request: ctx.request, clientAddress, resultado: 'denegado', detalle: { motivo: `acceso_${r.motivo}` } });
  } catch { /* la bitácora no debe abrir el acceso ni romper el rechazo */ }
  return respuestaRechazo(r);
}
