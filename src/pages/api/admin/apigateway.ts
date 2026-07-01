import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { getAgwConfig, bheEmitidas, emitirBHE, clearAgwCache } from '../../../lib/apigateway';

export const prerender = false;

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, string> = {};
  try { body = await request.json(); } catch { /* form fallback below */ }
  if (!body.action) {
    const form = await request.formData().catch(() => null);
    if (form) form.forEach((v, k) => { body[k] = String(v); });
  }
  const action = body.action;

  clearAgwCache();
  const cfg = await getAgwConfig();
  if (!cfg) return json({ ok: false, error: 'Falta configurar el token de API Gateway.' }, 400);

  // ── Probar conexión: consulta BHE emitidas del período (producto boletas) ──
  if (action === 'test') {
    if (!cfg.siiRut || !cfg.siiClave) {
      return json({ ok: false, needsSii: true,
        error: 'El token está guardado, pero para probar el producto de Boletas de Honorarios necesitas también el RUT y la clave SII.' }, 400);
    }
    try {
      const now     = new Date();
      const periodo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const result  = await bheEmitidas(cfg.siiRut, periodo, cfg);
      return json({ ok: true, periodo, result });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : 'Error desconocido' }, 502);
    }
  }

  // ── Emitir BHE para una reserva ───────────────────────────────────────────
  if (action === 'emitir') {
    const bookingId = body.booking_id;
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);

    const { data: b } = await supabase
      .from('bookings').select('patient_name, patient_email, amount, session_type').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    // RUT del receptor desde la ficha del paciente
    const { data: p } = await supabase
      .from('patients').select('rut, name, address').eq('email', (b.patient_email ?? '').toLowerCase()).maybeSingle();
    if (!p?.rut) return json({ ok: false, error: 'El paciente no tiene RUT registrado (requerido para la boleta).' }, 400);

    try {
      const result = await emitirBHE({
        receptor: { rut: p.rut, razonSocial: p.name ?? b.patient_name, direccion: p.address ?? '' },
        detalle:  [{ nombre: `Atención psicológica — ${b.session_type}`, monto: b.amount ?? 0 }],
      }, cfg);
      return json({ ok: true, result });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : 'Error al emitir' }, 502);
    }
  }

  return json({ ok: false, error: 'Acción no válida.' }, 400);
};
