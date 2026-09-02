import { supabase } from './supabase';

// Crea o actualiza la ficha del paciente en `patients` a partir de los datos
// de una reserva. Se llama cada vez que una reserva pasa a `confirmed` —
// así el paciente queda buscable de inmediato (ej. al reagendar desde el
// calendario) sin que haya que crearlo a mano después.
export async function upsertPatientFromBooking(b: {
  patient_name?: string | null;
  patient_email?: string | null;
  patient_phone?: string | null;
}): Promise<void> {
  const email = b.patient_email?.trim().toLowerCase();
  const name  = b.patient_name?.trim();
  if (!email || !name) return;

  try {
    const { data: existing } = await supabase
      .from('patients')
      .select('id, phone')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      // No pisar un teléfono ya guardado con uno vacío.
      const phone = b.patient_phone?.trim() || existing.phone;
      await supabase.from('patients').update({ name, phone }).eq('id', existing.id);
    } else {
      await supabase.from('patients').insert({
        name,
        email,
        phone: b.patient_phone?.trim() || null,
      });
    }
  } catch (err) {
    console.error('[patients] upsertPatientFromBooking:', err);
  }
}
