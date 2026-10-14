// Vitrina (14 oct 2026): talleres, charlas y contenido digital que se venden
// en /talleres. Todo lo que toca la base, Flow, Google Calendar o correos.
// Las ayudas puras (fechas, cupos, slugs, CSV) están en vitrinaUtils.ts.
//
// Pagos: usa las MISMAS funciones de Flow que las reservas (createPaymentOrder
// y getPaymentStatus de flow.ts), con orden "VT-<id>" y sus propios endpoints
// (/api/vitrina/flow-confirm y /api/vitrina/flow-return). El webhook de las
// reservas (/api/flow/confirm) no se toca y nunca recibe pagos de la vitrina.

import type { AstroCookies } from 'astro';
import { supabase } from './supabase';
import { getPaymentStatus, FLOW_URLS, type FlowStatus } from './flow';
import { sendVitrinaConfirmation, sendVitrinaAdminNotification, ADMIN_EMAIL_FALLBACK, type VitrinaEmailData } from './email';
import { logInfo, logWarn, logError } from './logger';
import { DIRECCION, conEstacionamiento } from '../data/consulta';
import { COOKIE_ADMIN, tokenAdminValido, tokenRevocado } from './adminSession';
import { getValidAccessToken } from './syncCalendar';
import { createCalendarEvent, updateCalendarEventTime, updateCalendarEventTitle } from './googleCalendar';
import { VITRINA_EXPIRA_MS, TIPO_LABEL, idDesdeOrden, partesChile, esEnlaceExterno, cuposRestantes, type VitrinaTipo } from './vitrinaUtils';

export const BUCKET_CONTENIDO = 'vitrina-contenido';
export const SETTING_PUBLICA = 'vitrina_publica';
export const COOKIE_PAGO_VITRINA = 'vo_vitrina_pago';
const DESCARGA_SEGUNDOS = 7 * 24 * 60 * 60;

export interface VitrinaItem {
  id: string;
  slug: string;
  type: VitrinaTipo;
  title: string;
  short_description: string | null;
  description: string | null;
  price: number;
  modality: 'online' | 'presencial';
  starts_at: string | null;
  duration_min: number | null;
  capacity: number | null;
  image_url: string | null;
  digital_file_path: string | null;
  meet_url: string | null;
  google_event_id: string | null;
  visible: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface VitrinaInscripcion {
  id: string;
  item_id: string;
  name: string;
  email: string;
  phone: string | null;
  status: 'pending_payment' | 'paid' | 'free' | 'cancelled' | 'expired';
  amount: number;
  flow_token: string | null;
  flow_order: string | null;
  paid_at: string | null;
  payment_note: string | null;
  confirmation_sent_at: string | null;
  origen: unknown;
  created_at: string;
}

// ── Interruptor y vista previa ───────────────────────────────────────────────

/** ¿La vitrina está publicada? (Configuración → vitrina_publica = 'true'). */
export async function vitrinaPublica(): Promise<boolean> {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', SETTING_PUBLICA).maybeSingle();
    return data?.value === 'true';
  } catch { return false; }
}

/** ¿Quien visita tiene la sesión del panel abierta? (para la vista previa). */
export async function esAdmin(cookies: AstroCookies): Promise<boolean> {
  const token = cookies.get(COOKIE_ADMIN)?.value ?? '';
  if (!tokenAdminValido(token)) return false;
  try { return !(await tokenRevocado(token)); } catch { return false; }
}

/** Entorno de Flow igual que las reservas: setting flow_env o la variable de entorno. */
export async function flowBaseDesdeSettings(): Promise<string | undefined> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'flow_env').maybeSingle();
  return data?.value === 'production' ? FLOW_URLS.production : data?.value === 'sandbox' ? FLOW_URLS.sandbox : undefined;
}

export async function correoAdmin(): Promise<string> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  return data?.value || ADMIN_EMAIL_FALLBACK;
}

// ── Cupos y vencimiento ──────────────────────────────────────────────────────

/** Libera las inscripciones que llevan más de 30 min esperando pago (como las
 *  reservas). Se hace "al pasar": al contar cupos y al inscribir; no hay cron. */
export async function expirarPendientes(itemId?: string): Promise<void> {
  const corte = new Date(Date.now() - VITRINA_EXPIRA_MS).toISOString();
  let q = supabase.from('vitrina_inscripciones').update({ status: 'expired' })
    .eq('status', 'pending_payment').lt('created_at', corte);
  if (itemId) q = q.eq('item_id', itemId);
  const { error } = await q;
  if (error) console.warn('[vitrina] no se pudieron vencer inscripciones pendientes:', error.message);
}

