// Pruebas de assemblyai.ts (cliente y webhook) con fetch falso — sin red. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorAssemblyAI, cabeceraValida, crearClienteAssemblyAI, cuerpoEnvio, decisionTrasErrorAAI,
  normalizarResultado, parsearCuerpoWebhook, procesarWebhookAssemblyAI, sanearMensaje,
  type CuerpoWebhook, type RepoWebhook, type SegmentoWebhook,
} from './assemblyai';
import { elegirModelo } from './reglas';
import type { EstadoSegmentoAAI, ResultadoTranscripcion } from './tipos';

const WH = { url: 'https://www.valentinaorellana.cl/api/transcriptor/webhook-assemblyai', secreto: 's3cr3t-de-prueba' };
const AUDIO = 'https://cuenta.us.r2.cloudflarestorage.com/audio/a/uuid.m4a?X-Amz-Signature=abc';

// ─── Cuerpo del envío ────────────────────────────────────────────────────────

test('pareja presencial: universal-3-5-pro + speaker_labels + speakers_expected 3', () => {
  const c = cuerpoEnvio(AUDIO, elegirModelo({ tipo: 'pareja', origen: 'presencial', lugarConRuido: false }), WH);
  assert.deepEqual(c, {
    audio_url: AUDIO, speech_models: ['universal-3-5-pro'], language_code: 'es', punctuate: true, format_text: true,
    speaker_labels: true, speakers_expected: 3, webhook_url: WH.url,
    webhook_auth_header_name: 'X-VO-Webhook', webhook_auth_header_value: WH.secreto,
  });
});

test('individual presencial: universal-2 + speaker_labels + speakers_expected 2 (17 oct)', () => {
  const c = cuerpoEnvio(AUDIO, elegirModelo({ tipo: 'individual', origen: 'presencial', lugarConRuido: false }), WH);
  assert.equal(c.speech_models[0], 'universal-2');
  assert.equal(c.speaker_labels, true);
  assert.equal(c.speakers_expected, 2);
  const ruido = cuerpoEnvio(AUDIO, elegirModelo({ tipo: 'individual', origen: 'presencial', lugarConRuido: true }), WH);
  assert.equal(ruido.speech_models[0], 'universal-3-5-pro');
  assert.equal(ruido.speaker_labels, true);
  assert.equal(ruido.speakers_expected, 2);
  const st = cuerpoEnvio(AUDIO, elegirModelo({ tipo: 'sin_tipo', origen: 'presencial', lugarConRuido: false }), WH);
  assert.equal(st.speaker_labels, true);
  assert.ok(!('speakers_expected' in st)); // sin tipo: el modelo decide cuántos (podría ser pareja)
});

test('online individual: sin diarización ni speakers_expected; pareja online: diarización 3; sin metadata ni language_detection', () => {
  const ind = cuerpoEnvio(AUDIO, elegirModelo({ tipo: 'individual', origen: 'online', lugarConRuido: false }), WH);
  assert.equal(ind.speech_models[0], 'universal-2');
  assert.equal(ind.speaker_labels, false);
  assert.ok(!('speakers_expected' in ind));
  const po = cuerpoEnvio(AUDIO, elegirModelo({ tipo: 'pareja', origen: 'online', lugarConRuido: false }), WH);
  assert.equal(po.speech_models[0], 'universal-3-5-pro');
  assert.equal(po.speaker_labels, true);
  assert.equal(po.speakers_expected, 3);
  for (const c of [ind, po]) {
    assert.ok(!('metadata' in c) && !('language_detection' in c) && !('speech_model' in c));
  }
});

test('cuerpoEnvio rechaza http y secretos con salto de línea', () => {
  const d = elegirModelo({ tipo: 'individual', origen: 'presencial', lugarConRuido: false });
  assert.throws(() => cuerpoEnvio('http://x', d, WH), ErrorAssemblyAI);
  assert.throws(() => cuerpoEnvio(AUDIO, d, { ...WH, secreto: 'a\nb' }), ErrorAssemblyAI);
});

test('decisionTrasErrorAAI: mismo modelo, luego U3.5 Pro, luego null', () => {
  const d = elegirModelo({ tipo: 'individual', origen: 'presencial', lugarConRuido: false });
  assert.equal(decisionTrasErrorAAI(d, 1)?.modelo, 'universal-2');
  assert.equal(decisionTrasErrorAAI(d, 2)?.modelo, 'universal-3-5-pro');
  assert.equal(decisionTrasErrorAAI(d, 3), null);
});

