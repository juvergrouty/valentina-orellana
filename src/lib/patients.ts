import { supabase } from './supabase';
import { logError } from './logger';

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
