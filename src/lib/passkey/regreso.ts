// Login con regreso (t-n-pulido): si una página del panel (p. ej. /admin/transcriptor/accion?…,
// el enlace de un correo de aviso) manda al login, después de entrar (contraseña + passkey) se
// vuelve a ESA misma dirección. El destino viaja en ?volver= y se valida en cada paso: solo rutas
// internas del panel (/admin…). Nada de redirecciones abiertas (otro dominio, //, \, esquemas).
// Pruebas en regreso.test.ts.

export const PARAM_VOLVER = 'volver';
export const MAX_VOLVER = 1000;
const BASE = 'https://panel.invalid';

/**
 * Destino seguro para después del login, o null. Acepta solo una ruta relativa que empiece con
 * "/admin" (exactamente /admin o /admin/…, también con ?query o #), sin barras invertidas ni
 * caracteres de control, que al normalizarla (../, %2e) siga dentro de /admin y no sea el login.
 */
export function destinoSeguro(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim();
  if (!s || s.length > MAX_VOLVER) return null;
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s, BASE); } catch { return null; }
  if (u.origin !== BASE) return null;
  const p = u.pathname;
  if (p !== '/admin' && !p.startsWith('/admin/')) return null;
  if (/%2f|%5c/i.test(p)) return null; // barras codificadas: no se aceptan
  if (p === '/admin/login' || p.startsWith('/admin/login/')) return null; // evita volver al login en círculo
  return `${p}${u.search}${u.hash}`;
}

/** Destino de la petición actual (para el middleware): solo navegaciones GET a páginas del panel. */
export function destinoDePeticion(url: URL, metodo: string): string | null {
  if (metodo !== 'GET') return null;
  return destinoSeguro(`${url.pathname}${url.search}`);
}

/** Agrega ?volver=… a una URL del login (si el destino es válido; si no, la deja igual). */
export function conVolver(urlLogin: string, volver: unknown): string {
  const d = destinoSeguro(volver);
  if (!d || d === '/admin') return urlLogin;
  return `${urlLogin}${urlLogin.includes('?') ? '&' : '?'}${PARAM_VOLVER}=${encodeURIComponent(d)}`;
}
