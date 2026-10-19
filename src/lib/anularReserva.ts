import { supabase } from './supabase';

// Anular una hora desde el panel (botón "Anular reserva" del panel lateral de la agenda).
// Decisión de Vale (19 oct 2026): "cuando quiera anular una hora dame algo para clickear si quiero o no
// mandar ese mail". Al anular aparece la casilla "Avisar a la paciente por correo" (DESMARCADA por
// defecto: nunca se manda nada sin querer). Si la marca, sale un correo corto de anulación con el enlace
// para elegir otro horario (src/lib/correoAnulacion.ts).
// Google Calendar: el evento se borra SIEMPRE sin aviso de Google (sendUpdates=none, ver
// googleCalendar.ts), así que con la casilla marcada la paciente recibe un solo aviso (el correo), y sin
// ella no recibe nada, como antes.
// Si la sesión ya estaba pagada, el panel muestra "Pago por devolver o reagendar" (pagosPorDevolver.ts).

const SIN_FECHA = '2099-12-31';

export type ResultadoCorreo = 'no_pedido' | 'enviado' | 'fallo' | 'sin_correo' | 'ya_anulada' | 'sin_fecha';
export type ResultadoAnular = { ok: true; correo: ResultadoCorreo } | { ok: false; error: string };

type Fila = {
  id: string; status?: string | null; patient_name?: string | null; patient_email?: string | null;
  session_date?: string | null; session_time?: string | null; paid_at?: string | null; amount?: number | null; payment_note?: string | null;
};

export interface DependenciasAnular {
  borrarEvento: (bookingId: string) => Promise<void>;
  enviarCorreo: (d: { patient_name: string; patient_email: string; session_date: string; session_time: string; pagada: boolean; sinCosto: boolean }, opts: { idempotencyKey: string }) => Promise<{ sent: boolean; reason?: string }>;
}

const dependenciasReales: DependenciasAnular = {
  borrarEvento: async (id) => (await import('./syncCalendar')).deleteBookingFromCalendar(id),
  enviarCorreo: async (d, opts) => (await import('./email')).sendCancellationEmail(d, opts),
};

/** Lee "Avisar a la paciente por correo" del formulario: solo cuenta si viene marcada. */
export function quiereAvisar(valor: FormDataEntryValue | null | undefined): boolean {
  return valor === 'on' || valor === '1' || valor === 'true';
}

export async function anularReserva(id: string, opts: { avisar: boolean }, deps: DependenciasAnular = dependenciasReales): Promise<ResultadoAnular> {
  const { data, error: errLeer } = await supabase.from('bookings')
    .select('id, status, patient_name, patient_email, session_date, session_time, paid_at, amount, payment_note')
    .eq('id', id).maybeSingle();
  if (errLeer) return { ok: false, error: errLeer.message };
  if (!data) return { ok: false, error: 'No se encontró la sesión.' };
  const b = data as Fila;
  const yaAnulada = b.status === 'cancelled';

  // Si la base no la anuló, NO se borra el evento de Google (8 oct 2026): antes la sesión seguía activa
  // (ocupando la hora) pero sin evento. Y tampoco se avisa a nadie.
  const { error } = await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  try { await deps.borrarEvento(id); } catch (e) { console.error('[anular] gcal:', e); }

  if (!opts.avisar) return { ok: true, correo: 'no_pedido' };
  if (yaAnulada) return { ok: true, correo: 'ya_anulada' }; // ya se había anulado antes: no se repite el aviso
  if (!b.session_date || b.session_date === SIN_FECHA || !b.session_time) return { ok: true, correo: 'sin_fecha' };
  const correo = String(b.patient_email ?? '').trim();
  if (!correo) return { ok: true, correo: 'sin_correo' };
  try {
    const r = await deps.enviarCorreo({
      patient_name: String(b.patient_name ?? '').trim(),
      patient_email: correo,
      session_date: String(b.session_date),
      session_time: String(b.session_time),
      pagada: !!b.paid_at && (Number(b.amount) || 0) > 0 && b.payment_note !== 'Sin costo',
      sinCosto: b.payment_note === 'Sin costo',
    }, { idempotencyKey: `anulacion-${id}` });
    return { ok: true, correo: r.sent ? 'enviado' : 'fallo' };
  } catch (e) {
    console.error('[anular] correo:', e);
    return { ok: true, correo: 'fallo' };
  }
}
