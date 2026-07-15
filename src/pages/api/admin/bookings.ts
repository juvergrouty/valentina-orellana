import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { pricingPlans } from '../../../data/services';
import { syncBookingToCalendar, deleteBookingFromCalendar, rescheduleBookingInCalendar } from '../../../lib/syncCalendar';
import { emitBoletaParaReserva } from '../../../lib/apigateway';
import { sendConfirmationToClient, sendNotificationToAdmin } from '../../../lib/email';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  const form   = await request.formData();
  const action = form.get('action')?.toString();
  const dest   = form.get('redirect')?.toString() ?? '/admin/agenda';

  // ── Confirmar reserva ───────────────────────────────────────────────────────
  if (action === 'confirm') {
    const id = form.get('id')?.toString();
    if (!id) return redirect(dest);
    await supabase.from('bookings').update({ status: 'confirmed' }).eq('id', id);
    const { data: booking } = await supabase.from('bookings').select('*').eq('id', id).single();
    if (booking) {
      // AWAIT: en serverless (Vercel) la función se termina al responder, matando
      // promesas pendientes. Hay que esperar la sincronización antes del redirect.
      try { await syncBookingToCalendar(booking); } catch (e) { console.error('[confirm] sync:', e); }
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
      .neq('status', 'cancelled')
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

    if (!session_type || !session_date || !session_time || !patient_name || !patient_email || !patient_phone) {
      return redirect(dest + '&error=missing_fields');
    }

    const { data: priceRows } = await supabase.from('settings').select('key, value')
      .eq('key', `price_${session_type.replace(/-/g, '_')}`);
    const settingsPrice = priceRows?.[0]?.value ? parseInt(priceRows[0].value) : null;
    const plan   = pricingPlans.find(p => p.id === session_type);
    const amount = (settingsPrice && !isNaN(settingsPrice)) ? settingsPrice : (plan?.price ?? 0);

    const { data: booking, error } = await supabase.from('bookings').insert({
      session_type, session_date, session_time,
      patient_name, patient_email, patient_phone,
      notes: notes || null,
      status: 'confirmed', payment_method: 'manual', amount,
    }).select().single();

    if (error || !booking) return redirect(dest + '&error=conflict');
    try { await syncBookingToCalendar(booking); } catch (e) { console.error('[create] sync:', e); }
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

    if (patient_id && patient_id !== '_new') {
      const { data: p } = await supabase
        .from('patients').select('name, email, phone').eq('id', patient_id).single();
      if (p) { finalName = p.name; finalEmail = p.email ?? finalEmail; finalPhone = p.phone ?? finalPhone; }
    }

    if (!finalName) return redirect(dest + '&error=missing_fields');

    // Determine session_type from service modality
    const svcModality = svc.modality === 'ambos' ? modality_choice : svc.modality;
    const sessionType = svc.type === 'pareja' ? `pareja-${svcModality}` : svcModality;

    // Precio por sesión: se reparte el total del pack entre las N sesiones para
    // que CADA sesión tenga su propio monto y pueda emitirse una boleta por sesión
    // (necesario para el reembolso en la isapre). El resto de la división lo
    // absorbe la primera sesión, así la suma cuadra exactamente con el total.
    const totalPrice     = svc.price;
    const durMin         = svc.duration_min ?? 50;
    const perSessionBase = Math.floor(totalPrice / sessions_count);
    const remainder      = totalPrice - perSessionBase * sessions_count;

    // Notification email
    const { data: settingsRows } = await supabase.from('settings').select('key, value').in('key', ['notification_email']);
    const notifEmail = settingsRows?.find((r: { key: string }) => r.key === 'notification_email')?.value ?? 'juver@grouty.cl';

    const bookingIds: string[] = [];

    for (let i = 0; i < sessions_count; i++) {
      const d = new Date(`${session_date}T00:00:00`);
      d.setDate(d.getDate() + i * 7);
      const bDate = d.toISOString().split('T')[0];

      // Check for conflict at this slot
      const { data: conflict } = await supabase
        .from('bookings').select('id')
        .eq('session_date', bDate)
        .eq('session_time', session_time)
        .neq('status', 'cancelled')
        .maybeSingle();

      if (conflict) continue; // Skip slots with conflicts (pack continues)

      const payload: Record<string, unknown> = {
        session_type:   sessionType,
        service_id:     svc.id,
        session_date:   bDate,
        session_time,
        patient_name:   finalName,
        patient_email:  finalEmail,
        patient_phone:  finalPhone,
        status:         'confirmed',
        payment_method: 'manual',
        amount:         perSessionBase + (i === 0 ? remainder : 0),
        duration_min:   durMin,
      };

      // Try to insert, degrade gracefully if optional columns missing
      let { data: booking, error: insErr } = await supabase.from('bookings').insert(payload).select().single();
      if (insErr?.code === '42703') {
        const { service_id: _s, duration_min: _d, ...base } = payload;
        const retry = await supabase.from('bookings').insert(base).select().single();
        booking = retry.data;
        insErr  = retry.error;
      }
      if (booking) bookingIds.push(booking.id);
    }

    // Sincronizar TODAS las reservas a Google Calendar (con await — en serverless
    // las promesas sin await se matan al responder). Crea Meet si es online.
    if (bookingIds.length > 0) {
      for (const bid of bookingIds) {
        const { data: b } = await supabase.from('bookings').select('*').eq('id', bid).single();
        if (b) { try { await syncBookingToCalendar(b); } catch (e) { console.error('[create-admin] sync:', e); } }
      }

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
    }

    return redirect(dest);
  }

  return redirect(dest);
};
