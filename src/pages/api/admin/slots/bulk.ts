import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { rutaInterna } from '../../../../lib/rutaInterna';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  // Solo rutas internas (8 oct 2026).
  const redirect = rutaInterna(form.get('redirect'), '/admin/horarios');
  const time     = form.get('start_time') as string;
  const days     = form.getAll('days').map(d => parseInt(d as string));

  if (time && days.length > 0) {
    const inserts = days.map(day => ({ day_of_week: day, start_time: time, active: true }));
    const { error } = await supabase.from('availability_slots').upsert(inserts, { onConflict: 'day_of_week,start_time', ignoreDuplicates: true });
    // Error visible (8 oct 2026): antes volvía igual que si se hubiera guardado.
    if (error) {
      const u = new URL(redirect, 'http://local');
      u.searchParams.set('error', 'slots_guardar');
      u.searchParams.set('detail', error.message.slice(0, 200));
      return new Response(null, { status: 302, headers: { Location: u.pathname + '?' + u.searchParams.toString() } });
    }
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
