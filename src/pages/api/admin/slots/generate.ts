import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { days, start_time, end_time, break_start, break_end, interval } = body as {
      days: number[];
      start_time: string;   // "09:00"
      end_time: string;     // "19:00"
      break_start?: string; // "13:00"
      break_end?: string;   // "14:00"
      interval: number;     // minutos
    };

    if (!days?.length || !start_time || !end_time || !interval) {
      return Response.json({ error: 'Faltan parámetros.' }, { status: 400 });
    }

    const toMinutes = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };

    const startMin  = toMinutes(start_time);
    const endMin    = toMinutes(end_time);
    const breakS    = break_start ? toMinutes(break_start) : null;
    const breakE    = break_end   ? toMinutes(break_end)   : null;

    // Generar los slots del template
    const generated: { day_of_week: number; start_time: string; active: boolean }[] = [];

    for (const day of days) {
      let cur = startMin;
      while (cur < endMin) {
        // Saltar colación
        const inBreak = breakS !== null && breakE !== null && cur >= breakS && cur < breakE;
        if (!inBreak) {
          const hh = String(Math.floor(cur / 60)).padStart(2, '0');
          const mm = String(cur % 60).padStart(2, '0');
          generated.push({ day_of_week: day, start_time: `${hh}:${mm}:00`, active: true });
        }
        cur += interval;
      }
    }

    // Borrar slots existentes de los días seleccionados
    const { error: delError } = await supabase
      .from('availability_slots')
      .delete()
      .in('day_of_week', days);

    if (delError) {
      return Response.json({ error: 'Error al limpiar slots: ' + delError.message }, { status: 500 });
    }

    // Insertar los nuevos
    if (generated.length > 0) {
      const { error: insError } = await supabase
        .from('availability_slots')
        .insert(generated);

      if (insError) {
        return Response.json({ error: 'Error al insertar slots: ' + insError.message }, { status: 500 });
      }
    }

    return Response.json({ ok: true, count: generated.length });
  } catch (err: any) {
    return Response.json({ error: err.message ?? 'Error interno.' }, { status: 500 });
  }
};
