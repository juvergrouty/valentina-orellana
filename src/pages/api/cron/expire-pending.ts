import type { APIRoute } from 'astro';
import { cronAutorizado } from '../../../lib/cronAuth';
import { expireStaleBookings } from '../../../lib/expireBooking';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Se llama cada pocos minutos (ver .github/workflows/frequent-cron.yml — Vercel Hobby
// solo permite cron diario, así que la frecuencia real la da Supabase (pg_cron cada 5 min; GitHub Actions queda de respaldo manual), gratis).
// En la práctica este cron es solo una red de seguridad: la limpieza real de reservas
// `pending_payment` vencidas ya ocurre en cada carga del calendario (availability.ts)
// y en cada intento de reserva (bookings.ts) — ambos llaman a la misma
// expireStaleBookings() de este cron, así que casi siempre se adelantan a este.
export const GET: APIRoute = async ({ request }) => {
  // Falla cerrado: CRON_SECRET o la clave interna de Supabase (ver cronAuth.ts).
  if (!(await cronAutorizado(request))) return new Response('Unauthorized', { status: 401 });

  // El link "Pagar y mantener mi hora" se arma con el dominio real de esta
  // petición (www.valentinaorellana.cl). Sin esto usaba PUBLIC_SITE_URL, que en
  // Vercel apunta a *.vercel.app (ver expireBooking.ts).
  const { claimed } = await expireStaleBookings(new URL(request.url).origin);

  return json({ ok: true, released: claimed });
};
