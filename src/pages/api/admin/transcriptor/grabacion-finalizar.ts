import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { verificarGrabacion, textoMotivo } from '../../../../lib/transcriptor/consentimiento';
import { transicionar } from '../../../../lib/transcriptor/estados';
import { elegirModelo } from '../../../../lib/transcriptor/reglas';
import { bytesObjeto, completarMultiparte, esSubidaInexistente, R2NoConfiguradoError, type ParteSubida } from '../../../../lib/transcriptor/multiparte';
import { almacenamiento, assemblyai } from '../../../../lib/transcriptor/dependencias-p4';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import { TIEMPOS, type EstadoGrabacion, type Grabacion, type PausaGrabacion, type TipoSesion } from '../../../../lib/transcriptor/tipos';

export const prerender = false;

// POST /api/admin/transcriptor/grabacion-finalizar — P4.
// 1) Completa la subida multiparte de cada segmento y verifica con HEAD que el tamaño en
//    R2 = el declarado. 2) Guarda duración, pausas, "Lugar con ruido" (el modelo se
//    recalcula con la regla fija). 3) subiendo → subida. 4) Intenta mandar cada segmento a
//    AssemblyAI; si falla, queda en 'subida' y el cron (P6) reintenta. Responde rápido.
// Idempotente: si ya estaba subida o más adelante responde ok (el navegador recién borra
// los trozos de IndexedDB cuando recibe ok de aquí).
// GET ?id=<grabacion_id> → { estado } para que la página muestre el avance.
//
// Cuerpo: { grabacion_id, lugar_con_ruido, inicio_at, fin_at, duracion_seg, pausas: [{desde_ms,hasta_ms}],
//           segmentos: [{ seq, upload_id, partes: [{n, etag}], bytes, sha256, offset_ms, duracion_ms }] }

const YA_SUBIDA: EstadoGrabacion[] = ['subida', 'transcribiendo', 'transcrita', 'resumiendo', 'lista', 'sin_audio'];
const entero = (x: unknown, min: number, max: number): number | null =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : null;
const fecha = (x: unknown): string | null => typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : null;

interface SegDeclarado { seq: number; uploadId: string; partes: ParteSubida[]; bytes: number; sha256: string | null; offsetMs: number; duracionMs: number | null }

function leerSegmentos(x: unknown): SegDeclarado[] | null {
  if (!Array.isArray(x) || x.length > 1000) return null;
  const out: SegDeclarado[] = [];
  for (const s of x as Record<string, unknown>[]) {
    const seq = entero(s?.seq, 0, 999), bytes = entero(s?.bytes, 0, 200 * 1024 * 1024);
    if (seq === null || bytes === null || typeof s.upload_id !== 'string' || !Array.isArray(s.partes)) return null;
    const partes: ParteSubida[] = [];
    for (const p of s.partes as Record<string, unknown>[]) {
      const n = entero(p?.n, 1, 10000);
      if (n === null || typeof p.etag !== 'string' || p.etag.length > 200) return null;
      partes.push({ n, etag: p.etag });
    }
    out.push({
      seq, uploadId: s.upload_id.slice(0, 1024), partes, bytes,
      sha256: typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256) ? s.sha256 : null,
      offsetMs: entero(s.offset_ms, 0, 24 * 3600_000) ?? 0,
      duracionMs: entero(s.duracion_ms, 0, 24 * 3600_000),
    });
  }
  return out;
}

function leerPausas(x: unknown): PausaGrabacion[] {
  if (!Array.isArray(x)) return [];
  return (x as Record<string, unknown>[]).slice(0, 200)
    .map((p) => ({ desde_ms: entero(p?.desde_ms, 0, 24 * 3600_000), hasta_ms: entero(p?.hasta_ms, 0, 24 * 3600_000) }))
    .filter((p): p is PausaGrabacion => p.desde_ms !== null && p.hasta_ms !== null && p.hasta_ms > p.desde_ms);
}

