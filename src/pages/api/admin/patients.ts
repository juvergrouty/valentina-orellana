import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { limpiarRut, rutValido } from '../../../lib/rut';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Agrega un parámetro de query a la URL de redirect (respeta los que ya tenga)
function withParam(path: string, key: string, value: string): string {
  const u = new URL(path, 'http://local');
  u.searchParams.delete('saved'); // si hubo error, no mostrar también "guardado"
  u.searchParams.set(key, value);
  return u.pathname + '?' + u.searchParams.toString();
}

export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const action   = form.get('action') as string;
  let   redirect = rutaInterna(form.get('redirect'), '/admin/pacientes');

  // Datos de la ficha que vienen del formulario (crear y editar).
  const g = (k: string) => (form.get(k) as string | null)?.trim() ?? '';
  const sinRut = form.get('sin_rut') === '1';
  const datos = (): Record<string, string | boolean | null> => ({
    name:             g('name'),
    email:            g('email').toLowerCase() || null,
    phone:            g('phone') || null,
    rut:              sinRut ? null : (g('rut') ? limpiarRut(g('rut')) : null),
    birthdate:        g('birthdate') || null,
    address:          g('address') || null,
    comuna:           g('comuna') || null,
    emergency_name:   g('emergency_name') || null,
    emergency_phone:  g('emergency_phone') || null,
    notes:            g('notes') || null,
    sin_rut:          sinRut,
    doc_tipo:         sinRut ? (g('doc_tipo') || null) : null,
    doc_numero:       sinRut ? (g('doc_numero') || null) : null,
    doc_pais:         sinRut ? (g('doc_pais') || null) : null,
  });
  // Si la migración 0006 aún no corrió, se guarda sin las columnas nuevas.
  const sinNuevas = (d: Record<string, unknown>) => {
    const { comuna: _c, sin_rut: _s, doc_tipo: _t, doc_numero: _n, doc_pais: _p, ...resto } = d;
    return resto;
  };

  // ── Crear paciente ──────────────────────────────────────────────────────────
  // Datos mínimos obligatorios (Valentina, 4 oct 2026): nombre completo,
  // correo, teléfono, dirección, comuna, contacto de emergencia y RUT (o, si
  // es extranjera/o sin RUT, el documento de su país).
  if (action === 'create') {
    const d = datos();
    const faltan: string[] = [];
    if (!d.name) faltan.push('nombre');
    if (!d.email) faltan.push('correo');
    if (!d.phone) faltan.push('teléfono');
    if (!d.address) faltan.push('dirección');
    if (!d.comuna) faltan.push('comuna');
    if (!d.emergency_name || !d.emergency_phone) faltan.push('contacto de emergencia');
    if (sinRut ? (!d.doc_numero || !d.doc_pais) : !d.rut) faltan.push(sinRut ? 'documento y país' : 'RUT');
    if (!sinRut && d.rut && !rutValido(String(d.rut))) faltan.push('RUT válido (revisa el dígito verificador)');
    if (faltan.length) {
      redirect = withParam(redirect, 'error', `Falta: ${faltan.join(', ')}.`);
    } else {
      let { error } = await supabase.from('patients').insert(d);
      if (error?.code === '42703') ({ error } = await supabase.from('patients').insert(sinNuevas(d)));
      if (error) {
        console.error('[patients] create:', error.message);
        redirect = withParam(redirect, 'error', `No se pudo crear el paciente: ${error.message}`);
      }
    }
  }

  // ── Actualizar paciente ─────────────────────────────────────────────────────
  if (action === 'update') {
    const id = form.get('id') as string;
    const d = datos();
    if (!sinRut && d.rut && !rutValido(String(d.rut))) {
      redirect = withParam(redirect, 'error', 'El RUT no es válido: revisa los números y el dígito verificador.');
    } else {
      let { error } = await supabase.from('patients').update(d).eq('id', id);
      if (error?.code === '42703') ({ error } = await supabase.from('patients').update(sinNuevas(d)).eq('id', id));
      if (error) {
        console.error('[patients] update:', error.message);
        redirect = withParam(redirect, 'error', `No se pudo guardar: ${error.message}`);
      }
    }
  }

  // ── Archivar / restaurar ────────────────────────────────────────────────────
  if (action === 'archive') {
    const id     = form.get('id') as string;
    const active = form.get('active') === 'true';
    await supabase.from('patients').update({ active: !active }).eq('id', id);
  }

  // ── "Eliminar" paciente = dar de baja, nunca borrar ─────────────────────────
  // La ficha clínica se debe conservar 15 años (Valentina, 4 oct 2026): antes
  // esto borraba la ficha para siempre. Ahora queda inactiva y se puede volver
  // a dar de alta.
  if (action === 'delete') {
    const id = form.get('id') as string;
    if (id) await supabase.from('patients').update({ active: false }).eq('id', id);
  }

  // ── Agregar nota de sesión ──────────────────────────────────────────────────
  if (action === 'add_note') {
    const bookingId = (form.get('booking_id') as string) || null;
    const { error } = await supabase.from('session_notes').insert({
      patient_id:   form.get('patient_id') as string,
      booking_id:   bookingId,
      session_date: form.get('session_date') as string,
      session_type: form.get('session_type') as string,
      content:      (form.get('content') as string)?.trim(),
    });
    if (error) console.error('[session_notes] add:', error.message);
  }

  // ── Editar nota ─────────────────────────────────────────────────────────────
  if (action === 'update_note') {
    const id      = form.get('id') as string;
    const content = (form.get('content') as string)?.trim();
    if (id && content) {
      await supabase.from('session_notes').update({ content }).eq('id', id);
    }
  }

  // ── Eliminar nota ───────────────────────────────────────────────────────────
  if (action === 'delete_note') {
    await supabase.from('session_notes').delete().eq('id', form.get('id') as string);
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
