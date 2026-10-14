import type { APIRoute, AstroCookies } from 'astro';
import { COOKIE_PAGO_VITRINA } from '../../../lib/vitrina';

export const prerender = false;

/**
 * POST/GET /api/vitrina/flow-return
 *
 * Flow devuelve a la persona aquí después de pagar (POST con token). Igual que
 * /api/flow/return: el token viaja en una cookie corta (solo para /talleres),
 * no en la URL, para que GTM no reciba un enlace con sus datos.
 */
function guardarToken(cookies: AstroCookies, token: string) {
  cookies.set(COOKIE_PAGO_VITRINA, token, {
    path:     '/talleres',
    httpOnly: true,
    secure:   import.meta.env.PROD,
    sameSite: 'lax',
    maxAge:   60 * 60,
  });
}

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  let token = '';
  try {
    const text = await request.text();
    token = new URLSearchParams(text).get('token') ?? '';
  } catch { /* sin body: se muestra el estado genérico */ }
  if (token) guardarToken(cookies, token.slice(0, 200));
  return redirect('/talleres/confirmacion', 302);
};

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const token = url.searchParams.get('token') ?? '';
  if (token) guardarToken(cookies, token.slice(0, 200));
  return redirect('/talleres/confirmacion', 302);
};
