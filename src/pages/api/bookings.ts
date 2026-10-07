import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { createPaymentOrder, PUBLIC_PAY_TIMEOUT_SECONDS, getPaymentStatus, FLOW_URLS } from '../../lib/flow';
import { limpiarNotasPaciente } from '../../lib/notasPaciente';
import { sendConfirmationToClient, sendNotificationToAdmin } from '../../lib/email';
import { logInfo, logWarn, logError } from '../../lib/logger';
import { upsertPatientFromBooking } from '../../lib/patients';
import { ADMIN_EMAIL_FALLBACK } from '../../lib/email';
import { hoursUntilSessionCL } from '../../lib/dateUtils';
import { expireStaleBookings } from '../../lib/expireBooking';
import { tagBookingsWithPaymentToken } from '../../lib/debt';
import { horaDisponible } from '../../lib/disponibilidad';
import { limpiarRut, rutValido, RUT_EXTRANJERO_SII, TIPOS_DOCUMENTO } from '../../lib/rut';
import { limpiarOrigen } from '../../lib/origen';

export const prerender = false;

// ─── POST /api/bookings ───────────────────────────────────────────────────────
// Crea una reserva en BD (status=pending_payment) y devuelve la URL de pago de Flow
export const POST: APIRoute = async ({ request }) => {
    try {
          return await handleBooking(request);
    } catch (fatal) {
          const msg = fatal instanceof Error ? fatal.message : String(fatal);
          console.error('[bookings] Error fatal:', msg);
          await logError('bookings/fatal', 'Excepción no controlada al crear una reserva — el paciente no pudo reservar', { error: msg });
          return json({ error: 'Error interno del servidor.' }, 500);
    }
};

