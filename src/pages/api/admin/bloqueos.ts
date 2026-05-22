import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  const form   = await request.formData();
  const action = form.get('action')?.toString();
  const dest   = '/admin/bloqueos';

  // ── Quitar bloqueo ────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = form.get('id')?.toString();
    if (id) await supabase.from('blocked_dates').delete().eq('id', id);
    return redirect(dest);
  }

  // ── Bloquear fecha individual ─────────────────────────────────────────────
  if (action === 'block-single') {
    const date   = form.get('date')?.toString();
    const reason = form.get('reason')?.toString() || null;
    if (date) {
      await supabase
        .from('blocked_dates')
        .upsert({ date, reason }, { onConflict: 'date' });
    }
    return redirect(dest);
  }

  // ── Bloquear rango ────────────────────────────────────────────────────────
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

      // Insertar en lotes de 50 para no exceder límites
      for (let i = 0; i < rows.length; i += 50) {
        await supabase
          .from('blocked_dates')
          .upsert(rows.slice(i, i + 50), { onConflict: 'date' });
      }
    }
    return redirect(dest);
  }

  return redirect(dest);
};
