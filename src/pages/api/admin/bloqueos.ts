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
  // Si no se guardó, se vuelve con un aviso visible y sin el "✓ bloqueada"
  // (8 oct 2026): antes una falla de la base se veía igual que un éxito.
  const conError = (detalle?: string) => {
    const u = new URL(dest, 'http://local');
    u.searchParams.delete('saved');
    u.searchParams.set('error', 'bloqueo_guardar');
    if (detalle) u.searchParams.set('detail', detalle.slice(0, 200));
    return redirect(u.pathname + '?' + u.searchParams.toString());
  };

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
      if (error) return conError(error.message);
      // El día cerrado queda anotado también en Google Calendar.
      await crearEventoCierre(date, reason ? `Cerrado · ${reason}` : 'Cerrado');
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
      let fallo: string | null = null;
      for (let i = 0; i < rows.length; i += 50) {
        const { error } = await supabase.from('blocked_dates').upsert(rows.slice(i, i + 50), { onConflict: 'date' });
        if (error) fallo = error.message;
      }
      if (fallo) return conError(fallo);
      // Igual que un día suelto: cada día cerrado queda anotado en Google Calendar
      // (hasta 62 días, para no pasarse del tiempo de la función).
      for (const r of rows.slice(0, 62)) await crearEventoCierre(r.date, reason ? `Cerrado · ${reason}` : 'Cerrado');
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

    if (!dateFrom || !dateTo || dateTo < dateFrom) return redirect(dest);

    // Cada fila de blocked_slots aplica su horario a TODOS los días de su rango.
    // "Lun 15:00 → Mié 12:00" no es una ventana diaria: es lunes desde las
    // 15:00, martes completo y miércoles hasta las 12:00. Antes se guardaba
    // como una sola fila (15:00–12:00) que no bloqueaba nada (auditoría 8 oct 2026).
    const masUnDia = (d: string) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
    const menosUnDia = (d: string) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
    type Fila = { date_from: string; date_to: string; time_from: string | null; time_to: string | null; all_day: boolean; label: string | null };
    const filas: Fila[] = [];
    if (allDay || (!timeFrom && !timeTo)) {
      filas.push({ date_from: dateFrom, date_to: dateTo, time_from: null, time_to: null, all_day: true, label });
    } else if (dateFrom === dateTo) {
      if (timeFrom && timeTo && timeTo <= timeFrom) return redirect(dest + (dest.includes('?') ? '&' : '?') + 'error=bloqueo_horas');
      filas.push({ date_from: dateFrom, date_to: dateTo, time_from: timeFrom ?? '00:00', time_to: timeTo ?? '23:59', all_day: false, label });
    } else {
      filas.push({ date_from: dateFrom, date_to: dateFrom, time_from: timeFrom ?? '00:00', time_to: '23:59', all_day: false, label });
      if (masUnDia(dateFrom) <= menosUnDia(dateTo)) filas.push({ date_from: masUnDia(dateFrom), date_to: menosUnDia(dateTo), time_from: null, time_to: null, all_day: true, label });
      filas.push({ date_from: dateTo, date_to: dateTo, time_from: '00:00', time_to: timeTo ?? '23:59', all_day: false, label });
    }

    // Try blocked_slots first (supports time ranges)
    const { error } = await supabase.from('blocked_slots' as any).insert(filas);

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
        const { error: e2 } = await supabase.from('blocked_dates').upsert(rows.slice(i, i + 50), { onConflict: 'date' });
        if (e2) return conError(e2.message);
      }
    } else if (error) {
      return conError(error.message);
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
