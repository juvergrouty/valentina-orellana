// Auditoría de regresión del transcriptor PRESENCIAL (19 oct 2026, rama audit-presencial-2).
// Flujo completo con las RUTAS REALES del grabador (grabacion-iniciar, subida-url, grabacion-finalizar
// POST/GET) y el orquestador REAL (pipeline.correr), sin red: Supabase en memoria (SupabaseMemoria, que
// reemplaza a src/lib/supabase.ts con un hook de resolución de módulos), R2/B2 falsos con el almacenamiento
// y el cifrado reales, AssemblyAI falso con el webhook real y Claude falso con resumirSesion real.
// Verifica que nada del robot online (espera de 15 min "Vale puede volver", una sesión = una grabación)
// retrasa ni toca una grabación presencial: iniciar → subir → finalizar → transcribir → 'lista' con
// resumen y evolución autollenada, individual y pareja, con internet y retomando sin internet.
// Correr: pnpm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { SupabaseMemoria, type Fila } from './pruebas/supabaseMemoria';
import { crearAlmacenamiento, endpointR2, OPCIONES_COMUNES } from './almacenamiento';
import { crearCifrado } from './cifrado';
import { cuerpoEnvio, procesarWebhookAssemblyAI, repoWebhookSupabase } from './assemblyai';
import { evaluarEnBase } from './consentimiento';
import { crearPipeline } from './pipeline';
import { PROMPT_VERSION_RESUMEN } from './resumen';
import type { AssemblyAI, DecisionModelo, PalabraAAI, ResultadoTranscripcion } from './tipos';
import type { ClienteMensajes } from './claude';
import { todayCL } from '../dateUtils';

// ─── src/lib/supabase.ts → base en memoria (solo en este proceso de prueba) ─────
const STUB = pathToFileURL(join(import.meta.dirname, 'pruebas', 'supabaseGlobal.ts')).href;
register(`data:text/javascript,${encodeURIComponent(`
  let stub;
  export function initialize(d) { stub = d.stub; }
  export async function resolve(spec, ctx, next) {
    const r = await next(spec, ctx);
    return /\\/src\\/lib\\/supabase\\.ts$/.test(r.url) ? { ...r, url: stub, shortCircuit: true } : r;
  }`)}`, { data: { stub: STUB } });

process.env.ADMIN_SECRET = 'secreto-admin-de-prueba-0123456789';
const SITIO = 'https://www.valentinaorellana.cl';

type Ruta = (ctx: unknown) => Promise<Response>;
let rutas: { iniciar: Ruta; subidaUrl: Ruta; finalizarPost: Ruta; finalizarGet: Ruta };
let singletons: { almacenamiento: Record<string, unknown>; assemblyai: Record<string, unknown> };
let token = '';

before(async () => {
  const ini = await import('../../pages/api/admin/transcriptor/grabacion-iniciar');
  const sub = await import('../../pages/api/admin/transcriptor/subida-url');
  const fin = await import('../../pages/api/admin/transcriptor/grabacion-finalizar');
  rutas = { iniciar: ini.POST as Ruta, subidaUrl: sub.POST as Ruta, finalizarPost: fin.POST as Ruta, finalizarGet: fin.GET as Ruta };
  const dep = await import('./dependencias-p4');
  singletons = { almacenamiento: dep.almacenamiento as never, assemblyai: dep.assemblyai as never };
  token = (await import('../adminSession')).crearTokenAdmin('passkey');
});

// ─── Dobles ──────────────────────────────────────────────────────────────────

const CUENTA = '0123456789abcdef0123456789abcdef';
const BUCKETS = { audio: 'vo-audio', transcripciones: 'vo-trans', b2: 'vo-b2' };

