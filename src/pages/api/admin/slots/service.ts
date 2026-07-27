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
  let body: { action?: string; service_id?: string; from_service_id?: string; slots?: Array<{ day_of_week: number; start_time: string }> };
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
