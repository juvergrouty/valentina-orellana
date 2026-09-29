import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { getAgwConfig, bheEmitidas, bhePdf, bheEmail, bheAnular, codigoDeFolio, clearAgwCache, fechaBoletaDesdeSesion, emitBoletaParaReserva, MARCA_PENDIENTE } from '../../../lib/apigateway';
import type { BheCausal } from '../../../lib/apigateway';
import { logError } from '../../../lib/logger';
import { ADMIN_EMAIL_FALLBACK } from '../../../lib/email';
import { nowCL } from '../../../lib/dateUtils';

// YYYYMM del período en que se emitió/emitirá la boleta (según la fecha de la sesión)
const periodoDeSesion = (sessionDate?: string | null) =>
  fechaBoletaDesdeSesion(sessionDate).slice(0, 7).replace('-', '');

// Extrae "Boleta Folio N · Cod XXX" de las notas de una reserva
function parseBoleta(notes: string | null): { folio: number | null; codigo: string | null } {
  const f = notes?.match(/Boleta Folio (\d+)/i);
  const c = notes?.match(/Cod ([\w-]+)/i);
  return { folio: f ? parseInt(f[1]) : null, codigo: c ? c[1] : null };
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
      const now     = nowCL();
      const periodo = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`; // YYYYMM (sin guion), hora de Chile
      const result  = await bheEmitidas(cfg.siiRut, periodo, 1, cfg);
      return json({ ok: true, periodo, result });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : 'Error desconocido' }, 502);
    }
  }

  // ── Emitir BHE para una reserva (y enviarla) ──────────────────────────────
  // ENCONTRADO (29 sep 2026, boleta 222): este botón tenía su propia copia de
  // la lógica de emisión que emitía ante el SII pero NUNCA enviaba la boleta
  // por correo — ni al paciente ni a Valentina. Solo Flow y "Marcar como
  // pagado" la enviaban. Ahora usa el mismo camino único que ellos
  // (emitBoletaParaReserva), que guarda el RUT, emite y envía, y si el envío
  // falla lo deja pendiente para que el cron lo reintente.
  if (action === 'emitir') {
    const bookingId = body.booking_id;
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);
    const r = await emitBoletaParaReserva(bookingId, { rutOverride: body.rut, enviarEmail: true });
    if (!r.ok) return json({ ok: false, error: r.error ?? 'Error al emitir' }, 502);
    if (r.alreadyEmitted) return json({ ok: false, error: `Esta sesión ya tiene la boleta Folio ${r.folio}. Usa "Enviar por email" para reenviarla.` }, 400);
    return json({ ok: true, folio: r.folio, codigo: r.codigo, enviada: r.enviada, enviadaA: r.enviadaA, errorEnvio: r.errorEnvio });
  }

  // ── Enviar la boleta por email al paciente ────────────────────────────────
  if (action === 'email') {
    const bookingId = body.booking_id;
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);

    const { data: b } = await supabase
      .from('bookings').select('patient_name, patient_email, session_date, notes').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    const email = (body.email ?? '').trim() || (b.patient_email ?? '');
    if (!email) return json({ ok: false, error: 'Falta el email de destino.' }, 400);

    let { folio, codigo } = parseBoleta(b.notes);
    if (!folio) return json({ ok: false, error: 'Esta sesión aún no tiene boleta emitida.' }, 400);
    if (!codigo) {
      try { codigo = await codigoDeFolio(cfg.siiRut, periodoDeSesion(b.session_date), folio, cfg); } catch { /* */ }
    }
    if (!codigo) return json({ ok: false, error: 'No se pudo resolver el código de la boleta (folio ' + folio + ').' }, 502);

    // Resguardo contra envíos duplicados (p.ej. doble clic, o un reintento del
    // navegador): si esta misma boleta ya se envió a este mismo correo hace
    // menos de 2 minutos, no se reenvía — se avisa que ya se mandó. El botón
    // en el admin ya se bloquea al hacer clic, pero esto cubre los casos que
    // se le puedan escapar (dos pestañas abiertas, recarga de página, etc.).
    const sentMarker = new RegExp(`BoletaEmailEnviada (\\S+) ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const sentMatch  = sentMarker.exec(b.notes ?? '');
    if (sentMatch) {
      const sentAt = Date.parse(sentMatch[1]);
      if (!isNaN(sentAt) && Date.now() - sentAt < 2 * 60 * 1000) {
        return json({ ok: true, email, skipped: 'ya_enviada_hace_poco' });
      }
    }

    try {
      const result = await bheEmail(codigo, email, cfg);
      {
        const base = (b.notes ?? '').split('\n').filter(l => !l.startsWith(MARCA_PENDIENTE)).join('\n');
        const marca = `${base ? base + '\n' : ''}BoletaEmailEnviada ${new Date().toISOString()} ${email}`;
        await supabase.from('bookings').update({ notes: marca }).eq('id', bookingId);
      }
      // Copia para Valentina — para que tenga registro de cada boleta enviada
      // sin tener que entrar al admin a revisarlas una por una. No bloquea la
      // respuesta si falla (el paciente ya recibió la suya).
      try {
        const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
        const adminEmail = notifRow?.value || ADMIN_EMAIL_FALLBACK;
        if (adminEmail.toLowerCase() !== email.toLowerCase()) {
          await bheEmail(codigo, adminEmail, cfg);
        }
      } catch (e) {
        await logError('boleta/copia-admin', 'Falló el envío de la copia de la boleta a Valentina', { bookingId, folio, error: e instanceof Error ? e.message : String(e) });
      }
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
      .from('bookings').select('session_date, notes').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    let { folio, codigo } = parseBoleta(b.notes);
    if (!folio) return json({ ok: false, error: 'Esta sesión aún no tiene boleta emitida.' }, 400);
    if (!codigo) {
      try { codigo = await codigoDeFolio(cfg.siiRut, periodoDeSesion(b.session_date), folio, cfg); } catch { /* */ }
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

  // ── Anular una boleta ya emitida ──────────────────────────────────────────
  // Corrige un error (monto, RUT, sesión equivocada). Anula el documento en el
  // SII; no borra el registro de la reserva, solo marca en las notas que la
  // boleta quedó anulada, para que la ficha no la muestre como vigente.
  if (action === 'anular') {
    const bookingId = body.booking_id;
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);

    const { data: b } = await supabase
      .from('bookings').select('notes').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    const { folio } = parseBoleta(b.notes);
    if (!folio) return json({ ok: false, error: 'Esta sesión no tiene una boleta emitida.' }, 400);
    if (/Boleta Folio \d+.*ANULADA/is.test(b.notes ?? '')) {
      return json({ ok: false, error: 'Esa boleta ya estaba anulada.' }, 400);
    }
    const validCausales: BheCausal[] = ['no_pago', 'no_prestacion', 'error_digitacion'];
    const causal: BheCausal = validCausales.includes(body.causal as BheCausal)
      ? (body.causal as BheCausal)
      : 'error_digitacion';

    try {
      await bheAnular(cfg.siiRut, folio, causal, cfg);
      const nuevaNota = (b.notes ?? '').replace(
        new RegExp(`(Boleta Folio ${folio}[^\\n]*)`, 'i'),
        '$1 · ANULADA'
      );
      await supabase.from('bookings').update({ notes: nuevaNota }).eq('id', bookingId);
      return json({ ok: true, folio });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : 'Error al anular' }, 502);
    }
  }

  return json({ ok: false, error: 'Acción no válida.' }, 400);
};
