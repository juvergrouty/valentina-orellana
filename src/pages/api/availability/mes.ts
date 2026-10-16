import type { APIRoute } from 'astro';
import { calcularDisponibilidad } from '../../../lib/disponibilidad';
import { todayCL } from '../../../lib/dateUtils';

export const prerender = false;

// GET /api/availability/mes?fechas=YYYY-MM-DD,YYYY-MM-DD,…&service_id=…&duration=…&modality=…
// Horas libres de varios días de una vez (16 oct 2026): el calendario de
// /agenda marca como "Sin horas" los días que no tienen ninguna, para que la
// paciente no tenga que probar día por día (igual puede tocarlos y pedir
// sobrecupo). Mismo cálculo que /api/availability (src/lib/disponibilidad.ts);
// al elegir el día se vuelve a consultar.
const MAX_FECHAS = 45;
const EN_PARALELO = 8;

export const GET: APIRoute = async ({ url }) => {
  const serviceId = url.searchParams.get('service_id');
  // Solo con servicio y fechas entre hoy y ~3 meses (lo que muestra el calendario).
  const hoy = todayCL();
  const tope = new Date(Date.parse(hoy + 'T12:00:00Z') + 95 * 86400000).toISOString().slice(0, 10);
  const fechas = [...new Set((url.searchParams.get('fechas') ?? '').split(','))]
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f) && f >= hoy && f <= tope)
    .slice(0, MAX_FECHAS);
  if (!serviceId) return new Response(JSON.stringify({ dias: {} }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const duration = parseInt(url.searchParams.get('duration') ?? '0') || null;
  const modality = url.searchParams.get('modality');

  const dias: Record<string, string[]> = {};
  for (let i = 0; i < fechas.length; i += EN_PARALELO) {
    await Promise.all(fechas.slice(i, i + EN_PARALELO).map(async (date) => {
      try {
        const r = await calcularDisponibilidad({ date, serviceId, duration, modality });
        // Con error no se informa el día: el calendario lo deja como está.
        if (!('error' in r)) dias[date] = r.slots;
      } catch { /* día sin dato: no se marca */ }
    }));
  }

  return new Response(JSON.stringify({ dias }), {
    status: 200,
    // Sin caché (Valentina, 16 oct 2026): una hora tomada debe dejar de verse al instante.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