/** Inscripciones que ocupan cupo por item: pagadas, gratis y pendientes de < 30 min. */
export async function ocupadosPorItem(ids: string[]): Promise<Map<string, number>> {
  const mapa = new Map<string, number>();
  if (!ids.length) return mapa;
  const corte = new Date(Date.now() - VITRINA_EXPIRA_MS).toISOString();
  const { data, error } = await supabase.from('vitrina_inscripciones')
    .select('item_id, status, created_at')
    .in('item_id', ids)
    .or(`status.in.(paid,free),and(status.eq.pending_payment,created_at.gte."${corte}")`);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as { item_id: string }[]) mapa.set(r.item_id, (mapa.get(r.item_id) ?? 0) + 1);
  return mapa;
}

export async function cuposDe(item: Pick<VitrinaItem, 'id' | 'capacity'>): Promise<{ ocupados: number; restantes: number | null }> {
  const ocupados = (await ocupadosPorItem([item.id])).get(item.id) ?? 0;
  return { ocupados, restantes: cuposRestantes(item.capacity, ocupados) };
}

// ── Datos para el correo ─────────────────────────────────────────────────────

/** Dirección de la consulta con las indicaciones para estacionar (solo inscritas). */
async function direccionConEstacionamiento(): Promise<string> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'clinic_address').maybeSingle();
  const base = data?.value?.trim() || `${DIRECCION.calle}, ${DIRECCION.detalle}, ${DIRECCION.comuna}`;
  return conEstacionamiento(base);
}

/** Link de descarga: enlace externo tal cual, o link firmado del bucket privado (7 días). */
export async function linkDescarga(item: Pick<VitrinaItem, 'digital_file_path'>): Promise<string | null> {
  const ruta = (item.digital_file_path ?? '').trim();
  if (!ruta) return null;
  if (esEnlaceExterno(ruta)) return ruta;
  const { data, error } = await supabase.storage.from(BUCKET_CONTENIDO).createSignedUrl(ruta, DESCARGA_SEGUNDOS, { download: true });
  if (error || !data?.signedUrl) {
    await logError('vitrina/descarga', 'No se pudo generar el link de descarga del contenido', { ruta, error: error?.message });
    return null;
  }
  return data.signedUrl;
}

async function datosCorreo(insc: VitrinaInscripcion, item: VitrinaItem): Promise<VitrinaEmailData> {
  return {
    inscripcion_id: insc.id,
    name:           insc.name,
    email:          insc.email,
    phone:          insc.phone,
    item_title:     item.title,
    item_type:      item.type,
    modality:       item.modality,
    starts_at:      item.starts_at,
    duration_min:   item.duration_min,
    amount:         insc.amount,
    meet_url:       item.type !== 'contenido' && item.modality === 'online' ? item.meet_url : null,
    direccion:      item.type !== 'contenido' && item.modality === 'presencial' ? await direccionConEstacionamiento() : null,
    download_url:   item.type === 'contenido' ? await linkDescarga(item) : null,
  };
}

/**
 * Envía la confirmación de una inscripción pagada o gratis.
 * - Automático (webhook, inscripción gratis): una sola vez. Se "toma" la fila
 *   con confirmation_sent_at IS NULL; si el envío falla se suelta para que el
 *   siguiente aviso de Flow (o "Reenviar" en el panel) lo reintente. Además
 *   lleva llave de idempotencia de Resend.
 * - forzar (botón "Reenviar" del panel): siempre envía.
 */
