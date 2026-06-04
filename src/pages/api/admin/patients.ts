import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const action   = form.get('action') as string;
  const redirect = (form.get('redirect') as string) ?? '/admin/pacientes';

  // ── Crear paciente ──────────────────────────────────────────────────────────
  if (action === 'create') {
    const { error } = await supabase.from('patients').insert({
      name:             (form.get('name') as string)?.trim(),
      email:            (form.get('email') as string)?.trim().toLowerCase() || null,
      phone:            (form.get('phone') as string)?.trim() || null,
      rut:              (form.get('rut') as string)?.trim() || null,
      birthdate:        (form.get('birthdate') as string) || null,
      address:          (form.get('address') as string)?.trim() || null,
      emergency_name:   (form.get('emergency_name') as string)?.trim() || null,
      emergency_phone:  (form.get('emergency_phone') as string)?.trim() || null,
      notes:            (form.get('notes') as string)?.trim() || null,
    });
    if (error) console.error('[patients] create:', error.message);
  }

  // ── Actualizar paciente ─────────────────────────────────────────────────────
  if (action === 'update') {
    const id = form.get('id') as string;
    const { error } = await supabase.from('patients').update({
      name:             (form.get('name') as string)?.trim(),
      email:            (form.get('email') as string)?.trim().toLowerCase() || null,
      phone:            (form.get('phone') as string)?.trim() || null,
      rut:              (form.get('rut') as string)?.trim() || null,
      birthdate:        (form.get('birthdate') as string) || null,
      address:          (form.get('address') as string)?.trim() || null,
      emergency_name:   (form.get('emergency_name') as string)?.trim() || null,
      emergency_phone:  (form.get('emergency_phone') as string)?.trim() || null,
      notes:            (form.get('notes') as string)?.trim() || null,
    }).eq('id', id);
    if (error) console.error('[patients] update:', error.message);
  }

  // ── Archivar / restaurar ────────────────────────────────────────────────────
  if (action === 'archive') {
    const id     = form.get('id') as string;
    const active = form.get('active') === 'true';
    await supabase.from('patients').update({ active: !active }).eq('id', id);
  }

  // ── Agregar nota de sesión ──────────────────────────────────────────────────
  if (action === 'add_note') {
    const { error } = await supabase.from('session_notes').insert({
      patient_id:   form.get('patient_id') as string,
      session_date: form.get('session_date') as string,
      session_type: form.get('session_type') as string,
      content:      (form.get('content') as string)?.trim(),
    });
    if (error) console.error('[session_notes] add:', error.message);
  }

  // ── Eliminar nota ───────────────────────────────────────────────────────────
  if (action === 'delete_note') {
    await supabase.from('session_notes').delete().eq('id', form.get('id') as string);
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
