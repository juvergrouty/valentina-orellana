import { defineMiddleware } from 'astro:middleware';
import type { APIContext, MiddlewareNext } from 'astro';
import { tokenAdminValido, tokenRevocado } from './lib/adminSession';

const COOKIE = 'vo_admin_token';

// Páginas públicas que son iguales para todas las visitas (12 oct 2026): el
// CDN de Vercel puede guardarlas 5 minutos y servir la copia anterior mientras
// genera una nueva. Revisado: ninguna lee cookies ni parámetros de la dirección
// (?error=, etc.), solo la ruta. Lista exacta a propósito: NO agenda, admin,
// api, pagar, recuperar, confirmacion ni pasos-a-seguir.
const PAGINAS_CACHEABLES = new Set(['/', '/servicios', '/precios', '/contacto', '/opiniones', '/condiciones']);
const CACHE_PUBLICO = 'public, s-maxage=300, stale-while-revalidate=86400';

// Panel y API del panel: que nadie (navegador, CDN ni proxy) guarde una copia.
const SIN_CACHE = 'private, no-store';

/** Pone un encabezado sin romper si la respuesta tiene encabezados inmutables. */
function conEncabezado(res: Response, nombre: string, valor: string): Response {
  try {
    res.headers.set(nombre, valor);
    return res;
  } catch {
    const copia = new Response(res.body, res);
    copia.headers.set(nombre, valor);
    return copia;
  }
}

// Revisión de sesión del panel (sin cambios: solo se movió a una función para
// poder agregar "private, no-store" a todas sus respuestas).
async function protegerAdmin(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const { pathname } = context.url;

  // Única ruta pública dentro de /api/admin: el login. El callback de Google
  // OAuth YA NO es público (3 oct 2026): cualquiera podía conectar su propia
  // cuenta de Google y recibir las sesiones de las pacientes en su calendario.
  // La cookie de sesión (SameSite=lax) sí viaja en el redirect de vuelta de
  // Google, así que exigirla no rompe la conexión de Valentina.
  const PUBLIC_ADMIN_API = ['/api/admin/login'];

  // Proteger rutas /admin/* y /api/admin/* (excepto las públicas)
  const isAdminPage = pathname.startsWith('/admin') && pathname !== '/admin/login';
  const isAdminApi  = pathname.startsWith('/api/admin') && !PUBLIC_ADMIN_API.includes(pathname);

  if (!isAdminPage && !isAdminApi) {
    return next();
  }

  // Token firmado con vencimiento (ver src/lib/adminSession.ts).
  const token = context.cookies.get(COOKIE)?.value ?? '';

  // Acciones del panel (POST, etc.) solo desde páginas de este mismo sitio:
  // otra página no puede hacer que el navegador de Valentina ejecute acciones
  // de su panel. Si el navegador no manda Origin/Referer, se deja pasar.
  if (isAdminApi && !['GET', 'HEAD', 'OPTIONS'].includes(context.request.method)) {
    const origen = context.request.headers.get('origin') || context.request.headers.get('referer');
    if (origen) {
      let host = '';
      try { host = new URL(origen).host; } catch { /* inválido */ }
      const propios = [context.url.host, context.request.headers.get('host'), context.request.headers.get('x-forwarded-host')].filter(Boolean);
      if (!propios.includes(host)) {
        return new Response(JSON.stringify({ error: 'Origen no permitido.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
    }
  }

  if (!tokenAdminValido(token) || await tokenRevocado(token)) {
    // Un formulario del panel enviado con la sesión vencida (navegación del
    // navegador, no un fetch) vuelve al login en vez de mostrar un JSON crudo.
    const esNavegacion = context.request.headers.get('sec-fetch-mode') === 'navigate'
      || (context.request.headers.get('accept') ?? '').includes('text/html');
    if (isAdminApi && esNavegacion) return context.redirect('/admin/login?expirada=1');
    // Las API routes devuelven 401 JSON, las páginas redirigen al login
    if (isAdminApi) {
      return new Response(JSON.stringify({ error: 'No autorizado.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return context.redirect('/admin/login');
  }

  return next();
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Toda respuesta de /admin/* y /api/admin/* (incluidos el login, los 401 y
  // las redirecciones) sale con "private, no-store".
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    return conEncabezado(await protegerAdmin(context, next), 'Cache-Control', SIN_CACHE);
  }

  const res = await next();
  // Solo respuestas 200 de las rutas exactas, y nunca si la respuesta pone una cookie.
  if (
    PAGINAS_CACHEABLES.has(pathname)
    && res.status === 200
    && ['GET', 'HEAD'].includes(context.request.method)
    && !res.headers.has('set-cookie')
  ) {
    return conEncabezado(res, 'Cache-Control', CACHE_PUBLICO);
  }
  return res;
});
