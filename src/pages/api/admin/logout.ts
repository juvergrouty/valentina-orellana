import type { APIRoute } from 'astro';
import { COOKIE_ADMIN, revocarTokenAdmin } from '../../../lib/adminSession';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect }) => {
  // La sesión queda invalidada en el servidor, no solo se borra la cookie.
  const token = cookies.get(COOKIE_ADMIN)?.value;
  if (token) { try { await revocarTokenAdmin(token); } catch { /* igual se cierra en este navegador */ } }
  cookies.delete(COOKIE_ADMIN, { path: '/' });
  return redirect('/admin/login');
};
