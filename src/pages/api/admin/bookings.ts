import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { pricingPlans } from '../../../data/services';
import { syncBookingToCalendar } from '../../../lib/syncCalendar';

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

    // Sincronizar con Google Calendar
    const { data: booking } = await supabase
      .from('bookings').select('*').eq('id', id).single();
    if (booking) syncBookingToCalendar(booking).catch(console.error);

    return redirect(dest);
  }

  // ── Cancelar reserva ────────────────────────────────────────────────────────
  if (action === 'cancel') {
    const id = form.get('id')?.toString();
    if (!id) return redirect(dest);
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', id);
    return redirect(dest);
  }

  // ── Reagendar reserva ───────────────────────────────────────────────────────
  if (action === 'reschedule') {
    const id           = form.get('id')?.toString();
    const session_date = form.get('session_date')?.toString() ?? '';
    const rawTime      = form.get('session_time')?.toString() ?? '';
    const custom_time  = form.get('custom_time')?.toString() ?? '';
    const session_time = rawTime === 'custom' ? custom_time : rawTime;

    if (!id || !session_date || !session_time) return redirect(dest);

    const { data: conflict } = await supabase
      .from('bookings').select('id')
      .eq('session_date', session_date)
      .eq('session_time', session_time)
      .neq('status', 'cancelled')
      .neq('id', id)
      .maybeSingle();

    if (conflict) return redirect(dest + '&error=conflict');

    await supabase.from('bookings')
      .update({ session_date, session_time }).eq('id', id);

    return redirect(dest);
  }

  // ── Crear reserva manual ────────────────────────────────────────────────────
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

    // Leer precio desde settings (con fallback a services.ts)
    const { data: priceRows } = await supabase.from('settings').select('key, value')
      .eq('key', `price_${session_type.replace(/-/g, '_')}`);
    const settingsPrice = priceRows?.[0]?.value ? parseInt(priceRows[0].value) : null;
    const plan   = pricingPlans.find(p => p.id === session_type);
    const amount = (settingsPrice && !isNaN(settingsPrice)) ? settingsPrice : (plan?.price ?? 0);

    const { data: booking, error } = await supabase.from('bookings').insert({
      session_type,
      session_date,
      session_time,
      patient_name,
      patient_email,
      patient_phone,
      notes:          notes || null,
      status:         'confirmed',
      payment_method: 'manual',
      amount,
    }).select().single();

    if (error || !booking) {
      console.error('Error creando reserva manual:', error?.message);
      return redirect(dest + '&error=conflict');
    }

    // Sincronizar con Google Calendar en segundo plano
    syncBookingToCalendar(booking).catch(console.error);

    return redirect(dest);
  }

  return redirect(dest);
};
