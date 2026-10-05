import { supabase } from './supabase';
import { todayCL } from './dateUtils';
import { leerHorasExtra } from './horasExtra';

// Aviso anticipado de días y horas cerradas — a pedido de Valentina (3 oct
// 2026): quiere saber con tiempo cuántas horas pierde, separadas en
// presenciales y online y por servicio, para abrir horas en otro día de esa
// semana y no perder atenciones. Incluye:
//   - días completos cerrados (blocked_dates: feriados, vacaciones, etc.)
//   - bloqueos de horas o de día completo hechos con "Bloquear hora" (blocked_slots)
// Se muestra en todas las páginas del admin desde DIAS_ANTES días antes
// (Valentina pidió 1 a 2 semanas).

export interface BlockedDayAlert {
  date:       string;   // YYYY-MM-DD
  label:      string;   // "lunes 12 oct"
  rango:      string | null; // "10:00–13:00" si es un bloqueo de horas; null = día completo
  reason:     string | null;
  presencial: string[]; // horas que se pierden, "08:00"
  online:     string[];
  serviciosPresencial: string[]; // servicios afectados (nombres del catálogo)
  serviciosOnline:     string[];
  agendadas:  number;   // sesiones ya agendadas en ese día/rango (habría que moverlas)
  extrasSemana: number; // horas que ya abriste en días específicos de esa semana (para compensar)
}

const DIAS_ANTES = 14;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIA_COMPLETO = { from: 0, to: 24 * 60 };

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const toMin = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };

interface Cierre { date: string; reason: string | null; from: number; to: number; rango: string | null }

export async function getBlockedDayAlerts(): Promise<BlockedDayAlert[]> {
  const today = todayCL();
  const until = addDays(today, DIAS_ANTES);

  const [{ data: blockedDays }, { data: slotBlocks }] = await Promise.all([
    supabase.from('blocked_dates').select('date, reason').gte('date', today).lte('date', until).order('date'),
    supabase.from('blocked_slots').select('date_from, date_to, time_from, time_to, all_day, label')
      .lte('date_from', until).gte('date_to', today),
  ]);

  const cierres: Cierre[] = (blockedDays ?? []).map((b: { date: string; reason: string | null }) =>
    ({ date: b.date, reason: b.reason, ...DIA_COMPLETO, rango: null }));
  for (const b of (slotBlocks ?? []) as { date_from: string; date_to: string; time_from: string | null; time_to: string | null; all_day: boolean | null; label: string | null }[]) {
    const diaCompleto = b.all_day || !b.time_from || !b.time_to;
    for (let d = b.date_from < today ? today : b.date_from; d <= b.date_to && d <= until; d = addDays(d, 1)) {
      if (cierres.some(c => c.date === d && c.rango === null)) continue; // el día ya está cerrado completo
      cierres.push(diaCompleto
        ? { date: d, reason: b.label, ...DIA_COMPLETO, rango: null }
        : { date: d, reason: b.label, from: toMin(b.time_from!), to: toMin(b.time_to!), rango: `${b.time_from!.slice(0, 5)}–${b.time_to!.slice(0, 5)}` });
    }
  }
  if (!cierres.length) return [];
  cierres.sort((a, b) => a.date.localeCompare(b.date) || a.from - b.from);

  // Horario semanal de los servicios que se ofrecen en la web, y sesiones agendadas.
  const fechas = [...new Set(cierres.map(c => c.date))];
  const extras = (await leerHorasExtra().catch(() => [])).filter(h => !h.quitar);
  // Lunes a domingo de la semana de una fecha.
  const semanaDe = (iso: string) => { const dow = weekday(iso); const lunes = addDays(iso, dow === 0 ? -6 : 1 - dow); return [lunes, addDays(lunes, 6)]; };
  const [{ data: services }, { data: slots }, { data: bookings }] = await Promise.all([
    supabase.from('services_catalog').select('id, modality, name, duration_min').eq('visible', true),
    supabase.from('availability_slots').select('day_of_week, start_time, service_id').eq('active', true),
    supabase.from('bookings').select('session_date, session_time, duration_min')
      .in('session_date', fechas)
      .in('status', ['confirmed', 'pending_payment']),
  ]);

  type Svc = { id: string; modality: string; name: string; duration_min: number | null };
  const svcById = new Map<string, Svc>((services ?? []).map((s: Svc) => [s.id, s]));

  return cierres.map((c) => {
    const dow = weekday(c.date);
    const presencial = new Set<string>();
    const online = new Set<string>();
    const svcPres = new Set<string>();
    const svcOnl = new Set<string>();
    for (const s of (slots ?? []) as { day_of_week: number; start_time: string; service_id: string | null }[]) {
      if (s.day_of_week !== dow || !s.service_id) continue;
      const svc = svcById.get(s.service_id);
      if (!svc) continue; // servicio oculto o inexistente: no se ofrece en la web
      const ini = toMin(s.start_time);
      const fin = ini + (svc.duration_min ?? 50);
      if (!(ini < c.to && fin > c.from)) continue; // la hora no cae en el bloqueo
      const hora = s.start_time.slice(0, 5);
      if (svc.modality === 'presencial' || svc.modality === 'ambos') { presencial.add(hora); svcPres.add(svc.name); }
      if (svc.modality === 'online' || svc.modality === 'ambos') { online.add(hora); svcOnl.add(svc.name); }
    }
    const agendadas = (bookings ?? []).filter((x: { session_date: string; session_time: string; duration_min: number | null }) => {
      if (x.session_date !== c.date) return false;
      const ini = toMin(x.session_time);
      return ini < c.to && ini + (x.duration_min ?? 50) > c.from;
    }).length;
    const [, m, d] = c.date.split('-').map(Number);
    const [lun, dom] = semanaDe(c.date);
    const extrasSemana = new Set(extras.filter(h => h.fecha >= lun && h.fecha <= dom && h.fecha !== c.date).map(h => `${h.fecha} ${h.hora}`)).size;
    return {
      extrasSemana,
      date: c.date,
      label: `${DIAS[dow]} ${d} ${MESES[m - 1]}`,
      rango: c.rango,
      reason: c.reason,
      presencial: [...presencial].sort(),
      online: [...online].sort(),
      serviciosPresencial: [...svcPres].filter(Boolean).sort(),
      serviciosOnline: [...svcOnl].filter(Boolean).sort(),
      agendadas,
    };
  });
}

