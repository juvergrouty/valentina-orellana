// Prueba de punta a punta del orquestador (P6) SIN red: Supabase en memoria, S3 falso con el
// almacenamiento y el cifrado REALES (P1), AssemblyAI falso con el webhook REAL (P2), Claude falso
// con resumirSesion REAL (P3), bot REAL de P5 con Google Calendar y Fly falsos, consentimiento REAL (P4).
// Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { SupabaseMemoria, type Fila } from './pruebas/supabaseMemoria';
import { crearAlmacenamiento, endpointR2, OPCIONES_COMUNES } from './almacenamiento';
import { crearCifrado } from './cifrado';
import { procesarWebhookAssemblyAI, repoWebhookSupabase } from './assemblyai';
import { crearBot, procesarEventoBot } from './bot';
import { evaluarEnBase } from './consentimiento';
import { reintentar, transicionar } from './estados';
import { crearPipeline, esperaTrasFallos, etiquetaSesion, MAX_GUARDADO, MAX_RESUMEN, type PipelineP6 } from './pipeline';
import { PROMPT_VERSION_RESUMEN } from './resumen';
import { leerContenidoResumen } from './resumenCifrado';
import { HABLANTE_SIN_SEPARAR } from './hablantes';
import type { NuevaAlerta } from './alertas';
import type { AssemblyAI, PalabraAAI, ResultadoTranscripcion } from './tipos';
import type { ClienteMensajes } from './claude';

// ─── Dobles ──────────────────────────────────────────────────────────────────

const CUENTA = '0123456789abcdef0123456789abcdef';
const BUCKETS = { audio: 'vo-audio', transcripciones: 'vo-trans', b2: 'vo-b2' };