/** S3 falso con multiparte: las URLs PUT prefirmadas se "suben" con subirParte (sin red). */
function s3Falso() {
  const objetos = new Map<string, Uint8Array>();
  const multipartes = new Map<string, { k: string; partes: Map<number, Uint8Array> }>();
  const cliente = new S3Client({ ...OPCIONES_COMUNES, region: 'auto', endpoint: endpointR2(CUENTA, 'us'), credentials: { accessKeyId: 'AKIAPRUEBA', secretAccessKey: 'x' } });
  (cliente as unknown as { send: (c: unknown) => Promise<unknown> }).send = async (c: unknown) => {
    const cmd = (c as { constructor: { name: string } }).constructor.name;
    const input = (c as { input: Record<string, any> }).input;
    const k = `${input.Bucket}/${input.Key}`;
    const no = (name = 'NotFound') => Object.assign(new Error('no existe'), { name, $metadata: { httpStatusCode: 404 } });
    switch (cmd) {
      case 'PutObjectCommand': objetos.set(k, new Uint8Array(input.Body as Uint8Array)); return {};
      case 'GetObjectCommand': { const v = objetos.get(k); if (!v) throw no(); return { Body: { transformToByteArray: async () => v } }; }
      case 'HeadObjectCommand': { const v = objetos.get(k); if (!v) throw no(); return { ContentLength: v.length }; }
      case 'DeleteObjectCommand': objetos.delete(k); return {};
      case 'CreateMultipartUploadCommand': { const id = `up_${randomUUID()}`; multipartes.set(id, { k, partes: new Map() }); return { UploadId: id }; }
      case 'CompleteMultipartUploadCommand': {
        const m = multipartes.get(input.UploadId);
        if (!m || m.k !== k) throw no('NoSuchUpload');
        const lista = (input.MultipartUpload.Parts as { PartNumber: number; ETag: string }[]).map((p) => {
          const d = m.partes.get(p.PartNumber);
          if (!d || p.ETag !== `"etag-${p.PartNumber}"`) throw new Error('parte inválida');
          return d;
        });
        objetos.set(k, Buffer.concat(lista));
        multipartes.delete(input.UploadId);
        return {};
      }
      default: throw new Error(`comando no simulado: ${cmd}`);
    }
  };
  /** Lo que hace el navegador con la URL prefirmada (PUT): guarda la parte y devuelve el ETag. */
  function subirParte(url: string, datos: Uint8Array): string {
    const u = new URL(url);
    assert.match(u.search, /X-Amz-Signature=/);
    const m = multipartes.get(u.searchParams.get('uploadId') ?? '');
    const n = Number(u.searchParams.get('partNumber'));
    if (!m) throw new Error('subida inexistente');
    m.partes.set(n, datos);
    return `"etag-${n}"`;
  }
  return { cliente, objetos, subirParte };
}

class AAIFalso implements AssemblyAI {
  t = new Map<string, ResultadoTranscripcion>();
  envios: { id: string; decision: DecisionModelo }[] = [];
  borrados: string[] = [];
  caido = false;
  private n = 0;
  async enviar({ audioUrl, decision }: Parameters<AssemblyAI['enviar']>[0]) {
    if (this.caido) throw new Error('AssemblyAI no responde');
    assert.match(audioUrl, /^https:\/\/.*X-Amz-Signature=/);
    const id = `tr_${++this.n}`;
    this.envios.push({ id, decision });
    this.t.set(id, { id, status: 'processing' });
    return { id };
  }
  async obtener(id: string) { const r = this.t.get(id); if (!r) throw new Error('no existe'); return structuredClone(r); }
  async borrar(id: string) { this.borrados.push(id); this.t.delete(id); }
  completar(id: string, words: PalabraAAI[]) { this.t.set(id, { id, status: 'completed', audio_duration: Math.ceil((words.at(-1)?.end ?? 0) / 1000), words }); }
}

const SECRETO_WEBHOOK = 'secreto-webhook-de-prueba';
const RESUMEN = `## Resumen automático (IA)

### Puntos más importantes
- Se conversó sobre la semana y el trabajo.

### Tareas
- Registrar momentos de calma.

### Para trabajar en la próxima sesión
- Cómo resultó el registro.`;

function claudeFalso() {
  const llamadas: unknown[] = [];
  const cliente: ClienteMensajes = {
    messages: {
      stream(params) {
        llamadas.push(params);
        return {
          async finalMessage() {
            return {
              id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
              content: [{ type: 'text', text: RESUMEN, citations: null }],
              usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            } as never;
          },
        };
      },
    },
  };
  return { cliente, llamadas };
}

