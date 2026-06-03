import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const action   = form.get('action') as string;
  const redirect = form.get('redirect') as string ?? '/admin/horarios';

  if (action === 'create') {
    const day  = parseInt(form.get('day_of_week') as string);
    const time = form.get('start_time') as string;
    if (!isNaN(day) && time) {
      await supabase.from('availability_slots').insert({
        day_of_week: day,
        start_time:  time,
        active:      true,
      });
    }
  }

  if (action === 'toggle') {
    const id     = form.get('id') as string;
    const active = form.get('active') === 'true';
    await supabase.from('availability_slots').update({ active: !active }).eq('id', id);
  }

  if (action === 'delete') {
    const id = form.get('id') as string;
    await supabase.from('availability_slots').delete().eq('id', id);
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
