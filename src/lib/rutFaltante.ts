// Aviso obligatorio de RUT (23 nov 2026, Vale: «el sistema me debe avisar siempre que no haya rut»).
// Cada sesión pagada sin RUT sale en el Inicio («falta su RUT para la boleta», botón «Agregar RUT»),
// en la ficha y en la sesión de la agenda. No se puede descartar: desaparece cuando el RUT queda
// escrito, y entonces la boleta sale sola con la fecha del pago (fechaEmisionBoleta en apigateway.ts).
import { supabase } from './supabase';
import { limpiarRut, rutValido } from './rut';
import { upsertPatientFromBooking } from './patients';
import { encolarYEjecutar } from './tareasEnvio';
import { tieneMarca } from './horaLinkUtil';
import { MARCA_ESPERA_BANCO, MARCA_BANCO_OK } from './gmailBancoUtil';
import { MARCA_TRANSFERENCIA_REVISADA } from './comprobantes';
import { desdeRutFaltante, faltaRutParaBoleta } from './rutFaltanteUtil';
import { todayCL } from './dateUtils';

export type SinRut = { bookingId: string; paciente: string; fecha: string; hora: string; monto: number; fichaId: string | null };

const COLS = 'id, patient_name, patient_email, session_date, session_time, amount, paid_at, status, payment_note, notes, debt_voided, patient_rut, service_id';

/** Sesiones pagadas (desde el 1° del mes anterior) a las que les falta el RUT para la boleta. */
export async function sesionesSinRut(filtro: { email?: string } = {}): Promise<SinRut[]> {
  const desde = `${desdeRutFaltante(todayCL())}T03:00:00Z`; // medianoche de Chile, con margen
  let q = supabase.from('bookings').select(COLS)
    .not('paid_at', 'is', null).gte('paid_at', desde).gt('amount', 0)
    .not('status', 'in', '(cancelled,expired)')
    .order('paid_at', { ascending: true }).limit(300);
  if (filtro.email) q = q.eq('patient_email', filtro.email.toLowerCase());
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  // Servicio con «Emitir la boleta automáticamente» apagado: Vale decide la boleta a mano, no se le exige el RUT.
  const { data: sinAuto } = await supabase.from('services_catalog').select('id').eq('boleta_auto', false);
  const serviciosSinAuto = new Set((sinAuto ?? []).map((x: { id: string }) => x.id));
  const filas = (data ?? []).filter((b) => !(b.service_id && serviciosSinAuto.has(b.service_id)));
  const correos = [...new Set(filas.map((b) => String(b.patient_email ?? '').toLowerCase()).filter(Boolean))];
  const { data: fichas } = correos.length ? await supabase.from('patients').select('*').in('email', correos) : { data: [] as any[] };
  const fichaDe = new Map((fichas ?? []).map((p: any) => [String(p.email).toLowerCase(), p]));
  return filas
    .filter((b) => faltaRutParaBoleta(b, fichaDe.get(String(b.patient_email ?? '').toLowerCase())))
    .map((b) => ({
      bookingId: b.id, paciente: b.patient_name, fecha: b.session_date, hora: String(b.session_time ?? '').slice(0, 5),
      monto: b.amount ?? 0, fichaId: fichaDe.get(String(b.patient_email ?? '').toLowerCase())?.id ?? null,
    }));
}

/**
 * Vale escribe el RUT: queda en la sesión (y en la ficha, si hay correo) y la boleta sale sola con la
 * fecha del pago. Si es una transferencia que todavía espera el correo del banco, la boleta espera.
 */
export async function guardarRutYEmitir(bookingId: string, rutCrudo: string): Promise<{ ok: boolean; error?: string; boleta?: 'emitida' | 'espera_banco' | 'pendiente' }> {
  if (!rutValido(rutCrudo)) return { ok: false, error: 'rut_invalido' };
  const rut = limpiarRut(rutCrudo);
  const { data: b, error } = await supabase.from('bookings').select(COLS).eq('id', bookingId).maybeSingle();
  if (error || !b) return { ok: false, error: 'no_encontrada' };
  const { error: upErr } = await supabase.from('bookings').update({ patient_rut: rut }).eq('id', bookingId);
  if (upErr) return { ok: false, error: 'guardar' };
  if (b.patient_email) {
    await upsertPatientFromBooking({ patient_name: b.patient_name, patient_email: b.patient_email, rut }, { actualizarRut: true }).catch(() => null);
  }
  const boleta = await emitirSiCorresponde({ ...b, patient_rut: rut });
  // Las demás sesiones pagadas de la misma ficha que esperaban el RUT también salen.
  if (b.patient_email) await emitirBoletasQueEsperabanRut(b.patient_email).catch(() => 0);
  return { ok: true, boleta };
}

async function emitirSiCorresponde(b: { id: string; paid_at: string | null; amount: number | null; notes: string | null; status: string; payment_note: string | null; debt_voided: boolean | null; patient_rut: string | null }): Promise<'emitida' | 'espera_banco' | 'pendiente'> {
  if (!faltaRutParaBoleta({ ...b, patient_rut: null }, null)) return 'pendiente'; // ya tenía boleta, sin pago, sin costo…
  if (tieneMarca(b.notes, MARCA_ESPERA_BANCO) && !tieneMarca(b.notes, MARCA_BANCO_OK) && !tieneMarca(b.notes, MARCA_TRANSFERENCIA_REVISADA)) return 'espera_banco';
  // "panel-…": lo pidió Vale al escribir el RUT (la boleta sale aunque el servicio tenga apagada la automática).
  const r = await encolarYEjecutar(b.id, 'boleta', `panel-rut-${Date.now()}`).catch(() => null);
  return r?.ok && !r.descartada ? 'emitida' : 'pendiente';
}

/**
 * RUT agregado (aviso o ficha): se emiten las boletas de las mismas sesiones que mostraba el aviso
 * obligatorio de RUT. Nunca las que Vale marcó pagadas sin boleta a propósito (SinBoletaAProposito),
 * los cobros de SumUp asociados sin boleta ni los servicios con la boleta automática apagada.
 */
export async function emitirBoletasQueEsperabanRut(email: string): Promise<number> {
  const { data } = await supabase.from('bookings').select(COLS)
    .eq('patient_email', email.toLowerCase()).not('paid_at', 'is', null)
    .gte('paid_at', `${desdeRutFaltante(todayCL())}T03:00:00Z`)
    .gt('amount', 0).not('status', 'in', '(cancelled,expired)').limit(50);
  let n = 0;
  const { data: sinAuto } = await supabase.from('services_catalog').select('id').eq('boleta_auto', false);
  const serviciosSinAuto = new Set((sinAuto ?? []).map((x: { id: string }) => x.id));
  for (const b of data ?? []) {
    if (b.service_id && serviciosSinAuto.has(b.service_id)) continue;
    if ((await emitirSiCorresponde(b)) === 'emitida') n++;
  }
  return n;
}
