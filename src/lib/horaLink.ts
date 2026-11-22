// Link a UNA hora (22 nov 2026, pedido de Vale): Vale (o el asistente de WhatsApp) elige la hora
// y el servicio y escribe solo nombre + correo o nombre + teléfono. Se crea la reserva
// "esperando pago", la hora queda retenida un plazo (Configuración, 24 h por defecto) y la
// paciente recibe /hora/<token>: esa sola hora, su precio y cómo pagarla. Nunca la agenda.
//
// - Pagar: Flow, SumUp (link) o transferencia, por los mismos caminos de siempre (mismas
//   tareas de envío de tareasEnvio.ts). Se agendó con teléfono → Pasos a seguir por WhatsApp.
// - Los demás datos (RUT, dirección, comuna, consentimiento) son opcionales: Vale los pide en
//   la consulta. La boleta sale cuando hay RUT, siempre con la fecha del pago (fechaEmisionBoleta).
// - Si vence sin pago, el cron la libera y Vale recibe el aviso (vencerHorasLink).
//
// FUNCIÓN PARA OTRAS PARTES DEL SITIO (asistente de WhatsApp): crearHoraConLink. Ver docs/hora-con-link.md.
import { randomBytes } from 'node:crypto';
import { supabase } from './supabase';
import { logError, logInfo, logWarn } from './logger';
import { normalizarTelefono } from './contacto';
import { chocaConOtraSesion, horaDisponible } from './disponibilidad';
import { syncBookingToCalendar, deleteBookingFromCalendar } from './syncCalendar';
import { upsertPatientFromBooking } from './patients';
import { agregarLineaNotas, folioVigente } from './apigateway';
import { hoursUntilSessionCL } from './dateUtils';
import { sendExpiredBookingAdminAlert, ADMIN_EMAIL_FALLBACK, sendPaymentLinkEmail } from './email';
import { sendWhatsappText, sendWhatsappTemplate } from './whatsapp';
import { stepsPageUrl } from './stepsPage';
import { meetDeNotas, normalizarMeet } from './enlaceSesion';
import { conEstacionamiento } from '../data/consulta';
import {
  MARCA_HORA_LINK, MARCA_HORA_VENCIDA, MARCA_HORA_VENCIDA_VISTA, MARCA_PASOS_WA_ENVIADOS, MARCA_PASOS_WA_PENDIENTE,
  MARCA_PASOS_WA_HECHO, MARCA_BOLETA_DATOS, MARCA_BOLETA_DATOS_OCULTA,
  calcularVence, correoValido, mensajeHoraWhatsapp, mensajePasosWhatsapp, origenValido, retencionHoras, tieneMarca,
  enlaceWhatsapp, esHoraLink, type OrigenHora,
} from './horaLinkUtil';

export const SITIO = 'https://www.valentinaorellana.cl';
export const CLAVE_RETENCION = 'hora_link_retencion_horas';
export const FALTA_MIGRACION = 'falta_migracion_0028';
/** Cookie con el código del link: /hora/<token> la guarda y redirige a /hora (sin el código en la URL). */
export const COOKIE_HORA = 'vo_hora';

const TIPOS_SESION = ['online', 'presencial', 'pareja-online', 'pareja-presencial'] as const;

export async function leerRetencionHoras(): Promise<number> {
  const { data } = await supabase.from('settings').select('value').eq('key', CLAVE_RETENCION).maybeSingle();
  return retencionHoras(data?.value);
}

export type CrearHoraInput = {
  /** id del servicio (services_catalog) o un tipo: 'online' | 'presencial' | 'pareja-online' | 'pareja-presencial'. */
  servicio: string;
  /** 'YYYY-MM-DD' (hora de Chile). */
  fecha: string;
  /** 'HH:MM' (hora de Chile). */
  hora: string;
  nombre: string;
  telefono?: string | null;
  correo?: string | null;
  /** Quién la crea: 'panel' (Vale), 'asistente' / 'whatsapp' (asistente de WhatsApp), 'otro'. */
  origen: OrigenHora | string;
  /** Solo si el servicio es "ambos": 'online' | 'presencial'. */
  modalidad?: 'online' | 'presencial' | null;
  /** Precio distinto al del servicio (solo el panel). */
  monto?: number | null;
  /**
   * true = solo una hora que aparece libre en la agenda web (horario + Google Calendar).
   * Por defecto true salvo origen 'panel' (Vale puede agendar fuera de su horario).
   */
  soloHorasLibres?: boolean;
  /** Vale ya vio el aviso "se cruza con…" y eligió agendar igual (solo el panel). */
  permitirCruce?: boolean;
  /** Mandarle el link por correo si se agendó solo con correo (por defecto sí). */
  enviarCorreo?: boolean;
  siteUrl?: string;
};

