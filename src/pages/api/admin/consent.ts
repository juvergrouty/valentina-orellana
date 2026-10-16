import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendConsentLinkEmail } from '../../../lib/email';
import { consentUrl, FaltaMigracion0021, getOrCreatePendingConsent, whatsappConsentMessage } from '../../../lib/consent';
import { correoParejaValido, estadoPareja, fichaEsParejaPorReserva, resumenEstadoPareja, urlWhatsAppPareja } from '../../../lib/transcriptor/pareja';
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
//           'revoke_recording' (retiró SOLO la grabación; exige consent_id y via — H1 de 81-revision),
//           'pareja_link' / 'pareja_whatsapp' (consentimiento de la SEGUNDA persona de una pareja:
//           otro consentimiento, persona = 2, ligado a esta ficha; solo si la ficha tiene una reserva
//           de pareja — decisión D del 16 oct noche),
//           'pareja_email' (manda ese link al correo que escribe Vale; el correo NO se guarda),
//           'pareja_estado' (¿ya firmó la segunda persona? — lo consulta la ficha mientras muestra el QR).
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

  // ¿Ya firmó la segunda persona? (la ficha lo consulta mientras muestra el QR en la consulta).
  if (action === 'pareja_estado') {
    const { data: filas, error: ec } = await supabase.from('consents').select('*').eq('patient_id', patientId).limit(200);
    if (ec) return json({ ok: false, error: 'No se pudo revisar la firma. Intenta de nuevo.' }, 500);
    const { data: pr } = await supabase.from('patients').select('rut').eq('id', patientId).maybeSingle();
    return json({ ok: true, ...resumenEstadoPareja(estadoPareja(filas ?? [], (pr as { rut?: string | null } | null)?.rut, patient.name)) });
  }

  if (action === 'pareja_link' || action === 'pareja_whatsapp' || action === 'pareja_email') {
    // pareja_email: el correo SOLO se usa para este envío; no se guarda en la ficha ni en el consentimiento.
    const correoPareja = action === 'pareja_email' ? correoParejaValido(body.email) : null;
    if (action === 'pareja_email' && !correoPareja) return json({ ok: false, error: 'Revisa el correo: no parece válido.' }, 400);
    if (correoPareja && correoPareja === String(patient.email ?? '').trim().toLowerCase()) {
      return json({ ok: false, error: 'Ese es el correo de la persona agendada. Escribe el de la segunda persona.' }, 400);
    }
    let esPareja: boolean;
    try { esPareja = await fichaEsParejaPorReserva(supabase, patient.email); }
    catch { return json({ ok: false, error: 'No se pudieron revisar las reservas. Intenta de nuevo.' }, 500); }
    if (!esPareja) return json({ ok: false, error: 'Esta ficha no tiene reservas de pareja.' }, 409);
    let p2: { id: string; token: string };
    try { p2 = await getOrCreatePendingConsent(patientId, 2); }
    catch (e) {
      if (!(e instanceof FaltaMigracion0021)) console.warn('[admin/consent] link de la pareja:', e instanceof Error ? e.message : e);
      return json({ ok: false, error: e instanceof FaltaMigracion0021 ? e.message : 'No se pudo crear el link de la pareja. Intenta de nuevo.' }, 500);
    }
    const linkP2 = consentUrl(url.origin, p2.token);
    if (action === 'pareja_link') return json({ ok: true, url: linkP2 });
    if (correoPareja) {
      const res = await sendConsentLinkEmail({ patientName: '', patientEmail: correoPareja, url: linkP2 });
      if (!res.sent) return json({ ok: false, error: 'No se pudo enviar el correo. Intenta de nuevo o usa WhatsApp.' }, 500);
      await supabase.from('consents').update({ sent_at: new Date().toISOString(), sent_via: 'email' }).eq('id', p2.id).is('signed_at', null);
      return json({ ok: true, url: linkP2 });
    }
    await supabase.from('consents').update({ sent_at: new Date().toISOString(), sent_via: 'whatsapp' }).eq('id', p2.id).is('signed_at', null);
    return json({ ok: true, url: linkP2, waUrl: urlWhatsAppPareja(String(patient.name ?? '').split(' ')[0], linkP2) });
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
