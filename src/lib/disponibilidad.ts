import { supabase } from './supabase';
import { nowCL } from './dateUtils';
import { logError } from './logger';
import { leerHorasExtra, aplicaA, estaQuitada } from './horasExtra';
import { getValidAccessToken } from './syncCalendar';
import { busyIntervals } from './googleCalendar';

// Cálculo ÚNICO de las horas disponibles de un día (re-auditoría 4 oct 2026).
// Antes vivía solo en /api/availability y el servidor no lo volvía a revisar al
// reservar: solo comprobaba que no hubiera otra reserva a la MISMA hora exacta,
// así que podían quedar sesiones cruzadas (10:00 de un servicio y 10:30 de
// otro) o reservas en horas bloqueadas / ocupadas en Google Calendar. Ahora lo
// usan la agenda (GET /api/availability), la reserva, reagendar, recuperar y el
// aviso de pago de Flow.

export interface ConsultaDisponibilidad {
  date: string;                 // YYYY-MM-DD
  serviceId?: string | null;
  duration?: number | null;     // duración de la sesión nueva (si no, la del servicio)
  modality?: string | null;     // 'online' | 'presencial' elegida por la paciente
  excluirIds?: string[];        // reservas que no cuentan como ocupadas (la propia al reagendar/recuperar)
  sinAnticipacion?: boolean;    // no aplicar el margen de 60 min para hoy (pago ya hecho)
}

export type ResultadoDisponibilidad =
  | { slots: string[]; blocked?: boolean }
  | { error: string; status: number };

const MAX_DIAS_ADELANTE = 365; // tope duro aunque el servicio no tenga "días visibles"

