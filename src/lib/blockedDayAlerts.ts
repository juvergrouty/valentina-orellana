import { supabase } from './supabase';
import { todayCL } from './dateUtils';

// Aviso anticipado de días cerrados (feriados, vacaciones: todo lo que está en
// blocked_dates) — a pedido de Valentina (3 oct 2026): quiere saber con
// tiempo cuántas horas pierde ese día, separadas en presenciales y online,
// para abrir horas en otro día de esa semana y no perder atenciones.
// Se muestra en todas las páginas del admin desde DIAS_ANTES días antes.

export interface BlockedDayAlert {
  date:       string;   // YYYY-MM-DD
  label:      string;   // "lunes 12 oct"
  reason:     string | null;
  presencial: string[]; // horas que se pierden, "08:00"
  online:     string[];
  agendadas:  number;   // sesiones ya agendadas ese día (habría que moverlas)
}

const DIAS_ANTES = 21;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export async function getBlockedDayAlerts(): Promise<BlockedDayAlert[]> {
  const today = todayCL();
  const until = addDays(today, DIAS_ANTES);

  const { data: blocked } = await supabase.from('blocked_dates')
    .select('date, reason').gte('date', today).lte('date', until).order('date');
  if (!blocked?.length) return [];

  // Horario semanal de los servicios que se ofrecen en la web.
  const [{ data: services }, { data: slots }, { data: bookings }] = await Promise.all([
    supabase.from('services_catalog').select('id, modality').eq('visible', true),
    supabase.from('availability_slots').select('day_of_week, start_time, service_id').eq('active', true),
    supabase.from('bookings').select('session_date')
      .in('session_date', blocked.map((b: { date: string }) => b.date))
      .in('status', ['confirmed', 'pending_payment']),
  ]);

  const modalityById = new Map<string, string>((services ?? []).map((s: { id: string; modality: string }) => [s.id, s.modality]));

  return blocked.map((b: { date: string; reason: string | null }) => {
    const dow = weekday(b.date);
    const presencial = new Set<string>();
    const online = new Set<string>();
    for (const s of (slots ?? []) as { day_of_week: number; start_time: string; service_id: string | null }[]) {
      if (s.day_of_week !== dow || !s.service_id) continue;
      const mod = modalityById.get(s.service_id);
      if (!mod) continue; // servicio oculto o inexistente: no se ofrece en la web
      const hora = s.start_time.slice(0, 5);
      if (mod === 'presencial' || mod === 'ambos') presencial.add(hora);
      if (mod === 'online' || mod === 'ambos') online.add(hora);
    }
    const [, m, d] = b.date.split('-').map(Number);
    return {
      date: b.date,
      label: `${DIAS[dow]} ${d} ${MESES[m - 1]}`,
      reason: b.reason,
      presencial: [...presencial].sort(),
      online: [...online].sort(),
      agendadas: (bookings ?? []).filter((x: { session_date: string }) => x.session_date === b.date).length,
    };
  });
}
