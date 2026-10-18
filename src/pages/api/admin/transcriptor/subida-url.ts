import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { motivoVisible, verificarGrabacion, textoMotivo } from '../../../../lib/transcriptor/consentimiento';
import { transicionar } from '../../../../lib/transcriptor/estados';
import {
  MAX_BYTES_SEGMENTO, R2NoConfiguradoError, iniciarMultiparte, mimeBase, nuevaLlaveAudio, partesPara, urlsPartes,
} from '../../../../lib/transcriptor/multiparte';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import type { EstadoGrabacion, Grabacion, TipoSesion } from '../../../../lib/transcriptor/tipos';

export const prerender = false;

// POST /api/admin/transcriptor/subida-url — P4. URLs PUT prefirmadas (15 min) para subir
// las partes de UN segmento directo a R2 (multiparte, partes de 8 MiB). El servidor
// decide la llave del objeto (opaca) y la guarda en grabacion_segmentos; el navegador
// solo manda el número de segmento y qué partes le faltan.
// Cuerpo: { grabacion_id, seq, mime, bytes, partes: number[], upload_id?, reiniciar?, offset_ms?, duracion_ms?, inicio_at? }
// Respuesta: { ok, upload_id, urls: { [n]: url } } | { ok, ya_subido: true }

const SUBIBLES: EstadoGrabacion[] = ['creada', 'grabando', 'pausada', 'subiendo'];
const UPLOAD_ID_RE = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
const entero = (x: unknown, min: number, max: number): number | null =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : null;

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'grabar_fin');
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request);
  if (!body || !esUuid(body.grabacion_id)) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const grabacionId = body.grabacion_id;
  const seq = entero(body.seq, 0, 999);
  const bytes = entero(body.bytes, 1, MAX_BYTES_SEGMENTO);
  const mime = mimeBase(body.mime);
  const total = bytes ? partesPara(bytes) : 0;
  const partes = Array.isArray(body.partes) ? [...new Set(body.partes)].filter((n): n is number => entero(n, 1, total) !== null) : [];
  if (seq === null || !bytes || !mime || !partes.length || partes.length > total) {
    return json({ ok: false, error: 'Datos del segmento inválidos.' }, 400);
  }

  try {
    const { data: g, error } = await supabase.from('grabaciones')
      .select('id, estado, patient_id, tipo, origen').eq('id', grabacionId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!g || g.origen !== 'presencial') return json({ ok: false, error: 'No encontré esa grabación.' }, 404);
    if (!SUBIBLES.includes(g.estado as EstadoGrabacion)) {
      // Ronda 2 (dos dispositivos): se dice QUÉ quedó subido (seq, tamaño, huella; nada de contenido) para que el
      // teléfono borre su copia solo si es la misma. Si otro dispositivo subió otra cosa, la conserva y avisa.
      const { data: subidos } = await supabase.from('grabacion_segmentos')
        .select('seq, bytes, sha256').eq('grabacion_id', grabacionId).not('subido_at', 'is', null);
      return json({ ok: true, ya_finalizada: true, estado: g.estado, segmentos: subidos ?? [] });
    }

    // El consentimiento se vuelve a verificar antes de aceptar audio (pudo revocarse).
    const v = await verificarGrabacion(g.patient_id, g.tipo as TipoSesion);
    if (!v.puede) {
      await auditar('vale', 'consentimiento_faltante', { grabacionId, patientId: g.patient_id, request, clientAddress, resultado: 'denegado', detalle: { fase: 'subida', motivo: v.motivo } });
      return json({ ok: false, motivo: v.motivo, error: textoMotivo(motivoVisible(v)) }, 403);
    }

    // Segmento: se crea una vez (unique grabacion_id+seq); la llave la pone el servidor.
    let { data: seg, error: e2 } = await supabase.from('grabacion_segmentos')
      .select('id, r2_key, mime, subido_at, bytes, sha256').eq('grabacion_id', grabacionId).eq('seq', seq).maybeSingle();
    if (e2) throw new Error(e2.message);
    let nuevo = false;
    if (!seg) {
      const { data, error: e3 } = await supabase.from('grabacion_segmentos').insert({
        grabacion_id: grabacionId, seq, r2_key: nuevaLlaveAudio(mime), mime, bytes,
        offset_ms: entero(body.offset_ms, 0, 24 * 3600_000) ?? 0,
        duracion_ms: entero(body.duracion_ms, 0, 24 * 3600_000),
      }).select('id, r2_key, mime, subido_at, bytes, sha256').maybeSingle();
      if (e3 && !/duplicate|unique/i.test(e3.message)) throw new Error(e3.message);
      if (data) { seg = data; nuevo = true; }
      else {
        const r = await supabase.from('grabacion_segmentos').select('id, r2_key, mime, subido_at, bytes, sha256').eq('grabacion_id', grabacionId).eq('seq', seq).single();
        if (r.error) throw new Error(r.error.message);
        seg = r.data;
      }
    }
    if (!seg) throw new Error('segmento sin fila');
    if (seg.subido_at) return json({ ok: true, ya_subido: true, bytes: seg.bytes ?? null, sha256: seg.sha256 ?? null });
    if (seg.mime !== mime) {
      return json({ ok: false, motivo: 'otro_dispositivo', error: 'Esta parte de la sesión ya se empezó a subir desde otro dispositivo (con otro formato de audio). Lo de este teléfono no se borró.' }, 409);
    }

    // creada → grabando → subiendo (la grabación se hizo sin conexión; se registra al subir).
    if (g.estado === 'creada') {
      const inicio = typeof body.inicio_at === 'string' && !Number.isNaN(Date.parse(body.inicio_at)) ? new Date(body.inicio_at).toISOString() : null;
      await transicionar(grabacionId, ['creada'], 'grabando', { inicio_at: inicio } as Partial<Grabacion>);
    }
    if (g.estado !== 'subiendo') await transicionar(grabacionId, ['grabando', 'pausada'], 'subiendo');

    const pedido = typeof body.upload_id === 'string' && UPLOAD_ID_RE.test(body.upload_id) && body.reiniciar !== true ? body.upload_id : null;
    const uploadId = pedido ?? (await iniciarMultiparte(seg.r2_key, mime));
    const urls = await urlsPartes(seg.r2_key, uploadId, partes.sort((a, b) => a - b));

    if (nuevo || !pedido) {
      await auditar('vale', 'grabar_fin', { grabacionId, patientId: g.patient_id, request, clientAddress, detalle: { fase: 'subida_iniciada', seq, partes: total, bytes, nuevo_upload: !pedido } });
    }
    return json({ ok: true, upload_id: uploadId, urls });
  } catch (e) {
    const sinR2 = e instanceof R2NoConfiguradoError;
    console.warn('[transcriptor/subida-url]', e instanceof Error ? e.message : e);
    await auditar('vale', 'grabar_fin', { grabacionId, request, clientAddress, resultado: 'error', detalle: { fase: 'subida_url', sin_r2: sinR2 } });
    return json({ ok: false, error: sinR2 ? 'El almacenamiento aún no está configurado. La grabación sigue segura en este teléfono.' : 'No se pudo preparar la subida. Se reintentará sola.' }, 503);
  }
};
