import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { getAgwConfig, bheEmitidas, emitirBHE, bhePdf, bheEmail, codigoDeFolio, clearAgwCache } from '../../../lib/apigateway';

// Extrae "Boleta Folio N · Cod XXX" de las notas de una reserva
function parseBoleta(notes: string | null): { folio: number | null; codigo: string | null } {
  const f = notes?.match(/Boleta Folio (\d+)/i);
  const c = notes?.match(/Cod ([\w-]+)/i);
  return { folio: f ? parseInt(f[1]) : null, codigo: c ? c[1] : null };
}
const periodoActual = () => {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}`;
};

// Normaliza RUT a formato "XXXXXXXX-X" (sin puntos, con guion antes del dígito verificador)
function normalizeRut(rut: string): string {
  const clean = rut.replace(/\./g, '').replace(/\s/g, '').replace(/-/g, '').trim();
  if (clean.length < 2) return rut.trim();
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

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
      const periodo = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`; // YYYYMM (sin guion)
      const result  = await bheEmitidas(cfg.siiRut, periodo, 1, cfg);
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
      .from('bookings').select('patient_name, patient_email, amount, session_type, notes').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    // RUT: prioriza el ingresado en el formulario; si no, el de la ficha del paciente
    const { data: p } = await supabase
      .from('patients').select('rut, name, address').eq('email', (b.patient_email ?? '').toLowerCase()).maybeSingle();
    const rutRaw = (body.rut ?? '').trim() || p?.rut || '';
    if (!rutRaw) return json({ ok: false, error: 'Falta el RUT del paciente (requerido para la boleta).' }, 400);
    const rut = normalizeRut(rutRaw);

    if (!b.amount) return json({ ok: false, error: 'La reserva no tiene monto.' }, 400);

    try {
      const result = await emitirBHE({
        receptor: { rut, razonSocial: p?.name ?? b.patient_name, direccion: p?.address ?? '' },
        detalle:  [{ nombre: 'Atención psicológica', monto: b.amount }],
      }, cfg) as { data?: { Encabezado?: { IdDoc?: { Folio?: number } } } };

      const folio = result?.data?.Encabezado?.IdDoc?.Folio ?? null;

      // Resolver el código de la boleta (necesario para PDF/email)
      let codigo: string | null = null;
      if (folio) {
        try { codigo = await codigoDeFolio(cfg.siiRut, periodoActual(), folio, cfg); } catch { /* opcional */ }
        const nuevaNota = `${b.notes ? b.notes + '\n' : ''}Boleta Folio ${folio}${codigo ? ' · Cod ' + codigo : ''}`;
        await supabase.from('bookings').update({ notes: nuevaNota }).eq('id', bookingId);
      }

      return json({ ok: true, folio, codigo, result });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : 'Error al emitir' }, 502);
    }
  }

  // ── Enviar la boleta por email al paciente ────────────────────────────────
  if (action === 'email') {
    const bookingId = body.booking_id;
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);

    const { data: b } = await supabase
      .from('bookings').select('patient_name, patient_email, notes').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    const email = (body.email ?? '').trim() || (b.patient_email ?? '');
    if (!email) return json({ ok: false, error: 'Falta el email de destino.' }, 400);

    let { folio, codigo } = parseBoleta(b.notes);
    if (!folio) return json({ ok: false, error: 'Esta sesión aún no tiene boleta emitida.' }, 400);
    if (!codigo) {
      try { codigo = await codigoDeFolio(cfg.siiRut, periodoActual(), folio, cfg); } catch { /* */ }
    }
    if (!codigo) return json({ ok: false, error: 'No se pudo resolver el código de la boleta (folio ' + folio + ').' }, 502);

    try {
      const result = await bheEmail(codigo, email, cfg);
      return json({ ok: true, email, result });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : 'Error al enviar' }, 502);
    }
  }

  // ── PDF de la boleta (devuelve base64 para descargar) ─────────────────────
  if (action === 'pdf') {
    const bookingId = body.booking_id;
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);

    const { data: b } = await supabase
      .from('bookings').select('notes').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    let { folio, codigo } = parseBoleta(b.notes);
    if (!folio) return json({ ok: false, error: 'Esta sesión aún no tiene boleta emitida.' }, 400);
    if (!codigo) {
      try { codigo = await codigoDeFolio(cfg.siiRut, periodoActual(), folio, cfg); } catch { /* */ }
    }
    if (!codigo) return json({ ok: false, error: 'No se pudo resolver el código de la boleta.' }, 502);

    try {
      const pdf = await bhePdf(codigo, cfg);
      if (!pdf) return json({ ok: false, error: 'La API no devolvió el PDF.' }, 502);
      return json({ ok: true, folio, pdf });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : 'Error al obtener PDF' }, 502);
    }
  }

  return json({ ok: false, error: 'Acción no válida.' }, 400);
};
