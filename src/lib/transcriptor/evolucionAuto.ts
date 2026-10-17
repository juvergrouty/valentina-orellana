// Evolución autollenada desde el resumen IA (pedido de Vale, 17 oct 2026: "cópialo automáticamente,
// pero en la evolución deja un botón de editar por si acaso").
//
// Cuando el orquestador deja listo el resumen IA de una grabación y esa sesión TODAVÍA no tiene
// evolución, se guarda la evolución con el texto plano del resumen, igual que si Vale hubiera tocado
// "Usar como base de mi evolución" y luego "Guardar evolución":
//   • misma tabla y columnas que /api/admin/patients (action=add_note): session_notes
//     { patient_id, booking_id, session_date, session_type, content } (texto plano, como toda nota);
//   • mismo texto: ENCABEZADO_EVOLUCION_IA + resumenATexto(contenido) (textoEvolucionDesdeResumen);
//   • la sesión se elige como la ficha (armarHistorial): por la reserva de la grabación si es de este
//     paciente; si la grabación no tiene reserva, por su fecha.
// Reglas:
//   • NUNCA pisa ni anexa: si la sesión ya tiene cualquier nota (incluso archivada, o una sin reserva
//     del mismo día), no hace nada. Eso también la hace idempotente: reintentos, la recuperación
//     "ya estaba listo" y las regeneraciones del resumen no duplican.
//   • Si la grabación no se puede asociar a una sesión (sin paciente, o su reserva no es de este
//     paciente), no hace nada.
//   • Nunca lanza: un error aquí jamás rompe la transcripción ni el resumen. Se registra en la
//     bitácora (sin contenido clínico).
// La exclusión mutua entre corridas la da la toma (lease) de la grabación en el orquestador.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccionAuditoria } from './tipos';
import { auditar } from './auditoria';
import { COLUMNAS_CONTENIDO, leerContenidoResumen } from './resumenCifrado';
import { sessionTypeDeGrabacion, textoEvolucionDesdeResumen } from './panel';

export const ACCION_EVOLUCION_AUTO = 'evolucion_autollenada' as AccionAuditoria;

export type ResultadoEvolucionAuto = 'guardada' | 'ya_hay_evolucion' | 'sin_sesion' | 'vacio' | 'error';

export interface GrabacionParaEvolucion {
  id: string;
  patient_id: string | null;
  booking_id: string | null;
  session_date: string;
  tipo?: string | null;
  origen?: string | null;
}

/** Error con etapa y código de Postgres/PostgREST: a la bitácora va solo eso (nunca el mensaje, que
 *  en algunos errores puede repetir valores de la fila). */
class ErrorEvolucion extends Error {
  constructor(readonly etapa: string, readonly codigo: string | null) { super(`${etapa}: ${codigo ?? 'sin código'}`); }
}
const errDe = (etapa: string, e: { code?: string } | null | undefined) => new ErrorEvolucion(etapa, e?.code ?? null);

/** Reserva "sin fecha" (cobro manual, ver lib/encuadrado.ts): no es una sesión con evolución. */
const FECHA_SIN_SESION = '2099-12-31';

export async function autollenarEvolucion(p: {
  db: SupabaseClient;
  grabacion: GrabacionParaEvolucion;
  /** Markdown del resumen IA recién listo (en claro, solo en memoria). */
  contenido: string | null | undefined;
  version?: number | null;
}): Promise<ResultadoEvolucionAuto> {
  const { db, grabacion: g } = p;
  const registrar = (resultado: 'ok' | 'error', detalle: Record<string, unknown>) =>
    auditar('sistema', ACCION_EVOLUCION_AUTO, { grabacionId: g.id, patientId: g.patient_id, resultado, detalle, cliente: db });
  try {
    const content = textoEvolucionDesdeResumen(p.contenido);
    if (!content) return 'vacio';
    if (!g.patient_id) {
      await registrar('ok', { motivo: 'sin_sesion' });
      return 'sin_sesion';
    }

    // ── La sesión, igual que la ficha ──
    let bookingId: string | null = null;
    let sessionDate = g.session_date;
    let sessionType = sessionTypeDeGrabacion(g);
    if (g.booking_id) {
      const [{ data: r, error: er }, { data: pac, error: ep }] = await Promise.all([
        db.from('bookings').select('id, session_date, session_type, patient_email').eq('id', g.booking_id).maybeSingle(),
        db.from('patients').select('email').eq('id', g.patient_id).maybeSingle(),
      ]);
      if (er || ep) throw errDe('leer_sesion', er ?? ep);
      const reserva = r as { id: string; session_date?: string | null; session_type?: string | null; patient_email?: string | null } | null;
      // Mismo criterio que la ficha: sus reservas son las de patient_email = patients.email (exacto).
      const email = (pac as { email?: string | null } | null)?.email ?? null;
      if (!reserva || !email || reserva.patient_email !== email || !reserva.session_date) {
        await registrar('ok', { motivo: 'sin_sesion' });
        return 'sin_sesion';
      }
      bookingId = reserva.id;
      sessionDate = reserva.session_date!;
      sessionType = reserva.session_type ?? sessionType;
    }
    if (!sessionDate || sessionDate === FECHA_SIN_SESION) {
      await registrar('ok', { motivo: 'sin_sesion' });
      return 'sin_sesion';
    }

    // ── ¿Ya hay evolución? (cualquier nota, incluso archivada) ──
    const consultas = [
      db.from('session_notes').select('id').eq('patient_id', g.patient_id).eq('session_date', sessionDate).limit(1),
    ];
    if (bookingId) consultas.push(db.from('session_notes').select('id').eq('patient_id', g.patient_id).eq('booking_id', bookingId).limit(1));
    const lecturas = await Promise.all(consultas);
    const fallida = lecturas.find((x) => x.error);
    if (fallida) throw errDe('leer_notas', fallida.error);
    if (lecturas.some((x) => (x.data ?? []).length > 0)) return 'ya_hay_evolucion';

    // ── Mismo guardado que "Guardar evolución" (add_note) ──
    const { error } = await db.from('session_notes').insert({
      patient_id: g.patient_id,
      booking_id: bookingId,
      session_date: sessionDate,
      session_type: sessionType ?? '',
      content,
    });
    if (error) throw errDe('guardar_nota', error);
    // La nota ya quedó: si la bitácora falla no se informa como error del autollenado.
    await registrar('ok', { version: p.version ?? null, largo: content.length, con_reserva: !!bookingId }).catch(() => false);
    return 'guardada';
  } catch (e) {
    const etapa = e instanceof ErrorEvolucion ? e.etapa : 'inesperado';
    const codigo = e instanceof ErrorEvolucion ? e.codigo : null;
    console.warn('[transcriptor/evolucionAuto] no se autollenó la evolución:', etapa, codigo ?? '');
    await registrar('error', { etapa, codigo }).catch(() => false);
    return 'error';
  }
}

