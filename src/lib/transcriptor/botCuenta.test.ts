// Pruebas del robot con cuenta propia (botCuenta.ts): filtro de la sesión, cifrado, candado,
// renovación y subida inicial. Sin red. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aprovisionamientoValido, cifrarSesion, correoRobotValido, cuentaRobotVigente, descifrarSesion, filtrarEstadoSesion,
  guardarSesionRenovada, leerModoBot, liberarSesion, marcarSesionVencida, normalizarModoBot, procesarSesionInicial,
  tomarSesion, venceUsoSesion, TABLA_SESION_BOT, type EstadoSesion,
} from './botCuenta';

const SECRETO = 's'.repeat(32);
const CORREO = 'notas.valentinaorellana@gmail.com';
const G1 = '3f2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b';
const G2 = '4a2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b';
const AHORA = new Date('2026-10-16T22:00:00.000Z');

const cookie = (name: string, domain = '.google.com') => ({ name, value: `v-${name}`, domain, path: '/', expires: 2_000_000_000, httpOnly: true, secure: true, sameSite: 'Lax' });
const ESTADO = {
  cookies: [cookie('SID'), cookie('__Secure-1PSID'), cookie('NID', '.google.com'), cookie('ajeno', '.evil.com'), cookie('YSC', '.youtube.com')],
  origins: [
    { origin: 'https://meet.google.com', localStorage: [{ name: 'k', value: 'v' }] },
    { origin: 'https://evil.com', localStorage: [{ name: 'x', value: 'y' }] },
  ],
};

// ─── Base falsa mínima ───────────────────────────────────────────────────────
type Fila = Record<string, unknown>;
class Base {
  tablas: Record<string, Fila[]> = { settings: [], [TABLA_SESION_BOT]: [], transcriptor_auditoria: [] };
  from(t: string) { return new Q(this, t); }
}
class Q implements PromiseLike<{ data: unknown; error: null }> {
  private f: ((x: Fila) => boolean)[] = [];
  private op: 'select' | 'update' | 'insert' | 'upsert' = 'select';
  private v: Fila = {};
  private una = false;
  constructor(private db: Base, private t: string) {}
  select() { return this; }
  update(v: Fila) { this.op = 'update'; this.v = v; return this; }
  insert(v: Fila) { this.op = 'insert'; this.v = v; return this; }
  upsert(v: Fila) { this.op = 'upsert'; this.v = v; return this; }
  eq(k: string, val: unknown) { this.f.push((x) => x[k] === val); return this; }
  maybeSingle() { this.una = true; return this; }
  then<A, B>(ok?: ((r: { data: unknown; error: null }) => A | PromiseLike<A>) | null, mal?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, mal);
  }
  private run(): { data: unknown; error: null } {
    const filas = this.db.tablas[this.t] ??= [];
    if (this.op === 'insert') { filas.push({ ...this.v }); return { data: null, error: null }; }
    if (this.op === 'upsert') {
      const previa = filas.find((x) => x.id === this.v.id);
      if (previa) Object.assign(previa, this.v); else filas.push({ ...this.v });
      return { data: null, error: null };
    }
    const c = filas.filter((x) => this.f.every((g) => g(x)));
    if (this.op === 'update') c.forEach((x) => Object.assign(x, this.v));
    return { data: this.una ? (c[0] ?? null) : c, error: null };
  }
}
function conSesion(extra: Fila = {}) {
  const db = new Base();
  db.tablas[TABLA_SESION_BOT].push({
    id: 1, cuenta_email: CORREO, sesion_cifrada: cifrarSesion(filtrarEstadoSesion(ESTADO)!, CORREO, SECRETO),
    estado: 'vigente', version: 3, en_uso_por: null, en_uso_hasta: null, ...extra,
  });
  return { db, fila: () => db.tablas[TABLA_SESION_BOT][0] };
}

// ─── Puras ───────────────────────────────────────────────────────────────────

test('modo y correo: invitado por defecto; correos válidos en minúsculas', () => {
  assert.equal(normalizarModoBot(undefined), 'invitado');
  assert.equal(normalizarModoBot('CUENTA'), 'invitado');
  assert.equal(normalizarModoBot('cuenta'), 'cuenta');
  assert.equal(correoRobotValido(' Notas.ValentinaOrellana@Gmail.com '), CORREO);
  assert.equal(correoRobotValido('sin-arroba'), null);
  assert.equal(correoRobotValido(42), null);
});

