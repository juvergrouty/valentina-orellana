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

  // duration_min del servicio que el usuario quiere reservar (para check inverso)
  const newDuration = parseInt(url.searchParams.get('duration') ?? '0') || null;

  // Modalidad solicitada: 'online' | 'presencial' (si no viene, no se filtra por modalidad)
  const reqModalityRaw = url.searchParams.get('modality');
  const reqModality = ['online', 'presencial'].includes(reqModalityRaw ?? '') ? reqModalityRaw : null;

  // Trae los slots del día. Intenta con la columna 'modality'; si aún no existe
  // (migración no aplicada), reintenta sin ella para no romper la disponibilidad.
  async function fetchSlots() {
    const withMod = await supabase.from('availability_slots')
      .select('start_time, modality').eq('day_of_week', dayOfWeek).eq('active', true).order('start_time');
    if (withMod.error?.code === '42703') {
      return await supabase.from('availability_slots')
        .select('start_time').eq('day_of_week', dayOfWeek).eq('active', true).order('start_time');
    }
    return withMod;
  }

  // Cargar en paralelo: slots, fecha bloqueada, reservas del día y prep_duration_min
  const [
    { data: slots, error: slotsError },
    { data: blockedDate },
    { data: booked, error: bookedError },
    { data: settingsRows },
  ] = await Promise.all([
    fetchSlots(),
    supabase.from('blocked_dates').select('id').eq('date', dateParam).maybeSingle(),
    supabase.from('bookings')
      .select('session_time, duration_min')
      .eq('session_date', dateParam)
      .neq('status', 'cancelled')
      .or(`status.eq.confirmed,and(status.eq.pending_payment,created_at.gte.${new Date(Date.now() - 30 * 60 * 1000).toISOString()})`),
    supabase.from('settings').select('key, value'),
  ]);

  if (slotsError) return new Response(JSON.stringify({ error: 'Error consultando disponibilidad.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  if (!slots || slots.length === 0) return new Response(JSON.stringify({ slots: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (blockedDate) return new Response(JSON.stringify({ slots: [], blocked: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (bookedError) return new Response(JSON.stringify({ error: 'Error consultando reservas.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  const cfg: Record<string, string> = {};
  (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { cfg[key] = value; });
  const prepMin = parseInt(cfg['prep_duration_min'] ?? '20');

  // Reservas existentes con su duración real (fallback 50 min para bookings antiguos sin duration_min)
  const bookedSessions = (booked ?? []).map((b) => {
    const [h, m] = b.session_time.slice(0, 5).split(':').map(Number);
    return { startMin: h * 60 + m, duration: b.duration_min ?? 50 };
  });

  const nowHour = new Date();
  const isToday = dateParam === nowHour.toISOString().slice(0, 10);
  const nowMin  = nowHour.getHours() * 60 + nowHour.getMinutes() + 60; // +60 min buffer

  const available = slots
    // Filtrar por modalidad: se aceptan los slots de la modalidad pedida y los 'ambos'.
    // Si el slot no tiene modalidad (columna vieja) o no se pidió modalidad, pasa igual.
    .filter((s: { modality?: string }) =>
      !reqModality || !s.modality || s.modality === 'ambos' || s.modality === reqModality)
    .map((s) => s.start_time.slice(0, 5))
    .filter((time) => {
      const [h, m] = time.split(':').map(Number);
      const slotMin = h * 60 + m;

      if (isToday && slotMin <= nowMin) return false;

      for (const { startMin: bMin, duration: bDur } of bookedSessions) {
        // Este slot cae dentro de la ventana de una reserva existente
        if (slotMin >= bMin && slotMin < bMin + bDur + prepMin) return false;
        // Una reserva existente cae dentro de la ventana de este slot (si se conoce la duración nueva)
        if (newDuration && bMin >= slotMin && bMin < slotMin + newDuration + prepMin) return false;
      }

      return true;
    });

  return new Response(JSON.stringify({ slots: available }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
