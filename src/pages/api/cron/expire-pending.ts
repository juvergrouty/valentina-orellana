import type { APIRoute } from 'astro';
import { expireStaleBookings } from '../../../lib/expireBooking';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Se llama cada pocos minutos (ver .github/workflows/frequent-cron.yml — Vercel Hobby
// solo permite cron diario, así que la frecuencia real la da GitHub Actions, gratis).
// En la práctica este cron es solo una red de seguridad: la limpieza real de reservas
// `pending_payment` vencidas ya ocurre en cada carga del calendario (availability.ts)
// y en cada intento de reserva (bookings.ts) — ambos llaman a la misma
// expireStaleBookings() de este cron, así que casi siempre se adelantan a este.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  // Falla cerrado: si CRON_SECRET no está configurado, nadie puede llamar al cron.
  {
    const auth = request.headers.get('authorization');
    if (!secret || auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }

  const { claimed } = await expireStaleBookings();

  return json({ ok: true, released: claimed });
};
