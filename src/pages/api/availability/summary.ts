import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

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

  const today = new Date().toISOString().slice(0, 10);
  const [{ data: slotsData }, { data: blk }] = await Promise.all([
    fetchWeekdays(),
    supabase.from('blocked_dates').select('date').gte('date', today),
  ]);

  const weekdays = Array.from(new Set((slotsData ?? []).map((s: { day_of_week: number }) => s.day_of_week)));
  const blocked  = (blk ?? []).map((b: { date: string }) => b.date);

  return new Response(JSON.stringify({ weekdays, blocked }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