/**
 * Asignar o corregir la ficha de una grabación (transcriptor/asignar.ts), llamado DESPUÉS de mover
 * grabaciones.patient_id:
 *   • en la ficha anterior se ARCHIVA (deleted_at, nunca se borra) la evolución autollenada de esta
 *     grabación solo si sigue intacta: texto idéntico al de alguna versión IA de su resumen y sin
 *     ediciones (historial vacío). Si Vale la editó, no se toca;
 *   • en la ficha nueva se autollena con la versión IA vigente (mismas reglas: nunca pisa).
 * Nunca lanza; todo queda en la bitácora sin contenido.
 */
export async function reasignarEvolucion(p: {
  db: SupabaseClient;
  grabacion: GrabacionParaEvolucion;
  anteriorPatientId: string | null;
  cif?: Parameters<typeof leerContenidoResumen>[1];
}): Promise<{ archivada: boolean; nueva: ResultadoEvolucionAuto }> {
  const { db, grabacion: g } = p;
  let archivada = false;
  try {
    const { data: rs, error: er } = await db.from('resumenes_ia').select(`id, version, ${COLUMNAS_CONTENIDO}`)
      .eq('grabacion_id', g.id).eq('autor', 'ia').eq('estado', 'listo').order('version', { ascending: false });
    if (er) throw errDe('leer_resumen', er);
    const textos: { version: number; md: string }[] = [];
    for (const r of (rs ?? []) as { id: string; version: number; contenido?: string | null; contenido_cifrado?: unknown }[]) {
      const md = await leerContenidoResumen(r, p.cif);
      if (md) textos.push({ version: r.version, md });
    }
    if (!textos.length) return { archivada, nueva: 'vacio' };

    if (p.anteriorPatientId && p.anteriorPatientId !== g.patient_id) {
      const posibles = new Set(textos.map((t) => textoEvolucionDesdeResumen(t.md)));
      const { data: ns, error: en } = await db.from('session_notes').select('id, content, historial')
        .eq('patient_id', p.anteriorPatientId).is('deleted_at', null);
      if (en) throw errDe('leer_notas', en);
      for (const n of (ns ?? []) as { id: string; content: string | null; historial?: unknown }[]) {
        const intacta = posibles.has(n.content ?? '') && (!Array.isArray(n.historial) || n.historial.length === 0);
        if (!intacta) continue;
        const { data: hecha, error: ea } = await db.from('session_notes').update({ deleted_at: new Date().toISOString() })
          .eq('id', n.id).eq('content', n.content).is('deleted_at', null).select('id');
        if (ea) throw errDe('archivar_nota', ea);
        if (hecha?.length) {
          archivada = true;
          await auditar('sistema', ACCION_EVOLUCION_AUTO, {
            grabacionId: g.id, patientId: p.anteriorPatientId, cliente: db,
            detalle: { motivo: 'archivada_por_reasignacion', nota_id: n.id, nueva_ficha: g.patient_id },
          }).catch(() => false);
        }
      }
    }
    const nueva = await autollenarEvolucion({ db, grabacion: g, contenido: textos[0].md, version: textos[0].version });
    return { archivada, nueva };
  } catch (e) {
    const etapa = e instanceof ErrorEvolucion ? e.etapa : 'inesperado';
    const codigo = e instanceof ErrorEvolucion ? e.codigo : null;
    console.warn('[transcriptor/evolucionAuto] reasignación de la evolución omitida:', etapa, codigo ?? '');
    await auditar('sistema', ACCION_EVOLUCION_AUTO, {
      grabacionId: g.id, patientId: g.patient_id, resultado: 'error', cliente: db, detalle: { etapa: `reasignar_${etapa}`, codigo },
    }).catch(() => false);
    return { archivada, nueva: 'error' };
  }
}
