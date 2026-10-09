import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const action   = form.get('action') as string;
  // Solo rutas internas (8 oct 2026): antes se usaba tal cual venía del formulario.
  const redirect = rutaInterna(form.get('redirect'), '/admin/horarios');
  // Si la base rechaza el cambio, se vuelve con un aviso visible (8 oct 2026):
  // antes cualquier error volvía igual que un éxito.
  const conError = (detalle: string) => {
    const u = new URL(redirect, 'http://local');
    u.searchParams.set('error', 'slots_guardar');
    u.searchParams.set('detail', detalle.slice(0, 200));
    return new Response(null, { status: 302, headers: { Location: u.pathname + '?' + u.searchParams.toString() } });
  };

  if (action === 'create') {
    const day  = parseInt(form.get('day_of_week') as string);
    const time = form.get('start_time') as string;
    if (!isNaN(day) && time) {
      const { error } = await supabase.from('availability_slots').insert({
        day_of_week: day,
        start_time:  time,
        active:      true,
      });
      if (error) return conError(error.message);
    }
  }

  if (action === 'toggle') {
    const id     = form.get('id') as string;
    const active = form.get('active') === 'true';
    const { error } = await supabase.from('availability_slots').update({ active: !active }).eq('id', id);
    if (error) return conError(error.message);
  }

  if (action === 'delete') {
    const id = form.get('id') as string;
    const { error } = await supabase.from('availability_slots').delete().eq('id', id);
    if (error) return conError(error.message);
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