export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('id');
  if (!esUuid(id)) return json({ ok: false, error: 'Falta la grabación.' }, 400);
  const { data, error } = await supabase.from('grabaciones').select('id, estado, patient_id').eq('id', id).maybeSingle();
  if (error) return json({ ok: false, error: 'No se pudo leer el estado.' }, 503);
  if (!data) return json({ ok: false, error: 'No encontré esa grabación.' }, 404);
  return json({ ok: true, estado: data.estado, patient_id: data.patient_id });
};

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'subida_completa');
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request, 256 * 1024);
  if (!body || !esUuid(body.grabacion_id)) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const grabacionId = body.grabacion_id;
  const declarados = leerSegmentos(body.segmentos);
  if (!declarados) return json({ ok: false, error: 'Lista de segmentos inválida.' }, 400);

  try {
    const { data: gData, error } = await supabase.from('grabaciones').select('*').eq('id', grabacionId).maybeSingle();
    if (error) throw new Error(error.message);
    const g = gData as Grabacion | null;
    if (!g || g.origen !== 'presencial') return json({ ok: false, error: 'No encontré esa grabación.' }, 404);
    if (YA_SUBIDA.includes(g.estado)) return json({ ok: true, estado: g.estado, patient_id: g.patient_id });
    if (!['creada', 'grabando', 'pausada', 'subiendo'].includes(g.estado)) {
      return json({ ok: false, error: 'Esta grabación ya no acepta audio.', estado: g.estado }, 409);
    }

    const v = await verificarGrabacion(g.patient_id, g.tipo as TipoSesion);
    if (!v.puede) {
      await auditar('vale', 'consentimiento_faltante', { grabacionId, patientId: g.patient_id, request, clientAddress, resultado: 'denegado', detalle: { fase: 'finalizar', motivo: v.motivo } });
      return json({ ok: false, motivo: v.motivo, error: textoMotivo(v.motivo) }, 403);
    }

    // 1) Completar y verificar cada segmento declarado.
    const { data: filas, error: e2 } = await supabase.from('grabacion_segmentos')
      .select('id, seq, r2_key, subido_at, bytes').eq('grabacion_id', grabacionId);
    if (e2) throw new Error(e2.message);
    const porSeq = new Map((filas ?? []).map((f) => [f.seq as number, f]));
    for (const d of declarados) {
      const f = porSeq.get(d.seq);
      if (!f) return json({ ok: false, error: 'Falta subir una parte de la grabación.', reintentar_seq: d.seq }, 409);
      if (f.subido_at) continue;
      try {
        await completarMultiparte(f.r2_key, d.uploadId, d.partes);
      } catch (e) {
        if (!esSubidaInexistente(e)) throw e; // NoSuchUpload: quizá ya se completó (respuesta perdida) → lo dice el HEAD
      }
      const enR2 = await bytesObjeto(f.r2_key);
      if (enR2 === null || enR2 !== d.bytes) {
        return json({ ok: false, error: 'Una parte no llegó completa. Se vuelve a subir.', reintentar_seq: d.seq, reiniciar: true }, 409);
      }
      const { error: e3 } = await supabase.from('grabacion_segmentos').update({
        bytes: enR2, sha256: d.sha256, offset_ms: d.offsetMs, duracion_ms: d.duracionMs, subido_at: new Date().toISOString(),
      }).eq('id', f.id);
      if (e3) throw new Error(e3.message);
      f.subido_at = 'ok';
    }
    // Filas sin audio que el teléfono no declaró (subida abandonada): fuera.
    const declaradas = new Set(declarados.map((d) => d.seq));
    const huerfanas = (filas ?? []).filter((f) => !f.subido_at && !declaradas.has(f.seq)).map((f) => f.id);
    if (huerfanas.length) await supabase.from('grabacion_segmentos').delete().in('id', huerfanas).is('subido_at', null);

    // 2) Metadatos finales + modelo recalculado (regla fija).
    const lugarConRuido = body.lugar_con_ruido === true ? true : body.lugar_con_ruido === false ? false : g.lugar_con_ruido;
    const decision = elegirModelo({ tipo: g.tipo, origen: 'presencial', lugarConRuido });
    const pausas = leerPausas(body.pausas);
    const cambios: Partial<Grabacion> = {
      lugar_con_ruido: lugarConRuido, modelo: decision.modelo, diarizacion: decision.diarizacion,
      inicio_at: g.inicio_at ?? fecha(body.inicio_at), fin_at: fecha(body.fin_at) ?? new Date().toISOString(),
      duracion_seg: entero(body.duracion_seg, 0, 24 * 3600), pausas,
    };

    // 3) creada/grabando/pausada → subiendo → subida | sin_audio
    if (g.estado === 'creada') await transicionar(grabacionId, ['creada'], 'grabando');
    if (g.estado !== 'subiendo') await transicionar(grabacionId, ['grabando', 'pausada'], 'subiendo');
    const conAudio = declarados.filter((d) => d.bytes > 0).length > 0;
    const fin = await transicionar(grabacionId, ['subiendo'], conAudio ? 'subida' : 'sin_audio', cambios);
    if (!fin) {
      const { data: ahora } = await supabase.from('grabaciones').select('estado').eq('id', grabacionId).maybeSingle();
      if (ahora && YA_SUBIDA.includes(ahora.estado)) return json({ ok: true, estado: ahora.estado, patient_id: g.patient_id });
      throw new Error('no se pudo pasar a subida');
    }
    await auditar('vale', 'subida_completa', {
      grabacionId, patientId: g.patient_id, request, clientAddress,
      detalle: { segmentos: declarados.length, bytes: declarados.reduce((a, d) => a + d.bytes, 0), duracion_seg: cambios.duracion_seg, modelo: decision.modelo, ruido: lugarConRuido },
    });
    if (pausas.length) {
      await auditar('vale', 'grabar_pausa', { grabacionId, patientId: g.patient_id, request, clientAddress, detalle: { pausas: pausas.length } });
    }
    if (!conAudio) return json({ ok: true, estado: 'sin_audio', patient_id: g.patient_id });

    // 4) Enviar a AssemblyAI (best effort; si falla, el cron reintenta desde 'subida').
    let enviados = 0, total = 0;
    try {
      const { data: segs } = await supabase.from('grabacion_segmentos')
        .select('id, r2_key, aai_transcript_id').eq('grabacion_id', grabacionId).not('subido_at', 'is', null).order('seq');
      total = segs?.length ?? 0;
      for (const s of segs ?? []) {
        if (s.aai_transcript_id) { enviados++; continue; }
        const audioUrl = await almacenamiento.urlLectura(s.r2_key, TIEMPOS.urlLecturaAssemblyAISeg);
        const { id } = await assemblyai.enviar({ audioUrl, decision });
        await supabase.from('grabacion_segmentos').update({ aai_transcript_id: id, aai_estado: 'enviado', aai_enviado_at: new Date().toISOString() }).eq('id', s.id);
        enviados++;
      }
      if (total > 0 && enviados === total) await transicionar(grabacionId, ['subida'], 'transcribiendo');
    } catch (e) {
      console.warn('[transcriptor/grabacion-finalizar] envío a AssemblyAI pendiente:', e instanceof Error ? e.message : e);
    }
    return json({ ok: true, estado: total > 0 && enviados === total ? 'transcribiendo' : 'subida', patient_id: g.patient_id });
  } catch (e) {
    const sinR2 = e instanceof R2NoConfiguradoError;
    console.warn('[transcriptor/grabacion-finalizar]', e instanceof Error ? e.message : e);
    await auditar('vale', 'subida_completa', { grabacionId, request, clientAddress, resultado: 'error', detalle: { sin_r2: sinR2 } });
    return json({ ok: false, error: 'No se pudo cerrar la subida. La grabación sigue segura en este teléfono y se reintentará sola.' }, 503);
  }
};
