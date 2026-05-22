import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = ({ cookies, redirect }) => {
  cookies.delete('vo_admin_token', { path: '/' });
  return redirect('/admin/login');
};
