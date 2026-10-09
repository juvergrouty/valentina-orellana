import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { createPaymentOrder, FLOW_URLS } from '../../../lib/flow';
import { syncBookingToCalendar } from '../../../lib/syncCalendar';
import { upsertPatientFromBooking } from '../../../lib/patients';
import { chocaConOtraSesion } from '../../../lib/disponibilidad';
import { tagBookingsWithPaymentToken } from '../../../lib/debt';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { name, email, phone, amount, description, serviceType, sessionDate, sessionTime, modality, force } = body;

    // Validación básica
    if (!name?.trim() || !email?.trim() || !amount || !description?.trim()) {
      return Response.json({ error: 'Faltan campos requeridos (nombre, email, monto, descripción).' }, { status: 400 });
    }
    const amountInt = parseInt(amount);
    if (isNaN(amountInt) || amountInt < 1000) {
      return Response.json({ error: 'Monto inválido (mínimo $1.000 CLP).' }, { status: 400 });
    }

    // Verificar cobro duplicado en la última hora (misma email + monto)
    if (!force) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: recent } = await supabase
        .from('bookings')
        .select('id, patient_name, amount, created_at')
        .eq('patient_email', email.trim().toLowerCase())
        .eq('amount', amountInt)
        .like('notes', 'Cobro manual%')
        .gte('created_at', oneHourAgo)
        .order('created_at', { ascending: false })
        .limit(1);

      if (recent && recent.length > 0) {
        const prev = recent[0];
        const mins = Math.round((Date.now() - new Date(prev.created_at).getTime()) / 60000);
        return Response.json({
          warning:  true,
          message:  `Ya se generó un cobro de $${new Intl.NumberFormat('es-CL').format(amountInt)} para ${prev.patient_name} hace ${mins} minuto${mins !== 1 ? 's' : ''}. ¿Deseas enviar uno nuevo de todas formas?`,
          duplicate: { id: prev.id, createdAt: prev.created_at, minutesAgo: mins },
        });
      }
    }

    // Leer configuración de Flow
    const { data: settingsRows } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', ['flow_env', 'flow_enabled']);

    const cfg = Object.fromEntries((settingsRows ?? []).map(r => [r.key, r.value]));
    const flowEnv   = cfg['flow_env'] ?? 'sandbox';
    const flowEnabled = cfg['flow_enabled'] !== 'false';

    if (!flowEnabled) {
      return Response.json({ error: 'Flow está deshabilitado en la configuración.' }, { status: 400 });
    }

    const baseUrl = flowEnv === 'production' ? FLOW_URLS.production : FLOW_URLS.sandbox;

    // Normalizar teléfono para WhatsApp (+56912345678 → 56912345678)
    let waPhone = (phone ?? '').replace(/\D/g, '');
    if (waPhone.startsWith('0'))  waPhone = waPhone.slice(1);
    if (waPhone.length === 9)     waPhone = '56' + waPhone;
    if (waPhone.length === 11 && waPhone.startsWith('0')) waPhone = waPhone.slice(1);

    // session_type igual que en el resto del sitio (online | presencial |
    // pareja-online | pareja-presencial): los correos, recordatorios y el
    // calendario deciden con él si la sesión es online. Antes se guardaba
    // "individual"/"pareja" y una sesión online quedaba como presencial.
    const mod = modality === 'online' ? 'online' : 'presencial';
    const sessionType = serviceType === 'pareja' ? `pareja-${mod}` : mod;

    // Crear registro en bookings (para trazabilidad)
    // Usamos session_date = '2099-12-31' como marcador de cobro manual.
    // El índice único idx_bookings_slot excluye esa fecha → sin colisiones.
    const bookingId = crypto.randomUUID();

    // Si no se indica fecha, usar marcador 2099-12-31 (excluido del índice único)
    const finalDate = sessionDate ?? '2099-12-31';
    const finalTime = sessionTime ?? '00:00';

    // Con fecha y hora, el cobro es una sesión real en la agenda: no puede
    // cruzarse con otra (antes solo lo frenaba el índice de hora exacta, y un
    // cobro a las 10:30 encima de una sesión de 10:00 pasaba — auditoría 8 oct 2026).
    if (finalDate !== '2099-12-31') {
      const choca = await chocaConOtraSesion(finalDate, finalTime, 50);
      if (choca) return Response.json({ error: 'Ese horario se cruza con otra sesión agendada. Elige otra hora.' }, { status: 409 });
    }

    const filaCobro: Record<string, unknown> = {
      id:             bookingId,
      session_type:   sessionType,
      session_date:   finalDate,
      session_time:   finalTime,
      patient_name:   name.trim(),
      patient_email:  email.trim().toLowerCase(),
      patient_phone:  phone?.trim() ?? '',
      notes:          `Cobro manual generado desde admin · ${description}`,
      status:         'pending_payment',
      payment_method: 'flow',
      amount:         amountInt,
      // Cobro creado por Valentina: nunca se libera solo a los 30 min (eso es
      // solo para reservas web abandonadas, ver expireBooking.ts). Sin esto,
      // el cobro caducaba, le llegaba a la paciente "tu reserva expiró" y el
      // link /pagar decía que no debía nada.
      created_by_admin: true,
      // Duración guardada (8 oct 2026): sin ella el calendario usaba 55 min
      // (settings) y el control de choques 50. serviceType aquí es solo
      // 'individual'/'pareja' (no un servicio del catálogo), así que va 50,
      // lo mismo que se usó arriba para revisar choques.
      duration_min:   50,
    };
    let { error: bookingErr } = await supabase.from('bookings').insert(filaCobro);
    if (bookingErr?.code === '42703') {
      // Base sin la columna (migración vieja): se guarda sin ella, como antes.
      const { duration_min: _d, ...sinDuracion } = filaCobro;
      ({ error: bookingErr } = await supabase.from('bookings').insert(sinDuracion));
    }

    if (bookingErr) {
      console.error('[payment-link] booking insert:', bookingErr.message);
      return Response.json({ error: 'Error al registrar cobro: ' + bookingErr.message }, { status: 500 });
    }

    // URL base del sitio — se deriva del request para funcionar en cualquier dominio
    const reqUrl  = new URL(request.url);
    const siteUrl = `${reqUrl.protocol}//${reqUrl.host}`;

    // Link de pago: la misma página intermedia /pagar/[id] que usa "Cobrar" en
    // todos lados — antes acá se creaba una orden de Flow propia y se mandaba
    // el link crudo de Flow por WhatsApp/copiar, distinto e inconsistente con
    // el resto del sitio (y esa orden quedaba huérfana si el cobro se pagaba
    // por otra vía). Ahora se asegura la ficha del paciente y no se crea
    // ninguna orden hasta que el paciente aprieta "Ir a pagar" en esa página.
    const patientId = await upsertPatientFromBooking({
      patient_name: name.trim(), patient_email: email.trim().toLowerCase(), patient_phone: phone?.trim() ?? '',
    });

    let paymentUrl: string;
    if (patientId) {
      paymentUrl = `${siteUrl}/pagar/${patientId}`;
    } else {
      // Respaldo si no se pudo crear/encontrar la ficha del paciente: orden de Flow directa.
      const order = await createPaymentOrder({
        subject:         description,
        amount:          amountInt,
        email:           email.trim().toLowerCase(),
        orderId:         bookingId,
        urlConfirmation: `${siteUrl}/api/flow/confirm`,
        urlReturn:       `${siteUrl}/api/flow/return`,
        baseUrl,
      });
      paymentUrl = `${order.url}?token=${order.token}`;
      await supabase.from('bookings').update({ mp_preference_id: order.token }).eq('id', bookingId);
      // Historial del link (como en los demás cobros): si después se genera
      // otro link, un pago con este igual se reconoce (ver flow/confirm.ts).
      await tagBookingsWithPaymentToken([bookingId], order.token).catch(() => {});
    }

    // Con fecha/hora → evento en Google Calendar ("Por pagar", sin invitar).
    // Online además trae el Meet link ahora. Presencial también lleva evento
    // (8 oct 2026): antes solo online, y la sesión presencial cobrada no
    // aparecía en el calendario de Valentina. syncBookingToCalendar pone la
    // dirección de la consulta y no crea Meet cuando no es online.
    let meetLink: string | undefined;
    const isOnline = modality === 'online';
    if (finalDate !== '2099-12-31') {
      const calResult = await syncBookingToCalendar({
        id:            bookingId,
        session_type:  sessionType,
        session_date:  finalDate,
        session_time:  finalTime,
        patient_name:  name.trim(),
        patient_email: email.trim().toLowerCase(),
        amount:        amountInt,
      }, { unpaid: true, invite: false }).catch(() => ({ success: false as const }));

      if ('meetLink' in calResult && calResult.meetLink) {
        meetLink = calResult.meetLink;
      }
    }

    // Construir mensaje de WhatsApp
    const firstName = name.trim().split(' ')[0];
    const amountFmt = new Intl.NumberFormat('es-CL').format(amountInt);
    const months    = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

    let dateLine = '';
    if (sessionDate) {
      const [, m, d] = sessionDate.split('-');
      dateLine = `📅 ${parseInt(d)} de ${months[parseInt(m) - 1]}`;
      if (sessionTime) dateLine += ` a las ${sessionTime}`;
      dateLine += '\n';
    }

    const modalityLine = isOnline ? '🎥 Sesión online\n' : '📍 Sesión presencial\n';
    const meetLine     = meetLink  ? `\n🔗 Google Meet: ${meetLink}` : '';

    const waMessage = `Hola ${firstName} 👋 Te comparto el enlace de pago para tu sesión:\n\n*${description}*\n${modalityLine}${dateLine}💰 $${amountFmt} CLP\n\n💳 Enlace de pago: ${paymentUrl}${meetLine}\n\nCualquier consulta, escríbeme. ¡Hasta pronto! 🌿`;

    const whatsappUrl = waPhone.length >= 10
      ? `https://wa.me/${waPhone}?text=${encodeURIComponent(waMessage)}`
      : null;

    return Response.json({
      ok:           true,
      paymentUrl,
      whatsappUrl,
      bookingId,
      waPhone,
      waMessage,
      meetLink:     meetLink ?? null,
    });

  } catch (err: any) {
    console.error('[payment-link] error:', err);
    return Response.json({ error: err.message ?? 'Error interno del servidor.' }, { status: 500 });
  }
};
