import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

// Limpiar reservas pending_payment con más de 30 min — no bloqueante
function cleanupExpiredPending() {
  const expiry = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  supabase
    .from('bookings')
    .delete()
    .eq('status', 'pending_payment')
    .lt('created_at', expiry)
    .then(({ error }) => {
      if (error) console.warn('[availability] cleanup error:', error.message);
    });
}

export const GET: APIRoute = async ({ url }) => {
  // Limpiar reservas expiradas en segundo plano
  cleanupExpiredPending();

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

  const dayOfWeek = requested.getDay();

  // Cargar en paralelo: slots, fecha bloqueada, reservas del día y settings
  const [
    { data: slots, error: slotsError },
    { data: blockedDate },
    { data: booked, error: bookedError },
    { data: settingsRows },
  ] = await Promise.all([
    supabase.from('availability_slots').select('start_time').eq('day_of_week', dayOfWeek).eq('active', true).order('start_time'),
    supabase.from('blocked_dates').select('id').eq('date', dateParam).maybeSingle(),
    // Solo bloquear: confirmadas + pending_payment creadas hace menos de 30 min
    supabase.from('bookings')
      .select('session_time')
      .eq('session_date', dateParam)
      .neq('status', 'cancelled')
      .or(`status.eq.confirmed,and(status.eq.pending_payment,created_at.gte.${new Date(Date.now() - 30 * 60 * 1000).toISOString()})`),
    supabase.from('settings').select('key, value'),
  ]);

  if (slotsError) return new Response(JSON.stringify({ error: 'Error consultando disponibilidad.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  if (!slots || slots.length === 0) return new Response(JSON.stringify({ slots: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (blockedDate) return new Response(JSON.stringify({ slots: [], blocked: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (bookedError) return new Response(JSON.stringify({ error: 'Error consultando reservas.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  // Duración total = sesión + preparación (desde settings o por defecto 55+20=75)
  const cfg: Record<string, string> = {};
  (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { cfg[key] = value; });
  const sessionMin = parseInt(cfg['session_duration_min'] ?? '55');
  const prepMin    = parseInt(cfg['prep_duration_min']    ?? '20');
  const totalMin   = sessionMin + prepMin;

  // Convertir reservas a minutos desde medianoche
  const bookedMinutes = (booked ?? []).map((b) => {
    const [h, m] = b.session_time.slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  });

  const nowHour  = new Date();
  const isToday  = dateParam === nowHour.toISOString().slice(0, 10);
  const nowMin   = nowHour.getHours() * 60 + nowHour.getMinutes() + 60; // +60 min buffer

  const available = slots
    .map((s) => s.start_time.slice(0, 5))
    .filter((time) => {
      const [h, m] = time.split(':').map(Number);
      const slotMin = h * 60 + m;

      // Filtrar horas pasadas si es hoy
      if (isToday && slotMin <= nowMin) return false;

      // Bloquear si el slot cae dentro de la duración de una reserva existente
      // O si una reserva existente caería dentro de la duración de este slot
      for (const bMin of bookedMinutes) {
        // Slot dentro del bloque de una reserva: bMin <= slotMin < bMin + totalMin
        if (slotMin >= bMin && slotMin < bMin + totalMin) return false;
        // Reserva existente dentro del bloque de este slot: bMin >= slotMin && bMin < slotMin + totalMin
        if (bMin >= slotMin && bMin < slotMin + totalMin) return false;
      }

      return true;
    });

  return new Response(JSON.stringify({ slots: available }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
