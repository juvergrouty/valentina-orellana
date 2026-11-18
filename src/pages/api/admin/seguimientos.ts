import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { rutaInterna } from '../../../lib/rutaInterna';
import { logInfo } from '../../../lib/logger';
import { createMessageTemplate, suscribirAppAWhatsapp, estadoPlantillas } from '../../../lib/whatsapp';
import { PLANTILLAS, IDIOMA_PLANTILLAS } from '../../../lib/seguimientos/textos';
import { normalizarCorreo, normalizarTelefono, mediodiaChile } from '../../../lib/seguimientos/reglas';

export const prerender = false;

// Botones de /admin/seguimientos y del aviso de pausas del panel (18 nov 2026).
// Protegido por la sesión del panel y el control de origen del middleware (/api/admin/*).
const UUID = /^[0-9a-f-]{36}$/i;

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const accion = String(form.get('accion') ?? '');
  const destino = rutaInterna(form.get('redirect'), '/admin/seguimientos');
  const sep = destino.includes('?') ? '&' : '?';
  const volver = (msg: string, ok = true) => redirect(`${destino}${sep}${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`, 303);
  const ahora = new Date().toISOString();
  const id = String(form.get('id') ?? '');

  switch (accion) {
    case 'activar':
    case 'desactivar': {
      const valor = accion === 'activar' ? 'true' : 'false';
      const { error } = await supabase.from('settings').upsert({ key: 'seguimientos_activos', value: valor, updated_at: ahora }, { onConflict: 'key' });
      if (error) return volver('No se pudo guardar el cambio.', false);
      await logInfo('seguimientos/interruptor', accion === 'activar' ? 'Seguimientos automáticos encendidos' : 'Seguimientos automáticos apagados');
      return volver(accion === 'activar' ? 'Seguimientos automáticos encendidos.' : 'Seguimientos automáticos apagados.');
    }

    case 'consulta_nueva': {
      // Psychology Today y otras consultas que no llegan por WhatsApp con anuncio o código.
      const nombre = String(form.get('nombre') ?? '').trim().slice(0, 120);
      const email = normalizarCorreo(String(form.get('email') ?? ''));
      const telefono = normalizarTelefono(String(form.get('telefono') ?? ''));
      const fecha = String(form.get('respondida') ?? '');
      if (!nombre) return volver('Falta el nombre.', false);
      if (!email && !telefono) return volver('Falta el correo o el teléfono.', false);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return volver('Falta la fecha en que le respondiste.', false);
      // Mediodía de Chile de ese día (con su horario de verano): el primer seguimiento sale 3 días después.
      const respondida = mediodiaChile(fecha);
      // Los correos se guardan siempre en minúsculas (normalizarCorreo).
      const porCorreo = email ? await supabase.from('seguimiento_personas').select('id, no_escribir').eq('email', email).limit(1).maybeSingle() : null;
      const porTelefono = !porCorreo?.data && telefono ? await supabase.from('seguimiento_personas').select('id, no_escribir').eq('telefono', telefono).limit(1).maybeSingle() : null;
      if (porCorreo?.error || porTelefono?.error) return volver('No se pudo guardar. ¿Falta aplicar la migración 0027?', false);
      const ya = porCorreo?.data ?? porTelefono?.data ?? null;
      const datos = { tipo: 'consulta', nombre, email, telefono, ultima_respuesta_vale_at: respondida, actualizado_at: ahora };
      // Volver a marcarla NO quita un "No escribir" que ya tenía.
      const { error } = ya
        ? await supabase.from('seguimiento_personas').update(ya.no_escribir ? datos : { ...datos, estado: 'activa' }).eq('id', ya.id)
        : await supabase.from('seguimiento_personas').insert({ ...datos, origen: 'manual', no_escribir: false, estado: 'activa' });
      if (error) return volver('No se pudo guardar la consulta nueva.', false);
      return volver(`Listo: ${nombre} quedó como consulta nueva.`);
    }

    case 'no_escribir':
    case 'reactivar':
    case 'respondio': {
      if (!UUID.test(id)) return volver('Persona no válida.', false);
      const cambios = accion === 'no_escribir' ? { no_escribir: true, estado: 'no_escribir' }
        : accion === 'reactivar' ? { no_escribir: false, estado: 'activa' } : { estado: 'respondio' };
      const { error } = await supabase.from('seguimiento_personas').update({ ...cambios, actualizado_at: ahora }).eq('id', id);
      if (error) return volver('No se pudo guardar el cambio.', false);
      return volver(accion === 'no_escribir' ? 'Listo: no se le escribirá.' : accion === 'reactivar' ? 'Listo: vuelve a tener seguimiento.' : 'Listo: quedó como que te respondió.');
    }

    case 'paciente_no_escribir':
    case 'paciente_reactivar': {
      if (!UUID.test(id)) return volver('Paciente no válida.', false);
      if (accion === 'paciente_reactivar') {
        const { error } = await supabase.from('seguimiento_personas').delete().eq('patient_id', id).eq('tipo', 'paciente');
        if (error) return volver('No se pudo guardar el cambio.', false);
        return volver('Listo: vuelve a tener seguimiento.');
      }
      const { data: ficha } = await supabase.from('patients').select('name').eq('id', id).maybeSingle();
      // El índice único de patient_id es parcial: se busca y se actualiza o inserta (sin upsert).
      const { data: ya } = await supabase.from('seguimiento_personas').select('id').eq('patient_id', id).maybeSingle();
      const r = ya
        ? await supabase.from('seguimiento_personas').update({ no_escribir: true, estado: 'no_escribir', actualizado_at: ahora }).eq('id', ya.id)
        : await supabase.from('seguimiento_personas').insert({ tipo: 'paciente', patient_id: id, origen: 'paciente', nombre: ficha?.name ?? null, no_escribir: true, estado: 'no_escribir' });
      if (r.error) return volver('No se pudo guardar el cambio.', false);
      return volver('Listo: no se le escribirá.');
    }

    // Mensajes que esperan a Vale: 3A (pausa) y 1B de consultas por correo.
    case 'aprobar':
    case 'descartar': {
      const envioId = Number(id);
      if (!Number.isInteger(envioId) || envioId <= 0) return volver('Aviso no válido.', false);
      const { data, error } = await supabase.from('seguimiento_envios')
        .update({ estado: accion === 'aprobar' ? 'aprobado' : 'descartado', motivo: accion === 'aprobar' ? 'Aprobado por Valentina' : 'Descartado por Valentina' })
        .eq('id', envioId).in('paso', ['3A', '1B']).eq('estado', 'por_aprobar').select('id');
      if (error || !data?.length) return volver('Ese aviso ya no está pendiente.', false);
      return volver(accion === 'aprobar'
        ? 'Aprobado: el mensaje sale en el próximo horario de envío (lunes a sábado, de 10:00 a 20:00).'
        : 'Listo: no se le enviará el mensaje.');
    }

    // Consulta por correo: "No respondió: enviar el segundo" (el 1B sale solo cuando toque).
    case 'segundo_aprobado': {
      if (!UUID.test(id)) return volver('Persona no válida.', false);
      const { error } = await supabase.from('seguimiento_personas').update({ segundo_aprobado: true, actualizado_at: ahora }).eq('id', id);
      if (error) return volver('No se pudo guardar el cambio.', false);
      await supabase.from('seguimiento_envios').update({ estado: 'aprobado', motivo: 'Aprobado por Valentina' })
        .eq('clave', `consulta:${id}`).eq('paso', '1B').eq('estado', 'por_aprobar');
      return volver('Listo: el segundo mensaje sale cuando corresponda.');
    }

    case 'crear_plantillas': {
      // Envía a revisión de Meta las plantillas que todavía no existen en la cuenta.
      const estados = await estadoPlantillas();
      if (!estados) return volver('No se pudo revisar las plantillas: WhatsApp no está conectado o Meta no respondió.', false);
      const faltan = PLANTILLAS.filter((p) => !estados.has(p.nombre));
      const fallos: string[] = [];
      for (const p of faltan) {
        const r = await createMessageTemplate({ name: p.nombre, language: IDIOMA_PLANTILLAS, bodyText: p.cuerpo, sampleValues: p.ejemplo, category: p.categoria });
        if (!r.ok) fallos.push(`${p.nombre}: ${r.reason}`);
      }
      if (fallos.length) return volver(`Algunas plantillas no se pudieron enviar a revisión. ${fallos.join(' · ')}`.slice(0, 600), false);
      return volver(faltan.length ? `Listo: ${faltan.length} plantillas enviadas a revisión de Meta.` : 'Las plantillas ya estaban creadas.');
    }

    case 'suscribir_whatsapp': {
      const r = await suscribirAppAWhatsapp();
      return r.ok ? volver('Listo: el sitio ya recibe los avisos de WhatsApp.') : volver(`No se pudo activar: ${r.reason}`, false);
    }
  }
  return volver('Acción no válida.', false);
};
