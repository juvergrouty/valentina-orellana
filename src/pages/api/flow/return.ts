import type { APIRoute, AstroCookies } from 'astro';

export const prerender = false;

/**
 * POST /api/flow/return
 *
 * Flow redirige al usuario aquí después del pago mediante un POST form.
 * Este endpoint extrae el token y redirige a /confirmacion con GET,
 * evitando el error "Cross-site POST form submissions are forbidden" de Astro.
 *
 * Privacidad (8 oct 2026): el token ya NO va en la URL de /confirmacion. Con
 * él cualquiera podía ver el nombre de la paciente, la sesión, la fecha y el
 * monto, y esa URL la leen GTM (GA4, Google Ads, Meta). Ahora viaja en una
 * cookie corta, solo para /confirmacion, y la URL queda limpia.
 */
const COOKIE_PAGO = 'vo_pago'; // la misma que lee src/pages/confirmacion.astro

function guardarToken(cookies: AstroCookies, token: string) {
  cookies.set(COOKIE_PAGO, token, {
    path:     '/confirmacion',
    httpOnly: true,
    secure:   import.meta.env.PROD,
    sameSite: 'lax', // 'lax': la cookie viaja en la navegación de vuelta desde Flow
    maxAge:   60 * 60, // 1 hora: alcanza para ver (y recargar) la confirmación
  });
}

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  let token = '';

  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      token = (form.get('token') as string) ?? '';
    } else {
      const text = await request.text();
      token = new URLSearchParams(text).get('token') ?? '';
    }
  } catch {
    // Si no se puede leer el body, redirigir sin token
  }

  if (token) guardarToken(cookies, token);
  return redirect('/confirmacion', 302);
};

// También manejar GET por si Flow redirige con parámetros en la URL
export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const token = url.searchParams.get('token') ?? '';
  if (token) guardarToken(cookies, token);
  return redirect('/confirmacion', 302);
};
