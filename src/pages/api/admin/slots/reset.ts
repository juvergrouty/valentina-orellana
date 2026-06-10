import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async () => {
  const { data, error } = await supabase
    .from('availability_slots')
    .update({ active: true })
    .eq('active', false)
    .select('id');

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ ok: true, count: data?.length ?? 0 });
};
