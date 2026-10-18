// POST /api/admin/transcriptor/instrucciones — P7 (50-arquitectura §3.8, 20-clinico §2).
// "Mis instrucciones para el resumen" (y para las preguntas). Nunca se pisa ni se borra una
// versión: guardar = fila nueva en instrucciones_ia que pasa a ser la activa.
// Cuerpo: { uso: 'resumen'|'preguntas', accion: 'guardar', texto } | { uso, accion: 'restaurar' }
//   ('restaurar' usa INSTRUCCIONES_*_POR_DEFECTO de resumen.ts).
// Auth del panel + Origin/Referer propio + X-Panel. La bitácora guarda solo uso y largo (nunca el texto).
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import { exigirAccesoClinico } from '../../../../lib/transcriptor/acceso';
import {
  INSTRUCCIONES_PREGUNTAS_POR_DEFECTO, INSTRUCCIONES_RESUMEN_POR_DEFECTO, MAX_INSTRUCCIONES,
} from '../../../../lib/transcriptor/resumen';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  // Ronda 2 (18 oct): las instrucciones deciden qué escribe la IA en la ficha → exige sesión con passkey.
  const rechazo = (await guardiaPanel(ctx, 'cambiar_instrucciones')) ?? (await exigirAccesoClinico(ctx, 'cambiar_instrucciones'));
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request, 128 * 1024);
  if (!body) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const uso = body.uso === 'preguntas' ? 'preguntas' : body.uso === 'resumen' ? 'resumen' : null;
  if (!uso) return json({ ok: false, error: 'Falta indicar qué instrucciones son.' }, 400);

  let texto: string;
  if (body.accion === 'restaurar') {
    texto = uso === 'resumen' ? INSTRUCCIONES_RESUMEN_POR_DEFECTO : INSTRUCCIONES_PREGUNTAS_POR_DEFECTO;
  } else if (body.accion === 'guardar') {
    texto = typeof body.texto === 'string' ? body.texto.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim() : '';
    if (!texto) return json({ ok: false, error: 'Las instrucciones no pueden quedar vacías. Usa "Restaurar original" si quieres volver al texto inicial.' }, 400);
    if (texto.length > MAX_INSTRUCCIONES) return json({ ok: false, error: `Pueden tener hasta ${MAX_INSTRUCCIONES.toLocaleString('es-CL')} caracteres (tienen ${texto.length.toLocaleString('es-CL')}).` }, 400);
  } else {
    return json({ ok: false, error: 'Acción no válida.' }, 400);
  }

  // Igual a la activa → no se crea una versión repetida.
  const { data: activa } = await supabase.from('instrucciones_ia').select('id, texto').eq('uso', uso).eq('activa', true).maybeSingle();
  if (activa && activa.texto === texto) return json({ ok: true, sin_cambios: true, id: activa.id });

  // 1) nueva fila inactiva; 2) apagar la activa; 3) activar la nueva (índice único: una activa por uso).
  // Si el paso 3 fallara, no queda ninguna activa y el resumen usa el texto por defecto (resumen.ts).
  const { data: nueva, error: e1 } = await supabase.from('instrucciones_ia')
    .insert({ uso, texto, activa: false }).select('id, created_at').single();
  if (e1 || !nueva) {
    await auditar('vale', 'cambiar_instrucciones', { request, clientAddress, resultado: 'error', detalle: { uso, codigo: e1?.code ?? null } });
    return json({ ok: false, error: 'No se pudieron guardar las instrucciones. Intenta de nuevo.' }, 500);
  }
  const { error: e2 } = await supabase.from('instrucciones_ia').update({ activa: false }).eq('uso', uso).eq('activa', true);
  const { error: e3 } = e2 ? { error: e2 } : await supabase.from('instrucciones_ia').update({ activa: true }).eq('id', nueva.id);
  if (e3) {
    await auditar('vale', 'cambiar_instrucciones', { request, clientAddress, resultado: 'error', detalle: { uso, paso: e2 ? 'apagar' : 'activar', codigo: e3.code ?? null } });
    return json({ ok: false, error: 'Se guardó una copia, pero no se pudo dejar como activa. Intenta de nuevo.' }, 500);
  }
  await auditar('vale', 'cambiar_instrucciones', {
    request, clientAddress,
    detalle: { uso, accion: body.accion, largo: texto.length, version_id: nueva.id },
  });
  return json({ ok: true, id: nueva.id, creada: nueva.created_at, restaurado: body.accion === 'restaurar' });
};
