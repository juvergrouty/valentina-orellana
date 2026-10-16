import type { APIRoute } from 'astro';
import { calcularDisponibilidad } from '../../../lib/disponibilidad';

export const prerender = false;

// GET /api/availability/mes?fechas=YYYY-MM-DD,YYYY-MM-DD,…&service_id=…&duration=…&modality=…
// Horas libres de varios días de una vez (16 oct 2026): el calendario de
// /agenda marca como "Sin horas" los días que no tienen ninguna, para que la
// paciente no tenga que probar día por día (igual puede tocarlos y pedir
// sobrecupo). Mismo cálculo que /api/availability (src/lib/disponibilidad.ts);
// al elegir el día se vuelve a consultar, así que esto solo orienta.
const MAX_FECHAS = 45;
const EN_PARALELO = 8;

export const GET: APIRoute = async ({ url }) => {
  const fechas = [...new Set((url.searchParams.get('fechas') ?? '').split(','))]
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .slice(0, MAX_FECHAS);
  const serviceId = url.searchParams.get('service_id');
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
    // Caché corta en el CDN: muchas pacientes mirando el mismo mes no
    // multiplican las consultas a Google Calendar.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
  });
};