/** Para el aviso de feriados: por cada fecha, cuántas horas de la agenda web
 *  caen ese día (presencial / online) y cuántas sesiones ya hay agendadas. */
export async function resumenDiaCompleto(fechas: string[]): Promise<Record<string, { presencial: number; online: number; agendadas: number }>> {
  if (!fechas.length) return {};
  const [{ data: services }, { data: slots }, { data: bookings }] = await Promise.all([
    supabase.from('services_catalog').select('id, modality').eq('visible', true),
    supabase.from('availability_slots').select('day_of_week, start_time, service_id').eq('active', true),
    supabase.from('bookings').select('session_date').in('session_date', fechas).in('status', ['confirmed', 'pending_payment']),
  ]);
  const mod = new Map((services ?? []).map((s: { id: string; modality: string }) => [s.id, s.modality]));
  const out: Record<string, { presencial: number; online: number; agendadas: number }> = {};
  for (const f of fechas) {
    const dow = weekday(f);
    const pres = new Set<string>(), onl = new Set<string>();
    for (const s of (slots ?? []) as { day_of_week: number; start_time: string; service_id: string | null }[]) {
      if (s.day_of_week !== dow || !s.service_id || !mod.has(s.service_id)) continue;
      const m = mod.get(s.service_id);
      if (m === 'presencial' || m === 'ambos') pres.add(s.start_time.slice(0, 5));
      if (m === 'online' || m === 'ambos') onl.add(s.start_time.slice(0, 5));
    }
    out[f] = { presencial: pres.size, online: onl.size, agendadas: (bookings ?? []).filter((b: { session_date: string }) => b.session_date === f).length };
  }
  return out;
}
