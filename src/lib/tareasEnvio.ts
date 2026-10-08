// Envíos "sí o sí, pero una sola vez" (Valentina, 8 oct 2026).
//
// Después de un pago hay que: confirmar a la paciente, avisar a Valentina,
// crear el evento de Google Calendar (con Meet), emitir la boleta y mandar
// "Pasos a seguir" + consentimiento. Antes todo corría seguido dentro del aviso
// de Flow: si la función se cortaba (p. ej. el SII lento con la boleta), lo que
// venía después se perdía para siempre, y Flow no reintenta un pago ya marcado.
//
// Ahora cada envío es una fila en `tareas_envio` (migración 0009):
// - Independientes: si una falla, las demás igual salen.
// - Se reintentan cada 5 min (cron boletas-pendientes) hasta MAX_INTENTOS.
// - Nunca dos veces:
//   · unique(booking_id, tarea) → cada envío existe una sola vez;
//   · cada fila se "toma" con un UPDATE condicionado (estado + intentos), así
//     dos procesos a la vez (aviso de Flow y cron) no pueden tomar la misma;
//   · los correos llevan una llave de idempotencia (Resend descarta un segundo
//     envío con la misma llave por 24 h) por si un intento se corta después de
//     enviar y antes de marcar "hecha";
//   · el evento de Calendar usa un id fijo derivado de la reserva;
//   · la boleta tiene su propio candado (emitBoletaParaReserva).
import { supabase } from './supabase';
import { logError, logWarn } from './logger';
import { sendConfirmationToClient, sendNotificationToAdmin, ADMIN_EMAIL_FALLBACK } from './email';
import { syncBookingToCalendar, markBookingPaidInCalendar } from './syncCalendar';
import { sendStepsOnFirstPayment } from './patients';
import { emitBoletaParaReserva } from './apigateway';

export type TareaPago = 'confirmacion' | 'aviso_admin' | 'calendario' | 'boleta' | 'pasos';
// Orden en que se ejecutan las de una misma reserva (todas independientes).
const ORDEN: TareaPago[] = ['confirmacion', 'aviso_admin', 'calendario', 'boleta', 'pasos'];
const MAX_INTENTOS = 12;          // ≈ 1 hora de reintentos cada 5 min
const TOMA_VENCIDA_MS = 10 * 60_000; // una toma "en curso" más vieja se dio por cortada

type Fila = { id: number; booking_id: string; tarea: string; estado: string; intentos: number; tomada_en: string | null };

// Cada envío se registra como "<tarea>#<orden de Flow>": el mismo pago nunca
// genera dos (reintentos de Flow), pero un pago NUEVO de la misma reserva (p. ej.
// tras "desmarcar pagado" y volver a pagar) sí tiene sus propios envíos.
export const nombreTarea = (t: TareaPago, pago: string) => `${t}#${pago}`;
const baseTarea = (nombre: string) => nombre.split('#')[0] as TareaPago;

/** Registra los envíos pendientes de una reserva para un pago (los que ya existen no se duplican). */
export async function encolarTareas(bookingId: string, tareas: TareaPago[], pago: string): Promise<boolean> {
  if (!tareas.length) return true;
  const { error } = await supabase.from('tareas_envio')
    .upsert(tareas.map(t => ({ booking_id: bookingId, tarea: nombreTarea(t, pago) })), { onConflict: 'booking_id,tarea', ignoreDuplicates: true });
  if (error) {
    await logError('envios/encolar', 'No se pudieron registrar los envíos tras el pago; se intentan directo', { bookingId, tareas, error: error.message });
    return false;
  }
  return true;
}

