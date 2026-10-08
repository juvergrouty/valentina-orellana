import type { APIRoute } from 'astro';
import { normalizarTelefono } from '../../../lib/contacto';
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

const MSG_TELEFONO = 'teléfono bien escrito (en Chile 9 dígitos; de otro país, con + y el código)';

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
    // Teléfonos guardados siempre como +<código><número> (si son válidos).
    phone:            normalizarTelefono(g('phone')) ?? (g('phone') || null),
    rut:              sinRut ? null : (g('rut') ? limpiarRut(g('rut')) : null),
    birthdate:        g('birthdate') || null,
    address:          g('address') || null,
    comuna:           g('comuna') || null,
    emergency_name:   g('emergency_name') || null,
    emergency_phone:  normalizarTelefono(g('emergency_phone')) ?? (g('emergency_phone') || null),
    notes:            g('notes') || null,
    sin_rut:          sinRut,
    doc_tipo:         sinRut ? (g('doc_tipo') || null) : null,
    doc_numero:       sinRut ? (g('doc_numero') || null) : null,
    doc_pais:         sinRut ? (g('doc_pais') || null) : null,
  });
  // Un teléfono escrito pero mal (ni chileno de 9 dígitos ni +código válido).
  // `guardados`: teléfonos que ya tenía la ficha. Si no se cambiaron, no se
  // revisan ni se tocan (fichas antiguas con fijos de 8 dígitos, anotaciones…),
  // para no impedir guardar otros datos de la ficha.
  const telefonoMal = (guardados: Record<string, string | null> = {}) =>
    ['phone', 'emergency_phone'].some(k => g(k) && g(k) !== (guardados[k] ?? '').trim() && !normalizarTelefono(g(k)));
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
    if (telefonoMal()) faltan.push(MSG_TELEFONO);
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
    const { data: actual } = await supabase.from('patients').select('phone, emergency_phone, email').eq('id', id).maybeSingle();
    const guardados = { phone: actual?.phone ?? null, emergency_phone: actual?.emergency_phone ?? null };
    for (const k of ['phone', 'emergency_phone'] as const) {
      if (g(k) && g(k) === (guardados[k] ?? '').trim()) d[k] = guardados[k];
    }
    if (!sinRut && d.rut && !rutValido(String(d.rut))) {
      redirect = withParam(redirect, 'error', 'El RUT no es válido: revisa los números y el dígito verificador.');
    } else if (telefonoMal(guardados)) {
      redirect = withParam(redirect, 'error', `Revisa el teléfono: ${MSG_TELEFONO}.`);
    } else {
      let { error } = await supabase.from('patients').update(d).eq('id', id);
      if (error?.code === '42703') ({ error } = await supabase.from('patients').update(sinNuevas(d)).eq('id', id));
      if (error) {
        console.error('[patients] update:', error.message);
        redirect = withParam(redirect, 'error', `No se pudo guardar: ${error.message}`);
      } else {
        // Las sesiones se vinculan a la ficha por correo: si se corrigió el
        // correo, sus sesiones (y deudas, boletas) lo siguen. Antes la ficha
        // quedaba "sin sesiones" tras corregir un correo (auditoría 8 oct 2026).
        const viejo = String(actual?.email ?? '').trim().toLowerCase();
        const nuevo = String(d.email ?? '').trim().toLowerCase();
        if (viejo && nuevo && viejo !== nuevo) {
          const { error: e2 } = await supabase.from('bookings').update({ patient_email: nuevo }).eq('patient_email', viejo);
          if (e2) redirect = withParam(redirect, 'error', `Se guardó la ficha, pero no se pudieron mover sus sesiones al correo nuevo: ${e2.message}`);
        }
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
    // Sin guardar, se avisa en la ficha (8 oct 2026): antes volvía como si la
    // nota hubiera quedado guardada y se perdía lo escrito sin saberlo.
    if (error) {
      console.error('[session_notes] add:', error.message);
      redirect = withParam(redirect, 'error', `La nota NO quedó guardada (${error.message}). Escríbela de nuevo e inténtalo otra vez.`);
    }
  }

  // ── Editar nota: se guarda la versión anterior (nunca se pisa) ──────────────
  // La ficha clínica se conserva 15 años (re-auditoría 5 oct 2026).
  if (action === 'update_note') {
    const id      = form.get('id') as string;
    const content = (form.get('content') as string)?.trim();
    if (id && content) {
      const { data: actual, error: lecturaErr } = await supabase.from('session_notes').select('*').eq('id', id).maybeSingle();
      if (lecturaErr || !actual) {
        redirect = withParam(redirect, 'error', 'No se pudo leer la nota para guardarla.');
      } else if (!('historial' in actual)) {
        redirect = withParam(redirect, 'error', 'Falta activar el historial de notas en la base de datos (migración 0007). La nota no se modificó.');
      } else if (actual.content !== content) {
        const historial = Array.isArray(actual.historial) ? actual.historial : [];
        historial.push({ content: actual.content, reemplazada: new Date().toISOString() });
        const { error } = await supabase.from('session_notes').update({ content, historial }).eq('id', id);
        if (error) redirect = withParam(redirect, 'error', `No se pudo guardar la nota: ${error.message}`);
      }
    }
  }

  // ── "Eliminar" nota = archivarla (deja de verse; no se borra) ───────────────
  if (action === 'delete_note') {
    const id = form.get('id') as string;
    if (id) {
      const { error } = await supabase.from('session_notes').update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) {
        redirect = withParam(redirect, 'error', (error.code === '42703' || error.code === 'PGRST204')
          ? 'Falta activar el archivo de notas en la base de datos (migración 0007). La nota no se modificó.'
          : `No se pudo archivar la nota: ${error.message}`);
      }
    }
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
