import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { createPaymentOrder, FLOW_URLS } from '../../../lib/flow';
import { syncBookingToCalendar } from '../../../lib/syncCalendar';

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

    // session_type debe ser uno de los valores permitidos por el CHECK constraint
    const validTypes = ['individual', 'pareja', 'grupal', 'paquete'];
    const sessionType = validTypes.includes(serviceType) ? serviceType : 'individual';

    // Crear registro en bookings (para trazabilidad)
    // Usamos session_date = '2099-12-31' como marcador de cobro manual.
    // El índice único idx_bookings_slot excluye esa fecha → sin colisiones.
    const bookingId = crypto.randomUUID();

    // Si no se indica fecha, usar marcador 2099-12-31 (excluido del índice único)
    const finalDate = sessionDate ?? '2099-12-31';
    const finalTime = sessionTime ?? '00:00';

    const { error: bookingErr } = await supabase.from('bookings').insert({
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
    });

    if (bookingErr) {
      console.error('[payment-link] booking insert:', bookingErr.message);
      return Response.json({ error: 'Error al registrar cobro: ' + bookingErr.message }, { status: 500 });
    }

    // URL base del sitio — se deriva del request para funcionar en cualquier dominio
    const reqUrl  = new URL(request.url);
    const siteUrl = `${reqUrl.protocol}//${reqUrl.host}`;

    // Crear orden en Flow
    const order = await createPaymentOrder({
      subject:         description,
      amount:          amountInt,
      email:           email.trim().toLowerCase(),
      orderId:         bookingId,
      urlConfirmation: `${siteUrl}/api/flow/confirm`,
      urlReturn:       `${siteUrl}/api/flow/return`,
      baseUrl,
    });

    const paymentUrl = `${order.url}?token=${order.token}`;

    // Guardar el token de Flow en mp_preference_id para que el webhook pueda encontrar esta reserva
    await supabase
      .from('bookings')
      .update({ mp_preference_id: order.token })
      .eq('id', bookingId);

    // Si es online con fecha/hora → crear evento en Google Calendar y obtener Meet link ahora
    let meetLink: string | undefined;
    const isOnline = modality === 'online';
    if (isOnline && finalDate !== '2099-12-31') {
      const calResult = await syncBookingToCalendar({
        id:            bookingId,
        session_type:  `${sessionType}-online`,   // solo para que syncBookingToCalendar active Meet
        session_date:  finalDate,
        session_time:  finalTime,
        patient_name:  name.trim(),
        patient_email: email.trim().toLowerCase(),
        amount:        amountInt,
      }).catch(() => ({ success: false as const }));

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

    const whatsappUrl = waPhone.length >= 11
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