export type CrearHoraResultado =
  | { ok: true; bookingId: string; token: string; url: string; venceAt: string; canal: 'whatsapp' | 'correo';
      monto: number; servicio: string; mensajeWhatsapp: string; whatsappUrl: string; correoEnviado: boolean }
  | { ok: false; error: string; codigo: 'datos' | 'servicio' | 'precio' | 'ocupada' | 'no_disponible' | 'pasada' | FalloCodigo };
type FalloCodigo = typeof FALTA_MIGRACION | 'base_de_datos';

/**
 * Crea la reserva "esperando pago" retenida y devuelve el link /hora/<token>.
 * Nunca pide RUT, dirección ni comuna. Requiere nombre y (teléfono o correo).
 */
export async function crearHoraConLink(input: CrearHoraInput): Promise<CrearHoraResultado> {
  const nombre = String(input.nombre ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const telRaw = String(input.telefono ?? '').trim();
  const telefono = telRaw ? normalizarTelefono(telRaw) : null;
  const correo = String(input.correo ?? '').trim().toLowerCase();
  const origen = origenValido(input.origen);
  const site = (input.siteUrl ?? SITIO).replace(/\/$/, '');

  if (!nombre) return { ok: false, error: 'Falta el nombre.', codigo: 'datos' };
  if (telRaw && !telefono) return { ok: false, error: 'Revisa el teléfono: en Chile son 9 dígitos (ej. 9 1234 5678); de otro país, con + y el código.', codigo: 'datos' };
  if (correo && !correoValido(correo)) return { ok: false, error: 'Revisa el correo: no parece válido.', codigo: 'datos' };
  if (!telefono && !correo) return { ok: false, error: 'Falta el teléfono o el correo (basta uno).', codigo: 'datos' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fecha ?? '') || !/^\d{2}:\d{2}$/.test(String(input.hora ?? '').slice(0, 5))) {
    return { ok: false, error: 'Falta la fecha o la hora.', codigo: 'datos' };
  }
  const hora = String(input.hora).slice(0, 5);
  const msHasta = hoursUntilSessionCL(input.fecha, hora) * 3600_000;
  if (!(msHasta > 0)) return { ok: false, error: 'Esa hora ya pasó.', codigo: 'pasada' };

  // ── Servicio, modalidad, precio y duración (misma regla que "Agendar hora" del panel) ──
  let svc: any = null;
  if (/^[0-9a-f-]{36}$/i.test(input.servicio)) {
    ({ data: svc } = await supabase.from('services_catalog').select('*').eq('id', input.servicio).maybeSingle());
  } else if ((TIPOS_SESION as readonly string[]).includes(input.servicio)) {
    const tipo = input.servicio.startsWith('pareja') ? 'pareja' : 'individual';
    const mod = input.servicio.includes('online') ? 'online' : 'presencial';
    ({ data: svc } = await supabase.from('services_catalog').select('*')
      .eq('type', tipo).in('modality', [mod, 'ambos']).eq('visible', true)
      .order('sort_order', { ascending: true }).limit(1).maybeSingle());
    if (svc && svc.modality === 'ambos') input = { ...input, modalidad: mod };
  }
  if (!svc) return { ok: false, error: 'No se encontró ese servicio.', codigo: 'servicio' };
  const modalidad: 'online' | 'presencial' = svc.modality === 'ambos'
    ? (input.modalidad === 'online' ? 'online' : 'presencial')
    : (svc.modality === 'online' ? 'online' : 'presencial');
  const sessionType = svc.type === 'pareja' ? `pareja-${modalidad}` : modalidad;
  const precioServicio = svc.modality === 'ambos'
    ? (modalidad === 'online' ? (svc.price_online || svc.price) : (svc.price_presencial || svc.price))
    : svc.price;
  const monto = input.monto && input.monto > 0 ? Math.round(input.monto) : Number(precioServicio);
  if (!Number.isFinite(monto) || monto < 100) return { ok: false, error: 'El servicio no tiene precio para esa modalidad.', codigo: 'precio' };
  const durMin = (svc.modality === 'ambos'
    ? (modalidad === 'online' ? svc.duration_min_online : svc.duration_min_presencial)
    : null) ?? svc.duration_min ?? 50;

  // ── ¿Está libre? ──
  const soloLibres = input.soloHorasLibres ?? origen !== 'panel';
  if (soloLibres) {
    const libre = await horaDisponible({ date: input.fecha, time: hora, serviceId: svc.id, modality: modalidad, duration: durMin });
    if (libre === false) return { ok: false, error: 'Esa hora ya no está disponible.', codigo: 'no_disponible' };
  }
  const choca = await chocaConOtraSesion(input.fecha, hora, durMin);
  const cruceAceptado = !!choca && origen === 'panel' && input.permitirCruce === true;
  if (choca && !cruceAceptado) return { ok: false, error: 'Esa hora se cruza con otra sesión.', codigo: 'ocupada' };

  // ── Ficha existente (por correo o por teléfono): su RUT permite que la boleta salga sola ──
  let rut: string | null = null;
  let correoFinal = correo;
  let telFinal = telefono ?? '';
  try {
    let ficha: { email: string | null; phone: string | null; rut: string | null } | null = null;
    if (correo) ({ data: ficha } = await supabase.from('patients').select('email, phone, rut').eq('email', correo).maybeSingle());
    if (!ficha && telefono) {
      const ult8 = telefono.replace(/\D/g, '').slice(-8);
      const { data: cands } = await supabase.from('patients').select('email, phone, rut').ilike('phone', `%${ult8.slice(0, 4)}%${ult8.slice(4)}%`).limit(10);
      ficha = (cands ?? []).find((p) => normalizarTelefono(p.phone) === telefono) ?? null;
    }
    if (ficha) {
      rut = ficha.rut?.trim() || null;
      if (!correoFinal && ficha.email) correoFinal = String(ficha.email).toLowerCase();
      if (!telFinal && ficha.phone) telFinal = normalizarTelefono(ficha.phone) ?? ficha.phone;
    }
  } catch (e) { console.error('[horaLink] ficha:', e); }

  const token = randomBytes(18).toString('base64url'); // 24 caracteres
  const horas = await leerRetencionHoras();
  const vence = calcularVence(Date.now(), horas, msHasta);
  const canal: 'whatsapp' | 'correo' = telefono ? 'whatsapp' : 'correo';
  const ahora = new Date().toISOString();

  const payload: Record<string, unknown> = {
    session_type: sessionType, service_id: svc.id, session_date: input.fecha, session_time: hora,
    patient_name: nombre, patient_email: correoFinal, patient_phone: telFinal, patient_rut: rut,
    notes: `${MARCA_HORA_LINK} ${ahora} ${origen}`,
    status: 'pending_payment', payment_method: 'flow', amount: monto, duration_min: durMin,
    // Del panel: no vence a los 30 min (expireBooking.ts) y se puede cobrar (debt.ts/esCobrable).
    // Su propio plazo es link_vence_at (vencerHorasLink).
    created_by_admin: true,
    reminder_email_enabled: !!correoFinal, whatsapp_reminder_enabled: false,
    evaluation_email_enabled: false, review_email_enabled: false,
    link_token: token, link_vence_at: vence.toISOString(), link_canal: canal,
    // Cruce aceptado por Vale: fuera de la regla "sin cruces" de la base (migración 0026).
    ...(cruceAceptado ? { cruce_permitido: true } : {}),
  };
  const { data: b, error } = await supabase.from('bookings').insert(payload).select().single();
  if (error?.code === '42703') return { ok: false, error: 'Falta aplicar la actualización 0028 de la base de datos.', codigo: FALTA_MIGRACION };
  if (error?.code === '23505' || error?.code === '23P01') return { ok: false, error: 'Esa hora se acaba de ocupar.', codigo: 'ocupada' };
  if (error || !b) {
    await logError('hora-link/crear', 'No se pudo crear la hora con link', { error: error?.message, fecha: input.fecha, hora });
    return { ok: false, error: 'No se pudo guardar la reserva. Intenta de nuevo.', codigo: 'base_de_datos' };
  }

  // Evento en Google Calendar ya (rojo "Por pagar", sin invitar hasta que pague), como el link de pago del panel.
  try { await syncBookingToCalendar(b, { unpaid: true, invite: false }); } catch (e) { console.error('[horaLink] calendario:', e); }
  // Con correo: ficha desde ya (la página /pagar, la boleta y el consentimiento la usan). Sin correo no hay ficha
  // hasta que la paciente o Vale agreguen uno (la reserva igual sale en la agenda con nombre y teléfono).
  if (correoFinal) await upsertPatientFromBooking({ patient_name: nombre, patient_email: correoFinal, patient_phone: telFinal, rut }).catch(() => null);

  const url = `${site}/hora/${token}`;
  const online = modalidad === 'online';
  const mensajeWhatsapp = mensajeHoraWhatsapp({ nombre, fecha: input.fecha, hora, online, url, venceIso: vence.toISOString() });
  let correoEnviado = false;
  if (canal === 'correo' && correoFinal && input.enviarCorreo !== false) {
    try {
      const r = await sendPaymentLinkEmail({ patientName: nombre, patientEmail: correoFinal, serviceName: svc.name, amount: monto, sessionDate: input.fecha, sessionTime: hora, paymentUrl: url });
      correoEnviado = r.sent;
    } catch (e) { console.error('[horaLink] correo:', e); }
  }
  await logInfo('hora-link/creada', `Hora con link para ${nombre}: ${input.fecha} ${hora}`, { bookingId: b.id, origen, canal, vence: vence.toISOString() });
  return {
    ok: true, bookingId: b.id, token, url, venceAt: vence.toISOString(), canal, monto, servicio: svc.name,
    mensajeWhatsapp, whatsappUrl: enlaceWhatsapp(telFinal, mensajeWhatsapp), correoEnviado,
  };
}

