import type { APIRoute } from 'astro';
import { expireStaleBookings } from '../../lib/expireBooking';
import { logError } from '../../lib/logger';
import { calcularDisponibilidad } from '../../lib/disponibilidad';

export const prerender = false;

// GET /api/availability?date=YYYY-MM-DD&service_id=…&duration=…&modality=…
// El cálculo vive en src/lib/disponibilidad.ts (el mismo que usan la reserva,
// reagendar, recuperar y el aviso de pago de Flow).
export const GET: APIRoute = async ({ url }) => {
  // Liberar reservas pending_payment vencidas (>30 min) antes de calcular qué
  // horarios están ocupados (correo + link de recuperación, ver expireBooking).
  try { await expireStaleBookings(url.origin); }
  catch (e) { await logError('availability/expirar', 'Falló la limpieza de reservas vencidas', { error: e instanceof Error ? e.message : String(e) }); }

  const r = await calcularDisponibilidad({
    date:      url.searchParams.get('date') ?? '',
    serviceId: url.searchParams.get('service_id'),
    duration:  parseInt(url.searchParams.get('duration') ?? '0') || null,
    modality:  url.searchParams.get('modality'),
  });
  const status = 'error' in r ? r.status : 200;
  const body = 'error' in r ? { error: r.error } : r;
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};
