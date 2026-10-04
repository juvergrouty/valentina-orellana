import { defineMiddleware } from 'astro:middleware';
import { tokenAdminValido } from './lib/adminSession';

const COOKIE = 'vo_admin_token';

export const onRequest = defineMiddleware((context, next) => {
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

  if (!tokenAdminValido(token)) {
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
