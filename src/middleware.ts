import { defineMiddleware } from 'astro:middleware';

const COOKIE = 'vo_admin_token';

export const onRequest = defineMiddleware((context, next) => {
  const { pathname } = context.url;

  // Solo proteger rutas /admin (excepto el login)
  if (!pathname.startsWith('/admin') || pathname === '/admin/login') {
    return next();
  }

  const token    = context.cookies.get(COOKIE)?.value ?? '';
  const expected = import.meta.env.ADMIN_SECRET;

  if (!expected || token !== expected) {
    return context.redirect('/admin/login');
  }

  return next();
});
