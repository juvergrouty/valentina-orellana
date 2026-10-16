// Sesión de Google del robot (modo 'cuenta'; docs/transcriptor/85-robot-meet.md). Puro: sin red.
// Formato = storageState de Playwright. El sitio la guarda cifrada y la entrega con `pide_sesion`;
// al salir, el bot devuelve la versión renovada con `sesion_actualizada` (Google rota cookies).
// Nunca se escribe en disco ni se registra en los logs.

export interface CookieSesion {
  name: string; value: string; domain: string; path: string;
  expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
}
export interface EstadoSesion {
  cookies: CookieSesion[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

/** Cookies que prueban una sesión de Google iniciada. */
export const COOKIES_SESION_GOOGLE = ['SID', '__Secure-1PSID', '__Secure-3PSID'];
const DOMINIO_GOOGLE_RE = /^\.?(?:[a-z0-9-]+\.)*google\.com$/i;
const ORIGEN_GOOGLE_RE = /^https:\/\/(?:[a-z0-9-]+\.)*google\.com$/i;

export function estadoSesionValido(x: unknown): x is EstadoSesion {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.cookies) || !Array.isArray(o.origins)) return false;
  return o.cookies.some((c) => !!c && typeof c === 'object'
    && COOKIES_SESION_GOOGLE.includes(String((c as Record<string, unknown>).name))
    && DOMINIO_GOOGLE_RE.test(String((c as Record<string, unknown>).domain)));
}

/** Deja solo lo de google.com (lo único que Meet necesita) antes de devolverla al sitio. */
export function soloGoogle(e: EstadoSesion): EstadoSesion {
  return {
    cookies: e.cookies.filter((c) => DOMINIO_GOOGLE_RE.test(c.domain)),
    origins: e.origins.filter((o) => ORIGEN_GOOGLE_RE.test(o.origin)),
  };
}

/** El texto visible de la página muestra el correo de la cuenta esperada (Meet lo muestra en la antesala). */
export function muestraCorreo(textoPagina: string, correo: string): boolean {
  return textoPagina.toLowerCase().includes(correo.toLowerCase());
}