/** Reagendar una hora con link sin pagar: nuevo plazo (desde ahora) que nunca pasa el inicio de la sesión nueva. */
export async function recalcularRetencionHora(bookingId: string, fecha: string, hora: string): Promise<void> {
  const { data: b, error } = await supabase.from('bookings').select('link_vence_at, paid_at, status').eq('id', bookingId).maybeSingle();
  if (error || !b?.link_vence_at || b.paid_at || b.status !== 'pending_payment') return; // sin 0028, pagada o no es hora con link
  const vence = calcularVence(Date.now(), await leerRetencionHoras(), hoursUntilSessionCL(fecha, String(hora).slice(0, 5)) * 3600_000);
  await supabase.from('bookings').update({ link_vence_at: vence.toISOString() }).eq('id', bookingId).is('paid_at', null);
}

export type HoraPublica = {
  id: string; status: string; session_type: string; session_date: string; session_time: string;
  patient_name: string; patient_email: string | null; patient_phone: string | null; patient_rut: string | null;
  amount: number; paid_at: string | null; payment_note: string | null; notes: string | null; service_id: string | null;
  mp_preference_id: string | null; mp_payment_id: string | null; debt_voided: boolean | null; created_by_admin: boolean | null;
  link_token: string; link_vence_at: string | null; link_canal: string | null; duration_min: number | null; created_at: string | null;
};

