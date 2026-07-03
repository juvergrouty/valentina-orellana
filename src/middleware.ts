import { defineMiddleware } from 'astro:middleware';

const COOKIE = 'vo_admin_token';

export const onRequest = defineMiddleware((context, next) => {
  const { pathname } = context.url;

  // Rutas públicas dentro de /api/admin: login y el callback de Google OAuth
  // (el callback llega redirigido desde Google, sin la cookie de sesión; su
  //  seguridad la da el código de autorización, no la cookie)
  const PUBLIC_ADMIN_API = ['/api/admin/login', '/api/admin/google/callback'];

  // Proteger rutas /admin/* y /api/admin/* (excepto las públicas)
  const isAdminPage = pathname.startsWith('/admin') && pathname !== '/admin/login';
  const isAdminApi  = pathname.startsWith('/api/admin') && !PUBLIC_ADMIN_API.includes(pathname);

  if (!isAdminPage && !isAdminApi) {
    return next();
  }

  const token    = context.cookies.get(COOKIE)?.value ?? '';
  const expected = import.meta.env.ADMIN_SECRET;

  if (!expected || token !== expected) {
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
