import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const { id } = await request.json() as { id: string };
    if (!id) return Response.json({ error: 'id requerido.' }, { status: 400 });

    const { data: slot } = await supabase
      .from('availability_slots')
      .select('active')
      .eq('id', id)
      .single();

    if (!slot) return Response.json({ error: 'Slot no encontrado.' }, { status: 404 });

    const { error } = await supabase
      .from('availability_slots')
      .update({ active: !slot.active })
      .eq('id', id);

    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true, active: !slot.active });
  } catch (err: any) {
    return Response.json({ error: err.message ?? 'Error.' }, { status: 500 });
  }
};
