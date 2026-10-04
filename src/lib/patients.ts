import { supabase } from './supabase';
import { logError } from './logger';
import { sendStepsEmail, sendConsentLinkEmail } from './email';
import { getOrCreatePendingConsent, consentUrl, vigente, type ConsentRow } from './consent';

// Crea o actualiza la ficha del paciente en `patients` a partir de los datos
// de una reserva. Se llama cada vez que una reserva pasa a `confirmed` —
// así el paciente queda buscable de inmediato (ej. al reagendar desde el
// calendario) sin que haya que crearlo a mano después.
// Devuelve el id de la ficha (creada o existente) — algunos llamadores (ej. el
// link de pago combinado /pagar/[id]) necesitan el id de inmediato, no solo
// que la ficha quede creada en algún momento posterior.
export async function upsertPatientFromBooking(b: {
  patient_name?: string | null;
  patient_email?: string | null;
  patient_phone?: string | null;
  rut?: string | null;
}): Promise<string | null> {
  const email = b.patient_email?.trim().toLowerCase();
  const name  = b.patient_name?.trim();
  if (!email || !name) return null;

  try {
    const { data: existing } = await supabase
      .from('patients')
      .select('id, phone, rut')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      // No pisar un teléfono/RUT ya guardado con uno vacío.
      const phone = b.patient_phone?.trim() || existing.phone;
      const rut   = b.rut?.trim() || existing.rut;
      await supabase.from('patients').update({ name, phone, rut }).eq('id', existing.id);
      return existing.id;
    } else {
      const { data: inserted } = await supabase.from('patients').insert({
        name,
        email,
        phone: b.patient_phone?.trim() || null,
        rut:   b.rut?.trim() || null,
      }).select('id').single();
      return inserted?.id ?? null;
    }
  } catch (err) {
    console.error('[patients] upsertPatientFromBooking:', err);
    await logError('patients/upsert', 'No se pudo crear/actualizar la ficha del paciente tras su reserva', { email, name, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// "Pasos a seguir": se envía solo una vez por paciente, automático cuando paga
// su primera sesión (pedido de Valentina, 3 oct 2026). Después solo sale si
// ella lo reenvía con el botón de la ficha. `paidBookingIds` son las reservas
// recién pagadas en este evento: si el paciente ya tenía otra pagada antes, no
// es su primer pago y no se envía.
export async function sendStepsOnFirstPayment(b: {
  patient_name?: string | null;
  patient_email?: string | null;
  patient_phone?: string | null;
  rut?: string | null;
}, paidBookingIds: string[]): Promise<void> {
  const email = b.patient_email?.trim().toLowerCase();
  if (!email) return;
  try {
    const { data: previos } = await supabase.from('bookings').select('id')
      .ilike('patient_email', email).not('paid_at', 'is', null);
    if ((previos ?? []).some(p => !paidBookingIds.includes(p.id))) return;

    const patientId = await upsertPatientFromBooking(b);
    if (!patientId) return;

    // Marcar antes de enviar (con guardia `is null`) evita un doble envío si
    // Flow reintenta el webhook al mismo tiempo.
    const { data: marcado } = await supabase.from('patients')
      .update({ steps_sent_at: new Date().toISOString() })
      .eq('id', patientId).is('steps_sent_at', null).select('id, name').maybeSingle();
    if (!marcado) return;

    const { data: addr } = await supabase.from('settings').select('value').eq('key', 'clinic_address').maybeSingle();
    const res = await sendStepsEmail({ patientName: marcado.name, patientEmail: email, clinicAddress: addr?.value ?? '' });
    if (!res.sent) {
      await supabase.from('patients').update({ steps_sent_at: null }).eq('id', patientId);
      await logError('email/pasos-automatico', `No se pudo enviar "Pasos a seguir" a ${email} tras su primer pago`, { email, error: res.reason });
      return;
    }
    // "Pasos a seguir" promete "te llegará un link para firmar el
    // consentimiento": se manda junto, en el primer pago (Valentina, 3 oct 2026).
    await enviarConsentimientoSiFalta(patientId, marcado.name, email);
  } catch (err) {
    await logError('email/pasos-automatico', 'Error al enviar "Pasos a seguir" tras el primer pago', { email, error: err instanceof Error ? err.message : String(err) });
  }
}

// Manda por correo el link del consentimiento informado si el paciente no
// tiene uno vigente firmado ni uno ya enviado esperando firma. Mismo link y
// mismo registro (sent_at/sent_via) que el botón "Enviar por correo" de la ficha.
export async function enviarConsentimientoSiFalta(patientId: string, name: string, email: string): Promise<void> {
  try {
    const { data: rows } = await supabase.from('consents').select('*').eq('patient_id', patientId);
    const lista = (rows ?? []) as ConsentRow[];
    if (vigente(lista)) return;                                  // ya firmó
    if (lista.some(r => !r.signed_at && r.sent_at)) return;      // ya se le mandó y está pendiente
    const c = await getOrCreatePendingConsent(patientId);
    const url = consentUrl('https://www.valentinaorellana.cl', c.token);
    const res = await sendConsentLinkEmail({ patientName: name, patientEmail: email, url });
    if (!res.sent) {
      await logError('consentimiento/automatico', `No se pudo enviar el consentimiento a ${email} tras su primer pago`, { patientId, error: res.reason });
      return;
    }
    await supabase.from('consents').update({ sent_at: new Date().toISOString(), sent_via: 'email' }).eq('id', c.id);
  } catch (e) {
    await logError('consentimiento/automatico', 'Error al enviar el consentimiento tras el primer pago', { patientId, error: e instanceof Error ? e.message : String(e) });
  }
}
