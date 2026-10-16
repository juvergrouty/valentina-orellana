import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendConsentLinkEmail } from '../../../lib/email';
import { consentUrl, getOrCreatePendingConsent, whatsappConsentMessage } from '../../../lib/consent';
import { auditar } from '../../../lib/transcriptor/auditoria';
import type { AccionAuditoria } from '../../../lib/transcriptor/tipos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Canales con que el paciente pidió retirar la grabación (consents.recording_revoked_via, 0019). */
const CANALES_RETIRO = ['correo', 'whatsapp', 'presencial', 'otro'];

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/admin/consent — botones del consentimiento en la ficha.
// Acciones: 'whatsapp' (devuelve link de wa.me y registra el envío),
//           'email' (manda el correo con el link), 'link' (solo el link),
//           'revoke' (el paciente retiró su consentimiento; exige consent_id),
//           'revoke_recording' (retiró SOLO la grabación; exige consent_id y via — H1 de 81-revision).
export const POST: APIRoute = async ({ request, url }) => {
  let body: Record<string, string>;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Body inválido.' }, 400); }

  const action    = (body.action ?? '').trim();
  const patientId = (body.patient_id ?? '').trim();
  if (!patientId) return json({ ok: false, error: 'Falta el paciente.' }, 400);

  const { data: patient } = await supabase.from('patients')
    .select('id, name, email, phone').eq('id', patientId).maybeSingle();
  if (!patient) return json({ ok: false, error: 'Paciente no encontrado.' }, 404);

  // 'revoke' (retiro completo) y 'revoke_recording' (H1: retirar SOLO la autorización de grabación)
  // exigen consent_id: Vale elige a la persona en la ficha (en pareja, cada uno tiene su firma).
  if (action === 'revoke' || action === 'revoke_recording') {
    const consentId = (body.consent_id ?? '').trim();
    if (!UUID.test(consentId)) return json({ ok: false, error: 'Elige de quién es el retiro.' }, 400);
    const note = (body.note ?? '').trim().slice(0, 500) || null;
    const { data: firmado, error: ef } = await supabase.from('consents')
      .select('*') // '*' y no la lista: sin la migración 0019 (recording_revoked_at) el retiro completo sigue funcionando (revisión final N1)
      .eq('id', consentId).maybeSingle();
    if (ef) return json({ ok: false, error: 'No se pudo leer el consentimiento. Intenta de nuevo.' }, 500);
    if (!firmado || firmado.patient_id !== patientId || !firmado.signed_at) {
      return json({ ok: false, error: 'Ese consentimiento no es de esta ficha.' }, 404);
    }
    if (firmado.revoked_at) return json({ ok: false, error: 'Ese consentimiento ya estaba retirado.' }, 409);
    const ahora = new Date().toISOString();

    if (action === 'revoke') {
      const { error } = await supabase.from('consents').update({ revoked_at: ahora, revoked_note: note })
        .eq('id', firmado.id).is('revoked_at', null);
      if (error) return json({ ok: false, error: 'No se pudo registrar el retiro. Intenta de nuevo.' }, 500);
      await auditar('vale', 'retiro_consentimiento' as AccionAuditoria, { patientId, request, detalle: { consent_id: firmado.id, alcance: 'completo' } });
      return json({ ok: true });
    }

    const via = (body.via ?? '').trim();
    if (!CANALES_RETIRO.includes(via)) return json({ ok: false, error: 'Indica cómo lo pidió (correo, WhatsApp, en persona u otro).' }, 400);
    if (!firmado.accept_recording) return json({ ok: false, error: 'Esa persona no había autorizado la grabación.' }, 409);
    if (firmado.recording_revoked_at) return json({ ok: true, sin_cambios: true });
    const { error } = await supabase.from('consents')
      .update({ recording_revoked_at: ahora, recording_revoked_via: via, recording_revoked_note: note })
      .eq('id', firmado.id).is('recording_revoked_at', null);
    if (error) {
      console.warn('[admin/consent] retiro de grabación:', error.code);
      return json({ ok: false, error: error.code === '42703' ? 'Falta actualizar la base de datos (migración 0019) para registrar este retiro.' : 'No se pudo registrar el retiro. Intenta de nuevo.' }, 500);
    }
    await auditar('vale', 'retiro_grabacion' as AccionAuditoria, { patientId, request, detalle: { consent_id: firmado.id, canal: via } });
    return json({ ok: true });
  }

  if (!['whatsapp', 'email', 'link'].includes(action)) return json({ ok: false, error: 'Acción no válida.' }, 400);

  let c: { id: string; token: string };
  try { c = await getOrCreatePendingConsent(patientId); }
  catch (e) { return json({ ok: false, error: e instanceof Error ? e.message : 'Error' }, 500); }
  const link = consentUrl(url.origin, c.token);

  if (action === 'link') return json({ ok: true, url: link });

  if (action === 'whatsapp') {
    const phone = (patient.phone ?? '').replace(/\D/g, '');
    if (!phone) return json({ ok: false, error: 'El paciente no tiene teléfono en su ficha.' }, 400);
    const text = whatsappConsentMessage(patient.name.split(' ')[0], link);
    await supabase.from('consents').update({ sent_at: new Date().toISOString(), sent_via: 'whatsapp' }).eq('id', c.id);
    return json({ ok: true, url: link, waUrl: `https://wa.me/${phone}?text=${encodeURIComponent(text)}` });
  }

  // email
  if (!patient.email) return json({ ok: false, error: 'El paciente no tiene correo en su ficha.' }, 400);
  const res = await sendConsentLinkEmail({ patientName: patient.name, patientEmail: patient.email, url: link });
  if (!res.sent) return json({ ok: false, error: res.reason ?? 'No se pudo enviar.' }, 500);
  await supabase.from('consents').update({ sent_at: new Date().toISOString(), sent_via: 'email' }).eq('id', c.id);
  return json({ ok: true, url: link });
};
