import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { logError, logInfo } from '../../lib/logger';
import { normalizeRut } from '../../lib/apigateway';
import { rutValido } from '../../lib/rut';
import { sendConsentSignedCopy } from '../../lib/email';
import { CONSENT_OPTIONS, CONSENT_VERSION, consentContactEmail, consentPlainText, personaConsent, sha256 } from '../../lib/consent';
import { rutYaFirmoEnFicha } from '../../lib/transcriptor/pareja';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/consentimiento — firma pública desde /consentimiento/<token>.
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }

  const token = String(body.token ?? '').trim();
  const name  = String(body.signer_name ?? '').trim().slice(0, 200);
  const rutTexto = String(body.signer_rut ?? '').trim().slice(0, 60);
  const acc = {
    accept_treatment:   body.accept_treatment === true,
    accept_recording:   body.accept_recording === true,
    accept_case_review: body.accept_case_review === true,
  };

  if (!token) return json({ ok: false, error: 'Link no válido.' }, 400);
  // La paciente debe firmar el mismo texto que vio (12 oct 2026): si la página
  // se abrió con una versión anterior del consentimiento, se le pide recargar.
  if (body.version !== undefined && String(body.version) !== CONSENT_VERSION) {
    return json({ ok: false, error: 'El texto del consentimiento se actualizó. Recarga la página para leer la versión vigente y firmar.' }, 409);
  }
  if (name.length < 3) return json({ ok: false, error: 'Escribe tu nombre completo.' }, 400);
  if (!acc.accept_treatment) return json({ ok: false, error: 'La autorización 1 es necesaria para poder atenderte.' }, 400);

  // select('*'): sin la migración 0021 (columna persona) la firma de siempre sigue funcionando.
  const { data: consent } = await supabase.from('consents')
    .select('*').eq('token', token).maybeSingle();
  if (!consent || !consent.patient_id) return json({ ok: false, error: 'Link no válido.' }, 404);
  if (consent.signed_at) return json({ ok: false, error: 'Este consentimiento ya fue firmado.' }, 409);

  const { data: patient } = await supabase.from('patients')
    .select('*').eq('id', consent.patient_id).maybeSingle();

  // Segunda persona de una pareja (0021, decisión D): firma SU consentimiento, ligado a la misma
  // ficha. No se usan los datos de la ficha (son de la persona agendada) ni se copian a ella.
  const esPareja2 = personaConsent(consent) === 2;

  // Con RUT chileno: formato y dígito verificador. Extranjera/o sin RUT
  // (marcado en su ficha; la pareja lo marca en la página): firma con su documento de identidad.
  const sinRut = esPareja2 ? body.sin_rut === true : (patient?.sin_rut === true && !patient?.rut);
  const rut = sinRut ? rutTexto : normalizeRut(rutTexto).toUpperCase();
  if (sinRut ? !/^[\w.\- ]{4,40}$/.test(rut) : !rutValido(rut)) {
    return json({ ok: false, error: sinRut ? 'Escribe el número de tu documento.' : 'Revisa tu RUT: escríbelo con guion, por ejemplo 12345678-9.' }, 400);
  }
  let correoPareja: string | null = null;
  if (esPareja2) {
    // Dos firmas de la misma persona no valen como dos (consentimiento.ts agrupa por RUT): se avisa aquí.
    const { data: otras, error: eo } = await supabase.from('consents')
      .select('id, signed_at, signer_rut, signer_email, signer_name').eq('patient_id', consent.patient_id).neq('id', consent.id);
    if (eo) return json({ ok: false, error: 'No se pudo guardar tu firma. Intenta de nuevo.' }, 500);
    if (rutYaFirmoEnFicha(rut, otras ?? [], patient?.rut)) {
      return json({ ok: false, error: 'Ese RUT o documento ya firmó en esta ficha. Cada persona de la pareja firma con el suyo.' }, 409);
    }
    const e = String(body.signer_email ?? '').trim().toLowerCase().slice(0, 200);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return json({ ok: false, error: 'Revisa tu correo (o déjalo en blanco).' }, 400);
    correoPareja = e || null;
  }

  const contactEmail = await consentContactEmail();
  const plainText = consentPlainText(contactEmail);
  const signedAt = new Date().toISOString();

  // `.is('signed_at', null)` evita una doble firma si se aprieta dos veces.
  const { data: updated, error } = await supabase.from('consents').update({
    ...acc,
    version:       CONSENT_VERSION,
    signed_at:     signedAt,
    signer_name:   name,
    signer_rut:    rut,
    signer_email:  esPareja2 ? correoPareja : (patient?.email ?? null),
    text_snapshot: plainText,
    text_sha256:   sha256(plainText),
    ip:            request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
    user_agent:    request.headers.get('user-agent')?.slice(0, 500) ?? null,
  }).eq('id', consent.id).is('signed_at', null).select('id').maybeSingle();

  if (error) {
    await logError('consentimiento/firma', 'No se pudo guardar la firma del consentimiento', { consentId: consent.id, error: error.message });
    return json({ ok: false, error: 'No se pudo guardar tu firma. Intenta de nuevo.' }, 500);
  }
  if (!updated) return json({ ok: false, error: 'Este consentimiento ya fue firmado.' }, 409);

  // Guardar el RUT en la ficha si no lo tenía (sirve también para las boletas).
  if (patient && !patient.rut && !sinRut && !esPareja2) await supabase.from('patients').update({ rut }).eq('id', patient.id);

  await logInfo('consentimiento/firma', `Consentimiento firmado por ${name}${esPareja2 ? ' (pareja)' : ''}`, { consentId: consent.id, patientId: consent.patient_id, persona: esPareja2 ? 2 : 1, ...acc });

  try {
    const fecha = new Date(signedAt).toLocaleString('es-CL', { timeZone: 'America/Santiago', dateStyle: 'long', timeStyle: 'short' });
    const marcadas = CONSENT_OPTIONS.map(o => `${acc[o.key] ? 'Sí' : 'No'} — ${o.titulo}`);
    await sendConsentSignedCopy({
      to: [...new Set([esPareja2 ? correoPareja : patient?.email, contactEmail].filter(Boolean) as string[])],
      signerName: name, signerRut: rut, signedAt: fecha, plainText, marcadas,
    });
  } catch (e) {
    await logError('consentimiento/copia', 'Firmado OK, pero no se pudo enviar la copia por correo', { consentId: consent.id, error: e instanceof Error ? e.message : String(e) });
  }

  return json({ ok: true });
};
