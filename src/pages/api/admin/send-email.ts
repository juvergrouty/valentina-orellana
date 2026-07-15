import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendReviewRequestEmail, sendStepsEmail, sendConfirmationToClient, sendReminderEmail } from '../../../lib/email';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/admin/send-email
// Acciones: 'review_request' (reseña), 'steps' (pasos a seguir),
//           'confirmation' y 'reminder' (por sesión, vía booking_id).
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, string>;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Body inválido.' }, 400); }

  const action    = (body.action ?? '').trim();
  const patientId  = (body.patient_id ?? '').trim();
  const bookingId  = (body.booking_id ?? '').trim();
  let   name       = (body.name ?? '').trim();
  let   email      = (body.email ?? '').trim().toLowerCase();

  // ── Reenviar confirmación o recordatorio de una sesión concreta ───────────
  if (action === 'confirmation' || action === 'reminder') {
    if (!bookingId) return json({ ok: false, error: 'Falta la sesión (booking_id).' }, 400);
    const { data: b } = await supabase.from('bookings')
      .select('patient_name, patient_email, patient_phone, session_type, session_date, session_time, amount, payment_method, service_id')
      .eq('id', bookingId).maybeSingle();
    if (!b) return json({ ok: false, error: 'Sesión no encontrada.' }, 404);
    if (!b.patient_email) return json({ ok: false, error: 'La sesión no tiene correo del paciente.' }, 400);

    let serviceName: string | undefined;
    if (b.service_id) {
      const { data: svc } = await supabase.from('services_catalog').select('name').eq('id', b.service_id).maybeSingle();
      serviceName = svc?.name;
    }
    const emailData = {
      patient_name:   b.patient_name,
      patient_email:  b.patient_email,
      patient_phone:  b.patient_phone ?? '',
      session_type:   b.session_type,
      session_date:   b.session_date,
      session_time:   b.session_time,
      amount:         b.amount ?? 0,
      payment_method: b.payment_method ?? 'manual',
      service_name:   serviceName,
    };
    try {
      // skipToggle / reenvío manual: se envía aunque el automático esté desactivado
      if (action === 'reminder') {
        const res = await sendReminderEmail(emailData);
        if (!res.sent) return json({ ok: false, error: res.reason ?? 'No se pudo enviar.' }, 500);
      } else {
        await sendConfirmationToClient(emailData, { skipToggle: true });
      }
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : 'No se pudo enviar.' }, 500);
    }
  }

  // Si viene patient_id, tomar nombre/email desde la ficha
  if (patientId) {
    const { data: p } = await supabase
      .from('patients').select('name, email').eq('id', patientId).maybeSingle();
    if (p) { name = p.name ?? name; email = (p.email ?? email).toLowerCase(); }
  }

  // Si viene booking_id (reenvío por sesión de 'steps'/'review'), resolver correo/nombre de la reserva
  if (bookingId && !email) {
    const { data: b } = await supabase
      .from('bookings').select('patient_name, patient_email').eq('id', bookingId).maybeSingle();
    if (b) { name = b.patient_name ?? name; email = (b.patient_email ?? '').toLowerCase(); }
  }

  if (!email) return json({ ok: false, error: 'El paciente no tiene correo registrado.' }, 400);

  // Leer settings necesarios
  const { data: rows } = await supabase.from('settings').select('key, value')
    .in('key', ['google_place_id', 'clinic_address']);
  const cfg: Record<string, string> = {};
  (rows ?? []).forEach((r: { key: string; value: string }) => { cfg[r.key] = r.value; });

  if (action === 'review_request') {
    const placeId = cfg['google_place_id'];
    if (!placeId) {
      return json({ ok: false, error: 'Falta el Place ID de Google en Configuración para armar el enlace de reseña.' }, 400);
    }
    const reviewUrl = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
    const res = await sendReviewRequestEmail({ patientName: name || 'hola', patientEmail: email, reviewUrl });
    if (!res.sent) return json({ ok: false, error: res.reason ?? 'No se pudo enviar el correo.' }, 500);
    return json({ ok: true });
  }

  if (action === 'steps') {
    const res = await sendStepsEmail({
      patientName: name || 'hola',
      patientEmail: email,
      clinicAddress: cfg['clinic_address'] ?? '',
    });
    if (!res.sent) return json({ ok: false, error: res.reason ?? 'No se pudo enviar el correo.' }, 500);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Acción no reconocida.' }, 400);
};
