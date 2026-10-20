import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { calcularDisponibilidad } from '../../../lib/disponibilidad';
import { todayCL } from '../../../lib/dateUtils';
import { normalizarHora, sesionesQueSeCruzan, avisosHora, type SesionDelDia } from '../../../lib/horaLibre';

export const prerender = false;

// GET /api/admin/revisar-hora?date=YYYY-MM-DD&time=HH:MM[&service_id&modality&sessions&excluir]
// Hora libre en el panel (20 oct 2026): antes de agendar o reagendar, el panel
// pregunta aquí si la hora queda fuera de su horario o se cruza con otra
// sesión. Solo AVISA: Valentina decide si agenda igual (nada se bloquea aquí).
// Protegido por el middleware (/api/admin/*).
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const GET: APIRoute = async ({ url }) => {
  const date = url.searchParams.get('date') ?? '';
  const hora = normalizarHora(url.searchParams.get('time'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !hora) return json({ ok: false, error: 'Fecha u hora inválida.' }, 400);
  const excluir = url.searchParams.get('excluir') || null;
  const semanas = Math.min(Math.max(parseInt(url.searchParams.get('sessions') ?? '1') || 1, 1), 52);
  let serviceId = url.searchParams.get('service_id') || null;
  let modality = url.searchParams.get('modality') || null;
  let duracion = parseInt(url.searchParams.get('duration') ?? '') || 0;

  // Reagendar: duración y servicio de la propia sesión (la misma regla que el servidor: 50 si no tiene).
  let original: { session_date: string; session_time: string; duration_min: number | null } | null = null;
  if (excluir) {
    const { data: b } = await supabase.from('bookings').select('service_id, duration_min, session_type, session_date, session_time').eq('id', excluir).maybeSingle();
    if (b) {
      original = b;
      serviceId = serviceId ?? b.service_id ?? null;
      duracion = duracion || Number(b.duration_min) || 50;
      modality = modality ?? (String(b.session_type ?? '').includes('online') ? 'online' : 'presencial');
    }
  }
  if (!duracion && serviceId) {
    const { data: svc } = await supabase.from('services_catalog').select('*').eq('id', serviceId).maybeSingle();
    if (svc) {
      const porModalidad = svc.modality === 'ambos'
        ? (modality === 'online' ? svc.duration_min_online : svc.duration_min_presencial) : null;
      duracion = Number(porModalidad ?? svc.duration_min) || 0;
    }
  }
  if (!duracion) duracion = 50;

  // Fechas (pack semana a semana) y sus sesiones activas.
  const fechas = Array.from({ length: semanas }, (_, i) => {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + i * 7);
    return d.toISOString().split('T')[0];
  });
  const { data: sesiones, error } = await supabase.from('bookings')
    .select('id, session_date, session_time, duration_min, patient_name')
    .in('session_date', fechas)
    .not('status', 'in', '(cancelled,expired)');
  if (error) return json({ ok: false, error: 'No se pudo revisar la agenda.' }, 500);
  const cruces: SesionDelDia[] = [];
  for (const f of fechas) {
    cruces.push(...sesionesQueSeCruzan(hora, duracion, ((sesiones ?? []) as SesionDelDia[]).filter((s) => s.session_date === f), excluir));
  }

  // ¿Es una de sus horas disponibles? Solo el primer día y solo de hoy en adelante.
  let fueraDeHorario: boolean | null = null;
  // Si ese día ya se cruza con otra sesión, basta ese aviso (el horario también la daría por ocupada).
  // Mover la misma sesión unos minutos: su propio evento de Google Calendar la daría por
  // ocupada (falso "fuera de horario"), así que en ese caso no se avisa.
  const solapaConSiMisma = !!original && original.session_date === date
    && sesionesQueSeCruzan(hora, duracion, [{ id: 'propia', session_time: String(original.session_time), duration_min: original.duration_min }]).length > 0;
  if (date >= todayCL() && !solapaConSiMisma && !cruces.some((c) => c.session_date === date)) {
    const r = await calcularDisponibilidad({ date, serviceId, duration: duracion, modality, excluirIds: excluir ? [excluir] : [], sinAnticipacion: true });
    if (!('error' in r)) fueraDeHorario = !r.slots.includes(hora);
  }

  return json({ ok: true, hora, duracion, hayCruce: cruces.length > 0, avisos: avisosHora({ hora, primeraFecha: date, fueraDeHorario, cruces }) });
};
