import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const redirect = form.get('redirect') as string ?? '/admin/horarios';
  const time     = form.get('start_time') as string;
  const days     = form.getAll('days').map(d => parseInt(d as string));

  if (time && days.length > 0) {
    const inserts = days.map(day => ({ day_of_week: day, start_time: time, active: true }));
    await supabase.from('availability_slots').upsert(inserts, { onConflict: 'day_of_week,start_time', ignoreDuplicates: true });
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
