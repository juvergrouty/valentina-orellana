// Pruebas del lado del sitio del bot (token, parser de eventos, calendario, máquina de Fly,
// y el endpoint con una base y almacenamiento falsos). Sin red. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correosInvitados, crearBot, cuerpoMaquina, eventoUtil, extraerBearer, generarTokenBot, hmacTokenBot, idEventoBot,
  maxHumanosPorTipo, meetUrlDesdeEvento, meetUrlDesdeNotas, normalizarMeetUrl, notaFinBot, parsearEventoBot,
  payloadSeguro, procesarEventoBot, sanearErrorBot, tokenVigente, uuidDesdeEventId, venceTokenBot, VIGENCIA_TOKEN_TRAS_FIN_MS,
  MAX_BYTES_SEGMENTO_BOT,
  type EventoCalendario,
} from './bot';
import { BOT_NOMBRE, type Grabacion } from './tipos';

const SECRETO = 's'.repeat(32);
const GID = '3f2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b';

// ─── Token ──────────────────────────────────────────────────────────────────

test('token: 43 caracteres base64url, distinto cada vez', () => {
  const a = generarTokenBot(), b = generarTokenBot();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('token: el HMAC es determinístico, depende del secreto y no contiene el token', () => {
  const t = generarTokenBot();
  const h = hmacTokenBot(t, SECRETO);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hmacTokenBot(t, SECRETO));
  assert.notEqual(h, hmacTokenBot(t, 'x'.repeat(32)));
  assert.ok(!h.includes(t));
  assert.throws(() => hmacTokenBot(t, 'corto'), /BOT_TOKEN_SECRET/);
  assert.throws(() => hmacTokenBot(t, ''), /BOT_TOKEN_SECRET/);
});

test('token: vence al terminar la sesión + 2 h; revocado = vencido', () => {
  const fin = '2026-10-16T20:00:00.000Z';
  const vence = venceTokenBot(fin);
  assert.equal(vence.getTime() - Date.parse(fin), VIGENCIA_TOKEN_TRAS_FIN_MS);
  assert.equal(vence.toISOString(), '2026-10-16T22:00:00.000Z');
  assert.ok(tokenVigente(vence.toISOString(), new Date('2026-10-16T21:59:59Z')));
  assert.ok(!tokenVigente(vence.toISOString(), new Date('2026-10-16T22:00:00Z')));
  assert.ok(!tokenVigente(null));
  assert.ok(!tokenVigente('basura'));
  assert.throws(() => venceTokenBot('no-fecha'), /hora_fin_prevista/);
});

test('Bearer: solo acepta el formato exacto', () => {
  const t = generarTokenBot();
  assert.equal(extraerBearer(`Bearer ${t}`), t);
  assert.equal(extraerBearer(`bearer ${t}`), null);
  assert.equal(extraerBearer(`Bearer ${t}x`), null);
  assert.equal(extraerBearer('Bearer abc'), null);
  assert.equal(extraerBearer(null), null);
  assert.equal(extraerBearer(`Basic ${t}`), null);
});

// ─── Parser de eventos ──────────────────────────────────────────────────────

test('parser: eventos válidos', () => {
  assert.deepEqual(parsearEventoBot({ tipo: 'lobby' }), { ok: true, evento: { tipo: 'lobby' } });
  assert.deepEqual(parsearEventoBot({ tipo: 'activo', extra: 1 }), { ok: true, evento: { tipo: 'activo' } });
  assert.deepEqual(parsearEventoBot({ tipo: 'pide_url', seq: 3 }), { ok: true, evento: { tipo: 'pide_url', seq: 3 } });
  assert.deepEqual(
    parsearEventoBot({ tipo: 'segmento_subido', seq: 0, bytes: 123, offset_ms: 0, duracion_ms: 900_000 }),
    { ok: true, evento: { tipo: 'segmento_subido', seq: 0, bytes: 123, offset_ms: 0, duracion_ms: 900_000 } },
  );
  const fin = parsearEventoBot({ tipo: 'fin', motivo: 'vale_salio', linea_hablantes: [{ t_ms: 10, nombre: ' Camila ', on: true }] });
  assert.deepEqual(fin, { ok: true, evento: { tipo: 'fin', motivo: 'vale_salio', linea_hablantes: [{ t_ms: 10, nombre: 'Camila', on: true }] } });
  assert.deepEqual(parsearEventoBot({ tipo: 'fin', motivo: 'solo' }), { ok: true, evento: { tipo: 'fin', motivo: 'solo', linea_hablantes: [] } });
  const err = parsearEventoBot({ tipo: 'error', detalle: 'a\nb'.padEnd(500, 'x') });
  assert.ok(err.ok && err.evento.tipo === 'error' && err.evento.detalle.length === 300 && !err.evento.detalle.includes('\n'));
});

test('parser: rechaza lo inválido', () => {
  const malos: unknown[] = [
    null, 'lobby', [], {}, { tipo: 'leer_transcripcion' },
    { tipo: 'pide_url' }, { tipo: 'pide_url', seq: -1 }, { tipo: 'pide_url', seq: 1.5 }, { tipo: 'pide_url', seq: 201 }, { tipo: 'pide_url', seq: '1' },
    { tipo: 'segmento_subido', seq: 0, bytes: 0, offset_ms: 0, duracion_ms: 1 },
    { tipo: 'segmento_subido', seq: 0, bytes: 10, offset_ms: -1, duracion_ms: 1 },
    { tipo: 'fin', motivo: 'me_aburri', linea_hablantes: [] },
    { tipo: 'fin', motivo: 'solo', linea_hablantes: [{ t_ms: -1, nombre: 'A', on: true }] },
    { tipo: 'fin', motivo: 'solo', linea_hablantes: [{ t_ms: 1, nombre: '', on: true }] },
    { tipo: 'fin', motivo: 'solo', linea_hablantes: [{ t_ms: 1, nombre: 'A'.repeat(61), on: true }] },
    { tipo: 'fin', motivo: 'solo', linea_hablantes: [{ t_ms: 1, nombre: 'A', on: 'si' }] },
    { tipo: 'fin', motivo: 'solo', linea_hablantes: 'x' },
    { tipo: 'error', detalle: 5 },
  ];
  for (const m of malos) assert.equal(parsearEventoBot(m).ok, false, JSON.stringify(m));
});

test('idempotencia: ids de evento y payload sin nombres', () => {
  assert.equal(idEventoBot(GID, { tipo: 'lobby' }), `${GID}:lobby:`);
  assert.equal(idEventoBot(GID, { tipo: 'segmento_subido', seq: 2, bytes: 1, offset_ms: 0, duracion_ms: 1 }), `${GID}:segmento_subido:2`);
  assert.equal(idEventoBot(GID, { tipo: 'pide_url', seq: 2 }), null);
  const fin = { tipo: 'fin' as const, motivo: 'solo' as const, linea_hablantes: [{ t_ms: 1, nombre: 'Camila Rojas', on: true }] };
  assert.ok(!JSON.stringify(payloadSeguro(fin)).includes('Camila'));
  assert.deepEqual(payloadSeguro(fin), { tipo: 'fin', motivo: 'solo', entradas_linea: 1 });
});

test('notas de fin', () => {
  assert.match(notaFinBot('error', 32)!, /32 min/);
  assert.match(notaFinBot('participantes_extra', 5)!, /más participantes/);
  assert.equal(notaFinBot('vale_salio', 50), null);
});

// ─── Calendario ─────────────────────────────────────────────────────────────

const EV: EventoCalendario = {
  id: '3f2b8a1e0c4d4e5f9a6b7c8d9e0f1a2b',
  status: 'confirmed',
  start: { dateTime: '2026-10-16T19:00:00-03:00' },
  end: { dateTime: '2026-10-16T19:50:00-03:00' },
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  attendees: [
    { email: 'vinculosquesostienen@gmail.com', self: true, responseStatus: 'accepted' },
    { email: 'Camila@Correo.cl', responseStatus: 'needsAction' },
    { email: 'sala@resource.calendar.google.com', resource: true },
  ],
};

test('Meet: normaliza y valida enlaces', () => {
  assert.equal(normalizarMeetUrl('https://meet.google.com/ABC-defg-hij?authuser=0'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(normalizarMeetUrl('https://meet.google.com.evil.cl/abc-defg-hij'), null);
  assert.equal(normalizarMeetUrl('http://meet.google.com/abc-defg-hij'), null);
  assert.equal(normalizarMeetUrl('https://meet.google.com/lookup/xyz'), null);
  assert.equal(meetUrlDesdeNotas('Hola\nMeet: https://meet.google.com/abc-defg-hij\nfin'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(meetUrlDesdeNotas('sin enlace'), null);
  assert.equal(meetUrlDesdeEvento({ id: 'x', conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:1' }, { entryPointType: 'video', uri: 'https://meet.google.com/aaa-bbbb-ccc' }] } }), 'https://meet.google.com/aaa-bbbb-ccc');
});

test('calendario: utilidad del evento, correos e id → uuid', () => {
  assert.ok(eventoUtil(EV));
  assert.ok(!eventoUtil({ ...EV, status: 'cancelled' }));
  assert.ok(!eventoUtil({ ...EV, hangoutLink: undefined }));
  assert.ok(!eventoUtil({ ...EV, start: { date: '2026-10-16' } }));
  assert.ok(!eventoUtil({ ...EV, attendees: [{ email: 'v@x.cl', self: true, responseStatus: 'declined' }] }));
  assert.deepEqual(correosInvitados(EV), ['camila@correo.cl']);
  assert.equal(uuidDesdeEventId(EV.id), GID);
  assert.equal(uuidDesdeEventId('cierre20261225'), null);
  assert.equal(maxHumanosPorTipo('pareja'), 3);
  assert.equal(maxHumanosPorTipo('individual'), 2);
  assert.equal(maxHumanosPorTipo('sin_tipo'), 2);
});

// ─── Máquina de Fly ─────────────────────────────────────────────────────────

const GRAB = { id: GID, meet_url: 'https://meet.google.com/abc-defg-hij', hora_fin_prevista: '2026-10-16T22:50:00.000Z', tipo: 'pareja' as const };

test('máquina: región iad, auto_destroy, sin reinicio, imagen fija y env completo', () => {
  const t = generarTokenBot();
  const c = cuerpoMaquina({ grabacion: GRAB, token: t, imagen: 'registry.fly.io/vo-bot-meet:v1', eventoUrl: 'https://www.valentinaorellana.cl/api/transcriptor/bot-evento', nombresVale: 'Valentina Orellana', sufijo: 'z' }) as {
    name: string; region: string; config: { image: string; auto_destroy: boolean; restart: { policy: string }; guest: Record<string, unknown>; env: Record<string, string> };
  };
  assert.equal(c.region, 'iad');
  assert.equal(c.name, 'bot-3f2b8a1e-z');
  assert.equal(c.config.auto_destroy, true);
  assert.deepEqual(c.config.restart, { policy: 'no' });
  assert.deepEqual(c.config.guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 });
  assert.equal(c.config.env.BOT_TOKEN, t);
  assert.equal(c.config.env.BOT_NOMBRE, BOT_NOMBRE);
  assert.equal(c.config.env.MAX_HUMANOS, '3');
  assert.equal(c.config.env.ESPERA_ADMISION_MS, String(20 * 60_000));
  assert.equal(c.config.env.HORA_FIN, '2026-10-16T22:50:00.000Z');
  // El env solo lleva lo que el bot necesita: nada de llaves de proveedores.
  assert.deepEqual(Object.keys(c.config.env).sort(), [
    'BOT_NOMBRE', 'BOT_TOKEN', 'ESPERA_ADMISION_MS', 'EVENTO_URL', 'GRABACION_ID', 'HORA_FIN', 'MAX_EXTRA_MS',
    'MAX_HUMANOS', 'MEET_URL', 'SEGMENTO_MS', 'SOLAPAMIENTO_MS', 'SOLO_MS', 'VALE_NOMBRES',
  ]);
});

test('máquina: rechaza imagen latest, enlace no-Meet y URL http', () => {
  const base = { grabacion: GRAB, token: 't', imagen: 'registry.fly.io/vo-bot-meet:v1', eventoUrl: 'https://x.cl/e', nombresVale: 'V' };
  assert.throws(() => cuerpoMaquina({ ...base, imagen: 'registry.fly.io/vo-bot-meet:latest' }), /FLY_IMAGEN/);
  assert.throws(() => cuerpoMaquina({ ...base, imagen: 'docker.io/otro:v1' }), /FLY_IMAGEN/);
  assert.throws(() => cuerpoMaquina({ ...base, grabacion: { ...GRAB, meet_url: 'https://zoom.us/j/1' } }), /Meet/);
  assert.throws(() => cuerpoMaquina({ ...base, eventoUrl: 'http://x.cl/e' }), /https/);
});

// ─── Base falsa (subconjunto del cliente de supabase-js que usa bot.ts) ──────

type Fila = Record<string, unknown>;
class BaseFalsa {
  tablas: Record<string, Fila[]> = { grabaciones: [], grabacion_segmentos: [], transcriptor_webhooks: [], transcriptor_auditoria: [], settings: [], bookings: [], patients: [] };
  from(t: string) { return new Consulta(this, t); }
}
class Consulta implements PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; count?: number }> {
  private filtros: ((f: Fila) => boolean)[] = [];
  private op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
  private valores: Fila = {};
  private unica = false;
  private cuenta = false;
  private conflicto: string[] = [];
  constructor(private db: BaseFalsa, private t: string) {}
  select(_c?: string, o?: { count?: string; head?: boolean }) { if (o?.count) this.cuenta = true; return this; }
  update(v: Fila) { this.op = 'update'; this.valores = v; return this; }
  insert(v: Fila) { this.op = 'insert'; this.valores = v; return this; }
  upsert(v: Fila, o?: { onConflict?: string }) { this.op = 'upsert'; this.valores = v; this.conflicto = (o?.onConflict ?? '').split(','); return this; }
  delete() { this.op = 'delete'; return this; }
  eq(k: string, v: unknown) { this.filtros.push((f) => f[k] === v); return this; }
  in(k: string, v: unknown[]) { this.filtros.push((f) => v.includes(f[k])); return this; }
  is(k: string, v: null) { this.filtros.push((f) => (f[k] ?? null) === v); return this; }
  not(k: string, _op: string, _v: null) { this.filtros.push((f) => f[k] != null); return this; }
  gte(k: string, v: string) { this.filtros.push((f) => String(f[k]) >= v); return this; }
  maybeSingle() { this.unica = true; return this; }
  then<A, B>(ok?: ((v: { data: unknown; error: { message: string; code?: string } | null; count?: number }) => A | PromiseLike<A>) | null, mal?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.ejecutar()).then(ok, mal);
  }
  private ejecutar() {
    const filas = this.db.tablas[this.t];
    const coincide = filas.filter((f) => this.filtros.every((g) => g(f)));
    if (this.op === 'insert') {
      if (this.t === 'grabacion_segmentos' && filas.some((f) => f.grabacion_id === this.valores.grabacion_id && f.seq === this.valores.seq)) {
        return { data: null, error: { message: 'duplicado', code: '23505' } };
      }
      filas.push({ id: `id${filas.length + 1}`, ...this.valores });
      return { data: null, error: null };
    }
    if (this.op === 'upsert') {
      const previa = filas.find((f) => this.conflicto.every((k) => f[k] === this.valores[k]));
      if (previa) Object.assign(previa, this.valores); else filas.push({ ...this.valores });
      return { data: null, error: null };
    }
    if (this.op === 'delete') { this.db.tablas[this.t] = filas.filter((f) => !coincide.includes(f)); return { data: null, error: null }; }
    if (this.op === 'update') coincide.forEach((f) => Object.assign(f, this.valores));
    if (this.cuenta) return { data: null, error: null, count: coincide.length };
    return { data: this.unica ? (coincide[0] ?? null) : coincide, error: null };
  }
}

function escenario(estado = 'bot_lanzando') {
  const db = new BaseFalsa();
  const token = generarTokenBot();
  db.tablas.grabaciones.push({
    id: GID, patient_id: 'p1', estado, inicio_at: null, origen: 'online',
    bot_token_sha256: hmacTokenBot(token, SECRETO), bot_token_vence_at: '2026-10-16T23:00:00.000Z', bot_machine_id: 'm1',
  });
  const objetos = new Map<string, number>();
  const alm = {
    urlSubida: async (key: string, ct: string, seg?: number) => `https://cuenta.r2.cloudflarestorage.com/audio/${key}?ct=${ct}&exp=${seg}`,
    head: async (_b: string, key: string) => (objetos.has(key) ? { bytes: objetos.get(key)! } : null),
  };
  const ahora = new Date('2026-10-16T22:00:00.000Z');
  const enviar = (cuerpo: unknown, tok: string | null = token) => procesarEventoBot(
    { authorization: tok === null ? null : `Bearer ${tok}`, cuerpoTexto: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), clientAddress: '1.2.3.4' },
    { db: db as never, secreto: SECRETO, almacenamiento: async () => alm as never, ahora: () => ahora },
  );
  const g = () => db.tablas.grabaciones[0];
  return { db, token, objetos, enviar, g };
}

test('endpoint: token ausente, falso o vencido → 404 genérico y queda en la bitácora', async () => {
  const s = escenario();
  assert.equal((await s.enviar({ tipo: 'lobby' }, null)).status, 404);
  assert.equal((await s.enviar({ tipo: 'lobby' }, generarTokenBot())).status, 404);
  s.g().bot_token_vence_at = '2026-10-16T21:00:00.000Z';
  const r = await s.enviar({ tipo: 'lobby' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.cuerpo, { error: 'No encontrado' });
  assert.equal(s.db.tablas.transcriptor_auditoria.filter((f) => f.resultado === 'denegado').length, 2);
  assert.equal(s.g().estado, 'bot_lanzando');
});

test('endpoint: bloquea la IP tras 10 tokens inválidos', async () => {
  const s = escenario();
  for (let i = 0; i < 10; i++) await s.enviar({ tipo: 'lobby' }, generarTokenBot());
  assert.equal((await s.enviar({ tipo: 'lobby' })).status, 404); // incluso con token válido desde esa IP
});

test('endpoint: flujo completo lobby → activo → segmentos → fin, sin devolver datos', async () => {
  const s = escenario();
  assert.deepEqual((await s.enviar({ tipo: 'lobby' })).cuerpo, { ok: true });
  assert.equal(s.g().estado, 'bot_en_lobby');
  assert.equal((await s.enviar({ tipo: 'pide_url', seq: 0 })).status, 409); // aún no graba
  await s.enviar({ tipo: 'activo' });
  assert.equal(s.g().estado, 'grabando');
  assert.equal(s.g().inicio_at, '2026-10-16T22:00:00.000Z');

  const u = await s.enviar({ tipo: 'pide_url', seq: 0 });
  assert.equal(u.status, 200);
  const url = String(u.cuerpo.url);
  assert.match(url, /^https:\/\/cuenta\.r2\.cloudflarestorage\.com\/audio\/a\/[0-9a-f-]{36}\.webm\?ct=audio\/webm&exp=900$/);
  assert.deepEqual(Object.keys(u.cuerpo).sort(), ['ok', 'url']);
  // Repetir pide_url del mismo seq reutiliza la llave (reintento del bot).
  assert.equal((await s.enviar({ tipo: 'pide_url', seq: 0 })).cuerpo.url, url);
  const key = String(s.db.tablas.grabacion_segmentos[0].r2_key);
  assert.ok(key.startsWith('a/'));

  // Tamaño que no calza con R2 → 409; calza → 200 y queda subido.
  s.objetos.set(key, 500);
  assert.equal((await s.enviar({ tipo: 'segmento_subido', seq: 0, bytes: 499, offset_ms: 0, duracion_ms: 900_000 })).status, 409);
  assert.equal((await s.enviar({ tipo: 'segmento_subido', seq: 0, bytes: 500, offset_ms: 0, duracion_ms: 900_000 })).status, 200);
  assert.equal(s.db.tablas.grabacion_segmentos[0].bytes, 500);
  assert.equal((await s.enviar({ tipo: 'pide_url', seq: 0 })).status, 409); // no se puede pisar
  await s.enviar({ tipo: 'pide_url', seq: 1 }); // pedido pero nunca confirmado

  const fin = await s.enviar({ tipo: 'fin', motivo: 'vale_salio', linea_hablantes: [{ t_ms: 0, nombre: 'Camila', on: true }, { t_ms: 5, nombre: 'Camila', on: false }] });
  assert.deepEqual(fin.cuerpo, { ok: true });
  assert.equal(s.g().estado, 'subida');
  assert.deepEqual(s.g().linea_hablantes, [{ t_ms: 0, nombre: 'Camila', on: true }, { t_ms: 5, nombre: 'Camila', on: false }]);
  assert.equal(s.db.tablas.grabacion_segmentos.length, 1); // el seq 1 sin confirmar se descartó
  // Token revocado: cualquier evento posterior → 404.
  assert.equal((await s.enviar({ tipo: 'pide_url', seq: 2 })).status, 404);
  // La bitácora de eventos no guarda nombres.
  assert.ok(!JSON.stringify(s.db.tablas.transcriptor_webhooks).includes('Camila'));
});

test('endpoint: fin sin segmentos → sin_audio; no admitido → bot_no_admitido; error antes de grabar → error', async () => {
  const a = escenario('grabando');
  await a.enviar({ tipo: 'fin', motivo: 'solo', linea_hablantes: [] });
  assert.equal(a.g().estado, 'sin_audio');

  const b = escenario('bot_en_lobby');
  await b.enviar({ tipo: 'fin', motivo: 'no_admitido', linea_hablantes: [] });
  assert.equal(b.g().estado, 'bot_no_admitido');

  const c = escenario('bot_lanzando');
  await c.enviar({ tipo: 'fin', motivo: 'error', linea_hablantes: [] });
  assert.equal(c.g().estado, 'error');
  assert.equal(c.g().estado_antes_error, 'bot_lanzando');
});

test('endpoint: eventos repetidos no repiten efectos; JSON inválido → 400', async () => {
  const s = escenario();
  await s.enviar({ tipo: 'lobby' });
  await s.enviar({ tipo: 'lobby' });
  assert.equal(s.db.tablas.transcriptor_auditoria.filter((f) => f.accion === 'bot_lobby').length, 1);
  assert.equal((await s.enviar('{no es json')).status, 400);
  assert.equal((await s.enviar({ tipo: 'leer', id: GID })).status, 400);
});

// ─── Fly (fetch falso) ──────────────────────────────────────────────────────

test('lanzarBot: guarda solo el HMAC, crea la máquina con Bearer y guarda su id', async () => {
  const db = new BaseFalsa();
  db.tablas.grabaciones.push({ id: GID, estado: 'bot_lanzando', patient_id: 'p1' });
  const llamadas: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    return new Response(JSON.stringify({ id: 'e2865013a1b2c3' }), { status: 200 });
  }) as unknown as typeof fetch;
  const bot = crearBot({
    db: db as never, fetch: f,
    env: { FLY_API_TOKEN: 'FlyV1 fm2_prueba', FLY_APP_BOT: 'vo-bot-meet', FLY_IMAGEN: 'registry.fly.io/vo-bot-meet:v1', BOT_TOKEN_SECRET: SECRETO, PUBLIC_SITE_URL: 'https://www.valentinaorellana.cl' },
  });
  const g = { ...GRAB, origen: 'online', patient_id: 'p1', estado: 'bot_lanzando' } as unknown as Grabacion;
  const r = await bot.lanzarBot(g);
  assert.deepEqual(r, { machineId: 'e2865013a1b2c3' });
  assert.equal(llamadas[0].url, 'https://api.machines.dev/v1/apps/vo-bot-meet/machines');
  assert.equal(new Headers(llamadas[0].init.headers).get('authorization'), 'Bearer FlyV1 fm2_prueba');
  const cuerpo = JSON.parse(String(llamadas[0].init.body));
  const token = cuerpo.config.env.BOT_TOKEN as string;
  const fila = db.tablas.grabaciones[0];
  assert.equal(fila.bot_token_sha256, hmacTokenBot(token, SECRETO));
  assert.ok(!JSON.stringify(fila).includes(token)); // el token en claro nunca se guarda
  assert.equal(fila.bot_token_vence_at, '2026-10-17T00:50:00.000Z');
  assert.equal(fila.bot_machine_id, 'e2865013a1b2c3');
  assert.equal(cuerpo.config.env.EVENTO_URL, 'https://www.valentinaorellana.cl/api/transcriptor/bot-evento');
  assert.equal(cuerpo.config.env.VALE_NOMBRES, 'Valentina Orellana|Vínculos que sostienen');
});

test('lanzarBot: no lanza si la grabación ya no está en bot_lanzando; revoca si Fly falla', async () => {
  const db = new BaseFalsa();
  db.tablas.grabaciones.push({ id: GID, estado: 'cancelada' });
  const env = { FLY_API_TOKEN: 't', FLY_APP_BOT: 'vo-bot-meet', FLY_IMAGEN: 'registry.fly.io/vo-bot-meet:v1', BOT_TOKEN_SECRET: SECRETO };
  let llamadas = 0;
  const f = (async () => { llamadas++; return new Response('sin capacidad', { status: 503 }); }) as unknown as typeof fetch;
  const g = { ...GRAB, origen: 'online' } as unknown as Grabacion;
  await assert.rejects(crearBot({ db: db as never, fetch: f, env }).lanzarBot(g), /bot_lanzando/);
  assert.equal(llamadas, 0);
  db.tablas.grabaciones[0].estado = 'bot_lanzando';
  await assert.rejects(crearBot({ db: db as never, fetch: f, env }).lanzarBot(g), /503/);
  assert.ok(Date.parse(String(db.tablas.grabaciones[0].bot_token_vence_at)) <= Date.now());
});

test('matarBot: DELETE con force, 404 cuenta como hecho', async () => {
  const db = new BaseFalsa();
  const urls: string[] = [];
  const f = (async (url: string) => { urls.push(url); return new Response('', { status: 404 }); }) as unknown as typeof fetch;
  await crearBot({ db: db as never, fetch: f, env: { FLY_API_TOKEN: 't', FLY_APP_BOT: 'vo-bot-meet' } }).matarBot('e2865013a1b2c3');
  assert.deepEqual(urls, ['https://api.machines.dev/v1/apps/vo-bot-meet/machines/e2865013a1b2c3?force=true']);
});

test('sesionesOnlineProximas: cruza reservas y fichas, descarta canceladas y presenciales', async () => {
  const db = new BaseFalsa();
  db.tablas.bookings.push(
    { id: GID, google_event_id: EV.id, session_type: 'pareja-online', status: 'confirmed', patient_email: 'camila@correo.cl', notes: null },
    { id: 'b2', google_event_id: 'ev2', session_type: 'online', status: 'cancelled', patient_email: 'x@x.cl', notes: null },
  );
  db.tablas.patients.push({ id: 'p1', email: 'camila@correo.cl', active: true }, { id: 'p9', email: 'enc@correo.cl', active: true });
  const items: EventoCalendario[] = [
    EV,
    { ...EV, id: 'ev2', hangoutLink: 'https://meet.google.com/zzz-zzzz-zzz' },
    { ...EV, id: 'encuadrado1', hangoutLink: 'https://meet.google.com/eee-eeee-eee', attendees: [{ email: 'enc@correo.cl' }] },
    { ...EV, id: 'fuera', start: { dateTime: '2026-10-16T23:30:00-03:00' }, end: { dateTime: '2026-10-17T00:20:00-03:00' } },
  ];
  const f = (async () => new Response(JSON.stringify({ items }), { status: 200 })) as unknown as typeof fetch;
  const bot = crearBot({ db: db as never, fetch: f, calendario: async () => ({ token: 'g', calendarId: 'primary' }) });
  const r = await bot.sesionesOnlineProximas(new Date('2026-10-16T21:55:00Z'), new Date('2026-10-16T22:05:00Z'));
  assert.deepEqual(r.map((x) => [x.googleEventId, x.bookingId, x.patientId, x.tipo, x.meetUrl]), [
    [EV.id, GID, 'p1', 'pareja', 'https://meet.google.com/abc-defg-hij'],
    ['encuadrado1', null, 'p9', 'sin_tipo', 'https://meet.google.com/eee-eeee-eee'],
  ]);
});

// ─── Revisión de seguridad 16 oct: tope por segmento (B7) y saneo de errores (B8) ───
test('endpoint: un segmento de más de 300 MB se rechaza (413) y no queda como subido', async () => {
  const s = escenario();
  await s.enviar({ tipo: 'lobby' });
  await s.enviar({ tipo: 'activo' });
  await s.enviar({ tipo: 'pide_url', seq: 0 });
  const key = String(s.db.tablas.grabacion_segmentos[0].r2_key);
  const grande = MAX_BYTES_SEGMENTO_BOT + 1;
  s.objetos.set(key, grande);
  const r = await s.enviar({ tipo: 'segmento_subido', seq: 0, bytes: grande, offset_ms: 0, duracion_ms: 900_000 });
  assert.equal(r.status, 413);
  assert.equal(s.db.tablas.grabacion_segmentos[0].subido_at ?? null, null);
  // Justo en el tope sí se acepta.
  s.objetos.set(key, MAX_BYTES_SEGMENTO_BOT);
  assert.equal((await s.enviar({ tipo: 'segmento_subido', seq: 0, bytes: MAX_BYTES_SEGMENTO_BOT, offset_ms: 0, duracion_ms: 900_000 })).status, 200);
});

test('sanearErrorBot: el error guardado no lleva el enlace ni el código de Meet', async () => {
  const m = sanearErrorBot('page.goto: Timeout at https://meet.google.com/abc-defg-hij?hl=en (meet.google.com/abc-defg-hij)\n');
  assert.ok(!m.includes('meet.google.com') && !m.includes('abc-defg-hij') && !m.includes('\n'), m);
  const s = escenario();
  await s.enviar({ tipo: 'lobby' });
  await s.enviar({ tipo: 'error', detalle: 'Falló: https://meet.google.com/xyz-abcd-efg' });
  assert.ok(!String(s.g().ultimo_error).includes('meet.google.com'));
  assert.ok(!String(s.g().ultimo_error).includes('xyz-abcd-efg'));
  assert.ok(!JSON.stringify(s.db.tablas.transcriptor_auditoria).includes('xyz-abcd-efg'));
});
