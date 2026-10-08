import { supabase } from './supabase';
import { logError } from './logger';
import { sendStepsEmail, sendConsentLinkEmail } from './email';
import { getOrCreatePendingConsent, consentUrl, vigente, type ConsentRow } from './consent';
import { limpiarRut, RUT_EXTRANJERO_SII } from './rut';

// Crea o actualiza la ficha del paciente en `patients` a partir de los datos
// de una reserva. Se llama cada vez que una reserva pasa a `confirmed` —
// así el paciente queda buscable de inmediato (ej. al reagendar desde el
// calendario) sin que haya que crearlo a mano después.
// Devuelve el id de la ficha (creada o existente) — algunos llamadores (ej. el
// link de pago combinado /pagar/[id]) necesitan el id de inmediato, no solo
// que la ficha quede creada en algún momento posterior.
export interface DatosFicha {
  patient_name?: string | null;
  patient_email?: string | null;
  patient_phone?: string | null;
  rut?: string | null;
  // Datos mínimos de la ficha (Valentina, 4 oct 2026). Opcionales aquí porque
  // no todos los caminos los traen (ej. un cobro); la reserva web y el panel sí.
  address?: string | null;
  comuna?: string | null;
  emergency_name?: string | null;
  emergency_phone?: string | null;
  sin_rut?: boolean | null;
  doc_tipo?: string | null;
  doc_numero?: string | null;
  doc_pais?: string | null;
}

const NUEVAS = ['comuna', 'sin_rut', 'doc_tipo', 'doc_numero', 'doc_pais'];

export async function upsertPatientFromBooking(b: DatosFicha, opts: { actualizarRut?: boolean } = {}): Promise<string | null> {
  const email = b.patient_email?.trim().toLowerCase();
  const name  = b.patient_name?.trim();
  if (!email || !name) return null;
  // El RUT genérico del SII para extranjeros (44.444.446-0) no es el RUT de
  // la persona: no se guarda como su RUT; se marca "sin RUT".
  const rutLimpio = limpiarRut(b.rut);
  const esGenerico = rutLimpio === RUT_EXTRANJERO_SII;
  const rut = esGenerico ? '' : (b.rut?.trim() ?? '');
  const sinRut = b.sin_rut === true || esGenerico;
  const t = (v: string | null | undefined) => v?.trim() || '';

  try {
    const { data: existing } = await supabase
      .from('patients')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      // Una ficha que ya existe NO se sobrescribe con lo que venga de una
      // reserva o un cobro (3 oct 2026): antes cada reserva pisaba nombre,
      // teléfono y RUT, así que otra persona que reservara con ese correo (ej.
      // la pareja) cambiaba el RUT con que salen las boletas, y se perdían las
      // correcciones hechas a mano en la ficha. Solo se completan datos vacíos.
      // Excepción: el RUT que Valentina escribe al emitir una boleta
      // (actualizarRut), que es una corrección explícita suya.
      const cambios: Record<string, string | boolean> = {};
      // Paciente dada de baja que vuelve a reservar: se reactiva (si no, no
      // aparecía en la agenda del panel ni en los avisos de consentimiento).
      if (existing.active === false) cambios.active = true;
      if (!existing.name?.trim()) cambios.name = name;
      if (!existing.phone?.trim() && t(b.patient_phone)) cambios.phone = t(b.patient_phone);
      if (rut && (opts.actualizarRut || !existing.rut?.trim())) cambios.rut = rut;
      if (!existing.address?.trim() && t(b.address)) cambios.address = t(b.address);
      if (!existing.emergency_name?.trim() && t(b.emergency_name)) cambios.emergency_name = t(b.emergency_name);
      if (!existing.emergency_phone?.trim() && t(b.emergency_phone)) cambios.emergency_phone = t(b.emergency_phone);
      if ('comuna' in existing) {
        if (!existing.comuna?.trim() && t(b.comuna)) cambios.comuna = t(b.comuna);
        if (sinRut && !existing.rut?.trim() && !existing.sin_rut) cambios.sin_rut = true;
        if (!existing.doc_numero?.trim() && t(b.doc_numero)) {
          cambios.doc_numero = t(b.doc_numero);
          if (t(b.doc_tipo)) cambios.doc_tipo = t(b.doc_tipo);
          if (t(b.doc_pais)) cambios.doc_pais = t(b.doc_pais);
        }
      }
      if (Object.keys(cambios).length) await supabase.from('patients').update(cambios).eq('id', existing.id);
      return existing.id;
    } else {
      const fila: Record<string, string | boolean | null> = {
        name,
        email,
        phone:           t(b.patient_phone) || null,
        rut:             rut || null,
        address:         t(b.address) || null,
        emergency_name:  t(b.emergency_name) || null,
        emergency_phone: t(b.emergency_phone) || null,
        comuna:          t(b.comuna) || null,
        sin_rut:         sinRut,
        doc_tipo:        sinRut ? (t(b.doc_tipo) || null) : null,
        doc_numero:      sinRut ? (t(b.doc_numero) || null) : null,
        doc_pais:        sinRut ? (t(b.doc_pais) || null) : null,
      };
      let { data: inserted, error } = await supabase.from('patients').insert(fila).select('id').single();
      if (error?.code === '42703') {
        // Migración 0006 aún no corrida: se guarda sin las columnas nuevas.
        for (const k of NUEVAS) delete fila[k];
        ({ data: inserted, error } = await supabase.from('patients').insert(fila).select('id').single());
      }
      if (error) throw new Error(error.message);
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
    // ilike sin comodines: un "_" o "%" en el correo no debe calzar con otro.
    const { data: previos } = await supabase.from('bookings').select('id')
      .ilike('patient_email', email.replace(/[\\%_]/g, (c) => `\\${c}`)).not('paid_at', 'is', null)
      .neq('status', 'cancelled'); // un pago de una sesión cancelada no cuenta como primer pago
    if ((previos ?? []).some(p => !paidBookingIds.includes(p.id))) return;

    const patientId = await upsertPatientFromBooking(b);
    if (!patientId) return;

    // Marcar antes de enviar (con guardia `is null`) evita un doble envío si
    // Flow reintenta el webhook al mismo tiempo.
    const { data: marcado } = await supabase.from('patients')
      .update({ steps_sent_at: new Date().toISOString() })
      .eq('id', patientId).is('steps_sent_at', null).select('id, name').maybeSingle();
    if (!marcado) {
      // "Pasos a seguir" ya se había mandado a mano (botón de la ficha o
      // WhatsApp): igual corresponde el consentimiento en su primer pago.
      // Antes se saltaba y la paciente nunca lo recibía sola.
      const { data: p } = await supabase.from('patients').select('name').eq('id', patientId).maybeSingle();
      await enviarConsentimientoSiFalta(patientId, p?.name ?? b.patient_name ?? '', email);
      return;
    }

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
