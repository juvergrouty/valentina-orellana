import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { RUT_EXTRANJERO_SII } from '../../lib/rut';

export const prerender = false;

// POST /api/recuperar-datos { token } — datos de una reserva que se liberó
// por falta de pago, para precargar la agenda cuando la paciente vuelve desde
// el correo "tu hora se liberó" y esa hora ya no está disponible (Valentina,
// 4 oct 2026): elige otra hora del mismo servicio sin volver a escribir todo.
// Solo con el token secreto del correo y solo para reservas vencidas. El token
// viaja en el cuerpo (no en la URL) para que no quede en registros ni en
// herramientas de analítica.
export const POST: APIRoute = async ({ request }) => {
  let token = '';
  try { token = String((await request.json())?.token ?? '').trim(); } catch { /* vacío */ }
  if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ ok: false }, 400);

  const { data: b } = await supabase.from('bookings')
    .select('patient_name, patient_email, patient_phone, patient_rut, session_type, service_id, notes')
    .eq('recovery_token', token).eq('status', 'expired').maybeSingle();
  if (!b) return json({ ok: false }, 404);

  const { data: p } = b.patient_email
    ? await supabase.from('patients').select('*').eq('email', String(b.patient_email).toLowerCase()).maybeSingle()
    : { data: null };
  const sinRut = b.patient_rut === RUT_EXTRANJERO_SII || (p?.sin_rut === true && !p?.rut);
  const motivo = /^Motivo: (.+)$/m.exec(b.notes ?? '')?.[1] ?? '';

  return json({
    ok: true,
    serviceId: b.service_id,
    modalidad: String(b.session_type ?? '').includes('online') ? 'online' : 'presencial',
    datos: {
      nombre:    b.patient_name ?? '',
      correo:    b.patient_email ?? '',
      telefono:  String(b.patient_phone ?? ''),
      rut:       sinRut ? '' : (b.patient_rut ?? p?.rut ?? ''),
      sinRut,
      docTipo:   p?.doc_tipo ?? '',
      docNumero: p?.doc_numero ?? '',
      docPais:   p?.doc_pais ?? '',
      direccion: p?.address ?? '',
      comuna:    p?.comuna ?? '',
      emergNombre:   p?.emergency_name ?? '',
      emergTelefono: p?.emergency_phone ?? '',
      motivo,
    },
  });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