export async function enviarConfirmacion(inscId: string, opts: { forzar?: boolean; avisarAdmin?: boolean } = {}): Promise<{ sent: boolean; reason?: string }> {
  const { data: insc } = await supabase.from('vitrina_inscripciones').select('*').eq('id', inscId).maybeSingle();
  if (!insc) return { sent: false, reason: 'Inscripción no encontrada' };
  if (insc.status !== 'paid' && insc.status !== 'free') return { sent: false, reason: 'La inscripción no está pagada ni es gratis' };
  const { data: item } = await supabase.from('vitrina_items').select('*').eq('id', insc.item_id).maybeSingle();
  if (!item) return { sent: false, reason: 'Item no encontrado' };

  const ahora = new Date().toISOString();
  if (!opts.forzar) {
    const { data: tomada } = await supabase.from('vitrina_inscripciones')
      .update({ confirmation_sent_at: ahora }).eq('id', inscId).is('confirmation_sent_at', null).select('id');
    if (!tomada?.length) return { sent: true, reason: 'ya enviada' };
  }

  const data = await datosCorreo(insc as VitrinaInscripcion, item as VitrinaItem);
  let res: { sent: boolean; reason?: string };
  try {
    res = await sendVitrinaConfirmation(data, opts.forzar ? {} : { idempotencyKey: `vitrina-confirmacion-${inscId}` });
  } catch (e) {
    res = { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.sent) {
    if (!opts.forzar) await supabase.from('vitrina_inscripciones').update({ confirmation_sent_at: null }).eq('id', inscId).eq('confirmation_sent_at', ahora);
    await logError('vitrina/confirmacion', `No se pudo enviar la confirmación a ${insc.name} (${item.title}). Reenvíala desde Vitrina en el panel.`, { inscripcionId: inscId, error: res.reason });
    return res;
  }
  if (opts.forzar) await supabase.from('vitrina_inscripciones').update({ confirmation_sent_at: ahora }).eq('id', inscId);

  if (opts.avisarAdmin) {
    try {
      let cupos: string | null = null;
      if (item.capacity) {
        const { ocupados } = await cuposDe(item as VitrinaItem);
        cupos = `${ocupados} de ${item.capacity} ocupados`;
      }
      await sendVitrinaAdminNotification({ ...data, cupos }, await correoAdmin(), { idempotencyKey: `vitrina-admin-${inscId}` });
    } catch (e) {
      await logWarn('vitrina/aviso-admin', 'No se pudo enviar el aviso de nueva inscripción a Valentina', { inscripcionId: inscId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return res;
}

// ── Pago con Flow ────────────────────────────────────────────────────────────

export type ResultadoPago = 'pagada' | 'pendiente' | 'rechazada' | 'cancelada' | 'desconocida';

/**
 * Consulta el estado REAL del pago en Flow (getPaymentStatus, como el webhook
 * de reservas) y actualiza la inscripción. Idempotente: un reintento de Flow,
 * o la página de vuelta llamándolo a la vez, no duplica nada (guardia
 * paid_at IS NULL + confirmation_sent_at). Lanza si Flow no responde.
 */
export async function procesarPagoFlow(token: string): Promise<{ resultado: ResultadoPago; inscripcion: VitrinaInscripcion | null; status?: FlowStatus }> {
  const status = await getPaymentStatus(token, await flowBaseDesdeSettings());

  let { data: insc } = await supabase.from('vitrina_inscripciones').select('*').eq('flow_token', token).maybeSingle();
  if (!insc) {
    const id = idDesdeOrden(status.commerceOrder);
    if (id) ({ data: insc } = await supabase.from('vitrina_inscripciones').select('*').eq('id', id).maybeSingle());
  }
  if (!insc) {
    if (status.status === 2) {
      await logError('vitrina/pago-huerfano', 'Flow confirmó un pago de la vitrina pero ninguna inscripción coincide. Revisar en Flow y conciliar a mano.', { token, flowOrder: status.flowOrder, commerceOrder: status.commerceOrder, amount: status.amount });
    }
    return { resultado: 'desconocida', inscripcion: null, status };
  }

  if (status.status === 2) {
    const flowOrder = String(status.flowOrder);
    if (insc.status === 'cancelled') {
      // Valentina la había cancelado: no se revive sola. Queda el registro del
      // pago y un error visible para devolverlo o reinscribir a la persona.
      if (!insc.paid_at) {
        await supabase.from('vitrina_inscripciones')
          .update({ paid_at: new Date().toISOString(), flow_order: flowOrder, payment_note: 'Flow (inscripción cancelada)' })
          .eq('id', insc.id).is('paid_at', null);
        await logError('vitrina/pago-cancelada', `Pago recibido de ${insc.name} (${insc.email}) por una inscripción que estaba cancelada. Sigue cancelada: hay que devolver el pago o volver a inscribirla.`, { inscripcionId: insc.id, flowOrder, amount: status.amount });
      }
      return { resultado: 'cancelada', inscripcion: insc as VitrinaInscripcion, status };
    }
    if (insc.paid_at && insc.flow_order !== flowOrder && insc.payment_note !== 'Flow') {
      await logError('vitrina/posible-pago-doble', `${insc.name} pagó por Flow (${status.amount}) una inscripción que ya figuraba pagada (${insc.payment_note ?? 'otro medio'}). Revisa si hay que devolver el pago.`, { inscripcionId: insc.id, flowOrder, amount: status.amount });
    }
    if (!insc.paid_at) {
      if (Number(status.amount) !== Number(insc.amount)) {
        await logError('vitrina/monto-distinto', `El pago de Flow (${status.amount}) no coincide con el valor de la inscripción (${insc.amount}). Se confirmó igual; revisa la diferencia.`, { inscripcionId: insc.id, flowOrder });
      }
      const estabaVencida = insc.status === 'expired';
      const { data: upd, error } = await supabase.from('vitrina_inscripciones')
        .update({ status: 'paid', paid_at: new Date().toISOString(), flow_order: flowOrder, payment_note: 'Flow' })
        .eq('id', insc.id).is('paid_at', null).select('*');
      if (error) {
        await logError('vitrina/confirmar-pago', 'Pago recibido pero la inscripción no se pudo marcar como pagada', { inscripcionId: insc.id, flowOrder, error: error.message });
        throw new Error(error.message); // 500 → Flow reintenta
      }
      if (upd?.length) {
        insc = upd[0];
        await logInfo('vitrina/pagada', `Inscripción pagada: ${insc.name}`, { inscripcionId: insc.id, itemId: insc.item_id, flowOrder });
        if (estabaVencida) {
          // Pagó tarde (después de los 30 min): se confirma igual porque el pago es real.
          const { data: item } = await supabase.from('vitrina_items').select('id, capacity, title').eq('id', insc.item_id).maybeSingle();
          if (item?.capacity) {
            const { ocupados } = await cuposDe(item as VitrinaItem);
            if (ocupados > item.capacity) {
              await logWarn('vitrina/sobrecupo', `${insc.name} pagó tarde "${item.title}" y quedó sobre el cupo (${ocupados} de ${item.capacity}). Se confirmó igual.`, { inscripcionId: insc.id });
            }
          }
        }
      }
    }
    await enviarConfirmacion(insc.id, { avisarAdmin: true });
    return { resultado: 'pagada', inscripcion: insc as VitrinaInscripcion, status };
  }

  if (status.status === 3 || status.status === 4) {
    await supabase.from('vitrina_inscripciones').update({ status: 'cancelled' }).eq('id', insc.id).eq('status', 'pending_payment');
    return { resultado: 'rechazada', inscripcion: insc as VitrinaInscripcion, status };
  }
  return { resultado: 'pendiente', inscripcion: insc as VitrinaInscripcion, status };
}

// ── Google Calendar (Meet) ───────────────────────────────────────────────────

/** id fijo del evento (base32hex): un reintento no crea un segundo evento. */
const idEvento = (itemId: string) => `vitrina${itemId.replace(/-/g, '')}`;

/**
 * Crea (o mueve) el evento del item en el Google Calendar de Valentina: así la
 * hora queda ocupada en la agenda y, si es online, se genera el Meet. No invita
 * a nadie: las inscritas reciben el link por correo. Devuelve el Meet (o null).
 */
export async function sincronizarEventoItem(item: VitrinaItem): Promise<{ ok: boolean; meetUrl: string | null; error?: string }> {
  if (item.type === 'contenido' || !item.starts_at) return { ok: true, meetUrl: item.meet_url };
  const partes = partesChile(item.starts_at);
  if (!partes) return { ok: false, meetUrl: item.meet_url, error: 'Fecha inválida' };
  const auth = await getValidAccessToken().catch(() => null);
  if (!auth) return { ok: false, meetUrl: item.meet_url, error: 'Google Calendar no está conectado (Configuración).' };
  const titulo = `${TIPO_LABEL[item.type]}: ${item.title}`;
  const duracion = item.duration_min || 60;
  const lugar = item.modality === 'presencial' ? `${DIRECCION.calle}, ${DIRECCION.detalle}, ${DIRECCION.comuna}` : undefined;
  try {
    if (item.google_event_id) {
      await updateCalendarEventTime(auth.token, auth.calendarId, item.google_event_id, partes.fecha, partes.hora, duracion, lugar, false);
      await updateCalendarEventTitle(auth.token, auth.calendarId, item.google_event_id, titulo);
      return { ok: true, meetUrl: item.meet_url };
    }
    const ev = await createCalendarEvent(auth.token, {
      title: titulo,
      description: `Vitrina (${TIPO_LABEL[item.type].toLowerCase()} grupal). Las personas inscritas reciben el enlace por correo; ver inscritas en /admin/vitrina.`,
      location: lugar,
      date: partes.fecha,
      startTime: partes.hora,
      durationMin: duracion,
      isOnline: item.modality === 'online',
      calendarId: auth.calendarId,
      eventId: idEvento(item.id),
    });
    const meetUrl = item.modality === 'online' ? (item.meet_url || ev.meetLink || null) : item.meet_url;
    await supabase.from('vitrina_items').update({ google_event_id: ev.id, meet_url: meetUrl, updated_at: new Date().toISOString() }).eq('id', item.id);
    return { ok: true, meetUrl };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logError('vitrina/calendario', `No se pudo crear o actualizar el evento de "${item.title}" en Google Calendar`, { itemId: item.id, error: msg });
    return { ok: false, meetUrl: item.meet_url, error: msg.slice(0, 160) };
  }
}
