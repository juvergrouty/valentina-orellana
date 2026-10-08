/**
 * POST /api/flow/confirm
 *
 * Webhook que Flow llama automáticamente cuando un pago cambia de estado.
 * Flow envía un POST con: token=XXXXX (form-encoded)
 *
 * Este endpoint:
 *  1. Consulta el estado real del pago con la API de Flow
 *  2. Si está pagado (status=2), marca la reserva como 'confirmed'
 *  3. Si fue rechazado/anulado (status=3/4), marca como 'cancelled'
 *  4. Devuelve 200 (Flow reintenta si recibe otro código)
 *
 * NOTA PARA DESARROLLO LOCAL:
 * Flow no puede llamar a localhost. Para pruebas locales usa:
 *   npx ngrok http 4321
 * y pon la URL pública de ngrok en PUBLIC_SITE_URL del .env
 */

import type { APIRoute } from 'astro';
import { getPaymentStatus } from '../../../lib/flow';
import { horaDisponible } from '../../../lib/disponibilidad';
import { supabase } from '../../../lib/supabase';
import { upsertPatientFromBooking } from '../../../lib/patients';
import { encolarTareas, procesarTareas, ejecutarTarea, nombreTarea, type TareaPago } from '../../../lib/tareasEnvio';
import { logInfo, logError, logWarn } from '../../../lib/logger';
import { tagBookingsWithPaymentToken } from '../../../lib/debt';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Flow envía el token como form-encoded
  let token: string | null = null;

  const contentType = request.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      token = form.get('token') as string | null;
    } else {
      // fallback: intentar leer como texto
      const text = await request.text();
      token = new URLSearchParams(text).get('token');
    }
  } catch {
    return new Response('Error leyendo body', { status: 400 });
  }

  if (!token) {
    console.warn('[Flow webhook] Token ausente');
    return new Response('Token requerido', { status: 400 });
  }

  try {
    // Leer entorno Flow desde settings (sandbox o producción)
    const { data: settingsRows } = await supabase.from('settings').select('key, value');
    const cfg: Record<string, string> = {};
    (settingsRows ?? []).forEach((r: { key: string; value: string }) => { cfg[r.key] = r.value; });
    const flowBaseUrl = cfg['flow_env'] === 'production'
      ? 'https://www.flow.cl/api'
      : cfg['flow_env'] === 'sandbox'
      ? 'https://sandbox.flow.cl/api'
      : undefined;

    const status = await getPaymentStatus(token, flowBaseUrl);
    console.log(`[Flow webhook] token=${token} status=${status.status} order=${status.flowOrder} env=${cfg['flow_env'] ?? 'default'}`);

    if (status.status === 2) {
      // ✅ Pagado — confirmar la(s) reserva(s) cubiertas por este token.
      // Normalmente es UNA sola (el flujo de siempre: agendar y pagar). Pero
      // desde /pagar/[id] (cobro de deuda combinada) un mismo pago de Flow
      // puede cubrir VARIAS reservas a la vez — todas comparten el mismo
      // mp_preference_id porque pagar-deuda.ts las marcó juntas al crear la
      // orden. Por eso esto ya no asume una sola fila.
      //
      // Idempotencia: se usa paid_at IS NULL (no status='pending_payment')
      // como guardia — así cubre tanto una reserva nueva (pending_payment)
      // como una reserva de deuda que ya estaba 'confirmed' pero sin pagar.
      // Un reintento de Flow no vuelve a matchear nada porque paid_at ya quedó
      // seteado la primera vez.
      let { data: candidates, error: selErr } = await supabase
        .from('bookings').select('*')
        .eq('mp_preference_id', token)
        .is('paid_at', null);

      if (selErr?.code === '42703') {
        // Migración de paid_at todavía no aplicada — degrada al comportamiento
        // anterior (una sola fila, por status).
        const retry = await supabase
          .from('bookings').select('*')
          .eq('mp_preference_id', token)
          .eq('status', 'pending_payment');
        candidates = retry.data;
        selErr = retry.error;
      }

      // Fallback: mp_preference_id solo guarda el ÚLTIMO token de una reserva. Si
      // se mandó un link individual y después uno combinado ("Cobrar todo"), el
      // combinado sobrescribe mp_preference_id de esa reserva y el link viejo
      // queda huérfano — si el paciente paga con ESE link viejo, no aparece acá.
      // Se busca en el historial guardado en notes (ver tagBookingsWithPaymentToken)
      // antes de darlo por "ya procesado" o "huérfano de verdad".
      let porHistorial = false;
      if (!selErr && (!candidates || !candidates.length)) {
        const likeToken = token.replace(/[%_]/g, c => `\\${c}`);
        const { data: historicos } = await supabase
          .from('bookings').select('*')
          .ilike('notes', `%PagoToken ${likeToken}%`)
          .is('paid_at', null);
        if (historicos && historicos.length) {
          // Segunda defensa: por esta vía (historial de links), el monto pagado
          // en Flow tiene que coincidir con el de las sesiones encontradas. Si
          // no, no se confirma nada y queda para revisión manual.
          const suma = historicos.reduce((t: number, h: { amount?: number | null }) => t + (Number(h.amount) || 0), 0);
          if (Number(status.amount) === suma) {
            candidates = historicos;
            porHistorial = true;
          } else {
            await logError('flow/monto-no-coincide', 'Pago de Flow encontrado por el historial de links, pero el monto no coincide con las sesiones: no se confirmó. Revisar en Flow.', { token, flowOrder: status.flowOrder, pagado: status.amount, esperado: suma, ids: historicos.map((h: { id: string }) => h.id) });
          }
        }
      }

      // Monto pagado vs. lo que se cobra (camino normal, por token). Si no
      // calza (p. ej. la paciente pagó un "Cobrar todo" con una sesión que
      // Valentina ya había marcado pagada en efectivo), se confirma igual —el
      // pago es real— pero queda un error visible para devolver la diferencia
      // (auditoría 8 oct 2026).
      if (!selErr && candidates?.length && !porHistorial) {
        const esperado = candidates.reduce((t: number, h: { amount?: number | null }) => t + (Number(h.amount) || 0), 0);
        if (Number(status.amount) !== esperado) {
          await logError('flow/monto-distinto',
            `El pago de Flow (${status.amount}) no coincide con lo que se cobraba (${esperado}). Revisa si hay que devolver una diferencia o cobrar lo que falta.`,
            { token, flowOrder: status.flowOrder, pagado: status.amount, esperado, ids: candidates.map((c: { id: string }) => c.id) });
        }
      }

      // Pago tardío de una reserva que ya se había liberado ('expired', pasó
      // el plazo para pagar): se recupera con el flujo completo de reserva
      // nueva solo si la hora sigue libre. Si otra persona ya la tomó, no se
      // toca (chocaría con su reserva) y queda un error visible en el panel
      // para reembolsar o reagendar. Con el vencimiento del link de Flow
      // (PUBLIC_PAY_TIMEOUT_SECONDS) esto debería ser muy raro.
      if (!selErr && candidates?.length) {
        for (const c of candidates.filter((x: { status: string }) => x.status === 'expired')) {
          // Si la hora la ocupa una reserva NUEVA SIN PAGAR de la misma paciente
          // (volvió a reservar y después pagó en la pestaña vieja de Flow), esa
          // reserva nueva no debe impedir confirmar la que sí pagó. Re-auditoría
          // 5 oct, con revisión independiente:
          //   - solo las que se CRUZAN con la hora pagada (no todo el día);
          //   - nunca las que Flow ya dio por pagadas ni las PagoSinAviso;
          //   - se liberan recién si la pagada se puede confirmar.
          const toMinC = (t: string) => { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return h * 60 + m; };
          const iniC = toMinC(c.session_time), finC = iniC + (c.duration_min ?? 50);
          const sinPagar: string[] = [];
          {
            const { data: propias } = await supabase.from('bookings')
              .select('id, created_by_admin, paid_at, notes, mp_preference_id, session_time, duration_min')
              .eq('patient_email', String(c.patient_email ?? '').toLowerCase())
              .eq('session_date', c.session_date)
              .eq('status', 'pending_payment')
              .neq('id', c.id);
            for (const p of (propias ?? []) as { id: string; created_by_admin?: boolean | null; paid_at?: string | null; notes?: string | null; mp_preference_id?: string | null; session_time: string; duration_min: number | null }[]) {
              if (p.created_by_admin || p.paid_at || /ComprobanteTransferencia|PagoSinAviso/.test(p.notes ?? '')) continue;
              const ini = toMinC(p.session_time), fin = ini + (p.duration_min ?? 50);
              if (!(ini < finC && fin > iniC)) continue; // no se cruza: no se toca
              if (p.mp_preference_id) {
                let pagada = true; // si Flow no responde, por seguridad se asume pagada (no se toca)
                try {
                  const st = await Promise.race([
                    getPaymentStatus(p.mp_preference_id, flowBaseUrl),
                    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Flow lento')), 4000)),
                  ]);
                  pagada = st.status === 2;
                } catch { /* se deja como pagada */ }
                if (pagada) continue;
              }
              sinPagar.push(p.id);
            }
          }
          const { data: ocupada } = await supabase
            .from('bookings').select('id')
            .eq('session_date', c.session_date)
            .eq('session_time', c.session_time)
            .not('id', 'in', `(${[c.id, ...sinPagar].join(',')})`)
            .not('status', 'in', '(cancelled,expired)')
            .limit(1);
          // Además del choque exacto: la hora tiene que seguir disponible con el
          // mismo cálculo de la agenda (cruces, bloqueos, Google Calendar). Si no
          // se puede comprobar (null), se confirma igual: el pago ya se hizo.
          const disponible = ocupada?.length ? false : await horaDisponible({
            date: c.session_date, time: c.session_time, serviceId: c.service_id,
            duration: c.duration_min, excluirIds: [c.id, ...sinPagar], sinAnticipacion: true,
            modality: String(c.session_type ?? '').includes('online') ? 'online' : 'presencial',
          }).catch(() => null);
          if (disponible !== false && sinPagar.length) {
            await supabase.from('bookings').update({ status: 'expired' }).in('id', sinPagar).eq('status', 'pending_payment');
            await logInfo('flow/pago-reserva-anterior', `${c.patient_name} pagó su reserva anterior; se liberó su reserva nueva sin pagar que se cruzaba`, { pagada: c.id, liberadas: sinPagar });
          }
          if (disponible === false) {
            candidates = candidates.filter((x: { id: string }) => x.id !== c.id);
            await logError('flow/pago-hora-ocupada',
              `Pago recibido de ${c.patient_name} (${c.patient_email}) por la sesión del ${c.session_date} a las ${String(c.session_time).slice(0, 5)}, pero esa hora ya se había liberado y ya no está disponible (la tomó otra persona, se bloqueó o se ocupó en tu calendario). Hay que reembolsar o reagendar.`,
              { bookingId: c.id, token, flowOrder: status.flowOrder, amount: status.amount });
          } else if (c.google_event_id) {
            // El evento se borró al liberarse la hora: se limpia para que se cree uno nuevo.
            await supabase.from('bookings').update({ google_event_id: null }).eq('id', c.id);
            c.google_event_id = null;
          }
        }
      }

      // Pago de una sesión que Valentina ya había CANCELADO (la paciente tenía
      // Flow abierto desde antes). No se revive sola: la cancelación fue a
      // propósito. Se registra el pago en esa sesión (queda la constancia del
      // pago de Flow; no suma en Finanzas mientras siga cancelada) y queda un
      // error visible en el panel para reembolsar o reagendar con la paciente.
      if (!selErr && candidates?.length) {
        for (const c of candidates.filter((x: { status: string }) => x.status === 'cancelled')) {
          candidates = candidates.filter((x: { id: string }) => x.id !== c.id);
          await supabase.from('bookings')
            .update({ mp_payment_id: String(status.flowOrder), paid_at: new Date().toISOString(), payment_note: 'Flow (sesión cancelada)' })
            .eq('id', c.id).is('paid_at', null);
          await logError('flow/pago-sesion-cancelada',
            `Pago recibido de ${c.patient_name} (${c.patient_email}) por la sesión del ${c.session_date} a las ${String(c.session_time).slice(0, 5)}, que estaba cancelada. La sesión sigue cancelada: hay que reembolsar o reagendar con la paciente (si la reagendas, marca la sesión nueva como pagada).`,
            { bookingId: c.id, token, flowOrder: status.flowOrder, amount: c.amount });
        }
      }

      if (selErr) {
        console.error('[Flow webhook] Error buscando reservas:', selErr);
        await logError('flow/confirmar-reserva', 'Pago recibido pero no se pudo buscar la(s) reserva(s) a marcar', { token, flowOrder: status.flowOrder, error: selErr.message });
      } else if (candidates && candidates.length) {
        const ids = candidates.map((c: { id: string }) => c.id);
        const wasNew = new Set(candidates.filter((c: { status: string }) => c.status === 'pending_payment' || c.status === 'expired').map((c: { id: string }) => c.id));

        let { data: updated, error } = await supabase
          .from('bookings')
          .update({ status: 'confirmed', mp_payment_id: String(status.flowOrder), paid_at: new Date().toISOString(), payment_note: 'Flow' })
          .in('id', ids)
          .is('paid_at', null) // guardia de carrera: solo toma las que sigan sin pagar
          .select();

        if (error?.code === '42703') {
          const retry = await supabase
            .from('bookings')
            .update({ status: 'confirmed', mp_payment_id: String(status.flowOrder) })
            .in('id', ids)
            .select();
          updated = retry.data;
          error   = retry.error;
        }

        // Una de las sesiones se cruza con otra reserva (regla bookings_sin_cruces
        // o misma hora): se confirman una por una para no dejar sin confirmar
        // las que no tienen problema; la que choca queda en el error de abajo.
        if (error?.code === '23P01' || error?.code === '23505') {
          const ok: any[] = [];
          const fallidas: string[] = [];
          for (const id of ids) {
            const r = await supabase.from('bookings')
              .update({ status: 'confirmed', mp_payment_id: String(status.flowOrder), paid_at: new Date().toISOString(), payment_note: 'Flow' })
              .eq('id', id).is('paid_at', null).select();
            if (r.error) fallidas.push(id); else ok.push(...(r.data ?? []));
          }
          updated = ok;
          error = fallidas.length ? { ...error, message: `Se cruza con otra reserva: ${fallidas.join(', ')}` } : null;
        }

        if (error) {
          // Crítico: el pago llegó de verdad (Flow ya confirmó status=2) pero
          // la(s) reserva(s) no quedaron marcadas como pagadas — antes esto solo
          // se veía en los logs de Vercel, que nadie revisa; ahora queda visible
          // en /admin/logs.
          console.error('[Flow webhook] Error confirmando reserva(s):', error);
          await logError('flow/confirmar-reserva', 'Pago recibido pero la(s) reserva(s) no se pudieron marcar como confirmadas', { token, flowOrder: status.flowOrder, ids, error: error.message });
        }

        // Envíos que siguen al pago — "sí o sí, pero una sola vez" (Valentina,
        // 8 oct 2026). Antes corrían aquí mismo uno tras otro: si la función se
        // cortaba (p. ej. con la boleta), lo que venía después se perdía para
        // siempre. Ahora cada envío queda registrado en tareas_envio y es
        // independiente: se intenta ya, y lo que falle o no alcance lo
        // reintenta el cron cada 5 min, sin repetir nunca un envío hecho
        // (ver src/lib/tareasEnvio.ts).
        //   - Reserva nueva (agendar y pagar): confirmación a la paciente, aviso
        //     a Valentina, evento en Google Calendar (con Meet) y boleta.
        //   - Pago de deuda (la sesión ya estaba agendada/confirmada): solo la
        //     boleta — su correo hace de recibo.
        //   - "Pasos a seguir" + consentimiento: una vez por paciente por pago
        //     (sendStepsOnFirstPayment decide si es su primer pago).
        const tareasPorReserva = new Map<string, TareaPago[]>();
        const conPasos = new Set<string>();
        for (const r of updated ?? []) {
          const t: TareaPago[] = wasNew.has(r.id) ? ['confirmacion', 'aviso_admin', 'calendario', 'boleta'] : ['boleta'];
          const em = String(r.patient_email ?? '').toLowerCase();
          if (em && !conPasos.has(em)) { conPasos.add(em); t.push('pasos'); }
          tareasPorReserva.set(r.id, t);
          // La ficha de la paciente (solo datos; idempotente).
          await upsertPatientFromBooking({ patient_name: r.patient_name, patient_email: r.patient_email, patient_phone: r.patient_phone, rut: r.patient_rut }).catch(console.error);
        }
        const sinCola: string[] = [];
        const pago = String(status.flowOrder);
        for (const [id, t] of tareasPorReserva) {
          if (!(await encolarTareas(id, t, pago))) sinCola.push(id);
        }
        // Lo registrado se procesa ya (con plazo, para responderle a Flow a tiempo).
        const enCola = [...tareasPorReserva.keys()].filter(id => !sinCola.includes(id));
        if (enCola.length) await procesarTareas({ bookingIds: enCola, hastaMs: Date.now() + 20_000 });
        // Respaldo si no se pudo registrar (base de datos con problemas): se
        // intenta directo, como antes. Las llaves de idempotencia evitan duplicar.
        for (const id of sinCola) {
          for (const t of tareasPorReserva.get(id) ?? []) await ejecutarTarea(id, nombreTarea(t, pago));
        }
      } else {
        // candidates vacío: puede ser (a) un reintento de Flow sobre un pago ya
        // procesado (inofensivo), o (b) un pago real cuyo token quedó huérfano
        // porque el mp_preference_id de esa reserva se sobrescribió después
        // (ej.: se mandó un link individual, el paciente no pagó, luego se generó
        // un link combinado nuevo con "Cobrar todo" para la misma reserva, y el
        // paciente termina pagando con el link viejo que aún tenía guardado en un
        // correo o WhatsApp). Se distingue viendo si este pago exacto ya quedó
        // registrado; si no, se avisa para revisar manualmente en Flow — mejor
        // que asumir en silencio que "no es nada".
        const { data: yaRegistrado } = await supabase
          .from('bookings').select('id').eq('mp_payment_id', String(status.flowOrder)).maybeSingle();
        if (!yaRegistrado) {
          await logWarn('flow/pago-huerfano', 'Flow confirmó un pago pero ninguna reserva coincide con ese token — puede ser un link de pago antiguo que ya fue reemplazado por uno nuevo. Revisar en Flow y conciliar manualmente.', { token, flowOrder: status.flowOrder, amount: status.amount, payer: status.payer });
        }
      }

    } else if (status.status === 3 || status.status === 4) {
      // ❌ Rechazado o anulado — cancelar SOLO si era una reserva web nueva sin
      // pagar (status='pending_payment'). Nunca tocar:
      // - una reserva de deuda que ya estaba 'confirmed' (la sesión ya ocurrió);
      // - una sesión o cobro que creó Valentina desde el panel (created_by_admin):
      //   una tarjeta rechazada no debe borrarle la sesión agendada; la paciente
      //   puede volver a intentar el pago con el mismo link.
      const { error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('mp_preference_id', token)
        .eq('status', 'pending_payment')
        .or('created_by_admin.is.null,created_by_admin.eq.false');

      if (error) {
        console.error('[Flow webhook] Error cancelando reserva:', error);
        await logError('flow/cancelar-reserva', 'No se pudo marcar la reserva como cancelada tras rechazo/anulación del pago', { token, error: error.message });
      }
    }
    // status=1 (pendiente) → no hacemos nada, esperamos otro webhook

  } catch (err) {
    console.error('[Flow webhook] Error consultando estado:', err);
    await logError('flow/webhook', 'Excepción al consultar/procesar el estado del pago en Flow', { token, error: err instanceof Error ? err.message : String(err) });
    // Devolvemos 500 para que Flow reintente más tarde
    return new Response('Error interno', { status: 500 });
  }

  // Flow requiere exactamente HTTP 200 para considerar el webhook exitoso
  return new Response('OK', { status: 200 });
};