test('filtro: deja solo google.com y exige una sesión iniciada', () => {
  const e = filtrarEstadoSesion(ESTADO)!;
  assert.deepEqual(e.cookies.map((c) => c.name), ['SID', '__Secure-1PSID', 'NID']);
  assert.deepEqual(e.origins.map((o) => o.origin), ['https://meet.google.com']);
  assert.equal(filtrarEstadoSesion({ cookies: [cookie('NID')], origins: [] }), null); // sin SID
  assert.equal(filtrarEstadoSesion({ cookies: [cookie('SID', '.evil.com')], origins: [] }), null);
  assert.equal(filtrarEstadoSesion({ cookies: 'x' }), null);
  assert.equal(filtrarEstadoSesion(null), null);
  const enorme = { cookies: [cookie('SID'), ...Array.from({ length: 60 }, (_, i) => ({ ...cookie(`c${i}`), value: 'x'.repeat(8000) }))], origins: [] };
  assert.equal(filtrarEstadoSesion(enorme), null); // > 400 KB
});

test('cifrado: ida y vuelta; otra cuenta, otro secreto o un byte cambiado fallan; no contiene las cookies', () => {
  const e = filtrarEstadoSesion(ESTADO)!;
  const c = cifrarSesion(e, CORREO, SECRETO);
  assert.match(c, /^VOS1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.ok(!c.includes('v-SID'));
  assert.deepEqual(descifrarSesion(c, CORREO, SECRETO), e);
  assert.notEqual(cifrarSesion(e, CORREO, SECRETO), c); // iv aleatorio
  assert.throws(() => descifrarSesion(c, 'otra@gmail.com', SECRETO));
  assert.throws(() => descifrarSesion(c, CORREO, 'x'.repeat(32)));
  const partes = c.split('.');
  const ct = Buffer.from(partes[2], 'base64url'); ct[0] ^= 1;
  assert.throws(() => descifrarSesion(`${partes[0]}.${partes[1]}.${ct.toString('base64url')}`, CORREO, SECRETO));
  assert.throws(() => cifrarSesion(e, CORREO, 'corto'), /BOT_TOKEN_SECRET/);
});

test('aprovisionamiento: solo el Bearer exacto y un secreto de 32+ caracteres', () => {
  const s = 'a'.repeat(40);
  assert.ok(aprovisionamientoValido(`Bearer ${s}`, s));
  assert.ok(!aprovisionamientoValido(`Bearer ${s}x`, s));
  assert.ok(!aprovisionamientoValido(s, s));
  assert.ok(!aprovisionamientoValido(null, s));
  assert.ok(!aprovisionamientoValido('Bearer corto', 'corto'));
  assert.ok(!aprovisionamientoValido(`Bearer ${s}`, undefined));
});

test('candado: vence 45 min después del fin previsto (o en 3 h sin hora de fin)', () => {
  assert.equal(venceUsoSesion(AHORA, '2026-10-16T23:00:00.000Z').toISOString(), '2026-10-16T23:45:00.000Z');
  assert.equal(venceUsoSesion(AHORA, null).toISOString(), '2026-10-17T01:00:00.000Z');
  assert.ok(venceUsoSesion(AHORA, '2020-01-01T00:00:00.000Z').getTime() > AHORA.getTime()); // nunca en el pasado
});

// ─── Con base ────────────────────────────────────────────────────────────────

test('leerModoBot y cuentaRobotVigente', async () => {
  const { db, fila } = conSesion();
  assert.equal(await leerModoBot(db as never), 'invitado');
  db.tablas.settings.push({ key: 'transcriptor_bot_modo', value: 'cuenta' });
  assert.equal(await leerModoBot(db as never), 'cuenta');
  assert.equal(await cuentaRobotVigente(db as never), CORREO);
  fila().estado = 'vencida';
  assert.equal(await cuentaRobotVigente(db as never), null);
  assert.equal(await cuentaRobotVigente(new Base() as never), null);
});

test('tomar: entrega la sesión a UNA grabación; otra espera; vencido el candado se puede tomar', async () => {
  const { db, fila } = conSesion();
  const r = await tomarSesion(db as never, G1, AHORA, SECRETO, '2026-10-16T23:00:00.000Z');
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.correo, CORREO); assert.ok(r.estado.cookies.some((c) => c.name === 'SID')); }
  assert.equal(fila().en_uso_por, G1);
  assert.equal(fila().version, 4);
  assert.deepEqual(await tomarSesion(db as never, G2, AHORA, SECRETO), { ok: false, motivo: 'ocupada' });
  assert.ok((await tomarSesion(db as never, G1, AHORA, SECRETO)).ok); // el mismo bot reintenta
  assert.ok((await tomarSesion(db as never, G2, new Date('2026-10-17T02:00:00.000Z'), SECRETO)).ok); // candado vencido
});