export async function calcularDisponibilidad(c: ConsultaDisponibilidad): Promise<ResultadoDisponibilidad> {
  const dateParam = c.date;
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return { error: 'Parámetro date inválido. Usa YYYY-MM-DD.', status: 400 };
  }

  // No permitir fechas pasadas
  const today = nowCL();
  today.setHours(0, 0, 0, 0);
  const requested = new Date(dateParam + 'T00:00:00');
  if (Number.isNaN(requested.getTime()) || requested < today) return { slots: [] };
  const tope = new Date(today);
  tope.setDate(tope.getDate() + MAX_DIAS_ADELANTE);
  if (requested > tope) return { slots: [] };

  const dayOfWeek = requested.getDay();
  const newDuration = c.duration && c.duration > 0 ? c.duration : null;
  const serviceId = c.serviceId || null;
  const reqModality = ['online', 'presencial'].includes(c.modality ?? '') ? c.modality! : null;
  const excluir = new Set(c.excluirIds ?? []);

  // Trae los slots del día. Prioriza service_id; degrada si faltan columnas nuevas.
  async function fetchSlots() {
    let q = supabase.from('availability_slots')
      .select('start_time, modality, service_id').eq('day_of_week', dayOfWeek).eq('active', true);
    if (serviceId) q = q.eq('service_id', serviceId);
    const res = await q.order('start_time');
    if (res.error?.code === '42703') {
      // columnas nuevas (service_id/modality) no existen aún → query mínima
      return await supabase.from('availability_slots')
        .select('start_time').eq('day_of_week', dayOfWeek).eq('active', true).order('start_time');
    }
    return res;
  }

  // Config del servicio pedido (duración/descanso/días visibles), con degradación.
  async function fetchServiceCfg() {
    if (!serviceId) return { data: null };
    const full = await supabase.from('services_catalog')
      .select('duration_min, break_min, booking_window_days, modality').eq('id', serviceId).maybeSingle();
    if (full.error?.code === '42703') {
      return await supabase.from('services_catalog').select('duration_min').eq('id', serviceId).maybeSingle();
    }
    return full;
  }

  // Reservas del día que cuentan como "ocupadas": confirmadas, pendientes de pago
  // recientes (<30 min), o pendientes creadas por la propia admin (esas se pueden
  // quedar pendientes mucho más tiempo — nunca se auto-eliminan — así que siguen
  // bloqueando el horario mientras existan). Se degrada si la columna no existe aún.
  async function fetchBooked() {
    const recentCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const res = await supabase.from('bookings')
      .select('id, session_time, duration_min')
      .eq('session_date', dateParam)
      .neq('status', 'cancelled')
      // PagoSinAviso: Flow dice que está pagada pero su aviso no llega; la hora
      // sigue siendo de esa paciente (no se ofrece a otras).
      .or(`status.eq.confirmed,created_by_admin.eq.true,and(status.eq.pending_payment,created_at.gte.${recentCutoff}),and(status.eq.pending_payment,notes.ilike.*ComprobanteTransferencia*),and(status.eq.pending_payment,notes.ilike.*PagoSinAviso*)`);
    if (res.error?.code === '42703') {
      return await supabase.from('bookings')
        .select('id, session_time, duration_min')
        .eq('session_date', dateParam)
        .neq('status', 'cancelled')
        .or(`status.eq.confirmed,and(status.eq.pending_payment,created_at.gte.${recentCutoff})`);
    }
    return res;
  }

  // Cargar en paralelo: slots, fecha bloqueada, reservas del día, settings, config del servicio
  const [
    { data: slots, error: slotsError },
    { data: blockedDate },
    { data: booked, error: bookedError },
    { data: settingsRows },
    { data: svcCfg },
  ] = await Promise.all([
    fetchSlots(),
    supabase.from('blocked_dates').select('id').eq('date', dateParam).maybeSingle(),
    fetchBooked(),
    supabase.from('settings').select('key, value'),
    fetchServiceCfg(),
  ]);

  // Bloqueos de horas ("Bloquear hora" en el calendario del panel, tabla
  // blocked_slots). Un bloqueo de día completo cierra el día; uno con horario
  // quita las horas que se cruzan con ese rango. Si la consulta falla, no se
  // bloquea nada (se registra el error).
  const { data: slotBlocks, error: slotBlocksErr } = await supabase.from('blocked_slots')
    .select('time_from, time_to, all_day')
    .lte('date_from', dateParam).gte('date_to', dateParam);
  if (slotBlocksErr) await logError('availability/bloqueos', 'No se pudieron leer los bloqueos de horas', { error: slotBlocksErr.message });
  const toMin = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
  const blockRanges = (slotBlocks ?? []).map((b: { time_from: string | null; time_to: string | null; all_day: boolean | null }) =>
    (b.all_day || !b.time_from || !b.time_to) ? { from: 0, to: 24 * 60 } : { from: toMin(b.time_from), to: toMin(b.time_to) });
  // Eventos del Google Calendar de Valentina (Valentina, 4 oct 2026): si tiene
  // algo agendado en Google, ninguna paciente puede reservar en esa hora (ella
  // sí puede, desde el panel). Se consulta la API FreeBusy para este día. Si
  // Google no responde, no se bloquea nada (se registra el error) para no
  // dejar la agenda vacía por una falla externa.
  let busyRanges: { from: number; to: number }[] = [];
  try {
    const auth = await getValidAccessToken();
    if (auth) {
      const [yy, mm, dd] = dateParam.split('-').map(Number);
      // Ventana amplia en UTC que cubre el día completo en Chile (UTC-3 / UTC-4).
      const timeMin = new Date(Date.UTC(yy, mm - 1, dd, 2, 0)).toISOString();
      const timeMax = new Date(Date.UTC(yy, mm - 1, dd + 1, 6, 0)).toISOString();
      const inicioDia = new Date(yy, mm - 1, dd).getTime(); // misma convención "hora de pared" que nowCL
      for (const b of await busyIntervals(auth.token, auth.calendarId, timeMin, timeMax)) {
        const from = Math.max(0, (nowCL(new Date(b.start)).getTime() - inicioDia) / 60000);
        const to   = Math.min(24 * 60, (nowCL(new Date(b.end)).getTime() - inicioDia) / 60000);
        if (to > from) busyRanges.push({ from, to });
      }
    }
  } catch (e) {
    await logError('availability/google', 'No se pudieron leer los horarios ocupados de Google Calendar (se muestran las horas igual)', { date: dateParam, error: e instanceof Error ? e.message : String(e) });
    busyRanges = [];
  }

  if (blockRanges.some(r => r.from === 0 && r.to === 24 * 60)) return { slots: [], blocked: true };

  // Límite "días visibles hacia el futuro" del servicio
  const svcWindow = (svcCfg as { booking_window_days?: number } | null)?.booking_window_days;
  if (serviceId && Number.isFinite(svcWindow)) {
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + Number(svcWindow));
    if (requested > maxDate) return { slots: [] };
  }

  if (slotsError) return { error: 'Error consultando disponibilidad.', status: 500 };

  // Horas extra abiertas por Valentina solo para esta fecha (ver horasExtra.ts).
  // Se suman al horario semanal del servicio; si la hora ya existe, no se duplica.
  let slotsDelDia = (slots ?? []) as { start_time: string; modality?: string }[];
  if (serviceId) {
    try {
      const svcModalidad = (svcCfg as { modality?: string } | null)?.modality;
      const todas = await leerHorasExtra();
      const extras = todas.filter(h => !h.quitar && h.fecha === dateParam && aplicaA(h, svcModalidad, serviceId)
        // Una hora abierta solo "online" (o solo "presencial") no se ofrece en la
        // otra modalidad de un servicio que admite ambas.
        && (h.servicioId || h.modalidad === 'ambos' || !reqModality || h.modalidad === reqModality));
      for (const h of extras) {
        if (!slotsDelDia.some(s => s.start_time.slice(0, 5) === h.hora)) slotsDelDia = [...slotsDelDia, { start_time: `${h.hora}:00` }];
      }
      // Horas quitadas solo este día para este servicio (excepción al horario semanal).
      slotsDelDia = slotsDelDia.filter(s => !estaQuitada(todas, dateParam, s.start_time.slice(0, 5), serviceId));
      slotsDelDia = [...slotsDelDia].sort((a, b) => a.start_time.localeCompare(b.start_time));
    } catch (e) {
      await logError('availability/horas-extra', 'No se pudieron leer las horas extra', { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!slotsDelDia.length) return { slots: [] };
  if (blockedDate) return { slots: [], blocked: true };
  if (bookedError) return { error: 'Error consultando reservas.', status: 500 };

  const cfg: Record<string, string> = {};
  (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { cfg[key] = value; });

  // Descanso entre sesiones: por servicio si está definido; si no, el global.
  const svcBreak = (svcCfg as { break_min?: number } | null)?.break_min;
  const prepMin = Number.isFinite(svcBreak) ? Number(svcBreak) : parseInt(cfg['prep_duration_min'] ?? '20');
  // Duración de la nueva sesión: la del parámetro o la del servicio.
  const svcDuration = (svcCfg as { duration_min?: number } | null)?.duration_min;
  const effDuration = newDuration ?? (Number.isFinite(svcDuration) ? Number(svcDuration) : null);

  // Reservas existentes con su duración real (fallback 50 min para bookings antiguos sin duration_min)
  const bookedSessions = ((booked ?? []) as { id?: string; session_time: string; duration_min: number | null }[])
    .filter(b => !b.id || !excluir.has(b.id))
    .map((b) => {
      const [h, m] = b.session_time.slice(0, 5).split(':').map(Number);
      return { startMin: h * 60 + m, duration: b.duration_min ?? 50 };
    });

  const nowHour = nowCL();
  const isToday = dateParam === nowHour.toISOString().slice(0, 10);
  const nowMin  = nowHour.getHours() * 60 + nowHour.getMinutes() + (c.sinAnticipacion ? 0 : 60); // +60 min buffer

  const available = slotsDelDia
    // Si se pidió por service_id, la query ya filtró; si no, se filtra por modalidad (compat).
    .filter((s: { modality?: string }) =>
      serviceId || !reqModality || !s.modality || s.modality === 'ambos' || s.modality === reqModality)
    .map((s) => s.start_time.slice(0, 5))
    .filter((time) => {
      const [h, m] = time.split(':').map(Number);
      const slotMin = h * 60 + m;

      if (isToday && slotMin <= nowMin) return false;

      // La sesión (con su duración) no puede cruzarse con un bloqueo de horas.
      const slotEnd = slotMin + (effDuration ?? 50);
      if (blockRanges.some(r => slotMin < r.to && slotEnd > r.from)) return false;
      // Ni con un evento del Google Calendar de Valentina.
      if (busyRanges.some(r => slotMin < r.to && slotEnd > r.from)) return false;

      for (const { startMin: bMin, duration: bDur } of bookedSessions) {
        // Este slot cae dentro de la ventana de una reserva existente
        if (slotMin >= bMin && slotMin < bMin + bDur + prepMin) return false;
        // Una reserva existente cae dentro de la ventana de este slot (si se conoce la duración nueva)
        if (effDuration && bMin >= slotMin && bMin < slotMin + effDuration + prepMin) return false;
      }

      return true;
    });

  // Sin service_id se juntan las horas de todos los servicios y la misma hora
  // venía repetida (ej. "12:00" seis veces). Se deja una sola, en orden (8 oct 2026).
  return { slots: [...new Set(available)].sort() };
}

/** ¿Esa hora exacta está disponible? null = no se pudo comprobar (error de base de datos). */
export async function horaDisponible(c: ConsultaDisponibilidad & { time: string }): Promise<boolean | null> {
  const r = await calcularDisponibilidad(c);
  if ('error' in r) return null;
  return r.slots.includes(c.time.slice(0, 5));
}

/** ¿Una sesión en esa fecha/hora/duración se cruza con otra sesión existente?
 *  Para lo que agenda Valentina desde el panel (ella puede agendar fuera de su
 *  horario, pero no encima de otra sesión). Antes solo se detectaba la misma
 *  hora exacta: 10:30 encima de una sesión de 10:00 a 10:50 pasaba.
 *  null = no se pudo comprobar. */
export async function chocaConOtraSesion(date: string, time: string, duracion: number, excluirId?: string): Promise<boolean | null> {
  const { data, error } = await supabase.from('bookings')
    .select('id, session_time, duration_min')
    .eq('session_date', date)
    .not('status', 'in', '(cancelled,expired)');
  if (error) return null;
  const toMin = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
  const ini = toMin(time);
  const fin = ini + (duracion || 50);
  return (data ?? []).some((b: { id: string; session_time: string; duration_min: number | null }) => {
    if (b.id === excluirId) return false;
    const bi = toMin(b.session_time);
    return ini < bi + (b.duration_min ?? 50) && fin > bi;
  });
}