test('sanearMensaje quita URLs firmadas', () => {
  assert.equal(sanearMensaje(`Download error, unable to download ${AUDIO}`), 'Download error, unable to download [url]');
});

// ─── Cliente HTTP con fetch falso ────────────────────────────────────────────

type Llamada = { url: string; init: RequestInit };
function fetchFalso(respuestas: (Response | Error)[]) {
  const llamadas: Llamada[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    const r = respuestas.shift();
    if (!r) throw new Error('sin más respuestas');
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { f, llamadas };
}
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const cfg = (f: typeof fetch) => ({ apiKey: 'llave-falsa', webhookSecret: WH.secreto, webhookUrl: WH.url, fetch: f, dormir: async () => {} });

test('enviar: POST /v2/transcript con authorization y reintenta 503 y red', async () => {
  const { f, llamadas } = fetchFalso([json({ error: 'busy' }, 503), new Error('ECONNRESET'), json({ id: 'abc-123', status: 'queued' })]);
  const aai = crearClienteAssemblyAI(cfg(f));
  const r = await aai.enviar({ audioUrl: AUDIO, decision: elegirModelo({ tipo: 'pareja', origen: 'presencial', lugarConRuido: false }) });
  assert.equal(r.id, 'abc-123');
  assert.equal(llamadas.length, 3);
  assert.equal(llamadas[0].url, 'https://api.assemblyai.com/v2/transcript');
  assert.equal(llamadas[0].init.method, 'POST');
  assert.equal((llamadas[0].init.headers as Record<string, string>).authorization, 'llave-falsa');
  assert.equal(JSON.parse(String(llamadas[0].init.body)).speaker_labels, true);
});

test('enviar: 400 no se reintenta y el error no contiene la URL firmada', async () => {
  const { f, llamadas } = fetchFalso([json({ error: `Invalid audio_url ${AUDIO}` }, 400)]);
  const aai = crearClienteAssemblyAI(cfg(f));
  await assert.rejects(
    aai.enviar({ audioUrl: AUDIO, decision: elegirModelo({ tipo: 'individual', origen: 'presencial', lugarConRuido: false }) }),
    (e: unknown) => e instanceof ErrorAssemblyAI && e.status === 400 && !e.recuperable && !e.message.includes('Signature'),
  );
  assert.equal(llamadas.length, 1);
});

test('enviar: tras 3 fallos 5xx lanza recuperable', async () => {
  const { f } = fetchFalso([json({}, 500), json({}, 502), json({}, 504)]);
  const aai = crearClienteAssemblyAI(cfg(f));
  await assert.rejects(
    aai.enviar({ audioUrl: AUDIO, decision: elegirModelo({ tipo: 'individual', origen: 'presencial', lugarConRuido: false }) }),
    (e: unknown) => e instanceof ErrorAssemblyAI && e.recuperable && e.status === 504,
  );
});

test('obtener normaliza (sin text completo) y borrar acepta 404', async () => {
  const { f, llamadas } = fetchFalso([
    json({ id: 'abc', status: 'completed', text: 'TEXTO COMPLETO', audio_duration: 61, words: [{ text: 'Hola', start: 0, end: 300, confidence: 0.9, speaker: 'A' }], utterances: [{ speaker: 'A', start: 0, end: 300, text: 'Hola', words: [], confidence: 1 }] }),
    json({ error: 'not found' }, 404),
  ]);
  const aai = crearClienteAssemblyAI(cfg(f));
  const r = await aai.obtener('abc');
  assert.deepEqual(r, { id: 'abc', status: 'completed', audio_duration: 61, words: [{ text: 'Hola', start: 0, end: 300, confidence: 0.9, speaker: 'A' }], utterances: [{ speaker: 'A', start: 0, end: 300, text: 'Hola' }] });
  await aai.borrar('abc');
  assert.equal(llamadas[1].init.method, 'DELETE');
  assert.equal(llamadas[1].url, 'https://api.assemblyai.com/v2/transcript/abc');
  await assert.rejects(aai.obtener('../x'), ErrorAssemblyAI);
});

test('normalizarResultado: status desconocido → error', () => {
  assert.equal(normalizarResultado({ id: 'x', status: 'raro' }).status, 'error');
});

// ─── Webhook ─────────────────────────────────────────────────────────────────

test('cabeceraValida en tiempo constante', () => {
  assert.equal(cabeceraValida(WH.secreto, WH.secreto), true);
  assert.equal(cabeceraValida('otro', WH.secreto), false);
  assert.equal(cabeceraValida(null, WH.secreto), false);
  assert.equal(cabeceraValida('', ''), false);
});

test('parsearCuerpoWebhook solo acepta transcript_id + completed|error', () => {
  assert.deepEqual(parsearCuerpoWebhook('{"transcript_id":"abc-1","status":"completed","extra":1}'), { transcript_id: 'abc-1', status: 'completed' });
  assert.equal(parsearCuerpoWebhook('{"transcript_id":"abc","status":"queued"}'), null);
  assert.equal(parsearCuerpoWebhook('{"transcript_id":"a/b","status":"error"}'), null);
  assert.equal(parsearCuerpoWebhook('no-json'), null);
});

/** Repo en memoria que imita las restricciones de la base (unique + updates condicionales). */
function repoMemoria(segmentos: (SegmentoWebhook & { aai_transcript_id: string; cambios?: Record<string, unknown> })[]) {
  const eventos = new Map<string, { payload: CuerpoWebhook; procesado: boolean }>();
  const grabaciones = new Map<string, string>(segmentos.map((s) => [s.grabacion_id, 'transcribiendo']));
  const efectos = { updates: 0, auditorias: 0, transiciones: 0 };
  const repo: RepoWebhook = {
    async registrar(id, payload) {
      if (eventos.has(id)) return { nuevo: false, procesado: eventos.get(id)!.procesado };
      eventos.set(id, { payload, procesado: false });
      return { nuevo: true, procesado: false };
    },
    async marcarProcesado(id) { const e = eventos.get(id); if (e) e.procesado = true; },
    async segmentoPorTranscript(tid) {
      const s = segmentos.find((x) => x.aai_transcript_id === tid);
      return s ? { id: s.id, grabacion_id: s.grabacion_id, seq: s.seq, aai_estado: s.aai_estado } : null;
    },
    async actualizarSegmento(id, desde, cambios) {
      const s = segmentos.find((x) => x.id === id)!;
      if (!desde.includes(s.aai_estado as EstadoSegmentoAAI)) return false;
      s.aai_estado = cambios.aai_estado as EstadoSegmentoAAI;
      s.cambios = { ...s.cambios, ...cambios };
      efectos.updates++;
      return true;
    },
    async asegurarTranscribiendo(gid) {
      if (grabaciones.get(gid) === 'subida') { grabaciones.set(gid, 'transcribiendo'); efectos.transiciones++; }
    },
    async auditar() { efectos.auditorias++; },
  };
  return { repo, efectos, eventos, grabaciones, segmentos };
}

const real = (r: Partial<ResultadoTranscripcion>) => ({ obtener: async (id: string) => ({ id, status: 'completed', audio_duration: 3000, words: [{ text: 'secreto clínico', start: 0, end: 1 }], ...r } as ResultadoTranscripcion) });

test('webhook repetido = 1 efecto (secuencial y en paralelo); no guarda texto', async () => {
  const m = repoMemoria([{ id: 's1', grabacion_id: 'g1', seq: 0, aai_estado: 'processing', aai_transcript_id: 'tid-1' }]);
  let consultas = 0;
  const aai = { obtener: async (id: string) => { consultas++; return real({}).obtener(id); } };
  const entrada = { cabecera: WH.secreto, cuerpo: JSON.stringify({ transcript_id: 'tid-1', status: 'completed' }), secreto: WH.secreto };
  const [a, b] = await Promise.all([procesarWebhookAssemblyAI(entrada, { repo: m.repo, aai }), procesarWebhookAssemblyAI(entrada, { repo: m.repo, aai })]);
  const c = await procesarWebhookAssemblyAI(entrada, { repo: m.repo, aai });
  assert.deepEqual([a.http, b.http, c.http], [200, 200, 200]);
  assert.deepEqual([a.efecto, b.efecto].sort(), ['completado', 'sin_cambio']);
  assert.equal(c.efecto, 'repetido');
  assert.deepEqual(m.efectos, { updates: 1, auditorias: 1, transiciones: 0 });
  assert.equal(consultas, 2); // el tercero ni siquiera consulta a AssemblyAI
  assert.equal(m.segmentos[0].aai_estado, 'completed');
  assert.equal(m.segmentos[0].cambios?.aai_audio_seg, 3000);
  assert.ok(!JSON.stringify(m.segmentos).includes('secreto clínico'));
  assert.ok(!JSON.stringify([...m.eventos.values()]).includes('secreto clínico'));
});

test('webhook no confía en el cuerpo: dice completed pero la API dice error', async () => {
  const m = repoMemoria([{ id: 's1', grabacion_id: 'g1', seq: 0, aai_estado: 'enviado', aai_transcript_id: 'tid-2' }]);
  const r = await procesarWebhookAssemblyAI(
    { cabecera: WH.secreto, cuerpo: '{"transcript_id":"tid-2","status":"completed"}', secreto: WH.secreto },
    { repo: m.repo, aai: real({ status: 'error', error: `Download error ${AUDIO}` }) },
  );
  assert.equal(r.efecto, 'error_aai');
  assert.equal(m.segmentos[0].aai_estado, 'error');
  assert.equal(m.segmentos[0].cambios?.aai_error, 'Download error [url]');
});

test('webhook: carrera con el envío → grabación subida pasa a transcribiendo', async () => {
  const m = repoMemoria([{ id: 's1', grabacion_id: 'g1', seq: 0, aai_estado: 'enviado', aai_transcript_id: 'tid-3' }]);
  m.grabaciones.set('g1', 'subida');
  await procesarWebhookAssemblyAI({ cabecera: WH.secreto, cuerpo: '{"transcript_id":"tid-3","status":"completed"}', secreto: WH.secreto }, { repo: m.repo, aai: real({}) });
  assert.equal(m.grabaciones.get('g1'), 'transcribiendo');
});

test('webhook: cabecera mala 401 sin tocar la base; sin secreto 503; cuerpo malo 400; desconocido 200', async () => {
  const m = repoMemoria([]);
  const tocado = () => m.eventos.size;
  assert.deepEqual(await procesarWebhookAssemblyAI({ cabecera: 'x', cuerpo: '{}', secreto: WH.secreto }, { repo: m.repo, aai: real({}) }), { http: 401, efecto: 'no_autorizado' });
  assert.equal((await procesarWebhookAssemblyAI({ cabecera: 'x', cuerpo: '{}', secreto: undefined }, { repo: m.repo, aai: real({}) })).http, 503);
  assert.equal((await procesarWebhookAssemblyAI({ cabecera: WH.secreto, cuerpo: '{}', secreto: WH.secreto }, { repo: m.repo, aai: real({}) })).http, 400);
  assert.equal(tocado(), 0);
  const d = await procesarWebhookAssemblyAI({ cabecera: WH.secreto, cuerpo: '{"transcript_id":"ajeno","status":"completed"}', secreto: WH.secreto }, { repo: m.repo, aai: real({}) });
  assert.deepEqual(d, { http: 200, efecto: 'desconocido' });
});

test('webhook: si AssemblyAI no responde → 503 y el reintento sí procesa', async () => {
  const m = repoMemoria([{ id: 's1', grabacion_id: 'g1', seq: 0, aai_estado: 'processing', aai_transcript_id: 'tid-4' }]);
  const entrada = { cabecera: WH.secreto, cuerpo: '{"transcript_id":"tid-4","status":"completed"}', secreto: WH.secreto };
  const r1 = await procesarWebhookAssemblyAI(entrada, { repo: m.repo, aai: { obtener: async () => { throw new Error('timeout'); } } });
  assert.deepEqual(r1, { http: 503, efecto: 'reintentar' });
  const r2 = await procesarWebhookAssemblyAI(entrada, { repo: m.repo, aai: real({}) });
  assert.equal(r2.efecto, 'completado');
  assert.equal(m.efectos.updates, 1);
});

test('webhook: no retrocede un segmento ya completado (error tardío)', async () => {
  const m = repoMemoria([{ id: 's1', grabacion_id: 'g1', seq: 0, aai_estado: 'completed', aai_transcript_id: 'tid-5' }]);
  const r = await procesarWebhookAssemblyAI({ cabecera: WH.secreto, cuerpo: '{"transcript_id":"tid-5","status":"error"}', secreto: WH.secreto }, { repo: m.repo, aai: real({ status: 'error' }) });
  assert.equal(r.efecto, 'sin_cambio');
  assert.equal(m.segmentos[0].aai_estado, 'completed');
});