test('tomar: sin sesión, vencida o dañada → no entrega (y la dañada queda vencida)', async () => {
  assert.deepEqual(await tomarSesion(new Base() as never, G1, AHORA, SECRETO), { ok: false, motivo: 'sin_sesion' });
  const v = conSesion({ estado: 'vencida' });
  assert.deepEqual(await tomarSesion(v.db as never, G1, AHORA, SECRETO), { ok: false, motivo: 'sin_sesion' });
  const d = conSesion({ sesion_cifrada: 'VOS1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.deepEqual(await tomarSesion(d.db as never, G1, AHORA, SECRETO), { ok: false, motivo: 'dañada' });
  assert.equal(d.fila().estado, 'vencida');
  assert.equal(d.fila().en_uso_por, null);
});

test('renovar: solo quien la tiene tomada; queda cifrada, vigente y libre', async () => {
  const { db, fila } = conSesion();
  await tomarSesion(db as never, G1, AHORA, SECRETO);
  const nueva = { ...ESTADO, cookies: [...ESTADO.cookies, cookie('__Secure-3PSID')] };
  assert.equal(await guardarSesionRenovada(db as never, G2, nueva, AHORA, SECRETO), false);
  assert.equal(await guardarSesionRenovada(db as never, G1, { cookies: [] }, AHORA, SECRETO), false);
  assert.equal(await guardarSesionRenovada(db as never, G1, nueva, AHORA, SECRETO), true);
  assert.equal(fila().en_uso_por, null);
  assert.equal(fila().estado, 'vigente');
  assert.ok(!String(fila().sesion_cifrada).includes('v-SID'));
  const e: EstadoSesion = descifrarSesion(String(fila().sesion_cifrada), CORREO, SECRETO);
  assert.ok(e.cookies.some((c) => c.name === '__Secure-3PSID'));
});

test('liberar y marcar vencida: solo afectan a la grabación que la tiene', async () => {
  const { db, fila } = conSesion();
  await tomarSesion(db as never, G1, AHORA, SECRETO);
  await liberarSesion(db as never, G2);
  assert.equal(fila().en_uso_por, G1);
  await marcarSesionVencida(db as never, G2, 'x');
  assert.equal(fila().estado, 'vigente');
  await marcarSesionVencida(db as never, G1, 'Meet pidió iniciar sesión');
  assert.equal(fila().estado, 'vencida');
  assert.equal(fila().en_uso_por, null);
});

test('sesión inicial: exige el secreto, guarda cifrado y no devuelve datos', async () => {
  const db = new Base();
  const aprov = 'p'.repeat(40);
  const deps = { db: db as never, secretoBot: SECRETO, secretoAprovisionar: aprov, ahora: () => AHORA };
  const cuerpo = JSON.stringify({ tipo: 'sesion_inicial', correo: CORREO, sesion: ESTADO });
  assert.equal((await procesarSesionInicial({ authorization: `Bearer ${'q'.repeat(40)}`, cuerpoTexto: cuerpo }, deps)).status, 404);
  assert.equal((await procesarSesionInicial({ authorization: `Bearer ${aprov}`, cuerpoTexto: cuerpo }, { ...deps, secretoAprovisionar: undefined })).status, 404);
  assert.equal((await procesarSesionInicial({ authorization: `Bearer ${aprov}`, cuerpoTexto: '{x' }, deps)).status, 400);
  assert.equal((await procesarSesionInicial({ authorization: `Bearer ${aprov}`, cuerpoTexto: JSON.stringify({ tipo: 'sesion_inicial', correo: CORREO, sesion: { cookies: [], origins: [] } }) }, deps)).status, 400);
  const r = await procesarSesionInicial({ authorization: `Bearer ${aprov}`, cuerpoTexto: cuerpo }, deps);
  assert.deepEqual(r, { status: 200, cuerpo: { ok: true } });
  const f = db.tablas[TABLA_SESION_BOT][0];
  assert.equal(f.cuenta_email, CORREO);
  assert.equal(f.estado, 'vigente');
  assert.ok(!JSON.stringify(db.tablas).includes('v-SID')); // ni en la tabla ni en la bitácora
  assert.equal(await cuentaRobotVigente(db as never), CORREO);
});
