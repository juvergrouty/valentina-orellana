import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { pricingPlans } from '../../../data/services';
import { syncBookingToCalendar, deleteBookingFromCalendar, rescheduleBookingInCalendar } from '../../../lib/syncCalendar';
import { emitBoletaParaReserva } from '../../../lib/apigateway';
import { sendConfirmationToClient, sendNotificationToAdmin, sendPaymentLinkEmail, ADMIN_EMAIL_FALLBACK } from '../../../lib/email';
import { createPaymentOrder, FLOW_URLS } from '../../../lib/flow';
import { upsertPatientFromBooking } from '../../../lib/patients';
import { sendWhatsappTemplate } from '../../../lib/whatsapp';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  const form   = await request.formData();
  const action = form.get('action')?.toString();
  const dest   = form.get('redirect')?.toString() ?? '/admin/agenda';

  // ── Guardar interruptor de recordatorio (WhatsApp 4h / email 24h) ────────────
  if (action === 'update-reminders') {
    const id    = form.get('id')?.toString();
    const field = form.get('field')?.toString();
    const value = form.get('value')?.toString() === 'true';
    const allowed = ['reminder_email_enabled', 'whatsapp_reminder_enabled', 'evaluation_email_enabled', 'review_email_enabled'];
    if (!id || !field || !allowed.includes(field)) {
      return new Response(JSON.stringify({ ok: false, error: 'Solicitud inválida.' }), { status: 400 });
    }
    const { error } = await supabase.from('bookings').update({ [field]: value }).eq('id', id);
    if (error) {
      const msg = error.code === '42703'
        ? 'Falta aplicar la migración de base de datos (columnas de recordatorio).'
        : error.message;
      return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── Confirmar reserva (link de pago pendiente → confirmada) ─────────────────
  // Esto es distinto de "marcar como pagado": una reserva puede confirmarse sin
  // que necesariamente se haya registrado el medio de pago (caso legacy). El
  // botón "Marcar como pagado" del panel es el que corresponde usar quere se
  // quiere dejar registro explícito del pago — ver action==='mark_paid'.
  if (action === 'confirm') {
    const id = form.get('id')?.toString();
    if (!id) return redirect(dest);
    await supabase.from('bookings').update({ status: 'confirmed' }).eq('id', id);
    const { data: booking } = await supabase.from('bookings').select('*').eq('id', id).single();
    if (booking) {
      // AWAIT: en serverless (Vercel) la función se termina al responder, matando
      // promesas pendientes. Hay que esperar la sincronización antes del redirect.
      try { await syncBookingToCalendar(booking); } catch (e) { console.error('[confirm] sync:', e); }
      try { await upsertPatientFromBooking({ ...booking, rut: booking.patient_rut }); } catch (e) { console.error('[confirm] patient:', e); }
      // Emisión automática de boleta si el servicio lo tiene activado
      if (booking.service_id) {
        try {
          const { data: svc } = await supabase.from('services_catalog').select('boleta_auto').eq('id', booking.service_id).maybeSingle();
          if (svc?.boleta_auto) await emitBoletaParaReserva(id, { enviarEmail: true });
        } catch (e) { console.error('[confirm] boleta:', e); }
      }
    }
    return redirect(dest);
  }

  // ── Marcar como pagado ───────────────────────────────────────────────────────
  // Registra explícitamente que el pago SÍ se recibió (con qué medio), separado
  // del estado de la reserva. Antes de esto, "Pago en consulta" dejaba la
  // reserva como 'confirmed' desde que se agendaba, sin que eso reflejara si la
  // psicóloga ya había recibido la plata — esto es lo que Valentina reportó
  // como "aparece confirmada pero no significa que esté pagada".
  if (action === 'mark_paid') {
    const id     = form.get('id')?.toString();
    const medio  = form.get('medio')?.toString()?.trim() || 'Manual';
    const emitir = form.get('emitir_boleta') === 'on';
    const rut    = form.get('rut')?.toString()?.trim();
    if (!id) return redirect(dest);

    let { error } = await supabase.from('bookings')
      .update({ paid_at: new Date().toISOString(), payment_note: medio, status: 'confirmed' })
      .eq('id', id);
    if (error?.code === '42703') {
      return redirect(dest + '&error=missing_migration');
    }
    if (error) {
      return redirect(dest + '&error=insert_failed&detail=' + encodeURIComponent(error.message.slice(0, 200)));
    }

    if (emitir) {
      try { await emitBoletaParaReserva(id, { rutOverride: rut, enviarEmail: true }); }
      catch (e) { console.error('[mark_paid] boleta:', e); }
    }
    return redirect(dest);
  }

  // ── Anular deuda ─────────────────────────────────────────────────────────────
  // Para cuando la sesión no se va a cobrar (cortesía, error, acuerdo con el
  // paciente) — no la marca como pagada, solo deja de aparecer como pendiente.
  if (action === 'void_debt') {
    const id = form.get('id')?.toString();
    if (!id) return redirect(dest);
    const { error } = await supabase.from('bookings').update({ debt_voided: true }).eq('id', id);
    if (error?.code === '42703') return redirect(dest + '&error=missing_migration');
    return redirect(dest);
  }

  // ── Anular pago (deshacer "Marcar como pagado") ──────────────────────────────
  // Para corregir un error al marcar una sesión como pagada. Vuelve a "Por
  // pagar"; no toca el status de la reserva ni la boleta si ya se emitió.
  if (action === 'unmark_paid') {
    const id = form.get('id')?.toString();
    if (!id) return redirect(dest);
    const { error } = await supabase.from('bookings')
      .update({ paid_at: null, payment_note: null })
      .eq('id', id);
    if (error?.code === '42703') return redirect(dest + '&error=missing_migration');
    return redirect(dest);
  }

  // ── Marcar / quitar inasistencia ──────────────────────────────────────────────
  // Independiente del pago y del estado de la reserva: el paciente no llegó.
  if (action === 'mark_no_show' || action === 'unmark_no_show') {
    const id = form.get('id')?.toString();
    if (!id) return redirect(dest);
    const { error } = await supabase.from('bookings')
      .update({ no_show: action === 'mark_no_show' })
      .eq('id', id);
    if (error?.code === '42703') return redirect(dest + '&error=missing_migration');
    return redirect(dest);
  }

  // ── Cancelar reserva ────────────────────────────────────────────────────────
  if (action === 'cancel') {
    const id = form.get('id')?.toString();
    if (!id) return redirect(dest);
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', id);
    try { await deleteBookingFromCalendar(id); } catch (e) { console.error('[cancel] gcal:', e); }
    return redirect(dest);
  }

  // ── Reagendar reserva ───────────────────────────────────────────────────────
  if (action === 'reschedule') {
    const id           = form.get('id')?.toString();
    const session_date = form.get('session_date')?.toString() ?? '';
    const session_time = form.get('session_time')?.toString() ?? '';

    if (!id || !session_date || !session_time) return redirect(dest);

    const { data: conflict } = await supabase
      .from('bookings').select('id')
      .eq('session_date', session_date)
      .eq('session_time', session_time)
      .not('status', 'in', '(cancelled,expired)')
      .neq('id', id)
      .maybeSingle();

    if (conflict) return redirect(dest + '&error=conflict');

    await supabase.from('bookings').update({ session_date, session_time }).eq('id', id);
    try { await rescheduleBookingInCalendar(id, session_date, session_time); } catch (e) { console.error('[reschedule] gcal:', e); }
    return redirect(dest);
  }

  // ── Crear reserva manual (modal simple, tipo legacy) ─────────────────────
  if (action === 'create') {
    const session_type  = form.get('session_type')?.toString() ?? '';
    const session_date  = form.get('session_date')?.toString() ?? '';
    const rawTime       = form.get('session_time')?.toString() ?? '';
    const custom_time   = form.get('custom_time')?.toString() ?? '';
    const session_time  = rawTime === 'custom' ? custom_time : rawTime;
    const patient_name  = form.get('patient_name')?.toString()?.trim() ?? '';
    const patient_email = form.get('patient_email')?.toString()?.trim().toLowerCase() ?? '';
    const patient_phone = form.get('patient_phone')?.toString()?.trim() ?? '';
    const notes         = form.get('notes')?.toString()?.trim() ?? '';
    // Precio manual opcional: si la admin lo especifica, tiene prioridad sobre el
    // precio por defecto del servicio (que sigue calculándose y mostrándose como base).
    const overrideRaw   = form.get('amount_override')?.toString()?.trim() ?? '';
    const overrideAmount = overrideRaw && !isNaN(parseInt(overrideRaw)) && parseInt(overrideRaw) > 0
      ? parseInt(overrideRaw) : null;

    if (!session_type || !session_date || !session_time || !patient_name || !patient_email || !patient_phone) {
      return redirect(dest + '&error=missing_fields');
    }

    // Precio por defecto: SIEMPRE desde services_catalog (fuente autoritativa y
    // actualizada desde /admin/servicios). Antes se leía de una fila vieja en
    // `settings` o de un array hardcodeado en el código (`pricingPlans`), ambos
    // desactualizados — eso causaba que se agendara a un precio antiguo/incorrecto.
    const svcType     = session_type.startsWith('pareja') ? 'pareja' : 'individual';
    const svcModality = session_type.includes('online') ? 'online' : 'presencial';
    const { data: matchedSvc } = await supabase
      .from('services_catalog')
      .select('*')
      .eq('type', svcType)
      .in('modality', [svcModality, 'ambos'])
      .eq('visible', true)
      .order('sort_order', { ascending: true })
      .limit(1)
      .maybeSingle();

    let defaultAmount = 0;
    if (matchedSvc) {
      defaultAmount = matchedSvc.modality === 'ambos'
        ? (svcModality === 'online' ? (matchedSvc.price_online ?? matchedSvc.price) : (matchedSvc.price_presencial ?? matchedSvc.price))
        : matchedSvc.price;
    } else {
      // Fallback legacy, solo si no hay ningún servicio visible que calce (no debería pasar en operación normal).
      const { data: priceRows } = await supabase.from('settings').select('key, value')
        .eq('key', `price_${session_type.replace(/-/g, '_')}`);
      const settingsPrice = priceRows?.[0]?.value ? parseInt(priceRows[0].value) : null;
      const plan = pricingPlans.find(p => p.id === session_type);
      defaultAmount = (settingsPrice && !isNaN(settingsPrice)) ? settingsPrice : (plan?.price ?? 0);
    }

    const amount = overrideAmount ?? defaultAmount;

    const basePayload: Record<string, unknown> = {
      session_type, session_date, session_time,
      patient_name, patient_email, patient_phone,
      notes: notes || null,
      status: 'confirmed', payment_method: 'manual', amount,
      created_by_admin: true, // creada desde el panel admin: nunca debe auto-eliminarse por falta de pago
    };
    if (matchedSvc) basePayload.service_id = matchedSvc.id;

    let { data: booking, error } = await supabase.from('bookings').insert(basePayload).select().single();
    if (error?.code === '42703') {
      // Columna(s) nueva(s) todavía no existen en la base de datos — reintenta sin ellas
      // para no romper el agendamiento (degradación igual que en el resto del archivo).
      const { created_by_admin: _c, service_id: _s, ...retryPayload } = basePayload;
      const retry = await supabase.from('bookings').insert(retryPayload).select().single();
      booking = retry.data; error = retry.error;
    }

    if (error || !booking) return redirect(dest + '&error=conflict');
    try { await syncBookingToCalendar(booking); } catch (e) { console.error('[create] sync:', e); }
    try { await upsertPatientFromBooking({ ...booking, rut: booking.patient_rut }); } catch (e) { console.error('[create] patient:', e); }
    return redirect(dest);
  }

  // ── Crear desde panel admin (booking panel, con packs y servicio) ──────────
  if (action === 'create-admin') {
    const service_id      = form.get('service_id')?.toString() ?? '';
    const patient_id      = form.get('patient_id')?.toString() ?? '';
    const session_date    = form.get('session_date')?.toString() ?? '';
    const session_time    = form.get('session_time')?.toString() ?? '';
    const sessions_raw    = parseInt(form.get('sessions_count')?.toString() ?? '1');
    const sessions_count  = Math.min(Math.max(isNaN(sessions_raw) ? 1 : sessions_raw, 1), 52);
    const modality_choice = form.get('modality_choice')?.toString() ?? 'presencial';
    const sendConf        = form.get('send_confirmation') !== null;
    // Comunicaciones al paciente (sección del panel "Agendar hora"): cada una se
    // guarda como columna propia de la reserva, independiente de las demás.
    const remEmailOn      = form.get('reminder_email_enabled') !== null;
    const remWhatsappOn   = form.get('whatsapp_reminder_enabled') !== null;
    const evalEmailOn     = form.get('evaluation_email_enabled') !== null;
    const reviewEmailOn   = form.get('review_email_enabled') !== null;
    // Modo de pago: 'manual' (pago en consulta, confirma de una) o 'link' (envía link de pago Flow)
    const payment_mode    = form.get('payment_mode')?.toString() === 'link' ? 'link' : 'manual';
    const notesText        = form.get('notes')?.toString()?.trim() ?? '';

    if (!service_id || !session_date || !session_time) {
      return redirect(dest + '&error=missing_fields');
    }

    // Lookup service
    const { data: svc } = await supabase
      .from('services_catalog').select('*').eq('id', service_id).single();
    if (!svc) return redirect(dest + '&error=service_not_found');

    // Patient info: from patients table OR form fields
    let finalName  = form.get('patient_name')?.toString()?.trim()  ?? '';
    let finalEmail = form.get('patient_email')?.toString()?.trim().toLowerCase() ?? '';
    let finalPhone = form.get('patient_phone')?.toString()?.trim() ?? '';
    // RUT: necesario para poder emitir la boleta de honorarios sola cuando el
    // paciente pague el link. Si es un paciente ya existente, se usa el RUT de
    // su ficha; si es nuevo, el que se haya escrito en el formulario (opcional).
    let finalRut   = form.get('patient_rut')?.toString()?.trim() ?? '';

    if (patient_id && patient_id !== '_new') {
      const { data: p } = await supabase
        .from('patients').select('name, email, phone, rut').eq('id', patient_id).single();
      if (p) { finalName = p.name; finalEmail = p.email ?? finalEmail; finalPhone = p.phone ?? finalPhone; finalRut = p.rut ?? finalRut; }
    }

    if (!finalName) return redirect(dest + '&error=missing_fields');

    // Determine session_type from service modality
    const svcModality = svc.modality === 'ambos' ? modality_choice : svc.modality;
    const sessionType = svc.type === 'pareja' ? `pareja-${svcModality}` : svcModality;

    // Precio manual opcional: si la admin lo especifica, reemplaza el precio del
    // servicio como total del pack (se sigue repartiendo entre las sesiones igual).
    const overrideRaw    = form.get('amount_override')?.toString()?.trim() ?? '';
    const overrideAmount = overrideRaw && !isNaN(parseInt(overrideRaw)) && parseInt(overrideRaw) > 0
      ? parseInt(overrideRaw) : null;

    // Precio por sesión: se reparte el total del pack entre las N sesiones para
    // que CADA sesión tenga su propio monto y pueda emitirse una boleta por sesión
    // (necesario para el reembolso en la isapre). El resto de la división lo
    // absorbe la primera sesión, así la suma cuadra exactamente con el total.
    const totalPrice     = overrideAmount ?? svc.price;
    const durMin         = svc.duration_min ?? 50;
    const perSessionBase = Math.floor(totalPrice / sessions_count);
    const remainder      = totalPrice - perSessionBase * sessions_count;

    // Notification email — si el setting no está configurado, se usa el correo
    // real de Valentina (nunca se manda a un tercero al azar ni se pierde el aviso).
    const { data: settingsRows } = await supabase.from('settings').select('key, value').in('key', ['notification_email']);
    const notifEmail = settingsRows?.find((r: { key: string }) => r.key === 'notification_email')?.value || ADMIN_EMAIL_FALLBACK;

    const bookingIds: string[] = [];
    let conflictCount = 0;
    let lastInsertError: string | null = null;

    for (let i = 0; i < sessions_count; i++) {
      const d = new Date(`${session_date}T00:00:00`);
      d.setDate(d.getDate() + i * 7);
      const bDate = d.toISOString().split('T')[0];

      // Check for conflict at this slot
      const { data: conflict } = await supabase
        .from('bookings').select('id')
        .eq('session_date', bDate)
        .eq('session_time', session_time)
        .not('status', 'in', '(cancelled,expired)')
        .maybeSingle();

      if (conflict) { conflictCount++; continue; } // Skip slots with conflicts (pack continues)

      const payload: Record<string, unknown> = {
        session_type:   sessionType,
        service_id:     svc.id,
        session_date:   bDate,
        session_time,
        patient_name:   finalName,
        patient_email:  finalEmail,
        patient_phone:  finalPhone,
        patient_rut:    finalRut || null,
        notes:          notesText || null,
        status:         payment_mode === 'link' ? 'pending_payment' : 'confirmed',
        payment_method: payment_mode === 'link' ? 'flow' : 'manual',
        amount:         perSessionBase + (i === 0 ? remainder : 0),
        duration_min:   durMin,
        created_by_admin: true, // creada desde el panel admin: nunca debe auto-eliminarse por falta de pago,
                                 // ni siquiera cuando payment_mode==='link' (queda en pending_payment esperando el pago)
        reminder_email_enabled:   remEmailOn,
        whatsapp_reminder_enabled: remWhatsappOn,
        evaluation_email_enabled: evalEmailOn,
        review_email_enabled:     reviewEmailOn,
      };

      // Try to insert, degrade gracefully if optional columns missing
      let { data: booking, error: insErr } = await supabase.from('bookings').insert(payload).select().single();
      if (insErr?.code === '42703') {
        const { service_id: _s, duration_min: _d, created_by_admin: _c,
                whatsapp_reminder_enabled: _w, evaluation_email_enabled: _e,
                review_email_enabled: _rv, ...base } = payload;
        let retry = await supabase.from('bookings').insert(base).select().single();
        // Si tampoco existe reminder_email_enabled (migración muy vieja / aún no corrida), reintenta sin ella también.
        if (retry.error?.code === '42703') {
          const { reminder_email_enabled: _r, ...base2 } = base;
          retry = await supabase.from('bookings').insert(base2).select().single();
        }
        booking = retry.data;
        insErr  = retry.error;
      }
      if (booking) {
        bookingIds.push(booking.id);
      } else if (insErr) {
        // No silenciar el error: antes esto se perdía por completo y la admin
        // no tenía forma de saber por qué "no pasó nada" al agendar.
        console.error('[create-admin] insert failed:', insErr.code, insErr.message, { bDate, session_time });
        lastInsertError = insErr.message ?? insErr.code ?? 'unknown';
      }
    }

    if (bookingIds.length === 0) {
      if (lastInsertError) {
        return redirect(dest + '&error=insert_failed&detail=' + encodeURIComponent(lastInsertError.slice(0, 200)));
      }
      if (conflictCount > 0) {
        return redirect(dest + '&error=slot_conflict');
      }
      return redirect(dest + '&error=unknown_no_booking');
    }

    // ── Modo LINK DE PAGO: generar orden Flow y enviarla al paciente ──────────
    if (payment_mode === 'link') {
      if (!finalEmail) return redirect(dest + '&error=need_email');
      try {
        // Config de Flow desde settings
        const { data: flowRows } = await supabase.from('settings').select('key, value').in('key', ['flow_env', 'flow_enabled']);
        const fcfg: Record<string, string> = {};
        (flowRows ?? []).forEach((r: { key: string; value: string }) => { fcfg[r.key] = r.value; });
        if (fcfg['flow_enabled'] === 'false') return redirect(dest + '&error=flow_disabled');
        const baseUrl = fcfg['flow_env'] === 'production' ? FLOW_URLS.production : FLOW_URLS.sandbox;

        const firstId = bookingIds[0];
        const reqUrl  = new URL(request.url);
        const siteUrl = `${reqUrl.protocol}//${reqUrl.host}`;

        const order = await createPaymentOrder({
          subject:         svc.name,
          amount:          totalPrice,
          email:           finalEmail,
          orderId:         firstId,
          urlConfirmation: `${siteUrl}/api/flow/confirm`,
          urlReturn:       `${siteUrl}/api/flow/return`,
          baseUrl,
        });
        const paymentUrl = `${order.url}?token=${order.token}`;
        await supabase.from('bookings').update({ mp_preference_id: order.token }).eq('id', firstId);

        // Enviar el link por correo al paciente
        try {
          await sendPaymentLinkEmail({
            patientName:  finalName,
            patientEmail: finalEmail,
            serviceName:  svc.name,
            amount:       totalPrice,
            sessionDate:  session_date,
            sessionTime:  session_time,
            paymentUrl,
          });
        } catch (e) { console.error('[create-admin] payment-link email:', e); }

        // Enviar el link también por WhatsApp automáticamente, si hay teléfono y
        // la plantilla ya está aprobada por Meta (si no, se degrada solo — el
        // banner manual de abajo sigue disponible como respaldo).
        let waSent = false;
        if (finalPhone) {
          try {
            const { data: tplRows } = await supabase.from('settings').select('key, value')
              .in('key', ['whatsapp_payment_template_name', 'whatsapp_payment_template_lang']);
            const tplCfg: Record<string, string> = {};
            (tplRows ?? []).forEach((r: { key: string; value: string }) => { tplCfg[r.key] = r.value; });
            const templateName = tplCfg['whatsapp_payment_template_name'];
            if (templateName) {
              const { data: addrRow } = await supabase.from('settings').select('value').eq('key', 'clinic_address').maybeSingle();
              const isOnline = sessionType.includes('online');
              const modalidad = isOnline ? 'Online (por videollamada)' : (addrRow?.value?.trim() || 'Presencial en consulta');
              const fechaHora = `${session_date} a las ${session_time}`;
              const valorTxt  = `$${totalPrice.toLocaleString('es-CL')}`;
              const res = await sendWhatsappTemplate(
                finalPhone,
                templateName,
                tplCfg['whatsapp_payment_template_lang'] || 'es',
                [finalName.split(' ')[0] || 'hola', svc.name, fechaHora, modalidad, valorTxt, paymentUrl],
              );
              waSent = res.sent;
              if (!res.sent) console.error('[create-admin] payment-link whatsapp:', res.reason);
            }
          } catch (e) { console.error('[create-admin] payment-link whatsapp:', e); }
        }

        // Aviso a Valentina de que se agendó/generó un link de pago — antes esta
        // rama terminaba (return) sin notificarla nunca, a diferencia del modo
        // manual; por eso el aviso de "nueva reserva" no llegaba para reservas
        // con link de pago (el caso más común al agendar desde el panel).
        {
          const emailData = {
            patient_name:   finalName,
            patient_email:  finalEmail,
            patient_phone:  finalPhone,
            session_type:   sessionType,
            session_date,
            session_time,
            amount:         totalPrice,
            payment_method: 'link',
            service_name:   svc.name,
          };
          try { await sendNotificationToAdmin(emailData, notifEmail); } catch (e) { console.error('[create-admin] notif (link):', e); }
        }

        // Redirigir mostrando el link (el banner de "compartir por WhatsApp" solo
        // se muestra si el envío automático no se hizo, para no duplicar el mensaje)
        return redirect(dest + `&payment_link=${encodeURIComponent(paymentUrl)}&pl_phone=${encodeURIComponent(finalPhone)}&pl_wa_sent=${waSent ? '1' : '0'}`);
      } catch (e) {
        console.error('[create-admin] flow order:', e);
        return redirect(dest + '&error=flow_error');
      }
    }

    // ── Modo MANUAL: confirmar de una (calendario + correos) ──────────────────
    for (const bid of bookingIds) {
      const { data: b } = await supabase.from('bookings').select('*').eq('id', bid).single();
      if (b) { try { await syncBookingToCalendar(b); } catch (e) { console.error('[create-admin] sync:', e); } }
    }
    try { await upsertPatientFromBooking({ patient_name: finalName, patient_email: finalEmail, patient_phone: finalPhone, rut: finalRut }); } catch (e) { console.error('[create-admin] patient:', e); }

    if (sendConf && finalEmail) {
      const emailData = {
        patient_name:   finalName,
        patient_email:  finalEmail,
        patient_phone:  finalPhone,
        session_type:   sessionType,
        session_date,
        session_time,
        amount:         totalPrice,
        payment_method: 'manual',
        service_name:   svc.name,
      };
      try { await sendConfirmationToClient(emailData); } catch (e) { console.error('[create-admin] email:', e); }
      try { await sendNotificationToAdmin(emailData, notifEmail); } catch (e) { console.error('[create-admin] notif:', e); }
    }

    return redirect(dest);
  }

  return redirect(dest);
};