/** La reserva de un link (o null). Lanza si falta la migración (para responder 404 sin romper). */
export async function horaPorToken(token: string): Promise<HoraPublica | null> {
  const { data, error } = await supabase.from('bookings')
    .select('id, status, session_type, session_date, session_time, patient_name, patient_email, patient_phone, patient_rut, amount, paid_at, payment_note, notes, service_id, mp_preference_id, mp_payment_id, debt_voided, created_by_admin, link_token, link_vence_at, link_canal, duration_min, created_at')
    .eq('link_token', token).maybeSingle();
  if (error) return null;
  return (data as HoraPublica) ?? null;
}

/**
 * Cron cada 5 min: libera las horas con link cuyo plazo venció sin pago. Antes de liberar se le
 * pregunta a Flow si alcanzó a pagar (igual que expireBooking.ts). Una hora con comprobante de
 * transferencia o pago informado por Flow nunca se libera aquí.
 */
export async function vencerHorasLink(hastaMs = Date.now() + 20_000): Promise<{ liberadas: number }> {
  const { data, error } = await supabase.from('bookings')
    .select('id, patient_name, patient_email, patient_phone, session_date, session_time, notes, mp_preference_id, google_event_id, link_vence_at')
    .eq('status', 'pending_payment').is('paid_at', null)
    .or('debt_voided.is.null,debt_voided.eq.false') // deuda anulada por Vale: es decisión suya, no se libera sola
    .not('link_vence_at', 'is', null).lt('link_vence_at', new Date().toISOString())
    .limit(20);
  if (error) return { liberadas: 0 }; // sin la migración 0028 no hay nada que vencer
  const filas = (data ?? []).filter((b) => !/ComprobanteTransferencia|PagoSinAviso/.test(b.notes ?? ''));
  if (!filas.length) return { liberadas: 0 };

  // flow.ts se carga solo aquí: lee la configuración al cargarse y tareasEnvio.ts importa este archivo.
  const { getPaymentStatus, FLOW_URLS } = await import('./flow');
  const { data: envRow } = await supabase.from('settings').select('value').eq('key', 'flow_env').maybeSingle();
  const flowBase = envRow?.value === 'production' ? FLOW_URLS.production : envRow?.value === 'sandbox' ? FLOW_URLS.sandbox : undefined;
  const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  let liberadas = 0;
  for (const b of filas) {
    if (Date.now() > hastaMs) break;
    if (b.mp_preference_id) {
      try {
        const st = await Promise.race([
          getPaymentStatus(b.mp_preference_id, flowBase),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Flow lento')), 4000)),
        ]);
        if (st.status === 2) continue; // pagó: el aviso de Flow la confirma (flow/confirm.ts)
      } catch { continue; } // Flow no respondió: se intenta en la próxima pasada (nunca liberar a ciegas)
    }
    // Link de SumUp: se pregunta antes de liberar (el cron de SumUp corre después de este).
    if (/SumUpCheckout/.test(b.notes ?? '')) {
      try {
        const { revisarLinkSumUpDeSesion } = await import('./sumup');
        if (await revisarLinkSumUpDeSesion(b.id)) continue;
      } catch { continue; }
    }
    const { data: upd } = await supabase.from('bookings').update({ status: 'expired' })
      .eq('id', b.id).eq('status', 'pending_payment').is('paid_at', null).select('id');
    if (!upd?.length) continue;
    liberadas++;
    await agregarLineaNotas(b.id, `${MARCA_HORA_VENCIDA} ${new Date().toISOString()}`);
    if (b.google_event_id) {
      try { await deleteBookingFromCalendar(b.id); }
      catch (e) { await logError('hora-link/vencer', 'No se pudo borrar el evento de Google Calendar de una hora con link vencida', { bookingId: b.id, error: e instanceof Error ? e.message : String(e) }); }
    }
    try {
      await sendExpiredBookingAdminAlert({
        patient_name: b.patient_name, patient_email: b.patient_email || b.patient_phone || '',
        session_date: b.session_date, session_time: String(b.session_time ?? '').slice(0, 5),
      }, notifRow?.value || ADMIN_EMAIL_FALLBACK);
    } catch (e) { console.error('[horaLink] aviso vencida:', e); }
    await logInfo('hora-link/vencida', `Venció sin pago la hora con link de ${b.patient_name} (${b.session_date} ${String(b.session_time).slice(0, 5)}): quedó libre`, { bookingId: b.id });
  }
  return { liberadas };
}

