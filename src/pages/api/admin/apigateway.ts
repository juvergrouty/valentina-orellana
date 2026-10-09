import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { getAgwConfig, bheEmitidas, bhePdf, bheEmail, bheAnular, codigoDeFolio, clearAgwCache, fechaBoletaDesdeSesion, periodosBoleta, emitBoletaParaReserva, enviarBoletaDeReserva, folioVigente, mensajeErrorSii, MARCA_PENDIENTE, registrarFolioManual, cambiarNotas } from '../../../lib/apigateway';
import type { BheCausal } from '../../../lib/apigateway';
import { logError } from '../../../lib/logger';
import { ADMIN_EMAIL_FALLBACK } from '../../../lib/email';
import { nowCL } from '../../../lib/dateUtils';

// YYYYMM del período en que se emitió/emitirá la boleta (según la fecha de la sesión)
const periodoDeSesion = (sessionDate?: string | null) =>
  fechaBoletaDesdeSesion(sessionDate).slice(0, 7).replace('-', '');

// Boleta VIGENTE de la reserva (la última "Boleta Folio N", salvo anulada).
// Antes tomaba la PRIMERA línea de notes: si una boleta se anuló y se emitió
// otra, PDF/email apuntaban a la anulada y "Anular" respondía "ya estaba
// anulada" sin dejar anular la nueva.
function parseBoleta(notes: string | null): { folio: number | null; codigo: string | null } {
  const v = folioVigente(notes);
  return { folio: v?.folio ?? null, codigo: v?.codigo ?? null };
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
    const r = await emitBoletaParaReserva(bookingId, { rutOverride: body.rut, enviarEmail: true, forzar: body.forzar === true, rutDesdePanel: !!body.rut && body.rut_editado === true });
    // Sesión futura: queda programada para su día (8 oct 2026). No es error.
    if (r.programada) return json({ ok: true, programada: true, fechaProgramada: r.fechaProgramada, mensaje: r.mensaje });
    if (!r.ok) return json({ ok: false, error: r.error ?? 'Error al emitir' }, 502);
    if (r.alreadyEmitted) return json({ ok: false, error: `Esta sesión ya tiene la boleta Folio ${r.folio}. Usa "Enviar por email" para reenviarla.` }, 400);
    return json({ ok: true, folio: r.folio, codigo: r.codigo, enviada: r.enviada, enviadaA: r.enviadaA, errorEnvio: r.errorEnvio });
  }

  // ── Registrar a mano un folio ya emitido en el SII ────────────────────────
  // Para boletas que quedaron emitidas pero sin registrar en la sesión: así
  // se quita el aviso rojo sin emitir una boleta duplicada.
  if (action === 'registrar_folio') {
    const bookingId = body.booking_id;
    const folio = parseInt(String(body.folio ?? ''), 10);
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);
    const r = await registrarFolioManual(bookingId, folio, body.enviar === true);
    if (!r.ok) return json({ ok: false, error: r.error }, 400);
    let envio: { sent: boolean; email?: string; error?: string } | null = null;
    if (body.enviar === true) envio = await enviarBoletaDeReserva(bookingId);
    return json({ ok: true, folio, enviada: envio?.sent ?? false, enviadaA: envio?.email, errorEnvio: envio?.error });
  }

  // ── Enviar la boleta por email al paciente ────────────────────────────────
  if (action === 'email') {
    const bookingId = body.booking_id;
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);

    const { data: b } = await supabase
      .from('bookings').select('patient_name, patient_email, session_date, paid_at, notes').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    const email = (body.email ?? '').trim() || (b.patient_email ?? '');
    if (!email) return json({ ok: false, error: 'Falta el email de destino.' }, 400);

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

    // Al correo del paciente: mismo camino que el envío automático (PDF desde
    // nuestro correo, copia a Valentina, y si el SII falla queda en cola y el
    // cron la reintenta). Antes este botón usaba solo el envío por correo del
    // SII, que falla cada vez que el portal del SII no responde.
    if (email.toLowerCase() === (b.patient_email ?? '').toLowerCase()) {
      const r = await enviarBoletaDeReserva(bookingId);
      if (r.sent) return json({ ok: true, email: r.email });
      const msg = mensajeErrorSii(r.error ?? 'No se pudo enviar');
      return json({ ok: false, error: r.pendiente ? `${msg} Quedó en cola: se enviará sola apenas el SII responda.` : msg }, 502);
    }

    let { folio, codigo } = parseBoleta(b.notes);
    if (!folio) return json({ ok: false, error: 'Esta sesión no tiene una boleta vigente.' }, 400);
    if (!codigo) {
      // Fecha de emisión = fecha del pago (9 oct 2026): se prueba su período y, por si acaso, el actual y el anterior.
      for (const periodo of periodosBoleta(b)) {
        try { codigo = await codigoDeFolio(cfg.siiRut, periodo, folio, cfg); } catch { /* */ }
        if (codigo) break;
      }
    }
    if (!codigo) return json({ ok: false, error: 'No se pudo resolver el código de la boleta (folio ' + folio + ').' }, 502);

    try {
      const result = await bheEmail(codigo, email, cfg);
      // Escritura atómica: se relee la nota actual (el envío tarda segundos y
      // entretanto pudo escribirse otra marca, ej. un recordatorio).
      await cambiarNotas(bookingId, (n) => {
        const base = n.split('\n').filter(l => !l.startsWith(MARCA_PENDIENTE)).join('\n');
        return `${base ? base + '\n' : ''}BoletaEmailEnviada ${new Date().toISOString()} ${email}`;
      });
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
      return json({ ok: false, error: mensajeErrorSii(e instanceof Error ? e.message : 'Error al enviar') }, 502);
    }
  }

  // ── PDF de la boleta (devuelve base64 para descargar) ─────────────────────
  if (action === 'pdf') {
    const bookingId = body.booking_id;
    if (!bookingId) return json({ ok: false, error: 'Falta booking_id.' }, 400);

    const { data: b } = await supabase
      .from('bookings').select('session_date, paid_at, notes').eq('id', bookingId).single();
    if (!b) return json({ ok: false, error: 'Reserva no encontrada.' }, 404);

    let { folio, codigo } = parseBoleta(b.notes);
    if (!folio) return json({ ok: false, error: 'Esta sesión aún no tiene boleta emitida.' }, 400);
    if (!codigo) {
      // Fecha de emisión = fecha del pago (9 oct 2026): se prueba su período y, por si acaso, el actual y el anterior.
      for (const periodo of periodosBoleta(b)) {
        try { codigo = await codigoDeFolio(cfg.siiRut, periodo, folio, cfg); } catch { /* */ }
        if (codigo) break;
      }
    }
    if (!codigo) return json({ ok: false, error: 'No se pudo resolver el código de la boleta.' }, 502);

    try {
      const pdf = await bhePdf(codigo, cfg);
      if (!pdf) return json({ ok: false, error: 'La API no devolvió el PDF.' }, 502);
      return json({ ok: true, folio, pdf });
    } catch (e) {
      return json({ ok: false, error: mensajeErrorSii(e instanceof Error ? e.message : 'Error al obtener PDF') }, 502);
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
    if (!folio) return json({ ok: false, error: 'Esta sesión no tiene una boleta vigente (sin emitir o ya anulada).' }, 400);
    const validCausales: BheCausal[] = ['no_pago', 'no_prestacion', 'error_digitacion'];
    const causal: BheCausal = validCausales.includes(body.causal as BheCausal)
      ? (body.causal as BheCausal)
      : 'error_digitacion';

    try {
      await bheAnular(cfg.siiRut, folio, causal, cfg);
      // Marca la línea vigente (la última de ese folio), no la primera. Escritura
      // atómica sobre la nota actual (la anulación en el SII tarda segundos).
      const r = await cambiarNotas(bookingId, (n) => {
        const lineas = n.split('\n');
        const idx = lineas.map(l => new RegExp(`Boleta\\s+Folio\\s+${folio}(?!\\d)`, 'i').test(l)).lastIndexOf(true);
        if (idx < 0) return null;
        lineas[idx] = `${lineas[idx]} · ANULADA`;
        return lineas.join('\n');
      });
      if (!r.ok) await logError('boleta/anular', `La boleta Folio ${folio} se anuló en el SII pero no quedó marcada en la sesión`, { bookingId, error: r.error });
      return json({ ok: true, folio });
    } catch (e) {
      return json({ ok: false, error: mensajeErrorSii(e instanceof Error ? e.message : 'Error al anular') }, 502);
    }
  }

  return json({ ok: false, error: 'Acción no válida.' }, 400);
};
