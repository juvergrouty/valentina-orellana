import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// Feriados fijos de Chile por año (sin Semana Santa — fecha variable)
function feriadosChile(year: number): string[] {
  // Semana Santa: calcular domingo de Pascua con algoritmo de Butcher
  function easter(y: number) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day   = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  }
  const easterDay = easter(year);
  const viernesSanto = new Date(easterDay); viernesSanto.setDate(easterDay.getDate() - 2);
  const sabadoGloria = new Date(easterDay); sabadoGloria.setDate(easterDay.getDate() - 1);
  const toISO = (d: Date) => d.toISOString().slice(0, 10);

  return [
    `${year}-01-01`,  // Año Nuevo
    toISO(viernesSanto),  // Viernes Santo
    toISO(sabadoGloria),  // Sábado de Gloria
    `${year}-05-01`,  // Día del Trabajo
    `${year}-05-21`,  // Glorias Navales
    `${year}-06-20`,  // Pueblos Indígenas
    `${year}-06-29`,  // San Pedro y San Pablo
    `${year}-07-16`,  // Virgen del Carmen
    `${year}-08-15`,  // Asunción
    `${year}-09-18`,  // Fiestas Patrias
    `${year}-09-19`,  // Glorias del Ejército
    `${year}-10-12`,  // Encuentro Dos Mundos
    `${year}-10-31`,  // Iglesias Evangélicas
    `${year}-11-01`,  // Todos los Santos
    `${year}-12-08`,  // Inmaculada Concepción
    `${year}-12-25`,  // Navidad
  ];
}

export const POST: APIRoute = async ({ request, redirect }) => {
  const form   = await request.formData();
  const action = form.get('action')?.toString();
  const dest   = form.get('_redirect')?.toString() ?? '/admin/horarios';

  // ── Quitar bloqueo ────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id    = form.get('id')?.toString();
    const table = form.get('table')?.toString() ?? 'blocked_dates';
    if (id) {
      await supabase.from(table as 'blocked_dates' | 'blocked_slots').delete().eq('id', id);
    }
    return redirect(dest);
  }

  // ── Bloquear fecha individual ─────────────────────────────────────────────
  if (action === 'block-single') {
    const date   = form.get('date')?.toString();
    const reason = form.get('reason')?.toString() || null;
    if (date) {
      await supabase.from('blocked_dates').upsert({ date, reason }, { onConflict: 'date' });
    }
    return redirect(dest);
  }

  // ── Bloquear rango de fechas (días completos) ─────────────────────────────
  if (action === 'block-range') {
    const dateFrom = form.get('date_from')?.toString();
    const dateTo   = form.get('date_to')?.toString();
    const reason   = form.get('reason')?.toString() || null;

    if (dateFrom && dateTo && dateFrom <= dateTo) {
      const rows: { date: string; reason: string | null }[] = [];
      const cursor = new Date(dateFrom + 'T00:00:00');
      const end    = new Date(dateTo   + 'T00:00:00');
      while (cursor <= end) {
        rows.push({ date: cursor.toISOString().slice(0, 10), reason });
        cursor.setDate(cursor.getDate() + 1);
      }
      for (let i = 0; i < rows.length; i += 50) {
        await supabase.from('blocked_dates').upsert(rows.slice(i, i + 50), { onConflict: 'date' });
      }
    }
    return redirect(dest);
  }

  // ── Bloquear slot con rango de horas ─────────────────────────────────────
  // Usa tabla blocked_slots (time-aware). Si no existe, cae a blocked_dates.
  if (action === 'block-slot') {
    const dateFrom = form.get('date_from')?.toString() ?? '';
    const dateTo   = form.get('date_to')?.toString()   ?? '';
    const allDay   = form.get('all_day') === '1';
    const timeFrom = allDay ? null : (form.get('time_from')?.toString() || null);
    const timeTo   = allDay ? null : (form.get('time_to')?.toString()   || null);
    const label    = form.get('label')?.toString() || null;

    if (!dateFrom || !dateTo) return redirect(dest);

    // Try blocked_slots first (supports time ranges)
    const { error } = await supabase.from('blocked_slots' as any).insert({
      date_from: dateFrom,
      date_to:   dateTo,
      time_from: timeFrom,
      time_to:   timeTo,
      all_day:   allDay,
      label,
    });

    // Fallback: table doesn't exist → use blocked_dates (full-day blocks)
    if (error?.code === '42P01') {
      const rows: { date: string; reason: string | null }[] = [];
      const cursor = new Date(dateFrom + 'T00:00:00');
      const end    = new Date(dateTo   + 'T00:00:00');
      while (cursor <= end) {
        rows.push({ date: cursor.toISOString().slice(0, 10), reason: label });
        cursor.setDate(cursor.getDate() + 1);
      }
      for (let i = 0; i < rows.length; i += 50) {
        await supabase.from('blocked_dates').upsert(rows.slice(i, i + 50), { onConflict: 'date' });
      }
    }

    return redirect(dest);
  }

  // ── Bloquear feriados de Chile del año en curso ───────────────────────────
  if (action === 'block-feriados') {
    const year     = new Date().getFullYear();
    const feriados = feriadosChile(year);
    const rows     = feriados.map(d => ({ date: d, reason: 'Feriado' }));
    for (let i = 0; i < rows.length; i += 50) {
      await supabase.from('blocked_dates').upsert(rows.slice(i, i + 50), { onConflict: 'date' });
    }
    return redirect(dest);
  }

  return redirect(dest);
};