async function handleBooking(request: Request) {
    // ── Parse body ──────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
    try {
          body = await request.json();
    } catch {
          return json({ error: 'Body inválido.' }, 400);
    }

  const {
        service_id,
        modality_choice,
        session_date,
        session_time,
        patient_name,
        patient_email,
        patient_phone,
        patient_rut,
        notes,
        recaptcha_token,
        patient_address,
        patient_comuna,
        emergency_name,
        emergency_phone,
        doc_tipo,
        doc_numero,
        doc_pais,
  } = body as Record<string, string>;
  // Extranjera/o sin RUT chileno: registra su documento y la boleta sale con
  // el RUT genérico del SII para extranjeros (ver src/lib/rut.ts).
  const sinRut = (body as Record<string, unknown>).sin_rut === true;

  // ── Cargar settings ──────────────────────────────────────────────────────────
  const { data: settingsRows } = await supabase.from('settings').select('key, value');
    const settings: Record<string, string> = {};
    (settingsRows ?? []).forEach(({ key, value }: { key: string; value: string }) => { settings[key] = value; });

  // ── Verificar reCAPTCHA v3 (si hay secret key configurada) ───────────────────
  const recaptchaSecret = settings['recaptcha_secret_key'];

  if (recaptchaSecret) {
        if (!recaptcha_token) {
                return json({ error: 'Verificación de seguridad faltante. Recarga la página e intenta de nuevo.' }, 400);
        }

      const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ secret: recaptchaSecret, response: recaptcha_token }),
      });
        const verifyData = await verifyRes.json();

      // Umbral típico para v3: 0.5. Si baja mucho spam real, se puede subir a 0.7.
      if (!verifyData.success || (typeof verifyData.score === 'number' && verifyData.score < 0.5)) {
              await logWarn('bookings', 'reCAPTCHA rechazado', { score: verifyData.score, errors: verifyData['error-codes'] });
              return json({ error: 'No pudimos verificar que eres una persona. Intenta nuevamente.' }, 400);
      }
  }
    // Si recaptcha_secret_key no está configurada en settings, no se exige nada —
  // mismo comportamiento que hoy, para no romper el flujo mientras no esté activo.

  // ── Validación ───────────────────────────────────────────────────────────────
  if (!service_id || !modality_choice || !session_date || !session_time || !patient_name || !patient_email || !patient_phone || (!patient_rut && !sinRut)) {
        return json({ error: 'Faltan campos obligatorios.' }, 400);
  }
  // Datos mínimos de la ficha (Valentina, 4 oct 2026): dirección, comuna y
  // contacto de emergencia, además de nombre, correo, teléfono y RUT.
  const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.trim() : '').slice(0, max);
  const direccion = txt(patient_address, 200);
  const comuna    = txt(patient_comuna, 80);
  const emergNom  = txt(emergency_name, 120);
  const emergTel  = txt(emergency_phone, 25);
  if (direccion.length < 3 || /[<>]/.test(direccion)) return json({ error: 'Revisa tu dirección.' }, 400);
  if (comuna.length < 2 || /[<>]/.test(comuna)) return json({ error: 'Revisa tu comuna.' }, 400);
  if (emergNom.length < 2 || /[<>]/.test(emergNom)) return json({ error: 'Revisa el nombre de tu contacto de emergencia.' }, 400);
  if (!/^[\d\s()+.-]{7,25}$/.test(emergTel)) return json({ error: 'Revisa el teléfono de tu contacto de emergencia.' }, 400);
  const docTipo   = txt(doc_tipo, 40);
  const docNumero = txt(doc_numero, 40);
  const docPais   = txt(doc_pais, 60);
  if (sinRut) {
    if (!(TIPOS_DOCUMENTO as readonly string[]).includes(docTipo)) return json({ error: 'Elige el tipo de documento.' }, 400);
    if (!/^[\w.\- ]{4,40}$/.test(docNumero)) return json({ error: 'Revisa el número de tu documento.' }, 400);
    if (docPais.length < 2 || /[<>]/.test(docPais)) return json({ error: 'Revisa el país de tu documento.' }, 400);
  }

  // Nombre y teléfono: texto plano, sin caracteres de HTML y con largo acotado
  // (se muestran en el panel y en correos; re-auditoría 4 oct 2026).
  if (/[<>]/.test(patient_name) || patient_name.trim().length > 120 || patient_name.trim().length < 2) {
        return json({ error: 'Revisa tu nombre: usa solo letras.' }, 400);
  }
  if (!/^[\d\s()+.-]{7,25}$/.test(patient_phone.trim())) {
        return json({ error: 'Revisa tu teléfono.' }, 400);
  }
  if (patient_email.trim().length > 200 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(patient_email.trim())) {
        return json({ error: 'Revisa tu correo.' }, 400);
  }

  const rutClean = sinRut ? RUT_EXTRANJERO_SII : limpiarRut(patient_rut);
  if (!sinRut && !rutValido(rutClean)) {
        return json({ error: 'RUT inválido: revisa los números y el dígito verificador.' }, 400);
  }

  if (!['online', 'presencial'].includes(modality_choice)) {
        return json({ error: 'Modalidad inválida.' }, 400);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(session_date) || !/^\d{2}:\d{2}$/.test(session_time)) {
        return json({ error: 'Formato de fecha u hora inválido.' }, 400);
  }

  // OJO: comparar con hoursUntilSessionCL (hora de Chile), no con
  // `new Date(session_date+'T'+session_time) <= new Date()` — ese parseo naive
  // se interpreta en la zona horaria del servidor (UTC en Vercel), lo que
  // desfasaba la comparación en 3-4 horas y podía rechazar horarios futuros
  // válidos (o aceptar horarios ya pasados) según la hora del día.
  if (hoursUntilSessionCL(session_date, session_time) <= 0) {
        return json({ error: 'No puedes reservar en una fecha pasada.' }, 400);
    }

  // ── Liberar reservas pending_payment expiradas (>30 min) ─────────────────────
  // Las reservas creadas por la propia admin (created_by_admin=true) nunca se
  // tocan acá — eso ya lo respeta expireStaleBookings(). Antes esto borraba la
  // fila en silencio; ahora usa la misma función "amable" que availability.ts y
  // el cron, que además avisa al paciente con un link para recuperar su hora.
  try { await expireStaleBookings(new URL(request.url).origin); }
  catch (e) { await logError('bookings/expirar', 'Falló la limpieza de reservas vencidas', { error: e instanceof Error ? e.message : String(e) }); }

  // ── Reserva anterior SIN PAGAR de la misma persona ───────────────────────────
  // Si fue a pagar, se arrepintió y vuelve a reservar (por ejemplo, la misma
  // hora), su reserva anterior sin pagar no debe bloquearla. Re-auditoría 5 oct:
  //   - antes de tocarla se le pregunta a Flow: si ya la pagó (el aviso viene
  //     atrasado) NO se libera;
  //   - se libera recién justo antes de crear la nueva (no antes de revisar la
  //     hora), y si la nueva falla se restaura;
  //   - si después paga en la pestaña vieja de Flow, el aviso de pago
  //     (flow/confirm.ts) confirma esa reserva y libera la nueva sin pagar.
  const flowBaseTemprano = settings['flow_env'] === 'production' ? FLOW_URLS.production
    : settings['flow_env'] === 'sandbox' ? FLOW_URLS.sandbox : undefined;
  let liberables: string[] = [];
  {
    const { data: previas } = await supabase.from('bookings')
      .select('id, created_by_admin, notes, mp_preference_id, session_date, session_time')
      .eq('patient_email', patient_email.trim().toLowerCase())
      .eq('status', 'pending_payment')
      .neq('session_date', '2099-12-31'); // cobros manuales: nunca se tocan
    for (const b of (previas ?? []) as { id: string; created_by_admin?: boolean | null; notes?: string | null; mp_preference_id?: string | null; session_date: string; session_time: string }[]) {
      if (b.created_by_admin || (b.notes ?? '').includes('ComprobanteTransferencia') || (b.notes ?? '').includes('PagoSinAviso')) continue;
      if (b.mp_preference_id) {
        let pagada = false;
        try {
          const st = await Promise.race([
            getPaymentStatus(b.mp_preference_id, flowBaseTemprano),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Flow lento')), 4000)),
          ]);
          pagada = st.status === 2;
        } catch { /* sin respuesta: se trata como no pagada */ }
        if (pagada) {
          if (b.session_date === session_date && String(b.session_time).slice(0, 5) === session_time) {
            return json({ error: 'Ya pagaste esta hora: en unos minutos te llega el correo de confirmación. Si no llega, escríbeme por WhatsApp.' }, 409);
          }
          continue; // pagada: no se toca
        }
      }
      liberables.push(b.id);
    }
  }

  // ── Verificar disponibilidad ─────────────────────────────────────────────────
  const { data: existing } = await supabase
      .from('bookings')
      .select('id')
      .eq('session_date', session_date)
      .eq('session_time', session_time)
      .not('status', 'in', '(cancelled,expired)')
      .not('id', 'in', `(${['00000000-0000-0000-0000-000000000000', ...liberables].join(',')})`)
      .limit(1)
      .maybeSingle();

  if (existing) {
        return json({ error: 'Ese horario ya fue reservado. Por favor elige otro.' }, 409);
  }

  // ── Buscar servicio por ID ────────────────────────────────────────────────────
  const { data: svc, error: svcErr } = await supabase
      .from('services_catalog')
      .select('*')
      .eq('id', service_id)
      .eq('visible', true)
      .single();

  if (svcErr || !svc) {
        await logError('bookings', 'Servicio no encontrado', { service_id, error: svcErr?.message });
        return json({ error: 'Servicio no encontrado.' }, 400);
  }

  // Derivar session_type para la tabla bookings (compatibilidad admin)
  const session_type = svc.type === 'pareja'
      ? `pareja-${modality_choice}`
        : modality_choice;

  // Precio y duración según modalidad elegida
  let finalPrice: number;
    let durationMin: number;

  if (svc.modality === 'ambos') {
        finalPrice  = modality_choice === 'online'
          ? (svc.price_online     ?? svc.price)
                : (svc.price_presencial ?? svc.price);
        durationMin = modality_choice === 'online'
          ? (svc.duration_min_online     ?? svc.duration_min ?? 50)
                : (svc.duration_min_presencial ?? svc.duration_min ?? 50);
  } else {
        finalPrice  = svc.price;
        durationMin = svc.duration_min ?? 50;
  }

  // La modalidad tiene que ser una que el servicio ofrece.
  if (svc.modality && svc.modality !== 'ambos' && svc.modality !== modality_choice) {
        return json({ error: 'Modalidad inválida para este servicio.' }, 400);
  }

  // La hora tiene que estar disponible de verdad (mismo cálculo que la agenda:
  // horario del servicio, horas extra/quitadas, bloqueos, Google Calendar,
  // descanso entre sesiones y cruces con otras reservas). Antes solo se
  // revisaba que no hubiera otra reserva a la misma hora exacta.
  const libre = await horaDisponible({
        date: session_date, time: session_time, serviceId: service_id,
        duration: durationMin, modality: modality_choice, excluirIds: liberables,
  });
  if (libre === null) {
        return json({ error: 'No pudimos comprobar la disponibilidad. Intenta de nuevo en un momento.' }, 503);
  }
  if (!libre) {
        return json({ error: 'Esa hora ya no está disponible. Por favor elige otra.' }, 409);
  }

  await logInfo('bookings', 'Servicio y precio', {
        service_id, name: svc.name, modality_choice, session_type, finalPrice, durationMin,
  });

  // ── Crear reserva en Supabase ────────────────────────────────────────────────
  const bookingPayload: Record<string, unknown> = {
        session_type,
        service_id,
        session_date,
        session_time,
        patient_name:   patient_name.trim(),
        patient_email:  patient_email.trim().toLowerCase(),
        patient_phone:  patient_phone.trim(),
        patient_rut:    rutClean,
        notes:          limpiarNotasPaciente(notes), // sin marcas internas falsas (ver notasPaciente.ts)
        status:         'pending_payment',
        payment_method: 'flow',
        amount:         finalPrice,
        duration_min:   durationMin,
        // De qué sitio/anuncio llegó (ver src/lib/origen.ts). Nunca bloquea la reserva.
        origen:         limpiarOrigen((body as Record<string, unknown>).origen),
  };

  let booking: { id: string } | null = null;

  const tryInsert = async (payload: Record<string, unknown>) => {
        const { data, error } = await supabase.from('bookings').insert(payload).select('id').single();
        return { data, error };
  };

  // Ahora sí: se liberan sus reservas anteriores sin pagar (ver arriba).
  // Solo se restauran las que liberó ESTA petición (un doble clic no debe
  // revivir lo que liberó la otra).
  let liberadasAqui: string[] = [];
  if (liberables.length) {
        const { data: exp } = await supabase.from('bookings').update({ status: 'expired' }).in('id', liberables).eq('status', 'pending_payment').select('id');
        liberadasAqui = (exp ?? []).map((r: { id: string }) => r.id);
  }
  // Si la nueva no se puede crear (o no se puede cobrar), se restauran las anteriores.
  const restaurarLiberadas = async () => {
        if (liberadasAqui.length) await supabase.from('bookings').update({ status: 'pending_payment' }).in('id', liberadasAqui).eq('status', 'expired').is('recovery_token', null);
  };

  let { data: bookingData, error: insertError } = await tryInsert(bookingPayload);

  // Si la columna "origen" aún no existe (migración 0008 pendiente), se reserva
  // igual sin ella: el origen nunca debe impedir una reserva.
  if (insertError && /origen/i.test(insertError.message ?? '')) {
        await logWarn('bookings', 'No se pudo guardar el origen de la reserva, reintentando sin él', { error: insertError.message, code: insertError.code });
        delete bookingPayload.origen;
        ({ data: bookingData, error: insertError } = await tryInsert(bookingPayload));
  }

  // Si falla por columna inexistente, reintentar quitando columnas opcionales una a una
  if (insertError?.code === '42703') {
        await logWarn('bookings', 'Columna desconocida, reintentando sin columnas opcionales', { error: insertError.message });
        let payload = { ...bookingPayload };
        let retry = { data: bookingData, error: insertError };
        const optionalCols = ['duration_min', 'service_id', 'patient_rut'];
        for (const col of optionalCols) {
                if (retry.error?.code !== '42703') break;
                delete payload[col];
                retry = await tryInsert(payload);
        }
        bookingData = retry.data;
        insertError = retry.error;
  }

  if (insertError?.code === '23505') {
        // Otra persona tomó la misma hora en el mismo instante (índice único).
        await restaurarLiberadas();
        return json({ error: 'Ese horario ya fue reservado. Por favor elige otro.' }, 409);
  }
  if (insertError || !bookingData) {
        await restaurarLiberadas();
        await logError('bookings', 'Error insertando reserva', { error: insertError?.message, code: insertError?.code, session_type, session_date, session_time });
        console.error('Error insertando reserva:', insertError);
        return json({ error: 'Error al crear la reserva. Intenta nuevamente.' }, 500);
  }
    booking = bookingData;

  // Guardar al paciente ni bien llena el formulario, no solo cuando paga — así
  // su nombre/correo/teléfono/RUT quedan en la ficha aunque abandone antes de
  // pagar o su hora expire, y Valentina puede rescatarlo manualmente.
  await upsertPatientFromBooking({
    patient_name:  patient_name.trim(),
    patient_email: patient_email.trim().toLowerCase(),
    patient_phone: patient_phone.trim(),
    rut:           rutClean,
    address:         direccion,
    comuna,
    emergency_name:  emergNom,
    emergency_phone: emergTel,
    sin_rut:         sinRut,
    doc_tipo:        sinRut ? docTipo : null,
    doc_numero:      sinRut ? docNumero : null,
    doc_pais:        sinRut ? docPais : null,
  }).catch((e) => logError('bookings', 'No se pudo guardar el paciente al crear la reserva', { error: e instanceof Error ? e.message : String(e) }));

  // ── Leer config desde settings ───────────────────────────────────────────────
  const notificationEmail  = settings['notification_email'] || ADMIN_EMAIL_FALLBACK;
    const manualEnabled      = settings['manual_payment_enabled'] !== 'false';
    const flowEnabled        = settings['flow_enabled'] !== 'false';
    const flowEnvSetting     = settings['flow_env']; // 'sandbox' | 'production' | undefined
  const flowBaseUrl        = flowEnvSetting === 'production'
      ? 'https://www.flow.cl/api'
        : flowEnvSetting === 'sandbox'
      ? 'https://sandbox.flow.cl/api'
        : undefined; // usa el valor del env var FLOW_ENV

  // Verificar si es paciente nuevo (sin reservas confirmadas previas)
  const emailLower = patient_email.trim().toLowerCase();
    const { count: prevCount } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('patient_email', emailLower)
      .in('status', ['confirmed', 'paid'])
      .neq('id', booking.id);
    const isNewPatient = (prevCount ?? 0) === 0;

  const emailData = {
        patient_name:   patient_name.trim(),
        patient_email:  emailLower,
        patient_phone:  patient_phone.trim(),
        session_type,
        session_date,
        session_time,
        amount:         finalPrice,
        payment_method: 'flow',
        is_new_patient: isNewPatient,
        service_name:   svc.name,
  };

  // ── Pago en consulta (manual) ─────────────────────────────────────────────────
  // Desactivado en la web (Valentina, 3 oct 2026): no se ofrece pago en
  // consulta a pacientes que reservan en línea hasta tener cobro con tarjeta
  // presencial (tap to pay). Este camino confirmaba la hora sin ningún pago.
  const isManual = false && (body as Record<string, string>).payment_method === 'manual';

  if (isManual && manualEnabled) {
        // Confirmar directamente sin pasar por Flow
      await supabase
          .from('bookings')
          .update({ status: 'confirmed', payment_method: 'manual' })
          .eq('id', booking.id);

      // Enviar emails (sin bloquear la respuesta) — el paciente ya se guardó arriba
      const ed = { ...emailData, payment_method: 'manual' };
        Promise.all([
                sendConfirmationToClient(ed).catch(console.error),
                sendNotificationToAdmin(ed, notificationEmail).catch(console.error),
              ]);

      return json({ bookingId: booking.id, confirmed: true });
  }

  // ── Flow deshabilitado desde admin ────────────────────────────────────────────
  if (!flowEnabled) {
        await supabase.from('bookings').delete().eq('id', booking.id);
        await restaurarLiberadas();
        return json({ error: 'El pago online está temporalmente deshabilitado. Por favor coordina tu sesión por WhatsApp.' }, 503);
  }

  // ── Validar precio antes de llamar a Flow ────────────────────────────────────
  if (!finalPrice || isNaN(finalPrice) || finalPrice < 100) {
        await logError('bookings', 'Precio inválido antes de Flow', { finalPrice, service_id, session_type });
        await supabase.from('bookings').delete().eq('id', booking.id);
        await restaurarLiberadas();
        return json({ error: `Precio inválido (${finalPrice}). Actualiza el precio del servicio en el admin.` }, 400);
  }

  // ── Crear orden de pago en Flow ──────────────────────────────────────────────
  // Se arma desde la propia petición (no desde PUBLIC_SITE_URL): esa variable de
  // entorno está mal configurada en Vercel Production (apunta a *.vercel.app),
  // igual que se encontró y corrigió en /admin/deudas y /api/pagar-deuda.
  const reqUrl  = new URL(request.url);
  const siteUrl = `${reqUrl.protocol}//${reqUrl.host}`;

  await logInfo('bookings', 'Creando orden Flow', { bookingId: booking.id, amount: finalPrice, email: patient_email.trim().toLowerCase() });

  let flowOrder;
    try {
          flowOrder = await createPaymentOrder({
                  subject:         `${svc.name} — Ps. Valentina Orellana`,
                  amount:          finalPrice,
                  email:           patient_email.trim().toLowerCase(),
                  orderId:         booking.id,
                  urlConfirmation: `${siteUrl}/api/flow/confirm`,
                  urlReturn:       `${siteUrl}/api/flow/return`,
                  baseUrl:         flowBaseUrl,
                  timeoutSeconds:  PUBLIC_PAY_TIMEOUT_SECONDS,
          });
    } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isEmailError = errMsg.includes('1620') || errMsg.toLowerCase().includes('useremail') || errMsg.toLowerCase().includes('email');

      await logError('bookings/flow', 'Error creando orden Flow', {
              bookingId: booking?.id,
              amount: finalPrice,
              session_type,
              isEmailError,
              error: errMsg,
      });

      // Siempre eliminar la reserva para no dejar slots bloqueados
      if (booking?.id) {
              const { error: delErr } = await supabase.from('bookings').delete().eq('id', booking.id);
              await restaurarLiberadas();
              if (delErr) await logError('bookings', 'Error eliminando reserva fallida', { bookingId: booking.id, error: delErr.message });
      }

      if (isEmailError) {
              return json({
                        error: 'El correo electrónico no es válido para el sistema de pago. Por favor usa un correo real.',
                        detail: errMsg,
                        errorType: 'invalid_email',
              }, 400);
      }

      return json({ error: 'Error al conectar con el sistema de pago.', detail: errMsg, errorType: 'flow_error' }, 502);
    }

  // Guardar el token de Flow en la reserva (para luego recuperarla desde el webhook/confirmación)
  await supabase
      .from('bookings')
      .update({ mp_preference_id: flowOrder.token })
      .eq('id', booking.id);
  try { await tagBookingsWithPaymentToken([booking.id], flowOrder.token); } catch (e) {
    await logError('bookings/token-historial', 'No se pudo guardar el historial de token de pago (no bloquea la reserva)', { bookingId: booking.id, error: e instanceof Error ? e.message : String(e) });
  }

  // La URL de pago es: flowOrder.url + '?token=' + flowOrder.token
  return json({
        bookingId:   booking.id,
        checkoutUrl: `${flowOrder.url}?token=${flowOrder.token}`,
  });
};

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
    });
}