function s3Falso() {
  const objetos = new Map<string, Uint8Array>();
  const cliente = new S3Client({ ...OPCIONES_COMUNES, region: 'auto', endpoint: endpointR2(CUENTA, 'us'), credentials: { accessKeyId: 'AKIAPRUEBA', secretAccessKey: 'x' } });
  (cliente as unknown as { send: (c: unknown) => Promise<unknown> }).send = async (c: unknown) => {
    const cmd = (c as { constructor: { name: string } }).constructor.name;
    const input = (c as { input: Record<string, unknown> }).input;
    const k = `${input.Bucket}/${input.Key}`;
    const no = () => Object.assign(new Error('no existe'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    switch (cmd) {
      case 'PutObjectCommand': objetos.set(k, new Uint8Array(input.Body as Uint8Array)); return {};
      case 'GetObjectCommand': { const v = objetos.get(k); if (!v) throw no(); return { Body: { transformToByteArray: async () => v } }; }
      case 'HeadObjectCommand': { const v = objetos.get(k); if (!v) throw no(); return { ContentLength: v.length }; }
      case 'DeleteObjectCommand': objetos.delete(k); return {};
      default: throw new Error(`comando no simulado: ${cmd}`);
    }
  };
  return { cliente, objetos };
}

class AAIFalso implements AssemblyAI {
  t = new Map<string, ResultadoTranscripcion>();
  envios: { id: string; modelo: string; diarizacion: boolean }[] = [];
  borrados: string[] = [];
  private n = 0;
  async enviar({ audioUrl, decision }: Parameters<AssemblyAI['enviar']>[0]) {
    assert.match(audioUrl, /^https:\/\/.*X-Amz-Signature=/); // GET prefirmado real (firmado localmente)
    const id = `tr_${++this.n}`;
    this.envios.push({ id, modelo: decision.modelo, diarizacion: decision.diarizacion });
    this.t.set(id, { id, status: 'processing' });
    return { id };
  }
  async obtener(id: string) { const r = this.t.get(id); if (!r) throw new Error('no existe'); return structuredClone(r); }
  async borrar(id: string) { this.borrados.push(id); this.t.delete(id); }
  completar(id: string, words: PalabraAAI[]) { this.t.set(id, { id, status: 'completed', audio_duration: Math.ceil((words.at(-1)?.end ?? 0) / 1000), words }); }
  fallar(id: string) { this.t.set(id, { id, status: 'error', error: 'Audio file could not be decoded' }); }
}

const SECRETO_WEBHOOK = 'secreto-webhook-de-prueba';
async function webhook(db: SupabaseMemoria, aai: AAIFalso, id: string, status: 'completed' | 'error') {
  return procesarWebhookAssemblyAI(
    { cabecera: SECRETO_WEBHOOK, cuerpo: JSON.stringify({ transcript_id: id, status }), secreto: SECRETO_WEBHOOK },
    { repo: repoWebhookSupabase(db.cliente), aai },
  );
}

/** Claude falso: cada llamada consume una respuesta (texto o error con status HTTP). */
function claudeFalso(plan: (string | number)[]) {
  const llamadas: unknown[] = [];
  const cliente: ClienteMensajes = {
    messages: {
      stream(params) {
        llamadas.push(params);
        const paso = plan.length > 1 ? plan.shift()! : plan[0];
        return {
          async finalMessage() {
            if (typeof paso === 'number') throw Object.assign(new Error(`HTTP ${paso}`), { status: paso });
            return {
              id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
              content: [{ type: 'text', text: paso, citations: null }],
              usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            } as never;
          },
        };
      },
    },
  };
  return { cliente, llamadas, plan };
}

const palabras = (texto: string, desde = 0, speaker?: string): PalabraAAI[] =>
  texto.split(' ').map((w, i) => ({ text: w, start: desde + i * 400, end: desde + i * 400 + 300, confidence: 0.9, speaker: speaker ?? null }));

const RESUMEN = `## Resumen automático (IA)

### Puntos más importantes
- Se conversó sobre la semana y el trabajo.

### Tareas
- Registrar momentos de calma.

### Para trabajar en la próxima sesión
- Cómo resultó el registro.`;

// ─── Escenario ───────────────────────────────────────────────────────────────

function escenario(planClaude: (string | number)[] = [RESUMEN]) {
  const db = new SupabaseMemoria();
  let t = Date.parse('2026-10-20T13:00:00Z'); // 10:00 en Chile
  db.ahora = () => new Date(t);
  const avanzar = (min: number) => { t += min * 60_000; };
  const ahora = () => new Date(t);

  const r2 = s3Falso(), b2 = s3Falso();
  const KEK = new Uint8Array(randomBytes(32));
  const cifrado = crearCifrado({ activa: 1, obtener: (v) => (v === 1 ? KEK : undefined) });
  const almacenamiento = crearAlmacenamiento({ r2: r2.cliente, b2: b2.cliente, buckets: BUCKETS, cifrado });
  const aai = new AAIFalso();
  const claude = claudeFalso(planClaude);
  const alertas: NuevaAlerta[] = [];
  const resueltas: string[] = [];

  // Bot real (P5) con Calendar y Fly falsos.
  const eventos: Record<string, unknown>[] = [];
  const maquinas: { id: string; token: string }[] = [];
  const matadas: string[] = [];
  const fetchFalso = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://www.googleapis.com/calendar/v3/')) return new Response(JSON.stringify({ items: eventos }), { status: 200 });
    if (u.endsWith('/apps/vo-bot/machines') && init?.method === 'POST') {
      const cuerpo = JSON.parse(String(init.body));
      const id = `maq${maquinas.length + 1}abcdef`;
      maquinas.push({ id, token: cuerpo.config.env.BOT_TOKEN });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (/\/machines\/maq/.test(u) && init?.method === 'DELETE') { matadas.push(u); return new Response('{}', { status: 200 }); }
    return new Response('no simulado', { status: 500 });
  }) as typeof fetch;
  const BOT_SECRETO = 'secreto-del-bot-de-prueba-0123456789abcdef';
  const bot = crearBot({
    db: db.cliente, fetch: fetchFalso, calendario: async () => ({ token: 'tok', calendarId: 'primary' }),
    env: { FLY_API_TOKEN: 'fly', FLY_APP_BOT: 'vo-bot', FLY_IMAGEN: 'registry.fly.io/vo-bot:v1', BOT_TOKEN_SECRET: BOT_SECRETO, PUBLIC_SITE_URL: 'https://www.valentinaorellana.cl' },
  });

  const pipeline: PipelineP6 = crearPipeline({
    db: db.cliente, almacenamiento, aai, bot, claude: claude.cliente, cifrado,
    puedeGrabar: (p, tipo) => evaluarEnBase(p, tipo, db.cliente),
    alertas: { registrarAlerta: async (a) => { alertas.push(a); }, resolverAlertasDe: async (id) => { resueltas.push(id); } },
  });

  db.tabla('settings').push(
    { key: 'transcriptor_activo', value: 'true' }, { key: 'transcriptor_bot_activo', value: 'true' },
    { key: 'transcriptor_resumen_modo', value: 'directo' }, { key: 'transcriptor_bot_nombres_vale', value: 'Valentina Orellana' },
  );
  const paciente = (name: string, email: string) => { const id = randomUUID(); db.tabla('patients').push({ id, name, email, active: true, birthdate: '1990-05-05' }); return id; };
  const firma = (patient_id: string, signer_name: string, signer_rut: string, version = '2026-11-v3') =>
    db.tabla('consents').push({ id: randomUUID(), patient_id, version, signed_at: '2026-10-10T12:00:00Z', signer_name, signer_rut, signer_email: null, accept_recording: true, revoked_at: null });

  /** Lo que hacen grabacion-iniciar + subida-url + grabacion-finalizar (P4) con la base. */
  async function grabarPresencial(patientId: string, tipo: 'individual' | 'pareja', segundos: number[]): Promise<string> {
    const pareja = tipo === 'pareja';
    const consentIds = db.tabla('consents').filter((c) => c.patient_id === patientId).map((c) => c.id);
    const g = await db.from('grabaciones').insert({
      patient_id: patientId, consent_ids: consentIds, origen: 'presencial', tipo, modelo: pareja ? 'universal-3-5-pro' : 'universal-2', diarizacion: pareja,
      session_date: '2026-10-20', inicio_at: ahora().toISOString(), estado: 'creada', creada_por: 'vale',
    }).select('*').single();
    const id = g.data.id as string;
    await transicionar(id, ['creada'], 'grabando', {}, db.cliente);
    let offset = 0;
    for (const [seq, s] of segundos.entries()) {
      const key = `a/${randomUUID()}.m4a`;
      const audio = new Uint8Array(randomBytes(1000 + seq));
      r2.objetos.set(`${BUCKETS.audio}/${key}`, audio);
      db.tabla('grabacion_segmentos').push({ id: randomUUID(), grabacion_id: id, seq, r2_key: key, mime: 'audio/mp4', bytes: audio.length, offset_ms: offset, duracion_ms: s * 1000, subido_at: ahora().toISOString(), aai_transcript_id: null, aai_estado: null, aai_errores: 0, audio_borrado_at: null, aai_borrado_at: null, created_at: ahora().toISOString() });
      offset += s * 1000 + 60_000;
    }
    await transicionar(id, ['grabando'], 'subiendo', {}, db.cliente);
    await transicionar(id, ['subiendo'], 'subida', { duracion_seg: segundos.reduce((a, b) => a + b, 0), fin_at: ahora().toISOString() }, db.cliente);
    return id;
  }

  const grab = (id: string) => db.tabla('grabaciones').find((g) => g.id === id) as Fila;
  const segs = (id: string) => db.tabla('grabacion_segmentos').filter((s) => s.grabacion_id === id).sort((a, b) => a.seq - b.seq);
  const correr = async () => { const r = await pipeline.correr(ahora()); assert.deepEqual(r.errores, []); return r; };

  return { db, ahora, avanzar, r2, b2, aai, claude, alertas, resueltas, eventos, maquinas, matadas, BOT_SECRETO, almacenamiento, cifrado, pipeline, paciente, firma, grabarPresencial, grab, segs, correr };
}

// ─── Pruebas ─────────────────────────────────────────────────────────────────

test('E2E presencial individual: subida → transcribiendo → transcrita (cifrada, audio borrado) → lista', async () => {
  const e = escenario();
  const p = e.paciente('Camila Rojas', 'camila@ejemplo.cl');
  e.firma(p, 'Camila Rojas', '12.345.678-5');
  const id = await e.grabarPresencial(p, 'individual', [50 * 60]);

  await e.correr();
  assert.equal(e.grab(id).estado, 'transcribiendo');
  assert.deepEqual(e.aai.envios.map((x) => [x.modelo, x.diarizacion]), [['universal-2', true]]);
  const trId = e.segs(id)[0].aai_transcript_id;

  // Sin webhook todavía: no pasa nada.
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'transcribiendo');

  e.aai.completar(trId, palabras('hola cómo has estado esta semana bien gracias trabajé mucho'));
  assert.equal((await webhook(e.db, e.aai, trId, 'completed')).efecto, 'completado');
  assert.equal((await webhook(e.db, e.aai, trId, 'completed')).efecto, 'repetido'); // idempotente
  e.avanzar(1); await e.correr();

  // 17 oct (velocidad): la misma corrida que guarda la transcripción escribe el resumen.
  const g = e.grab(id);
  assert.equal(g.estado, 'lista');
  const tr = e.db.tabla('transcripciones').find((x) => x.grabacion_id === id)!;
  assert.match(tr.r2_key, /^t\/[0-9a-f-]+\.bin$/);
  assert.ok(tr.b2_key, 'copia en B2');
  assert.equal(tr.palabras, 10);
  // En R2 está cifrado (no aparece el texto) y se puede leer con la KEK.
  const crudo = Buffer.from(e.r2.objetos.get(`${BUCKETS.transcripciones}/${tr.r2_key}`)!).toString('latin1');
  assert.ok(!crudo.includes('trabajé') && crudo.startsWith('VOT1'));
  const clara = await e.almacenamiento.leerTranscripcion(tr.r2_key);
  assert.equal(clara.segmentos[0].hablante, HABLANTE_SIN_SEPARAR);
  // Audio borrado en R2 y transcript borrado en AssemblyAI, recién después de guardar.
  assert.equal([...e.r2.objetos.keys()].filter((k) => k.startsWith(`${BUCKETS.audio}/`)).length, 0);
  assert.deepEqual(e.aai.borrados, [trId]);
  assert.ok(e.segs(id)[0].audio_borrado_at && e.segs(id)[0].aai_borrado_at && g.audio_borrado_at);

  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista');
  const r = e.db.tabla('resumenes_ia').find((x) => x.grabacion_id === id)!;
  assert.equal(r.estado, 'listo');
  assert.equal(r.modo, 'directo');
  assert.equal(r.prompt_version, PROMPT_VERSION_RESUMEN);
  assert.equal(r.plantilla, 'individual');
  assert.ok(r.costo_usd > 0 && r.tokens_salida === 300);
  // H7: el contenido va cifrado (VOT1) y en claro queda null; se abre con la misma KEK.
  assert.equal(r.contenido, null);
  assert.match(String(r.contenido_cifrado), /^\\x564f5431/); // 'VOT1'
  assert.match(String(await leerContenidoResumen(r as never, e.cifrado)), /### Tareas\n- Registrar momentos de calma/);
  // Al modelo solo va el nombre de pila (sin apellido) y sin Batch.
  const enviado = JSON.stringify(e.claude.llamadas[0]);
  assert.ok(enviado.includes('Camila') && !enviado.includes('Rojas'));
  assert.equal(e.alertas.length, 0);
  assert.deepEqual(e.resueltas, [id]);
  // Nada que hacer en la siguiente pasada.
  e.avanzar(1); const fin = await e.correr();
  assert.equal(fin.pasos.resumenes + fin.pasos.envios + fin.pasos.transcripciones, 0);
});

test('E2E presencial pareja (2 segmentos): error de AssemblyAI → reintento con el mismo modelo → lista', async () => {
  const e = escenario();
  const p = e.paciente('Ana y Luis', 'pareja@ejemplo.cl');
  e.firma(p, 'Ana Pérez', '11.111.111-1');
  e.firma(p, 'Luis Soto', '9.876.543-2');
  const id = await e.grabarPresencial(p, 'pareja', [20 * 60, 25 * 60]);

  await e.correr();
  assert.deepEqual(e.aai.envios.map((x) => [x.modelo, x.diarizacion]), [['universal-3-5-pro', true], ['universal-3-5-pro', true]]);
  const [s0, s1] = e.segs(id).map((s) => s.aai_transcript_id);
  e.aai.fallar(s0);
  await webhook(e.db, e.aai, s0, 'error');
  e.aai.completar(s1, palabras('y entonces le dije que necesitaba tiempo', 0, 'B'));
  await webhook(e.db, e.aai, s1, 'completed');

  e.avanzar(1); await e.correr();
  // Se reenvió el segmento 0 con el MISMO modelo (regla 4) y el transcript con error se borró.
  assert.equal(e.aai.envios.length, 3);
  assert.equal(e.aai.envios[2].modelo, 'universal-3-5-pro');
  assert.ok(e.aai.borrados.includes(s0));
  const nuevo = e.segs(id)[0];
  assert.equal(nuevo.aai_errores, 1);
  assert.equal(nuevo.aai_estado, 'enviado');
  assert.equal(e.grab(id).estado, 'transcribiendo');

  e.aai.completar(nuevo.aai_transcript_id, palabras('bueno partamos por lo que pasó el fin de semana', 0, 'A'));
  await webhook(e.db, e.aai, nuevo.aai_transcript_id, 'completed');
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista'); // 17 oct: transcripción y resumen en la misma corrida
  const clara = await e.almacenamiento.leerTranscripcion(e.db.tabla('transcripciones')[0].r2_key);
  assert.ok(clara.hablantes.some((h) => /Hablante A/.test(h)) && clara.hablantes.some((h) => /Hablante B \(parte 2\)/.test(h)));

  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista');
  assert.equal(e.db.tabla('resumenes_ia')[0].plantilla, 'pareja');
  // H14: al modelo van los nombres de pila de las dos personas que firmaron (sin apellidos).
  const enviadoPareja = JSON.stringify(e.claude.llamadas[0]);
  assert.ok(enviadoPareja.includes('Miembro: Ana') && enviadoPareja.includes('Miembro: Luis'), 'pareja: nombres de pila de ambos');
  assert.ok(!/Pérez|Soto/.test(enviadoPareja), 'sin apellidos');
  assert.match(enviadoPareja, /orden no determinado/);
  assert.equal(e.alertas.length, 0);
});

test('E2E online (consentimiento v2, decisión 9): bot → sondeo sin webhook → resumen falla 4 veces → alerta → Reintentar → lista', async () => {
  const e = escenario([529]);
  const p = e.paciente('Diego Soto', 'diego@ejemplo.cl');
  e.firma(p, 'Diego Soto', '15.555.555-5', '2026-10-v2'); // v2 con accept_recording = true
  const bookingId = randomUUID();
  const eventoId = bookingId.replace(/-/g, '');
  const inicio = new Date(e.ahora().getTime() + 2 * 60_000).toISOString();
  const fin = new Date(e.ahora().getTime() + 52 * 60_000).toISOString();
  e.db.tabla('bookings').push({ id: bookingId, google_event_id: eventoId, session_type: 'online', status: 'confirmed', patient_email: 'diego@ejemplo.cl', notes: 'Meet: https://meet.google.com/abc-defg-hij' });
  e.eventos.push({ id: eventoId, status: 'confirmed', start: { dateTime: inicio }, end: { dateTime: fin }, hangoutLink: 'https://meet.google.com/abc-defg-hij', attendees: [{ email: 'diego@ejemplo.cl' }] });

  // 1) El cron despacha el bot (una sola vez aunque corra de nuevo).
  await e.correr();
  const g0 = e.db.tabla('grabaciones')[0];
  assert.deepEqual([g0.estado, g0.origen, g0.patient_id, g0.creada_por, g0.meet_url, g0.hora_fin_prevista], ['bot_lanzando', 'online', p, 'cron', 'https://meet.google.com/abc-defg-hij', fin]);
  assert.equal(e.maquinas.length, 1);
  assert.equal(g0.bot_machine_id, e.maquinas[0].id);
  e.avanzar(1); await e.correr();
  assert.equal(e.maquinas.length, 1);
  const id = g0.id as string;

  // 2) El bot (P5) avisa lobby → activo → pide URL → sube → fin con la línea de hablantes.
  const evento = (cuerpo: object) => procesarEventoBot(
    { authorization: `Bearer ${e.maquinas[0].token}`, cuerpoTexto: JSON.stringify(cuerpo) },
    { db: e.db.cliente, secreto: e.BOT_SECRETO, almacenamiento: async () => e.almacenamiento, ahora: e.ahora },
  );
  assert.equal((await evento({ tipo: 'lobby' })).status, 200);
  assert.equal((await evento({ tipo: 'activo' })).status, 200);
  const pide = await evento({ tipo: 'pide_url', seq: 0 });
  assert.match(String(pide.cuerpo.url), /^https:\/\//);
  const key = e.segs(id)[0].r2_key;
  e.r2.objetos.set(`${BUCKETS.audio}/${key}`, new Uint8Array(4000));
  e.avanzar(45);
  assert.equal((await evento({ tipo: 'segmento_subido', seq: 0, bytes: 4000, offset_ms: 0, duracion_ms: 45 * 60_000 })).status, 200);
  const linea = [{ t_ms: 0, nombre: 'Valentina Orellana', on: true }, { t_ms: 1900, nombre: 'Valentina Orellana', on: false }, { t_ms: 2000, nombre: 'Diego Soto', on: true }, { t_ms: 6000, nombre: 'Diego Soto', on: false }];
  assert.equal((await evento({ tipo: 'fin', motivo: 'vale_salio', linea_hablantes: linea })).status, 200);
  assert.equal(e.grab(id).estado, 'subida');

  // 3) Envío a AssemblyAI (online individual: universal-2, sin diarización pagada).
  await e.correr();
  assert.equal(e.grab(id).estado, 'transcribiendo');
  const tr = e.segs(id)[0].aai_transcript_id;
  assert.deepEqual(e.aai.envios.map((x) => [x.modelo, x.diarizacion]), [['universal-2', false]]);
  e.aai.completar(tr, [...palabras('hola diego cómo estás', 0), ...palabras('bien gracias valentina', 2100)]);

  // 4) El webhook nunca llega: a los 30 min el cron sondea y guarda.
  e.avanzar(10); await e.correr();
  assert.equal(e.grab(id).estado, 'transcribiendo');
  e.avanzar(21); await e.correr();
  // 17 oct: la misma corrida que guarda la transcripción ya intenta el resumen (aquí falla con 529).
  assert.equal(e.grab(id).estado, 'resumiendo');
  assert.equal(e.db.tabla('resumenes_ia')[0].intentos, 1);
  const clara = await e.almacenamiento.leerTranscripcion(e.db.tabla('transcripciones')[0].r2_key);
  assert.deepEqual(clara.hablantes, ['Ps. Valentina', 'Diego Soto']);
  assert.deepEqual(e.grab(id).mapa_hablantes, { 'Valentina Orellana': 'Ps. Valentina' });

  // 5) Resumen: Anthropic sobrecargado (529) → reintentos con backoff 1/5/15 min → al 4.º, error + alerta.
  for (let i = 1; i <= MAX_RESUMEN; i++) {
    if (i > 1) await e.correr(); // el 1.er intento ya ocurrió en la corrida que guardó la transcripción
    const r = e.db.tabla('resumenes_ia')[0];
    assert.equal(r.intentos, i);
    if (i < MAX_RESUMEN) {
      assert.equal(e.grab(id).estado, 'resumiendo');
      assert.equal(r.estado, 'pendiente');
      e.avanzar(1); await e.correr(); // antes del backoff no se reintenta (salvo el primero: 1 min)
      if (i > 1) assert.equal(e.db.tabla('resumenes_ia')[0].intentos, i);
      e.avanzar(esperaTrasFallos(i) / 60_000);
    }
  }
  assert.equal(e.grab(id).estado, 'error');
  assert.equal(e.grab(id).estado_antes_error, 'resumiendo');
  assert.equal(e.db.tabla('resumenes_ia')[0].estado, 'error');
  assert.equal(e.alertas.length, 1);
  const a = e.alertas[0];
  assert.deepEqual([a.tipo, a.accion, a.grabacionId, a.clave], ['resumen', 'reintentar_resumen', id, `resumen:${id}`]);
  assert.equal(a.titulo, `No se pudo generar el resumen automático de la ${etiquetaSesion(e.grab(id) as never)}`);
  assert.ok(!/Diego|Soto|hola/.test(`${a.titulo} ${a.detalle}`), 'la alerta no lleva nombres ni contenido');
  assert.match(a.titulo, /sesión online del 20\/10 a las 10:01/);
  assert.doesNotMatch(a.titulo, /individual|pareja/, 'H17: el tipo de terapia no va en el título (viaja en el asunto del correo)');

  // 6) Vale toca "Reintentar resumen" (P7 → estados.reintentar); Anthropic ya responde.
  e.claude.plan.splice(0, e.claude.plan.length, RESUMEN);
  assert.ok(await reintentar(id, e.db.cliente));
  await e.correr();
  assert.equal(e.grab(id).estado, 'lista');
  assert.equal(e.db.tabla('resumenes_ia').length, 1);
  assert.equal(e.db.tabla('resumenes_ia')[0].estado, 'listo');
  assert.ok(e.resueltas.includes(id));
});

test('vigilante: bot vivo después de HORA_FIN + 40 min → se apaga la máquina y se transcribe lo subido', async () => {
  const e = escenario();
  const p = e.paciente('Marta Gil', 'marta@ejemplo.cl');
  e.firma(p, 'Marta Gil', '13.333.333-3');
  const g = (await e.db.from('grabaciones').insert({
    patient_id: p, origen: 'online', tipo: 'individual', modelo: 'universal-2', session_date: '2026-10-20', estado: 'grabando',
    google_event_id: 'ev1', meet_url: 'https://meet.google.com/abc-defg-hij', hora_fin_prevista: new Date(e.ahora().getTime() - 41 * 60_000).toISOString(),
    inicio_at: new Date(e.ahora().getTime() - 90 * 60_000).toISOString(), bot_machine_id: 'maq9abcdef',
  }).select('*').single()).data;
  e.db.tabla('grabacion_segmentos').push({ id: randomUUID(), grabacion_id: g.id, seq: 0, r2_key: `a/${randomUUID()}.webm`, mime: 'audio/webm', offset_ms: 0, subido_at: e.ahora().toISOString(), aai_errores: 0, aai_transcript_id: null });
  e.db.tabla('grabacion_segmentos').push({ id: randomUUID(), grabacion_id: g.id, seq: 1, r2_key: `a/${randomUUID()}.webm`, mime: 'audio/webm', offset_ms: 0, subido_at: null, aai_errores: 0, aai_transcript_id: null });
  await e.correr();
  assert.equal(e.matadas.length, 1);
  assert.equal(e.grab(g.id).estado, 'transcribiendo'); // vigilar → subida; el mismo minuto se envía
  assert.equal(e.segs(g.id).length, 1, 'el segmento nunca confirmado se descarta');
  assert.equal(e.alertas[0].tipo, 'bot');
});

test('envío a AssemblyAI que falla: backoff 1/5/15/60 min y, agotado, error + alerta de transcripción', async () => {
  const e = escenario();
  const p = e.paciente('Paula Díaz', 'paula@ejemplo.cl');
  e.firma(p, 'Paula Díaz', '14.444.444-4');
  const id = await e.grabarPresencial(p, 'individual', [600]);
  e.aai.enviar = async () => { throw Object.assign(new Error('AssemblyAI POST 503'), { name: 'ErrorAssemblyAI' }); };
  for (let i = 1; i <= 6; i++) {
    await e.correr();
    if (i < 6) {
      assert.equal(e.grab(id).estado, 'subida');
      assert.equal(e.grab(id).intentos, i);
      e.avanzar(esperaTrasFallos(i) / 60_000);
    }
  }
  assert.equal(e.grab(id).estado, 'error');
  assert.equal(e.grab(id).estado_antes_error, 'subida');
  assert.deepEqual(e.alertas.map((a) => [a.tipo, a.accion]), [['transcripcion', 'reintentar']]);
});

test('sin consentimiento: no se lanza el bot y queda la fila sin_consentimiento (sin alerta)', async () => {
  const e = escenario();
  const p = e.paciente('Sofía Paz', 'sofia@ejemplo.cl');
  e.firma(p, 'Sofía Paz', '16.666.666-6', '2026-10-v1'); // v1 no autoriza grabar
  const inicio = new Date(e.ahora().getTime() + 60_000).toISOString();
  e.eventos.push({ id: 'evencuadrado1', start: { dateTime: inicio }, end: { dateTime: new Date(e.ahora().getTime() + 51 * 60_000).toISOString() }, hangoutLink: 'https://meet.google.com/xyz-abcd-efg', attendees: [{ email: 'sofia@ejemplo.cl' }] });
  await e.correr();
  assert.equal(e.maquinas.length, 0);
  assert.equal(e.db.tabla('grabaciones')[0].estado, 'sin_consentimiento');
  assert.equal(e.alertas.length, 0);
});

test('limpieza: "creada" sin audio por más de 72 h → cancelada; con audio en camino no se toca', async () => {
  const e = escenario();
  const vieja = new Date(e.ahora().getTime() - 73 * 3600_000).toISOString();
  e.db.tabla('grabaciones').push(
    { id: 'g-huerfana', origen: 'presencial', tipo: 'individual', modelo: 'universal-2', estado: 'creada', session_date: '2026-10-17', created_at: vieja, updated_at: vieja, tomada_en: null, intentos: 0 },
    { id: 'g-con-audio', origen: 'presencial', tipo: 'individual', modelo: 'universal-2', estado: 'creada', session_date: '2026-10-17', created_at: vieja, updated_at: vieja, tomada_en: null, intentos: 0 },
  );
  e.db.tabla('grabacion_segmentos').push({ id: 's1', grabacion_id: 'g-con-audio', seq: 0, r2_key: 'a/x.m4a', subido_at: null });
  await e.correr();
  assert.equal(e.grab('g-huerfana').estado, 'cancelada');
  assert.equal(e.grab('g-con-audio').estado, 'creada');
});

test('transcriptor apagado: no despacha ni procesa; avisa si hay grabaciones detenidas a mitad', async () => {
  const e = escenario();
  e.db.tabla('settings').find((s) => s.key === 'transcriptor_activo')!.value = 'false';
  const p = e.paciente('Ema Ruiz', 'ema@ejemplo.cl');
  e.firma(p, 'Ema Ruiz', '17.777.777-7');
  const id = await e.grabarPresencial(p, 'individual', [600]);
  const r = await e.correr();
  assert.equal(r.apagado, true);
  assert.equal(e.grab(id).estado, 'subida');
  assert.equal(e.aai.envios.length, 0);
  assert.deepEqual(e.alertas.map((a) => a.clave), ['config:apagado-con-pendientes']);
  assert.ok(e.db.tabla('settings').some((s) => s.key === 'transcriptor_latido'));
});


// ─── Correcciones 81/82-revision (16 oct) ────────────────────────────────────

test('M1: Regenerar inserta la fila pendiente ANTES de pasar a resumiendo; el cron en medio no la deja huérfana', async () => {
  const e = escenario([RESUMEN, RESUMEN.replace('Registrar momentos de calma.', 'Anotar dos momentos de calma.')]);
  const p = e.paciente('Rosa Vidal', 'rosa@ejemplo.cl');
  e.firma(p, 'Rosa Vidal', '18.888.888-8');
  const id = await e.grabarPresencial(p, 'individual', [600]);
  await e.correr();
  const tr = e.segs(id)[0].aai_transcript_id;
  e.aai.completar(tr, palabras('hola cómo estás bien gracias'));
  await webhook(e.db, e.aai, tr, 'completed');
  e.avanzar(1); await e.correr();
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista');
  // Lo que hace regenerar-resumen.ts: 1) fila v2 pendiente  2) (el cron corre justo aquí)  3) lista → resumiendo.
  const t = e.db.tabla('transcripciones')[0];
  await e.db.from('resumenes_ia').insert({ grabacion_id: id, patient_id: p, transcripcion_id: t.id, version: 2, autor: 'ia', plantilla: 'individual', modo: 'directo', estado: 'pendiente' });
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista', 'con la grabación en lista el cron no toca la fila nueva');
  assert.ok(await transicionar(id, ['lista'], 'resumiendo', {}, e.db.cliente));
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista');
  const v2 = e.db.tabla('resumenes_ia').find((r) => r.grabacion_id === id && r.version === 2)!;
  assert.equal(v2.estado, 'listo', 'la v2 la tomó el cron (no quedó pendiente para siempre)');
  assert.match(String(await leerContenidoResumen(v2 as never, e.cifrado)), /Anotar dos momentos/);
  assert.equal(e.db.tabla('resumenes_ia').filter((r) => r.grabacion_id === id).length, 2, 'no se creó otra fila');
});

// ─── Evolución autollenada desde el resumen (pedido de Vale, 17 oct 2026) ─────

async function hastaLista(e: ReturnType<typeof escenario>, p: string): Promise<string> {
  const id = await e.grabarPresencial(p, 'individual', [600]);
  await e.correr();
  const tr = e.segs(id)[0].aai_transcript_id;
  e.aai.completar(tr, palabras('hola cómo estás bien gracias'));
  await webhook(e.db, e.aai, tr, 'completed');
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista');
  return id;
}

test('evolución automática: al quedar listo el resumen se guarda una vez; regenerar no la duplica ni la pisa', async () => {
  const e = escenario([RESUMEN, RESUMEN.replace('Registrar momentos de calma.', 'Anotar dos momentos de calma.')]);
  const p = e.paciente('Rosa Vidal', 'rosa@ejemplo.cl');
  e.firma(p, 'Rosa Vidal', '18.888.888-8');
  const id = await hastaLista(e, p);
  const notas = () => e.db.tabla('session_notes').filter((n) => n.patient_id === p);
  assert.equal(notas().length, 1);
  assert.equal(notas()[0].session_date, '2026-10-20');
  assert.equal(notas()[0].booking_id, null);
  assert.equal(notas()[0].session_type, 'presencial');
  assert.match(notas()[0].content, /^Basado en el resumen automático \(IA\) — revisar y editar:\n/);
  assert.match(notas()[0].content, /Registrar momentos de calma/);
  assert.ok(!/^#|\*\*/m.test(notas()[0].content), 'texto plano, sin Markdown');
  // Regenerar (v2): la evolución no cambia ni se duplica.
  const t = e.db.tabla('transcripciones')[0];
  await e.db.from('resumenes_ia').insert({ grabacion_id: id, patient_id: p, transcripcion_id: t.id, version: 2, autor: 'ia', plantilla: 'individual', modo: 'directo', estado: 'pendiente' });
  assert.ok(await transicionar(id, ['lista'], 'resumiendo', {}, e.db.cliente));
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista');
  assert.equal(notas().length, 1);
  assert.match(notas()[0].content, /Registrar momentos de calma/);
  assert.equal(e.db.tabla('transcriptor_auditoria').filter((a) => a.accion === 'evolucion_autollenada' && a.resultado === 'ok').length, 1);
});

test('evolución automática: ruta de recuperación (resumen ya listo, grabación sin cerrar) descifra y autollena una sola vez', async () => {
  const e = escenario();
  const p = e.paciente('Rosa Vidal', 'rosa@ejemplo.cl');
  e.firma(p, 'Rosa Vidal', '18.888.888-8');
  const id = await hastaLista(e, p);
  // Como si la corrida se hubiera cortado antes de guardar la evolución.
  e.db.tablas['session_notes'] = [];
  assert.ok(await transicionar(id, ['lista'], 'resumiendo', {}, e.db.cliente));
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'lista');
  const notas = e.db.tabla('session_notes').filter((n) => n.patient_id === p);
  assert.equal(notas.length, 1);
  assert.match(notas[0].content, /Registrar momentos de calma/, 'el resumen cifrado se descifró');
});

test('evolución automática: si Vale ya escribió la evolución, no se toca', async () => {
  const e = escenario();
  const p = e.paciente('Rosa Vidal', 'rosa@ejemplo.cl');
  e.firma(p, 'Rosa Vidal', '18.888.888-8');
  e.db.tabla('session_notes').push({ id: randomUUID(), patient_id: p, booking_id: null, session_date: '2026-10-20', session_type: 'presencial', content: 'Mi evolución.', historial: [], deleted_at: null });
  await hastaLista(e, p);
  const notas = e.db.tabla('session_notes').filter((n) => n.patient_id === p);
  assert.equal(notas.length, 1);
  assert.equal(notas[0].content, 'Mi evolución.');
});

test('evolución automática: un fallo al guardarla no rompe la transcripción ni el resumen', async () => {
  const e = escenario();
  const p = e.paciente('Rosa Vidal', 'rosa@ejemplo.cl');
  e.firma(p, 'Rosa Vidal', '18.888.888-8');
  const real = e.db.from.bind(e.db);
  (e.db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    if (t === 'session_notes') throw new Error('session_notes caída');
    return real(t);
  };
  const id = await hastaLista(e, p);
  const r = e.db.tabla('resumenes_ia').find((x) => x.grabacion_id === id)!;
  assert.equal(r.estado, 'listo');
  assert.equal(e.alertas.length, 0);
  assert.equal(e.db.tabla('session_notes').length, 0);
  const err = e.db.tabla('transcriptor_auditoria').filter((a) => a.accion === 'evolucion_autollenada');
  assert.equal(err.length, 1);
  assert.equal(err[0].resultado, 'error');
});

test('M3: Reintentar un bot caído antes de grabar lo relanza (sin exigir intentos > 0)', async () => {
  const e = escenario();
  const p = e.paciente('Iván Mora', 'ivan@ejemplo.cl');
  e.firma(p, 'Iván Mora', '19.999.999-9');
  const g = (await e.db.from('grabaciones').insert({
    patient_id: p, origen: 'online', tipo: 'individual', modelo: 'universal-2', session_date: '2026-10-20', estado: 'error',
    estado_antes_error: 'bot_lanzando', intentos: 3, bot_machine_id: 'maqvieja1', google_event_id: 'evx',
    meet_url: 'https://meet.google.com/abc-defg-hij', hora_fin_prevista: new Date(e.ahora().getTime() + 40 * 60_000).toISOString(),
  }).select('*').single()).data;
  assert.ok(await reintentar(g.id, e.db.cliente));
  assert.equal(e.grab(g.id).bot_machine_id, null);
  assert.equal(e.grab(g.id).intentos, 0);
  await e.correr();
  assert.equal(e.maquinas.length, 1, 'se lanzó un bot nuevo');
  assert.equal(e.grab(g.id).bot_machine_id, e.maquinas[0].id);
  e.avanzar(1); await e.correr();
  assert.equal(e.maquinas.length, 1, 'y no se relanza en cada minuto');
});

test('M4: si otro proceso ya guardó un transcript para el segmento, el nuevo se borra en AssemblyAI', async () => {
  const e = escenario();
  const p = e.paciente('Lía Paz', 'lia@ejemplo.cl');
  e.firma(p, 'Lía Paz', '10.101.010-1');
  const id = await e.grabarPresencial(p, 'individual', [600]);
  // Mientras el cron enviaba, grabacion-finalizar alcanzó a guardar el suyo.
  const enviarReal = e.aai.enviar.bind(e.aai);
  e.aai.enviar = async (x) => {
    const r = await enviarReal(x);
    e.segs(id)[0].aai_transcript_id = 'tr_de_finalizar';
    return r;
  };
  await e.correr();
  assert.equal(e.segs(id)[0].aai_transcript_id, 'tr_de_finalizar', 'no se pisa el id guardado');
  assert.deepEqual(e.aai.borrados, ['tr_1'], 'el transcript duplicado se borró en AssemblyAI');
});

test('B4: si la copia a B2 falla, el audio NO se borra hasta reintentarla; agotada, sigue con aviso y el paso respaldos la completa', async () => {
  const e = escenario();
  const p = e.paciente('Tere Luna', 'tere@ejemplo.cl');
  e.firma(p, 'Tere Luna', '12.121.212-2');
  const id = await e.grabarPresencial(p, 'individual', [600]);
  await e.correr();
  const tr = e.segs(id)[0].aai_transcript_id;
  e.aai.completar(tr, palabras('hola cómo has estado esta semana'));
  await webhook(e.db, e.aai, tr, 'completed');
  // B2 caído: toda escritura en el bucket de respaldo falla.
  const sendB2 = (e.b2.cliente as unknown as { send: (c: unknown) => Promise<unknown> }).send;
  (e.b2.cliente as unknown as { send: (c: unknown) => Promise<unknown> }).send = async () => { throw Object.assign(new Error('B2 caído'), { $metadata: { httpStatusCode: 503 } }); };
  const audio = () => [...e.r2.objetos.keys()].filter((k) => k.startsWith('vo-audio/')).length;
  e.avanzar(1); await e.correr();
  assert.equal(e.grab(id).estado, 'transcribiendo');
  assert.equal(e.db.tabla('transcripciones')[0].b2_key, null);
  assert.equal(audio(), 1, 'el audio sigue guardado mientras falte la copia en B2');
  assert.deepEqual(e.aai.borrados, [], 'ni se borra en AssemblyAI');
  for (let i = 1; i < MAX_GUARDADO; i++) { e.avanzar(esperaTrasFallos(i) / 60_000); await e.correr(); }
  assert.equal(e.grab(id).estado, 'lista', 'agotados los intentos sigue (R2 verificada) con la copia pendiente (y se resume en la misma corrida, 17 oct)');
  assert.equal(audio(), 0);
  assert.ok(e.alertas.some((a) => a.tipo === 'respaldo' && a.grabacionId === id));
  // B2 vuelve: el paso respaldos completa la copia y cierra el aviso.
  (e.b2.cliente as unknown as { send: (c: unknown) => Promise<unknown> }).send = sendB2;
  e.avanzar(1); await e.correr();
  assert.ok(e.db.tabla('transcripciones')[0].b2_key, 'copia en B2 hecha');
  assert.ok(e.resueltas.includes(id));
});

test('H2: evento online sin tipo de una ficha de pareja con UNA firma → no se envía el bot', async () => {
  const e = escenario();
  const p = e.paciente('Clara y Tomás', 'clara@ejemplo.cl');
  e.firma(p, 'Clara Ríos', '13.131.313-3');
  const inicio = new Date(e.ahora().getTime() + 60_000).toISOString();
  e.eventos.push({ id: 'evpareja1', start: { dateTime: inicio }, end: { dateTime: new Date(e.ahora().getTime() + 51 * 60_000).toISOString() }, hangoutLink: 'https://meet.google.com/xyz-abcd-efg', attendees: [{ email: 'clara@ejemplo.cl' }] });
  await e.correr();
  assert.equal(e.maquinas.length, 0);
  const g = e.db.tabla('grabaciones')[0];
  assert.equal(g.estado, 'sin_consentimiento');
  assert.equal(g.tipo, 'pareja', 'el servidor dedujo pareja desde la ficha');
});

test('H13: hueco entre segmentos sin pausa registrada → tramo "[pausa / interrupción …]" en la transcripción', async () => {
  const e = escenario();
  const p = e.paciente('Nora Gil', 'nora@ejemplo.cl');
  e.firma(p, 'Nora Gil', '14.141.414-4');
  const id = await e.grabarPresencial(p, 'individual', [10, 10]); // 2 segmentos con 60 s entre ambos (interrupción)
  await e.correr();
  const [a, b] = e.segs(id).map((s) => s.aai_transcript_id);
  e.aai.completar(a, palabras('primera parte de la sesión'));
  e.aai.completar(b, palabras('segunda parte después de la llamada'));
  await webhook(e.db, e.aai, a, 'completed');
  await webhook(e.db, e.aai, b, 'completed');
  e.avanzar(1); await e.correr();
  const clara = await e.almacenamiento.leerTranscripcion(e.db.tabla('transcripciones')[0].r2_key);
  const marca = clara.segmentos.find((t) => t.texto.startsWith('[pausa / interrupción'));
  assert.ok(marca, 'hay marca de hueco');
  assert.equal(marca!.hablante, '');
  assert.equal(e.db.tabla('transcripciones')[0].palabras, 11, 'la marca no cuenta como voz (5 + 6 palabras)');
});

// ─── Auditoría de seguridad (17 oct): el retiro del consentimiento corta lo que sigue ─────────────

test('auditoría seguridad: consentimiento retirado antes del envío a AssemblyAI → no se envía (error, en bitácora)', async () => {
  const e = escenario();
  const p = e.paciente('Rosa Díaz', 'rosa@ejemplo.cl');
  e.firma(p, 'Rosa Díaz', '13.131.313-1');
  const id = await e.grabarPresencial(p, 'individual', [600]);
  // "Retirar solo la grabación" (0019) después de subir, antes de que el cron la envíe.
  e.db.tabla('consents').filter((c) => c.patient_id === p).forEach((c) => { c.recording_revoked_at = e.ahora().toISOString(); });
  await e.correr();
  assert.equal(e.aai.envios.length, 0, 'nada va a AssemblyAI');
  assert.equal(e.grab(id).estado, 'error');
  assert.equal(e.grab(id).estado_antes_error, 'subida');
  assert.ok(e.db.tabla('transcriptor_auditoria').some((a) => a.accion === 'consentimiento_faltante' && a.grabacion_id === id));
});

test('auditoría seguridad: relanzar un bot exige consentimiento vigente; retirado → cancelada sin máquina', async () => {
  const e = escenario();
  const p = e.paciente('Tomás Ríos', 'tomas@ejemplo.cl');
  e.firma(p, 'Tomás Ríos', '14.141.414-1');
  const g = (await e.db.from('grabaciones').insert({
    patient_id: p, origen: 'online', tipo: 'individual', modelo: 'universal-2', session_date: '2026-10-20', estado: 'error',
    estado_antes_error: 'bot_lanzando', intentos: 3, bot_machine_id: 'maqvieja2', google_event_id: 'evy',
    meet_url: 'https://meet.google.com/abc-defg-hij', hora_fin_prevista: new Date(e.ahora().getTime() + 40 * 60_000).toISOString(),
  }).select('*').single()).data;
  assert.ok(await reintentar(g.id, e.db.cliente));
  e.db.tabla('consents').filter((c) => c.patient_id === p).forEach((c) => { c.revoked_at = e.ahora().toISOString(); });
  await e.correr();
  assert.equal(e.maquinas.length, 0, 'no se lanzó el bot');
  assert.equal(e.grab(g.id).estado, 'cancelada');
});
