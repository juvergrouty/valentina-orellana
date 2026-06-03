import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * POST /api/flow/return
 *
 * Flow redirige al usuario aquí después del pago mediante un POST form.
 * Este endpoint extrae el token y redirige a /confirmacion con GET,
 * evitando el error "Cross-site POST form submissions are forbidden" de Astro.
 */
export const POST: APIRoute = async ({ request }) => {
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

  const location = token ? `/confirmacion?token=${encodeURIComponent(token)}` : '/confirmacion';

  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
};

// También manejar GET por si Flow redirige con parámetros en la URL
export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get('token') ?? '';
  const location = token ? `/confirmacion?token=${encodeURIComponent(token)}` : '/confirmacion';
  return new Response(null, { status: 302, headers: { Location: location } });
};
