import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendConsentLinkEmail } from '../../../lib/email';
import { consentUrl, getOrCreatePendingConsent, whatsappConsentMessage } from '../../../lib/consent';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/admin/consent — botones del consentimiento en la ficha.
// Acciones: 'whatsapp' (devuelve link de wa.me y registra el envío),
//           'email' (manda el correo con el link), 'link' (solo el link),
//           'revoke' (el paciente retiró su consentimiento).
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

  if (action === 'revoke') {
    const note = (body.note ?? '').trim().slice(0, 500) || null;
    const { data: firmado } = await supabase.from('consents').select('id')
      .eq('patient_id', patientId).not('signed_at', 'is', null).is('revoked_at', null)
      .order('signed_at', { ascending: false }).limit(1).maybeSingle();
    if (!firmado) return json({ ok: false, error: 'No hay un consentimiento vigente que retirar.' }, 400);
    await supabase.from('consents').update({ revoked_at: new Date().toISOString(), revoked_note: note }).eq('id', firmado.id);
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
