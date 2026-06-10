import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const { day, from, to } = await request.json() as {
      day: number;
      from: string; // "HH:MM"
      to: string;   // "HH:MM"
    };

    if (day === undefined || !from || !to) {
      return Response.json({ error: 'Faltan parámetros.' }, { status: 400 });
    }

    const fromTime = from.length === 5 ? from + ':00' : from;
    const toTime   = to.length === 5   ? to   + ':00' : to;

    const { data, error } = await supabase
      .from('availability_slots')
      .update({ active: false })
      .eq('day_of_week', day)
      .gte('start_time', fromTime)
      .lte('start_time', toTime)
      .select('id');

    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true, count: data?.length ?? 0 });
  } catch (err: any) {
    return Response.json({ error: err.message ?? 'Error.' }, { status: 500 });
  }
};