/** Toma una fila de forma exclusiva. Devuelve true solo si este proceso la tomó. */
async function tomar(f: Fila): Promise<boolean> {
  // (el tope de intentos lo controla quien llama)
  const vencida = new Date(Date.now() - TOMA_VENCIDA_MS).toISOString();
  const { data, error } = await supabase.from('tareas_envio')
    .update({ estado: 'en_curso', tomada_en: new Date().toISOString(), intentos: f.intentos + 1 })
    .eq('id', f.id)
    .eq('intentos', f.intentos) // compare-and-swap: si otro la tomó, intentos ya cambió
    .or(`estado.in.(pendiente,error),and(estado.eq.en_curso,tomada_en.lt.${vencida})`)
    .select('id');
  return !error && (data ?? []).length === 1;
}

async function cerrar(f: Fila, r: Resultado) {
  const intentos = f.intentos + 1;
  if (r.ok) {
    await supabase.from('tareas_envio').update({ estado: r.descartada ? 'descartada' : 'hecha', hecha_en: new Date().toISOString(), ultimo_error: r.nota ?? null }).eq('id', f.id);
    return;
  }
  await supabase.from('tareas_envio').update({ estado: 'error', ultimo_error: (r.error ?? 'error desconocido').slice(0, 500) }).eq('id', f.id);
  if (intentos >= MAX_INTENTOS) {
    await logError('envios/agotado', `No se pudo completar "${baseTarea(f.tarea)}" de una sesión pagada tras ${intentos} intentos. Revísalo a mano.`, { bookingId: f.booking_id, tarea: f.tarea, error: r.error });
  }
}

type Resultado = { ok: boolean; error?: string; descartada?: boolean; nota?: string };

