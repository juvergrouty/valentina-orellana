import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

// GET /api/availability?date=YYYY-MM-DD
// Devuelve los slots disponibles para la fecha solicitada
export const GET: APIRoute = async ({ url }) => {
  const dateParam = url.searchParams.get('date');

  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return new Response(JSON.stringify({ error: 'Parámetro date inválido. Usa YYYY-MM-DD.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // No permitir fechas pasadas
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const requested = new Date(dateParam + 'T00:00:00');
  if (requested < today) {
    return new Response(JSON.stringify({ slots: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // día de semana (0=domingo…6=sábado)
  const dayOfWeek = requested.getDay();

  // 1. Obtener slots activos para ese día de semana
  const { data: slots, error: slotsError } = await supabase
    .from('availability_slots')
    .select('start_time')
    .eq('day_of_week', dayOfWeek)
    .eq('active', true)
    .order('start_time');

  if (slotsError) {
    return new Response(JSON.stringify({ error: 'Error consultando disponibilidad.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!slots || slots.length === 0) {
    return new Response(JSON.stringify({ slots: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Verificar si la fecha está bloqueada
  const { data: blockedDate } = await supabase
    .from('blocked_dates')
    .select('id')
    .eq('date', dateParam)
    .maybeSingle();

  if (blockedDate) {
    return new Response(JSON.stringify({ slots: [], blocked: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Obtener slots ya reservados para esa fecha
  const { data: booked, error: bookedError } = await supabase
    .from('bookings')
    .select('session_time')
    .eq('session_date', dateParam)
    .neq('status', 'cancelled');

  if (bookedError) {
    return new Response(JSON.stringify({ error: 'Error consultando reservas.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bookedTimes = new Set((booked ?? []).map((b) => b.session_time.slice(0, 5)));

  // 3. Filtrar: quitar los ya ocupados
  // Si es hoy, también quitar horas que ya pasaron
  const nowHour = new Date();
  const isToday = dateParam === nowHour.toISOString().slice(0, 10);

  const available = slots
    .map((s) => s.start_time.slice(0, 5))
    .filter((time) => {
      if (bookedTimes.has(time)) return false;
      if (isToday) {
        const [h, m] = time.split(':').map(Number);
        const slotMinutes = h * 60 + m;
        const nowMinutes = nowHour.getHours() * 60 + nowHour.getMinutes() + 60; // +60 min buffer
        if (slotMinutes <= nowMinutes) return false;
      }
      return true;
    });

  return new Response(JSON.stringify({ slots: available }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
