import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { todayCL } from '../../../../lib/dateUtils';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { motivoVisible, verificarGrabacion, textoMotivo } from '../../../../lib/transcriptor/consentimiento';
import { elegirModelo, origenDesdeSessionType, tipoDesdeSessionType } from '../../../../lib/transcriptor/reglas';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import type { TipoSesion } from '../../../../lib/transcriptor/tipos';

export const prerender = false;

// POST /api/admin/transcriptor/grabacion-iniciar — P4 (50-arquitectura §3.5).
// Se llama CON internet al elegir la sesión (antes de que Vale active el modo avión):
// verifica en el servidor interruptor + consentimiento con grabación autorizada, v2 o v3 (pareja: ambos) + mayoría de
// edad y deja la grabación en estado 'creada' con su modelo (regla fija reglas.ts).
// Sin esta respuesta el botón Grabar no se habilita, y subida-url/finalizar vuelven a
// verificar todo antes de aceptar audio. Idempotente: si ya hay una 'creada' de la misma
// sesión (últimas 12 h) se reutiliza.
// Cuerpo: { booking_id? , patient_id?, google_event_id?, tipo?: 'individual'|'pareja', lugar_con_ruido?: boolean,
//          nueva?: true (no reutilizar: el teléfono ya tiene audio guardado con la preparación anterior) }

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'grabar_inicio');
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request);
  if (!body) return json({ ok: false, error: 'Solicitud inválida.' }, 400);

  const bookingId = esUuid(body.booking_id) ? body.booking_id : null;
  let patientId = esUuid(body.patient_id) ? body.patient_id : null;
  const googleEventId = typeof body.google_event_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(body.google_event_id) ? body.google_event_id : null;
  const lugarConRuido = body.lugar_con_ruido === true;
  let tipo: TipoSesion | null = body.tipo === 'individual' || body.tipo === 'pareja' ? body.tipo : null;
  let sessionDate = todayCL();
  let nombre: string | null = null;

  try {
    if (bookingId) {
      const { data: b, error } = await supabase.from('bookings')
        .select('id, patient_name, patient_email, session_type, session_date, status')
        .eq('id', bookingId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!b || ['cancelled', 'expired'].includes(String(b.status))) return json({ ok: false, error: 'No encontré esa sesión (¿se canceló?).' }, 404);
      if (origenDesdeSessionType(b.session_type) === 'online') {
        return json({ ok: false, error: 'Esta sesión es online: la graba el asistente de Meet, no este grabador.' }, 400);
      }
      const tipoReserva = tipoDesdeSessionType(b.session_type);
      if (tipoReserva !== 'sin_tipo') tipo = tipoReserva;
      sessionDate = String(b.session_date ?? sessionDate);
      nombre = b.patient_name ?? null;
      const email = String(b.patient_email ?? '').trim();
      if (email) {
        const { data: p, error: pe } = await supabase.from('patients')
          .select('id, name').ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`)).limit(2);
        if (pe) throw new Error(pe.message);
        if (p && p.length === 1) {
          if (patientId && patientId !== p[0].id) {
            return json({ ok: false, error: 'La paciente elegida no coincide con la de la reserva. Recarga la página.' }, 409);
          }
          patientId = p[0].id;
          nombre = p[0].name ?? nombre;
        }
      }
    }

    if (patientId && !nombre) {
      const { data: p, error } = await supabase.from('patients').select('id, name').eq('id', patientId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!p) return json({ ok: false, error: 'No encontré la ficha de ese paciente.' }, 404);
      nombre = p.name ?? null;
    }
    if (!tipo) return json({ ok: false, error: 'Elige si la sesión es individual o de pareja.', motivo: 'falta_tipo' }, 400);

    const v = await verificarGrabacion(patientId, tipo);
    if (!v.puede) {
      await auditar('vale', v.motivo === 'transcriptor_apagado' ? 'grabar_inicio' : 'consentimiento_faltante', {
        patientId, request, clientAddress, resultado: 'denegado',
        detalle: { motivo: v.motivo, tipo, tipo_efectivo: v.tipoEfectivo, origen: 'presencial', booking: bookingId, firmas_vigentes: v.consentIds.length, requeridas: v.requeridas },
      });
      return json({ ok: false, motivo: v.motivo, error: textoMotivo(motivoVisible(v), nombre), firmantes: v.firmantes, tipo: v.tipoEfectivo }, 403);
    }
    // H2: el tipo lo fija el servidor; si la ficha es de pareja, la grabación es de pareja aunque
    // la pantalla haya elegido "individual" (ya se exigieron las 2 firmas en verificarGrabacion).
    tipo = v.tipoEfectivo;

    const decision = elegirModelo({ tipo, origen: 'presencial', lugarConRuido });
    const fila = {
      patient_id: patientId,
      booking_id: bookingId,
      google_event_id: googleEventId,
      consent_ids: v.consentIds,
      origen: 'presencial' as const,
      tipo,
      lugar_con_ruido: lugarConRuido,
      modelo: decision.modelo,
      diarizacion: decision.diarizacion,
      session_date: sessionDate,
      creada_por: 'vale' as const,
    };

    // Reutiliza una preparación anterior de la misma sesión (sin audio aún).
    const hace12h = new Date(Date.now() - 12 * 3600_000).toISOString();
    let q = supabase.from('grabaciones').select('id')
      .eq('patient_id', patientId!).eq('origen', 'presencial').eq('estado', 'creada')
      .eq('session_date', sessionDate).gte('created_at', hace12h)
      .order('created_at', { ascending: false }).limit(1);
    q = bookingId ? q.eq('booking_id', bookingId) : q.is('booking_id', null);
    const { data: previaDb, error: e1 } = body.nueva === true ? { data: null, error: null } : await q.maybeSingle();
    if (e1) throw new Error(e1.message);
    const previa = previaDb as { id: string } | null;

    let grabacionId: string;
    if (previa) {
      const { data, error } = await supabase.from('grabaciones').update(fila).eq('id', previa.id).eq('estado', 'creada').select('id').maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return json({ ok: false, error: 'La grabación cambió de estado. Recarga la página.' }, 409);
      grabacionId = data.id;
    } else {
      const { data, error } = await supabase.from('grabaciones').insert({ ...fila, estado: 'creada' }).select('id').single();
      if (error || !data) throw new Error(error?.message ?? 'insert sin fila');
      grabacionId = data.id;
    }

    await auditar('vale', 'grabar_inicio', {
      grabacionId, patientId, request, clientAddress,
      detalle: { fase: 'autorizada', tipo, modelo: decision.modelo, diarizacion: decision.diarizacion, ruido: lugarConRuido, reutilizada: !!previa, firmas: v.consentIds.length },
    });
    return json({
      ok: true, grabacion_id: grabacionId, tipo, modelo: decision.modelo, diarizacion: decision.diarizacion,
      motivo_modelo: decision.motivo, firmantes: v.firmantes, requeridas: v.requeridas,
    });
  } catch (e) {
    console.warn('[transcriptor/grabacion-iniciar]', e instanceof Error ? e.message : e);
    await auditar('vale', 'grabar_inicio', { patientId, request, clientAddress, resultado: 'error', detalle: { fase: 'autorizar' } });
    return json({ ok: false, error: 'No se pudo preparar la grabación. Revisa tu conexión e intenta de nuevo.' }, 500);
  }
};
