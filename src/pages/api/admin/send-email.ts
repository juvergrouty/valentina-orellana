import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendReviewRequestEmail, sendStepsEmail } from '../../../lib/email';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/admin/send-email
// Acciones: 'review_request' (reseña de Google), 'steps' (pasos a seguir).
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, string>;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Body inválido.' }, 400); }

  const action    = (body.action ?? '').trim();
  const patientId  = (body.patient_id ?? '').trim();
  let   name       = (body.name ?? '').trim();
  let   email      = (body.email ?? '').trim().toLowerCase();

  // Si viene patient_id, tomar nombre/email desde la ficha
  if (patientId) {
    const { data: p } = await supabase
      .from('patients').select('name, email').eq('id', patientId).maybeSingle();
    if (p) { name = p.name ?? name; email = (p.email ?? email).toLowerCase(); }
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
