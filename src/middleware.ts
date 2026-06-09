import { defineMiddleware } from 'astro:middleware';

const COOKIE = 'vo_admin_token';

export const onRequest = defineMiddleware((context, next) => {
  const { pathname } = context.url;

  // Proteger rutas /admin/* y /api/admin/* (excepto el login)
  const isAdminPage = pathname.startsWith('/admin') && pathname !== '/admin/login';
  const isAdminApi  = pathname.startsWith('/api/admin') && pathname !== '/api/admin/login';

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
