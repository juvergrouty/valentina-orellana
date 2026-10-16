// Transcriptor IA (P4) — guardia común de los endpoints del grabador.
// El middleware ya exige la cookie del panel en /api/admin/*, pero deja pasar un POST
// SIN Origin/Referer (30-seguridad R4). Aquí se falla CERRADO (checklist §8):
//   - método POST,
//   - Origin (o, si falta, Referer) presente y del mismo sitio,
//   - cabecera X-Panel: 1 (un formulario de otro sitio no puede ponerla sin CORS),
//   - cookie del panel válida y no revocada (defensa en profundidad).
// Cada rechazo queda en la bitácora del transcriptor.
import type { APIContext } from 'astro';
import { COOKIE_ADMIN, tokenAdminValido, tokenRevocado } from '../adminSession';
import { auditar } from './auditoria';
import type { AccionAuditoria } from './tipos';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

/** Host del Origin/Referer; '' si falta o es inválido. */
export function hostDeOrigen(request: Request): string {
  const o = request.headers.get('origin') || request.headers.get('referer') || '';
  if (!o || o === 'null') return '';
  try { return new URL(o).host; } catch { return ''; }
}

export function origenPropio(request: Request, url: URL): boolean {
  const host = hostDeOrigen(request);
  if (!host) return false;
  const propios = [url.host, request.headers.get('host'), request.headers.get('x-forwarded-host')].filter(Boolean);
  return propios.includes(host);
}

/** null = puede seguir; Response = rechazo ya listo para devolver. */
export async function guardiaPanel(ctx: APIContext, accion: AccionAuditoria): Promise<Response | null> {
  const { request, url, cookies } = ctx;
  let motivo: string | null = null;
  if (request.method !== 'POST') motivo = 'metodo';
  else if (!origenPropio(request, url)) motivo = 'origen';
  else if (request.headers.get('x-panel') !== '1') motivo = 'cabecera';
  else {
    const token = cookies.get(COOKIE_ADMIN)?.value ?? '';
    if (!tokenAdminValido(token) || (await tokenRevocado(token))) motivo = 'sesion';
  }
  if (!motivo) return null;
  await auditar('vale', accion, { request, clientAddress: safeAddr(ctx), resultado: 'denegado', detalle: { motivo } });
  if (motivo === 'sesion') return json({ ok: false, error: 'Tu sesión del panel venció. Vuelve a entrar.', motivo }, 401);
  return json({ ok: false, error: 'Origen no permitido.', motivo }, 403);
}

export function safeAddr(ctx: APIContext): string | null {
  try { return ctx.clientAddress ?? null; } catch { return null; }
}

export async function leerJson(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  try {
    const t = await request.text();
    if (t.length > maxBytes) return null;
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (x: unknown): x is string => typeof x === 'string' && UUID_RE.test(x);