/**
 * Pasos a seguir por WhatsApp (se agendó con teléfono), una sola vez por reserva. Lo llama la tarea
 * "confirmacion" de tareasEnvio.ts tras el pago. Nunca falla hacia afuera: si WhatsApp no está
 * disponible deja la marca PasosWhatsappPendiente y Vale ve en el Inicio el botón para mandarlos ella.
 */
export async function enviarPasosWhatsapp(b: { id: string; patient_name: string; patient_phone: string | null; session_type: string; session_date: string; session_time: string; notes: string | null }): Promise<'enviado' | 'pendiente' | 'ya'> {
  if (tieneMarca(b.notes, MARCA_PASOS_WA_ENVIADOS) || tieneMarca(b.notes, MARCA_PASOS_WA_PENDIENTE)) return 'ya';
  const texto = await textoPasosWhatsapp(b);
  let enviado = false;
  let motivo = 'sin teléfono';
  if (b.patient_phone) {
    // Plantilla aprobada por Meta (si Vale la configura): se puede mandar aunque la paciente no haya escrito en 24 h.
    const { data: tpl } = await supabase.from('settings').select('key, value').in('key', ['whatsapp_pasos_template_name', 'whatsapp_pasos_template_lang']);
    const cfg = Object.fromEntries((tpl ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    if (cfg['whatsapp_pasos_template_name']) {
      const r = await sendWhatsappTemplate(b.patient_phone, cfg['whatsapp_pasos_template_name'], cfg['whatsapp_pasos_template_lang'] || 'es', [texto.replace(/\n+/g, ' · ')]);
      enviado = r.sent; motivo = r.reason ?? motivo;
    }
    if (!enviado) {
      // Texto libre: Meta lo permite si la paciente escribió a este número en las últimas 24 h
      // (lo normal cuando se agendó conversando por WhatsApp).
      const r = await sendWhatsappText(b.patient_phone, texto);
      enviado = r.sent; motivo = r.reason ?? motivo;
    }
  }
  const iso = new Date().toISOString();
  await agregarLineaNotas(b.id, `${enviado ? MARCA_PASOS_WA_ENVIADOS : MARCA_PASOS_WA_PENDIENTE} ${iso}`);
  if (!enviado) await logWarn('hora-link/pasos-whatsapp', `No se pudieron mandar solos por WhatsApp los Pasos a seguir de ${b.patient_name}: mándalos tú desde el Inicio.`, { bookingId: b.id, motivo });
  return enviado ? 'enviado' : 'pendiente';
}

async function datosPasos(): Promise<{ direccion: string | null; pasosUrl: string | null }> {
  const { data: addr } = await supabase.from('settings').select('value').eq('key', 'clinic_address').maybeSingle();
  const direccion = addr?.value?.trim() ? conEstacionamiento(addr.value.trim()) : null;
  let pasosUrl: string | null = null;
  try { pasosUrl = await stepsPageUrl(SITIO); } catch { pasosUrl = null; }
  return { direccion, pasosUrl };
}

export async function textoPasosWhatsapp(b: { patient_name: string; session_type: string; session_date: string; session_time: string; notes: string | null }, datos?: { direccion: string | null; pasosUrl: string | null }): Promise<string> {
  const online = String(b.session_type).includes('online');
  const { direccion, pasosUrl } = datos ?? await datosPasos();
  return mensajePasosWhatsapp({
    nombre: b.patient_name, fecha: b.session_date, hora: String(b.session_time).slice(0, 5), online,
    meet: normalizarMeet(meetDeNotas(b.notes)), direccion, pasosUrl,
  });
}

// ── Avisos del Inicio (cada uno con su botón de «atendido») ─────────────────────────────────
export type AvisoHora = {
  tipo: 'vencida' | 'pasos_whatsapp' | 'boleta_datos';
  bookingId: string; paciente: string; fecha: string; hora: string; cuando: string; monto: number;
  waUrl?: string;
};

export async function avisosHoraLink(): Promise<AvisoHora[]> {
  const desde = new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('bookings')
    .select('id, patient_name, patient_phone, session_type, session_date, session_time, status, paid_at, amount, notes')
    .ilike('notes', `%${MARCA_HORA_LINK} %`).gte('session_date', desde).limit(200);
  if (error) throw new Error(error.message);
  const avisos: AvisoHora[] = [];
  const marcaEn = (n: string | null, m: string) => new RegExp(`^${m} (\\S+)`, 'm').exec(n ?? '')?.[1] ?? '';
  let datos: { direccion: string | null; pasosUrl: string | null } | null = null;
  for (const b of data ?? []) {
    if (!esHoraLink(b.notes)) continue;
    const base = { bookingId: b.id, paciente: b.patient_name, fecha: b.session_date, hora: String(b.session_time).slice(0, 5), monto: b.amount ?? 0 };
    if (b.status === 'expired' && tieneMarca(b.notes, MARCA_HORA_VENCIDA) && !tieneMarca(b.notes, MARCA_HORA_VENCIDA_VISTA)) {
      avisos.push({ ...base, tipo: 'vencida', cuando: marcaEn(b.notes, MARCA_HORA_VENCIDA) });
    }
    if (b.paid_at && b.status !== 'cancelled' && tieneMarca(b.notes, MARCA_PASOS_WA_PENDIENTE) && !tieneMarca(b.notes, MARCA_PASOS_WA_HECHO)) {
      datos ??= await datosPasos();
      const texto = await textoPasosWhatsapp(b, datos);
      avisos.push({ ...base, tipo: 'pasos_whatsapp', cuando: marcaEn(b.notes, MARCA_PASOS_WA_PENDIENTE), waUrl: enlaceWhatsapp(b.patient_phone, texto) });
    }
    if (b.paid_at && b.status !== 'cancelled' && (b.amount ?? 0) > 0 && tieneMarca(b.notes, MARCA_BOLETA_DATOS)
      && !tieneMarca(b.notes, MARCA_BOLETA_DATOS_OCULTA) && !folioVigente(b.notes)) {
      avisos.push({ ...base, tipo: 'boleta_datos', cuando: b.paid_at });
    }
  }
  return avisos;
}
