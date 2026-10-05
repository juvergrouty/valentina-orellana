import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { crearEventoCierre, borrarEventoCierre, listaFeriados } from '../../../lib/feriados';
import { todayCL } from '../../../lib/dateUtils';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  const form   = await request.formData();
  const action = form.get('action')?.toString();
  // Solo rutas internas del panel.
  const destRaw = form.get('_redirect')?.toString() ?? '';
  const dest    = /^\/admin(\/|$|\?)/.test(destRaw) && !destRaw.includes('//') ? destRaw : '/admin/horarios';

  // ── Quitar bloqueo ────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id    = form.get('id')?.toString();
    // Solo estas dos tablas (antes el nombre de la tabla venía del formulario
    // sin revisar y se podía borrar por id en cualquier otra).
    const tableRaw = form.get('table')?.toString() ?? 'blocked_dates';
    const table = tableRaw === 'blocked_slots' ? 'blocked_slots' : 'blocked_dates';
    if (id) {
      // Si era un día cerrado, quitar también su anotación en Google Calendar.
      const { data: row } = table === 'blocked_dates'
        ? await supabase.from('blocked_dates').select('date').eq('id', id).maybeSingle()
        : { data: null };
      await supabase.from(table as 'blocked_dates' | 'blocked_slots').delete().eq('id', id);
      if (row?.date) await borrarEventoCierre(row.date);
    }
    return redirect(dest);
  }

  // ── Bloquear fecha individual ─────────────────────────────────────────────
  if (action === 'block-single') {
    const date   = form.get('date')?.toString();
    const reason = form.get('reason')?.toString() || null;
    if (date) {
      const { error } = await supabase.from('blocked_dates').upsert({ date, reason }, { onConflict: 'date' });
      // El día cerrado queda anotado también en Google Calendar.
      if (!error) await crearEventoCierre(date, reason ? `Cerrado · ${reason}` : 'Cerrado');
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
      let ok = true;
      for (let i = 0; i < rows.length; i += 50) {
        const { error } = await supabase.from('blocked_dates').upsert(rows.slice(i, i + 50), { onConflict: 'date' });
        if (error) ok = false;
      }
      // Igual que un día suelto: cada día cerrado queda anotado en Google Calendar
      // (hasta 62 días, para no pasarse del tiempo de la función).
      if (ok) for (const r of rows.slice(0, 62)) await crearEventoCierre(r.date, reason ? `Cerrado · ${reason}` : 'Cerrado');
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
  // Solo feriados nacionales de hoy en adelante (descargados + verificados, src/lib/feriados.ts).
  // Antes usaba una lista fija con fechas que cambian (Pueblos Indígenas,
  // traslados por ley) y cerraba también fechas ya pasadas, sin anotarlas en
  // Google Calendar.
  if (action === 'block-feriados') {
    const hoy = todayCL();
    for (const f of (await listaFeriados()).filter(f => f.fecha >= hoy)) {
      const titulo = `Feriado · ${f.nombre}`;
      const { error } = await supabase.from('blocked_dates').upsert({ date: f.fecha, reason: titulo }, { onConflict: 'date' });
      if (!error) await crearEventoCierre(f.fecha, titulo);
    }
    return redirect(dest);
  }

  return redirect(dest);
};
