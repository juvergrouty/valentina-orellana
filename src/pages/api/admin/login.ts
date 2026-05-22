import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form     = await request.formData();
  const password = form.get('password')?.toString() ?? '';
  const expected = import.meta.env.ADMIN_PASSWORD;
  const secret   = import.meta.env.ADMIN_SECRET;

  if (!expected || password !== expected) {
    return redirect('/admin/login?error=1');
  }

  // Setear cookie de sesión (httpOnly, 8 horas)
  cookies.set('vo_admin_token', secret, {
    path:     '/',
    httpOnly: true,
    sameSite: 'strict',
    secure:   import.meta.env.PROD,
    maxAge:   60 * 60 * 8,
  });

  return redirect('/admin');
};
