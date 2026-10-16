// POST /api/admin/transcriptor/exportar-ficha — "Descargar ficha completa" (02-decisiones-16oct-noche, B).
// Body: { patient_id: uuid, formato: 'zip' | 'pdf' | 'json', anio?: number }
// Devuelve el archivo (attachment). Reglas:
//   • guardiaPanel (POST, Origin/Referer propio, X-Panel: 1, sesión no cerrada) + sesión con passkey.
//   • Bitácora OBLIGATORIA ('exportar') antes de leer contenido: si no se puede registrar, no se exporta.
//   • Todo en memoria (exportacion.ts, pdf.ts, zip.ts): nada se escribe en disco, Supabase ni R2; sin caché.
//   • Si el archivo pasa de ~4,4 MB (límite de respuesta de Vercel: 4,5 MB) se pide exportar por año.
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { exigirAccesoClinico } from '../../../../lib/transcriptor/acceso';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import { auditar, auditarObligatorio } from '../../../../lib/transcriptor/auditoria';
import { FORMATOS, TOPE_RESPUESTA_BYTES, armarArchivo, recopilarFicha, type FormatoExportacion } from '../../../../lib/transcriptor/exportacion';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = (await guardiaPanel(ctx, 'exportar')) ?? (await exigirAccesoClinico(ctx, 'exportar'));
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request);
  if (!body || !esUuid(body.patient_id)) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const formato = (FORMATOS as readonly string[]).includes(String(body.formato)) ? (body.formato as FormatoExportacion) : 'zip';
  const anio = body.anio == null || body.anio === '' ? null : Number(body.anio);
  if (anio != null && !(Number.isInteger(anio) && anio >= 2020 && anio <= 2100)) return json({ ok: false, error: 'Año no válido.' }, 400);
  const patientId = body.patient_id;

  const { data: p } = await supabase.from('patients').select('id').eq('id', patientId).maybeSingle();
  if (!p) return json({ ok: false, error: 'No se encontró la ficha.' }, 404);

  try {
    await auditarObligatorio('vale', 'exportar', { patientId, request, clientAddress, detalle: { fase: 'inicio', formato, anio } });
  } catch {
    return json({ ok: false, error: 'No se pudo registrar la exportación en la bitácora; por seguridad no se exporta. Intenta de nuevo en un momento.' }, 503);
  }

  try {
    const { almacenamiento } = await import('../../../../lib/transcriptor/almacenamiento');
    const ficha = await recopilarFicha(patientId, {
      db: supabase,
      leerTranscripcion: (key) => almacenamiento.leerTranscripcion(key),
      alm: almacenamiento,
    }, { anio });
    const archivo = armarArchivo(ficha, formato);
    if (archivo.bytes.length > TOPE_RESPUESTA_BYTES) {
      await auditar('vale', 'exportar', { patientId, request, clientAddress, resultado: 'error', detalle: { fase: 'demasiado_grande', bytes: archivo.bytes.length, formato, anio } });
      return json({ ok: false, error: 'La ficha completa es demasiado grande para descargarla de una vez. Elige un año y descárgala por partes (los consentimientos van completos en cada parte).' }, 413);
    }
    await auditar('vale', 'exportar', { patientId, request, clientAddress, detalle: { fase: 'listo', formato, anio, bytes: archivo.bytes.length, ...archivo.resumen } });
    return new Response(archivo.bytes as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': archivo.contentType,
        'Content-Disposition': `attachment; filename="${archivo.nombre}"`,
        'Content-Length': String(archivo.bytes.length),
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    console.warn('[transcriptor/exportar-ficha]', e instanceof Error ? e.message.slice(0, 120) : 'error');
    await auditar('vale', 'exportar', { patientId, request, clientAddress, resultado: 'error', detalle: { fase: 'fallo', formato, anio } });
    return json({ ok: false, error: 'No se pudo armar la ficha completa en este momento. Intenta de nuevo en unos minutos.' }, 502);
  }
};
