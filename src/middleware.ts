import { defineMiddleware } from 'astro:middleware';
import { tokenAdminValido, tokenRevocado } from './lib/adminSession';

const COOKIE = 'vo_admin_token';

export const onRequest = defineMiddleware(async (context, next) => {
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
});