const palabras = (texto: string, desde = 0, speaker = 'A'): PalabraAAI[] =>
  texto.split(' ').map((w, i) => ({ text: w, start: desde + i * 400, end: desde + i * 400 + 300, confidence: 0.9, speaker }));

// ─── Escenario ───────────────────────────────────────────────────────────────

function escenario() {
  const db = new SupabaseMemoria();
  (globalThis as { __voSupabasePrueba?: unknown }).__voSupabasePrueba = db.cliente;
  const r2 = s3Falso(), b2 = s3Falso();
  const KEK = new Uint8Array(randomBytes(32));
  const cifrado = crearCifrado({ activa: 1, obtener: (v) => (v === 1 ? KEK : undefined) });
  const almacenamiento = crearAlmacenamiento({ r2: r2.cliente, b2: b2.cliente, buckets: BUCKETS, cifrado });
  const aai = new AAIFalso();
  const claude = claudeFalso();
  // Las rutas usan las instancias únicas (dependencias-p4): se les ponen los mismos dobles que al pipeline.
  Object.assign(singletons.almacenamiento, almacenamiento);
  Object.assign(singletons.assemblyai, { enviar: aai.enviar.bind(aai), obtener: aai.obtener.bind(aai), borrar: aai.borrar.bind(aai) });
  const alertas: unknown[] = [];
  // El robot no debe intervenir en lo presencial: cualquier llamada al bot falla la prueba.
  const botProhibido = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : () => { throw new Error(`el pipeline llamó al bot (${String(k)}) con una sesión presencial`); }) });
  const pipeline = crearPipeline({
    db: db.cliente, almacenamiento, aai, bot: botProhibido as never, claude: claude.cliente, cifrado,
    puedeGrabar: (p, tipo) => evaluarEnBase(p, tipo, db.cliente),
    alertas: { registrarAlerta: async (a) => { alertas.push(a); }, resolverAlertasDe: async () => {} },
  });
  db.tabla('settings').push(
    { key: 'transcriptor_activo', value: 'true' }, { key: 'transcriptor_bot_activo', value: 'true' },
    { key: 'transcriptor_resumen_modo', value: 'directo' },
  );
  const hoy = todayCL();
  const paciente = (name: string, email: string) => { const id = randomUUID(); db.tabla('patients').push({ id, name, email, active: true, birthdate: '1990-05-05' }); return id; };
  const firma = (patient_id: string, signer_name: string, signer_rut: string) =>
    db.tabla('consents').push({ id: randomUUID(), patient_id, version: '2026-11-v3', signed_at: '2026-10-10T12:00:00Z', signer_name, signer_rut, signer_email: null, accept_recording: true, revoked_at: null });
  const reserva = (email: string, name: string, session_type: string) => {
    const id = randomUUID();
    db.tabla('bookings').push({ id, patient_name: name, patient_email: email, session_type, session_date: hoy, session_time: '10:00', duration_min: 50, status: 'confirmed' });
    return id;
  };

  const ctx = (ruta: string, body?: unknown) => {
    const url = new URL(`${SITIO}${ruta}`);
    return {
      url, clientAddress: '127.0.0.1',
      cookies: { get: (n: string) => (n === 'vo_admin_token' ? { value: token } : undefined) },
      request: new Request(url, body === undefined ? { method: 'GET' } : {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Origin: SITIO, 'X-Panel': '1' },
      }),
    };
  };
  const post = async (r: Ruta, ruta: string, body: unknown) => { const res = await r(ctx(ruta, body)); return { status: res.status, data: await res.json() as Record<string, any> }; };
  const iniciar = (body: Record<string, unknown>) => post(rutas.iniciar, '/api/admin/transcriptor/grabacion-iniciar', body);
  const estado = async (id: string) => (await rutas.finalizarGet(ctx(`/api/admin/transcriptor/grabacion-finalizar?id=${id}`))).json() as Promise<Record<string, any>>;

  /** Lo que hace subirUna() del Grabador: subida-url por segmento, PUT de cada parte y finalizar. */
  async function subirYFinalizar(gid: string, segs: { seq: number; audio: Uint8Array; offsetMs: number; durMs: number }[], extra: Record<string, unknown> = {}) {
    const declarados = [];
    for (const s of segs) {
      const sha = createHash('sha256').update(s.audio).digest('hex');
      const r = await post(rutas.subidaUrl, '/api/admin/transcriptor/subida-url', {
        grabacion_id: gid, seq: s.seq, mime: 'audio/mp4', bytes: s.audio.length, partes: [1], upload_id: null, reiniciar: false,
        offset_ms: s.offsetMs, duracion_ms: s.durMs, inicio_at: new Date(Date.now() - 50 * 60_000).toISOString(),
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.ok(r.data.ok && r.data.upload_id && r.data.urls?.[1], 'subida-url entrega upload_id y la URL de la parte');
      const etag = r2.subirParte(r.data.urls[1], s.audio);
      declarados.push({ seq: s.seq, upload_id: r.data.upload_id, bytes: s.audio.length, sha256: sha, partes: [{ n: 1, etag }], offset_ms: s.offsetMs, duracion_ms: s.durMs });
    }
    return post(rutas.finalizarPost, '/api/admin/transcriptor/grabacion-finalizar', {
      grabacion_id: gid, lugar_con_ruido: false, inicio_at: new Date(Date.now() - 50 * 60_000).toISOString(), fin_at: new Date().toISOString(),
      duracion_seg: Math.round(segs.reduce((a, s) => a + s.durMs, 0) / 1000), pausas: [], segmentos: declarados, ...extra,
    });
  }

  const grab = (id: string) => db.tabla('grabaciones').find((g) => g.id === id) as Fila;
  const segs = (id: string) => db.tabla('grabacion_segmentos').filter((s) => s.grabacion_id === id).sort((a, b) => a.seq - b.seq);
  const correr = async () => { const r = await pipeline.correr(new Date()); assert.deepEqual(r.errores, []); return r; };
  const webhook = (id: string) => procesarWebhookAssemblyAI(
    { cabecera: SECRETO_WEBHOOK, cuerpo: JSON.stringify({ transcript_id: id, status: 'completed' }), secreto: SECRETO_WEBHOOK },
    { repo: repoWebhookSupabase(db.cliente), aai },
  );
  const audiosEnR2 = () => [...r2.objetos.keys()].filter((k) => k.startsWith(`${BUCKETS.audio}/`)).length;
  return { db, r2, aai, claude, alertas, hoy, paciente, firma, reserva, iniciar, estado, subirYFinalizar, grab, segs, correr, webhook, audiosEnR2, cifrado };
}

// ─── Pruebas ─────────────────────────────────────────────────────────────────

test('presencial individual por las rutas reales: iniciar → subir → finalizar envía YA a AssemblyAI → lista con resumen y evolución', async () => {
  const e = escenario();
  const p = e.paciente('Camila Rojas', 'camila@ejemplo.cl');
  e.firma(p, 'Camila Rojas', '12.345.678-5');
  const bookingId = e.reserva('camila@ejemplo.cl', 'Camila Rojas', 'presencial');

  const ini = await e.iniciar({ booking_id: bookingId, patient_id: p, tipo: 'individual', lugar_con_ruido: false });
  assert.equal(ini.status, 200, JSON.stringify(ini.data));
  assert.deepEqual([ini.data.ok, ini.data.tipo, ini.data.modelo, ini.data.diarizacion], [true, 'individual', 'universal-2', true]);
  const gid = ini.data.grabacion_id as string;
  assert.deepEqual([e.grab(gid).estado, e.grab(gid).origen, e.grab(gid).booking_id], ['creada', 'presencial', bookingId]);

  // Mismo dispositivo vuelve a preparar (reutilizar = su id): misma fila. Otro dispositivo (sin reutilizar): otra.
  const misma = await e.iniciar({ booking_id: bookingId, patient_id: p, tipo: 'individual', reutilizar: gid });
  assert.equal(misma.data.grabacion_id, gid);
  const otra = await e.iniciar({ booking_id: bookingId, patient_id: p, tipo: 'individual' });
  assert.notEqual(otra.data.grabacion_id, gid);

  // Un cron mientras la sesión se graba sin internet (fila 'creada'): no toca nada ni llama al robot.
  await e.correr();
  assert.equal(e.grab(gid).estado, 'creada');

  const fin = await e.subirYFinalizar(gid, [{ seq: 0, audio: new Uint8Array(randomBytes(3000)), offsetMs: 0, durMs: 50 * 60_000 }]);
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  // Se envió a AssemblyAI en la misma respuesta (sin esperar 15 min ni al cron).
  assert.deepEqual([fin.data.ok, fin.data.estado], [true, 'transcribiendo']);
  assert.equal(e.aai.envios.length, 1);
  const d = e.aai.envios[0].decision;
  assert.deepEqual([d.modelo, d.diarizacion, d.hablantesEsperados], ['universal-2', true, 2]);
  const cuerpo = cuerpoEnvio('https://r2.ejemplo/a.m4a', d, { url: 'https://www.valentinaorellana.cl/api/transcriptor/webhook', secreto: 's' });
  assert.deepEqual([cuerpo.speaker_labels, cuerpo.speakers_expected], [true, 2], 'presencial individual: speaker_labels con 2 voces');
  assert.equal((await e.estado(gid)).estado, 'transcribiendo');

  const tr = e.segs(gid)[0].aai_transcript_id as string;
  e.aai.completar(tr, palabras('hola cómo has estado esta semana bien gracias trabajé mucho'));
  assert.equal((await e.webhook(tr)).efecto, 'completado');
  await e.correr();

  const g = e.grab(gid);
  assert.equal(g.estado, 'lista');
  const r = e.db.tabla('resumenes_ia').find((x) => x.grabacion_id === gid)!;
  assert.deepEqual([r.estado, r.plantilla, r.prompt_version], ['listo', 'individual', PROMPT_VERSION_RESUMEN]);
  const est = await e.estado(gid);
  assert.deepEqual([est.estado, est.resumen], ['lista', true], 'el grabador muestra "Resumen listo"');
  // Evolución autollenada en la sesión de la reserva.
  const notas = e.db.tabla('session_notes').filter((n) => n.patient_id === p);
  assert.equal(notas.length, 1);
  assert.deepEqual([notas[0].booking_id, notas[0].session_date, notas[0].session_type], [bookingId, e.hoy, 'presencial']);
  assert.match(String(notas[0].content), /Registrar momentos de calma/);
  // Audio borrado en R2 y transcript borrado en AssemblyAI; sin avisos.
  assert.equal(e.audiosEnR2(), 0);
  assert.deepEqual(e.aai.borrados, [tr]);
  assert.deepEqual(e.alertas, []);
});

test('presencial pareja, retomada sin internet (2 segmentos misma grabación) y AssemblyAI caído al finalizar → el cron envía en la PRIMERA corrida → lista', async () => {
  const e = escenario();
  const p = e.paciente('Ana y Luis', 'pareja@ejemplo.cl');
  e.firma(p, 'Ana Pérez', '11.111.111-1');
  e.firma(p, 'Luis Soto', '9.876.543-2');
  const bookingId = e.reserva('pareja@ejemplo.cl', 'Ana y Luis', 'pareja-presencial');

  const ini = await e.iniciar({ booking_id: bookingId, patient_id: p, tipo: 'individual' }); // la reserva manda: pareja
  assert.equal(ini.status, 200, JSON.stringify(ini.data));
  assert.deepEqual([ini.data.tipo, ini.data.modelo, ini.data.diarizacion], ['pareja', 'universal-3-5-pro', true]);
  const gid = ini.data.grabacion_id as string;

  // Seg 0 antes de que iOS descartara la pestaña; seg 1 retomado en /grabar-sin-internet (mismo gid, seq que sigue).
  e.aai.caido = true;
  const fin = await e.subirYFinalizar(gid, [
    { seq: 0, audio: new Uint8Array(randomBytes(2000)), offsetMs: 0, durMs: 20 * 60_000 },
    { seq: 1, audio: new Uint8Array(randomBytes(2500)), offsetMs: 22 * 60_000, durMs: 25 * 60_000 },
  ]);
  assert.deepEqual([fin.status, fin.data.ok, fin.data.estado], [200, true, 'subida']);
  assert.equal(e.grab(gid).estado, 'subida');

  // Reintento del teléfono (respuesta perdida): idempotente, no borra nada.
  const rep = await e.subirYFinalizar(gid, [], {});
  assert.deepEqual([rep.data.ok, rep.data.estado], [true, 'subida']);

  e.aai.caido = false;
  await e.correr(); // misma hora: nada de esperas de 15 min
  assert.equal(e.grab(gid).estado, 'transcribiendo');
  assert.equal(e.aai.envios.length, 2);
  for (const x of e.aai.envios) {
    assert.deepEqual([x.decision.modelo, x.decision.diarizacion, x.decision.hablantesEsperados], ['universal-3-5-pro', true, 3]);
  }
  const [t0, t1] = e.segs(gid).map((s) => s.aai_transcript_id as string);
  e.aai.completar(t0, palabras('bueno partamos por lo que pasó el fin de semana', 0, 'A'));
  e.aai.completar(t1, palabras('y entonces le dije que necesitaba tiempo', 0, 'B'));
  await e.webhook(t0); await e.webhook(t1);
  await e.correr();

  assert.equal(e.grab(gid).estado, 'lista');
  assert.equal(e.db.tabla('resumenes_ia').find((x) => x.grabacion_id === gid)!.plantilla, 'pareja');
  assert.deepEqual((await e.estado(gid)).resumen, true);
  const notas = e.db.tabla('session_notes').filter((n) => n.patient_id === p);
  assert.deepEqual(notas.map((n) => [n.booking_id, n.session_type]), [[bookingId, 'pareja-presencial']]);
  assert.equal(e.audiosEnR2(), 0);
  assert.deepEqual(e.alertas, []);
});

test('presencial sin reserva (botón de la ficha) → evolución por fecha; sin voz → "lista" sin resumen y aviso SOLO en el panel', async () => {
  const e = escenario();
  const p = e.paciente('Josefa Muñoz', 'josefa@ejemplo.cl');
  e.firma(p, 'Josefa Muñoz', '13.131.313-1');
  const ini = await e.iniciar({ patient_id: p, tipo: 'individual' });
  assert.equal(ini.status, 200, JSON.stringify(ini.data));
  const gid = ini.data.grabacion_id as string;
  const fin = await e.subirYFinalizar(gid, [{ seq: 0, audio: new Uint8Array(randomBytes(1500)), offsetMs: 0, durMs: 45 * 60_000 }]);
  assert.equal(fin.data.estado, 'transcribiendo');
  const tr = e.segs(gid)[0].aai_transcript_id as string;
  e.aai.completar(tr, []);
  await e.webhook(tr);
  await e.correr();
  assert.equal(e.grab(gid).estado, 'lista');
  assert.equal((await e.estado(gid)).resumen, false, 'el grabador dice "Sin resumen: no se reconoció voz"');
  const avisos = e.alertas as { clave: string; accion: string }[];
  assert.deepEqual(avisos.map((a) => [a.clave, a.accion]), [[`sin-voz:${gid}`, 'ninguna']]);
  assert.equal(e.db.tabla('session_notes').length, 0, 'sin resumen no hay evolución');

  // Con voz, sin reserva: la evolución va a la fecha de la grabación (booking_id null).
  const ini2 = await e.iniciar({ patient_id: p, tipo: 'individual', nueva: true });
  const gid2 = ini2.data.grabacion_id as string;
  await e.subirYFinalizar(gid2, [{ seq: 0, audio: new Uint8Array(randomBytes(1500)), offsetMs: 0, durMs: 45 * 60_000 }]);
  const tr2 = e.segs(gid2)[0].aai_transcript_id as string;
  e.aai.completar(tr2, palabras('hoy quiero hablar de lo que pasó con mi mamá'));
  await e.webhook(tr2);
  await e.correr();
  assert.equal(e.grab(gid2).estado, 'lista');
  const notas = e.db.tabla('session_notes').filter((n) => n.patient_id === p);
  assert.deepEqual(notas.map((n) => [n.booking_id, n.session_date]), [[null, e.hoy]]);
});
