import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { todayCL } from '../../../lib/dateUtils';
import { leerHorasExtra, aplicaA } from '../../../lib/horasExtra';

export const prerender = false;

// GET /api/availability/summary?service_id=XXX
// Devuelve los días de la semana que tienen horario para ese servicio y las
// fechas bloqueadas (feriados/vacaciones), para deshabilitarlos en el calendario.
export const GET: APIRoute = async ({ url }) => {
  const serviceId = url.searchParams.get('service_id');

  // Días de la semana con franjas activas del servicio (con degradación si falta service_id)
  async function fetchWeekdays() {
    let q = supabase.from('availability_slots').select('day_of_week, service_id').eq('active', true);
    if (serviceId) q = q.eq('service_id', serviceId);
    const res = await q;
    if (res.error?.code === '42703') {
      return await supabase.from('availability_slots').select('day_of_week').eq('active', true);
    }
    return res;
  }

  const today = todayCL();
  const [{ data: slotsData }, { data: blk }, { data: dayBlocks }] = await Promise.all([
    fetchWeekdays(),
    supabase.from('blocked_dates').select('date').gte('date', today),
    // Bloqueos de día completo hechos con "Bloquear hora" (tabla blocked_slots)
    supabase.from('blocked_slots').select('date_from, date_to, time_from, time_to, all_day').gte('date_to', today),
  ]);

  const weekdays = Array.from(new Set((slotsData ?? []).map((s: { day_of_week: number }) => s.day_of_week)));
  const blocked  = (blk ?? []).map((b: { date: string }) => b.date);
  for (const b of (dayBlocks ?? []) as { date_from: string; date_to: string; time_from: string | null; time_to: string | null; all_day: boolean | null }[]) {
    if (!(b.all_day || !b.time_from || !b.time_to)) continue; // con horario: lo resuelve /api/availability
    const [y, m, d] = (b.date_from > today ? b.date_from : today).split('-').map(Number);
    for (let i = 0; i < 366; i++) {
      const iso = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
      if (iso > b.date_to) break;
      blocked.push(iso);
    }
  }

  // Fechas con horas extra para este servicio: se habilitan en el calendario
  // aunque ese día de la semana no tenga horario normal.
  let extra: string[] = [];
  if (serviceId) {
    try {
      const { data: svc } = await supabase.from('services_catalog').select('modality').eq('id', serviceId).maybeSingle();
      extra = [...new Set((await leerHorasExtra()).filter(h => !h.quitar && h.fecha >= today && aplicaA(h, svc?.modality, serviceId)).map(h => h.fecha))];
    } catch { /* sin horas extra */ }
  }

  return new Response(JSON.stringify({ weekdays, blocked, extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