/** Ejecuta un envío ("<tarea>#<pago>"). Debe ser seguro de repetir (ver llaves de idempotencia). */
export async function ejecutarTarea(bookingId: string, nombre: string): Promise<Resultado> {
  const tarea = baseTarea(nombre);
  try {
    const { data: b, error } = await supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!b) return { ok: true, descartada: true, nota: 'la reserva ya no existe' };
    if (!b.paid_at) return { ok: true, descartada: true, nota: 'la reserva ya no figura pagada' };
    const sinFecha = String(b.session_date) === '2099-12-31'; // cobro manual sin fecha: no hay sesión que confirmar
    const llave = `${bookingId}:${nombre}`;

    // Las reservas de este mismo pago (un pago de deuda puede cubrir varias).
    const mismoPago = async (): Promise<string[]> => {
      if (!b.mp_payment_id) return [bookingId];
      const { data } = await supabase.from('bookings').select('id').eq('mp_payment_id', b.mp_payment_id);
      const ids = (data ?? []).map((r: { id: string }) => r.id);
      return ids.includes(bookingId) ? ids : [...ids, bookingId];
    };

    const datosCorreo = async () => {
      let serviceName: string | undefined;
      if (b.service_id) {
        const { data: svc } = await supabase.from('services_catalog').select('name').eq('id', b.service_id).maybeSingle();
        serviceName = svc?.name ?? undefined;
      }
      const ids = await mismoPago();
      const { count: pagadasAntes } = await supabase.from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('patient_email', String(b.patient_email ?? '').toLowerCase())
        .not('paid_at', 'is', null)
        .neq('status', 'cancelled')
        .not('id', 'in', `(${ids.join(',')})`);
      return {
        patient_name:   b.patient_name,
        patient_email:  b.patient_email,
        patient_phone:  b.patient_phone,
        session_type:   b.session_type,
        session_date:   b.session_date,
        session_time:   String(b.session_time ?? '').slice(0, 5),
        amount:         b.amount,
        payment_method: 'flow',
        booking_id:     b.id,
        service_name:   serviceName,
        is_new_patient: (pagadasAntes ?? 0) === 0,
      };
    };

    switch (tarea) {
      case 'confirmacion': {
        if (sinFecha) return { ok: true, descartada: true, nota: 'cobro sin fecha' };
        if (!b.patient_email) return { ok: true, descartada: true, nota: 'sin correo' };
        const r = await sendConfirmationToClient(await datosCorreo(), { idempotencyKey: llave });
        return r.sent ? { ok: true, nota: r.reason } : { ok: false, error: r.reason };
      }
      case 'aviso_admin': {
        const { data: cfg } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
        const r = await sendNotificationToAdmin(await datosCorreo(), cfg?.value || ADMIN_EMAIL_FALLBACK, false, { idempotencyKey: llave });
        return r.sent ? { ok: true } : { ok: false, error: r.reason };
      }
      case 'calendario': {
        if (sinFecha) return { ok: true, descartada: true, nota: 'cobro sin fecha' };
        const r = await syncBookingToCalendar(b);
        if (!r.success) {
          if ((r.error ?? '').includes('no está conectado')) return { ok: true, descartada: true, nota: 'Google Calendar no conectado' };
          return { ok: false, error: r.error };
        }
        // Si el evento ya existía (sesión agendada con link de pago): pasa a pagado e invita a la paciente.
        return (await markBookingPaidInCalendar(bookingId, true)) ? { ok: true } : { ok: false, error: 'no se pudo marcar pagado en el calendario' };
      }
      case 'boleta': {
        // Interruptor "Emitir la boleta automáticamente" del servicio.
        if (b.service_id) {
          const { data: svcB } = await supabase.from('services_catalog').select('boleta_auto').eq('id', b.service_id).maybeSingle();
          if (svcB?.boleta_auto === false) {
            await logWarn('flow/boleta-automatica', 'Boleta no emitida automáticamente: el servicio tiene apagado "Emitir la boleta automáticamente". Emítela desde el calendario.', { bookingId });
            return { ok: true, descartada: true, nota: 'boleta automática apagada en el servicio' };
          }
        }
        // emitBoletaParaReserva tiene candado y folio: repetirla nunca emite una segunda boleta.
        // Si el SII falla, la deja en su propia cola (BoletaPendienteEmision) y avisa en el panel.
        const res = await emitBoletaParaReserva(bookingId, { rutOverride: b.patient_rut || undefined, enviarEmail: true });
        if (!res.ok) {
          const esFaltaRut = (res.error ?? '').toLowerCase().includes('rut');
          await logWarn('flow/boleta-automatica', esFaltaRut
            ? `Boleta no emitida: falta el RUT de ${b.patient_name} (${b.patient_email}). Agrégalo en su ficha y emite la boleta manualmente desde el calendario.`
            : `Boleta no emitida automáticamente: ${res.error}`,
            { bookingId, patientEmail: b.patient_email, error: res.error });
        }
        return { ok: true, nota: res.ok ? undefined : res.error };
      }
      case 'pasos': {
        const ok = await sendStepsOnFirstPayment(
          { patient_name: b.patient_name, patient_email: b.patient_email, patient_phone: b.patient_phone, rut: b.patient_rut },
          await mismoPago(), { idempotencyKey: llave });
        return ok ? { ok: true } : { ok: false, error: 'no se pudo enviar pasos a seguir / consentimiento' };
      }
    }
    return { ok: true, descartada: true, nota: 'tarea desconocida' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Procesa los envíos pendientes (los de ciertas reservas, o todos) hasta el
 * plazo indicado. Lo que no alcance queda para la próxima pasada del cron.
 */
export async function procesarTareas(opts: { bookingIds?: string[]; hastaMs?: number } = {}): Promise<{ hechas: number; fallidas: number; pendientes: number }> {
  const hasta = opts.hastaMs ?? Date.now() + 40_000;
  const vencida = new Date(Date.now() - TOMA_VENCIDA_MS).toISOString();

  // Último intento cortado a la mitad (quedó "en curso" con el tope de
  // intentos): no se reintenta más, pero se cierra y se avisa (antes quedaba
  // pegado sin ningún aviso).
  {
    const { data: pegadas } = await supabase.from('tareas_envio')
      .update({ estado: 'error', ultimo_error: 'el último intento se cortó a la mitad' })
      .eq('estado', 'en_curso').gte('intentos', MAX_INTENTOS).lt('tomada_en', vencida)
      .not('tarea', 'like', 'recordatorio-%')
      .select('booking_id, tarea');
    for (const f of (pegadas ?? []) as { booking_id: string; tarea: string }[]) {
      await logError('envios/agotado', `No se pudo completar "${baseTarea(f.tarea)}" de una sesión pagada tras ${MAX_INTENTOS} intentos. Revísalo a mano.`, { bookingId: f.booking_id, tarea: f.tarea });
    }
  }

  let q = supabase.from('tareas_envio')
    .select('id, booking_id, tarea, estado, intentos, tomada_en')
    .in('estado', ['pendiente', 'error', 'en_curso'])
    .not('tarea', 'like', 'recordatorio-%')
    .lt('intentos', MAX_INTENTOS)
    .order('creada_en', { ascending: true })
    .limit(100);
  if (opts.bookingIds?.length) q = q.in('booking_id', opts.bookingIds);
  const { data, error } = await q;
  if (error) {
    await logError('envios/procesar', 'No se pudieron leer los envíos pendientes', { error: error.message });
    return { hechas: 0, fallidas: 0, pendientes: 0 };
  }
  const filas = ((data ?? []) as Fila[]).filter(f => ORDEN.includes(baseTarea(f.tarea)));
  filas.sort((a, b) => a.booking_id === b.booking_id
    ? ORDEN.indexOf(baseTarea(a.tarea)) - ORDEN.indexOf(baseTarea(b.tarea))
    : 0);

  let hechas = 0, fallidas = 0, pendientes = 0;
  for (const f of filas) {
    if (Date.now() > hasta) { pendientes++; continue; }
    // En curso y reciente: la está haciendo otro proceso ahora mismo.
    if (f.estado === 'en_curso' && f.tomada_en && Date.now() - Date.parse(f.tomada_en) < TOMA_VENCIDA_MS) continue;
    if (!(await tomar(f))) continue;
    const r = await ejecutarTarea(f.booking_id, f.tarea);
    await cerrar(f, r);
    if (r.ok) hechas++; else fallidas++;
  }
  return { hechas, fallidas, pendientes };
}

/**
 * Para envíos que no siguen a un pago (recordatorios): reserva el envío
 * `tarea` de la reserva para este proceso. true = puede enviar (y debe cerrar
 * con terminarEnvioUnico); false = ya se envió, lo está enviando otro proceso
 * o no se pudo verificar (ante la duda NO se envía: nunca dos veces).
 */
export async function reservarEnvioUnico(bookingId: string, tarea: string, maxIntentos = MAX_INTENTOS): Promise<boolean> {
  const ahora = new Date().toISOString();
  const { error } = await supabase.from('tareas_envio')
    .insert({ booking_id: bookingId, tarea, estado: 'en_curso', tomada_en: ahora, intentos: 1 });
  if (!error) return true;
  if (error.code !== '23505') {
    await logError('envios/reservar', 'No se pudo registrar un envío; se omite para no duplicarlo', { bookingId, tarea, error: error.message });
    return false;
  }
  // Ya existe: solo se puede volver a intentar si el intento anterior falló
  // o quedó cortado (en curso hace más de 10 min).
  const { data: f } = await supabase.from('tareas_envio')
    .select('id, booking_id, tarea, estado, intentos, tomada_en').eq('booking_id', bookingId).eq('tarea', tarea).maybeSingle();
  if (!f || f.estado === 'hecha' || f.estado === 'descartada' || f.intentos >= maxIntentos) return false;
  return tomar(f as Fila);
}

export async function terminarEnvioUnico(bookingId: string, tarea: string, ok: boolean, error?: string): Promise<void> {
  await supabase.from('tareas_envio')
    .update(ok ? { estado: 'hecha', hecha_en: new Date().toISOString(), ultimo_error: null } : { estado: 'error', ultimo_error: (error ?? '').slice(0, 500) })
    .eq('booking_id', bookingId).eq('tarea', tarea);
}
