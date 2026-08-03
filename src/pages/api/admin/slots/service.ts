import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/admin/slots/service
// Acciones:
//   'save' { service_id, slots: [{day_of_week, start_time}] }  → reemplaza el horario del servicio
//   'copy' { from_service_id }                                 → devuelve las franjas de otro servicio (para pre-cargar la grilla)
export const POST: APIRoute = async ({ request }) => {
  let body: {
    action?: string; service_id?: string; from_service_id?: string;
    slots?: Array<{ day_of_week: number; start_time: string }>;
    settings?: { duration_min?: number; break_min?: number; slot_interval_min?: number; booking_window_days?: number };
  };
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Body inválido.' }, 400); }

  const action = body.action ?? '';

  // ── Copiar: devolver las franjas de otro servicio ─────────────────────────
  if (action === 'copy') {
    if (!body.from_service_id) return json({ ok: false, error: 'Falta from_service_id.' }, 400);
    const { data, error } = await supabase
      .from('availability_slots')
      .select('day_of_week, start_time')
      .eq('service_id', body.from_service_id)
      .eq('active', true);
    if (error) return json({ ok: false, error: error.message }, 500);
    const slots = (data ?? []).map(s => ({ day_of_week: s.day_of_week, start_time: String(s.start_time).slice(0, 5) }));
    return json({ ok: true, slots });
  }

  // ── Guardar: reemplazar todo el horario del servicio ──────────────────────
  if (action === 'save') {
    const serviceId = body.service_id;
    if (!serviceId) return json({ ok: false, error: 'Falta service_id.' }, 400);

    // Guardar la configuración del servicio (duración/descanso/frecuencia/días).
    // Degrada sin romper si las columnas nuevas aún no existen.
    if (body.settings) {
      const s = body.settings;
      const upd: Record<string, number> = {};
      if (Number.isFinite(s.duration_min))        upd.duration_min        = Number(s.duration_min);
      if (Number.isFinite(s.break_min))           upd.break_min           = Number(s.break_min);
      if (Number.isFinite(s.slot_interval_min))   upd.slot_interval_min   = Number(s.slot_interval_min);
      if (Number.isFinite(s.booking_window_days)) upd.booking_window_days = Number(s.booking_window_days);
      if (Object.keys(upd).length) {
        const r = await supabase.from('services_catalog').update(upd).eq('id', serviceId);
        if (r.error && r.error.code !== '42703') {
          return json({ ok: false, error: 'Error al guardar la configuración: ' + r.error.message }, 500);
        }
      }
    }

    const clean = (body.slots ?? [])
      .filter(s => typeof s.day_of_week === 'number' && /^\d{2}:\d{2}$/.test(s.start_time))
      .map(s => ({
        service_id:  serviceId,
        day_of_week: s.day_of_week,
        start_time:  `${s.start_time}:00`,
        active:      true,
      }));

    // Borrar el horario actual de ESTE servicio y volver a insertarlo
    const { error: delErr } = await supabase.from('availability_slots').delete().eq('service_id', serviceId);
    if (delErr) return json({ ok: false, error: 'Error al limpiar: ' + delErr.message }, 500);

    if (clean.length > 0) {
      const { error: insErr } = await supabase.from('availability_slots').insert(clean);
      if (insErr) return json({ ok: false, error: 'Error al guardar: ' + insErr.message }, 500);
    }
    return json({ ok: true, count: clean.length });
  }

  return json({ ok: false, error: 'Acción no reconocida.' }, 400);
};
