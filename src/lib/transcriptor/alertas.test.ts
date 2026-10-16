// Pruebas de alertas.ts (deduplicación, freno de correo, nunca lanza). Sin red ni base:
// repositorio en memoria que imita el índice único parcial de 0017. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armarCorreo, claveDe, crearAlertas, debeEnviarCorreo, normalizarAlerta, sanearTexto,
  FRENO_CORREO_MS, TablaAlertasFaltanteError, type AlertaAbierta, type AlertaFila, type RepoAlertas,
} from './alertas';

const GID = '11111111-2222-4333-8444-555555555555';

function repoMemoria() {
  const filas: AlertaFila[] = [];
  let n = 0;
  let fallar = false;
  const chk = () => { if (fallar) throw new Error('base caída'); };
  const repo: RepoAlertas = {
    async abiertaPorClave(clave) { chk(); return structuredClone(filas.find((f) => f.clave === clave && !f.resuelta_at) ?? null); },
    async insertar(f) {
      chk();
      if (filas.some((x) => x.clave === f.clave && !x.resuelta_at)) return { fila: null, conflicto: true };
      const fila: AlertaFila = { ...f, id: `a${++n}`, creada_at: f.ultima_vez, resuelta_at: null, resuelta_por: null, correo_enviado_at: null };
      filas.push(fila);
      return { fila: structuredClone(fila), conflicto: false };
    },
    async sumarVez(id, previas, cambios) {
      chk();
      const f = filas.find((x) => x.id === id && x.veces === previas && !x.resuelta_at);
      if (!f) return null;
      Object.assign(f, cambios, { veces: previas + 1 });
      return structuredClone(f);
    },
    async ultimoCorreo(clave) {
      chk();
      return filas.filter((f) => f.clave === clave && f.correo_enviado_at).map((f) => f.correo_enviado_at!).sort().at(-1) ?? null;
    },
    async reclamarCorreo(id, ahora, limite) {
      chk();
      const f = filas.find((x) => x.id === id);
      if (!f || (f.correo_enviado_at && f.correo_enviado_at >= limite)) return false;
      f.correo_enviado_at = ahora;
      return true;
    },
    async liberarCorreo(id, previo) { const f = filas.find((x) => x.id === id); if (f) f.correo_enviado_at = previo; },
    async obtener(id) { chk(); return structuredClone(filas.find((f) => f.id === id) ?? null); },
    async listarAbiertas(lim) { chk(); return filas.filter((f) => !f.resuelta_at).slice(0, lim).map((f) => ({ ...f, sesion: null }) as AlertaAbierta); },
    async resolver(fl, ahora) {
      chk();
      let k = 0;
      for (const f of filas) {
        if (f.resuelta_at) continue;
        if (fl.id && f.id !== fl.id) continue;
        if (fl.grabacionId && f.grabacion_id !== fl.grabacionId) continue;
        if (fl.tipo && f.tipo !== fl.tipo) continue;
        if (fl.prefijo && !f.clave.startsWith(fl.prefijo)) continue;
        if (fl.salvo?.includes(f.clave)) continue;
        f.resuelta_at = ahora; f.resuelta_por = 'sistema'; k++;
      }
      return k;
    },
    async correoDestino() { return 'vale@example.test'; },
  };
  return { repo, filas, setFallar: (v: boolean) => { fallar = v; } };
}

function servicio(opts: { ahora?: { t: number }; correoOk?: boolean } = {}) {
  const m = repoMemoria();
  const reloj = opts.ahora ?? { t: Date.parse('2026-10-16T12:00:00Z') };
  const correos: { para: string; asunto: string; texto: string }[] = [];
  const auditadas: string[] = [];
  const s = crearAlertas({
    repo: m.repo,
    ahora: () => new Date(reloj.t),
    enviarCorreo: async (para, c) => { correos.push({ para, asunto: c.asunto, texto: c.texto }); return opts.correoOk ?? true; },
    auditarNueva: async (f) => { auditadas.push(f.clave); },
  });
  return { s, m, reloj, correos, auditadas };
}

test('deduplica por clave mientras está abierta: suma veces y no crea otra fila', async () => {
  const { s, m, reloj, auditadas } = servicio();
  await s.registrarAlerta({ tipo: 'transcripcion', titulo: 'AssemblyAI respondió 500', grabacionId: GID, accion: 'reintentar' });
  reloj.t += 60_000;
  await s.registrarAlerta({ tipo: 'transcripcion', titulo: 'AssemblyAI respondió 503', grabacionId: GID, accion: 'reintentar' });
  await s.registrarAlerta({ tipo: 'transcripcion', titulo: 'AssemblyAI respondió 503', grabacionId: GID, accion: 'reintentar' });
  assert.equal(m.filas.length, 1);
  assert.equal(m.filas[0].veces, 3);
  assert.equal(m.filas[0].clave, `transcripcion:${GID}`);
  assert.equal(m.filas[0].titulo, 'AssemblyAI respondió 503', 'se actualiza al último título');
  assert.equal(m.filas[0].ultima_vez, new Date(reloj.t).toISOString());
  assert.deepEqual(auditadas, [`transcripcion:${GID}`], 'solo la alerta nueva va a la bitácora');
});

test('claves distintas = alertas distintas; resuelta + mismo error = alerta nueva', async () => {
  const { s, m } = servicio();
  await s.registrarAlerta({ tipo: 'resumen', titulo: 'Falló el resumen', grabacionId: GID });
  await s.registrarAlerta({ tipo: 'transcripcion', titulo: 'Falló la transcripción', grabacionId: GID });
  assert.equal(m.filas.length, 2);
  await s.resolverAlertasDe(GID, 'resumen');
  assert.ok(m.filas.find((f) => f.tipo === 'resumen')!.resuelta_at);
  assert.equal(m.filas.find((f) => f.tipo === 'resumen')!.resuelta_por, 'sistema');
  assert.equal(m.filas.find((f) => f.tipo === 'transcripcion')!.resuelta_at, null);
  await s.registrarAlerta({ tipo: 'resumen', titulo: 'Falló el resumen', grabacionId: GID });
  assert.equal(m.filas.length, 3);
  assert.equal(m.filas[2].veces, 1);
});

test('conflicto con el índice único (otra instancia la creó a la vez) → suma en la existente', async () => {
  const { s, m } = servicio();
  const orig = m.repo.abiertaPorClave;
  let primera = true;
  // La primera lectura no la ve (carrera); el insert choca; la segunda lectura sí la ve.
  await m.repo.insertar({ tipo: 'bot', titulo: 'x', detalle: null, grabacion_id: null, accion: 'revisar', clave: 'bot:x', veces: 1, ultima_vez: 'ayer' });
  m.repo.abiertaPorClave = async (c) => { if (primera) { primera = false; return null; } return orig(c); };
  await s.registrarAlerta({ tipo: 'bot', titulo: 'x', clave: 'bot:x' });
  assert.equal(m.filas.length, 1);
  assert.equal(m.filas[0].veces, 2);
});

test('correo de respaldo: máx. 1 por clave cada 6 h, aunque la alerta se resuelva y reabra', async () => {
  const { s, reloj, correos } = servicio();
  await s.registrarAlerta({ tipo: 'respaldo', titulo: 'Respaldo viejo', clave: 'salud:respaldo_supabase' });
  await s.registrarAlerta({ tipo: 'respaldo', titulo: 'Respaldo viejo', clave: 'salud:respaldo_supabase' });
  assert.equal(correos.length, 1);
  assert.equal(correos[0].para, 'vale@example.test');
  await s.resolverPorPrefijo('salud:respaldo', []);
  reloj.t += 60 * 60_000; // 1 h después se reabre
  await s.registrarAlerta({ tipo: 'respaldo', titulo: 'Respaldo viejo', clave: 'salud:respaldo_supabase' });
  assert.equal(correos.length, 1, 'misma clave dentro de 6 h: sin correo');
  reloj.t += FRENO_CORREO_MS;
  await s.registrarAlerta({ tipo: 'respaldo', titulo: 'Respaldo viejo', clave: 'salud:respaldo_supabase' });
  assert.equal(correos.length, 2);
});

test('si el correo falla se libera el freno y se reintenta en la próxima repetición', async () => {
  const { s, m, correos } = servicio({ correoOk: false });
  await s.registrarAlerta({ tipo: 'config', titulo: 'Falta una llave', clave: 'salud:config' });
  assert.equal(correos.length, 1);
  assert.equal(m.filas[0].correo_enviado_at, null);
  await s.registrarAlerta({ tipo: 'config', titulo: 'Falta una llave', clave: 'salud:config' });
  assert.equal(correos.length, 2);
});

test('nunca lanza: base caída → console.error y correo de respaldo con freno en memoria', async () => {
  const { s, m, correos } = servicio();
  m.setFallar(true);
  const errores: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errores.push(a); };
  try {
    await assert.doesNotReject(s.registrarAlerta({ tipo: 'subida', titulo: 'No se pudo subir', grabacionId: GID }));
    await assert.doesNotReject(s.registrarAlerta({ tipo: 'subida', titulo: 'No se pudo subir', grabacionId: GID }));
    await assert.doesNotReject(s.resolverAlertasDe(GID));
    assert.deepEqual(await s.listarAlertasAbiertas(), []);
  } finally { console.error = orig; }
  assert.ok(errores.length >= 2);
  assert.equal(correos.length, 1, 'el freno en memoria evita repetir el correo');
  assert.equal(correos[0].para, 'vinculosquesostienen@gmail.com');
});

test('cerrarAlerta (sistema) cierra solo esa; resolverPorPrefijo respeta las que siguen fallando', async () => {
  const { s, m } = servicio();
  await s.registrarAlerta({ tipo: 'salud', titulo: 'a', clave: 'salud:atascadas:g1' });
  await s.registrarAlerta({ tipo: 'salud', titulo: 'b', clave: 'salud:atascadas:g2' });
  await s.registrarAlerta({ tipo: 'salud', titulo: 'c', clave: 'salud:gasto' });
  assert.equal(await s.resolverPorPrefijo('salud:atascadas', ['salud:atascadas:g2']), 1);
  assert.equal(m.filas.find((f) => f.clave === 'salud:atascadas:g2')!.resuelta_at, null);
  const id = m.filas.find((f) => f.clave === 'salud:gasto')!.id;
  assert.equal(await s.cerrarAlerta(id), true);
  assert.equal(m.filas.find((f) => f.id === id)!.resuelta_por, 'sistema', 'nunca hay cierre manual');
  assert.equal(await s.cerrarAlerta(id), false, 'ya resuelta');
});

test('funciones puras: clave, saneo, normalización, freno y correo sin datos de la sesión', () => {
  assert.equal(claveDe({ tipo: 'resumen', grabacionId: GID, titulo: 'x' }), `resumen:${GID}`);
  assert.equal(claveDe({ tipo: 'salud', titulo: 'R2 no responde' }), 'salud:r2 no responde');
  assert.equal(claveDe({ tipo: 'salud', titulo: 'x', clave: ' salud:r2 ' }), 'salud:r2');
  assert.equal(sanearTexto('falló GET https://r2.example/a/x.m4a?X-Amz-Signature=abc\n en 3 s', 200), 'falló GET [url] en 3 s');
  assert.equal(sanearTexto('authorization: Bearer abc123', 200), 'authorization: Bearer [oculto]');
  assert.equal(sanearTexto('x-api-key=abc123 falló', 200), 'x-api-key: [oculto] falló');
  assert.ok(!sanearTexto('llave sk-ant-api03-abcdefghijkl rechazada', 200).includes('sk-ant'));
  assert.equal(sanearTexto('a'.repeat(300), 10).length, 10);
  const n = normalizarAlerta({ tipo: 'nada' as never, titulo: '', accion: 'reintentar' });
  assert.equal(n.tipo, 'salud');
  assert.equal(n.accion, 'revisar', 'reintentar sin grabación no tiene sentido');
  assert.equal(n.titulo, 'Error del transcriptor');
  assert.equal(normalizarAlerta({ tipo: 'bot', titulo: 'x', grabacionId: 'no-uuid' }).grabacionId, null);
  const ahora = new Date('2026-10-16T12:00:00Z');
  assert.equal(debeEnviarCorreo(null, ahora), true);
  assert.equal(debeEnviarCorreo('2026-10-16T07:00:00Z', ahora), false);
  assert.equal(debeEnviarCorreo('2026-10-16T06:00:00Z', ahora), true);
  const c = armarCorreo({ tipo: 'transcripcion', titulo: 'AssemblyAI respondió 500', detalle: 'HTTP 500', veces: 3 }, 'https://www.valentinaorellana.cl/admin');
  assert.match(c.asunto, /Transcriptor: AssemblyAI respondió 500/);
  assert.match(c.texto, /Se repitió 3 veces/);
  assert.match(c.html, /Abrir el panel/);
  assert.doesNotMatch(c.html + c.texto, /<script/i);
});

test('sin la tabla 0017 (migración sin aplicar): no manda correos de respaldo', async () => {
  const { s, m, correos } = servicio();
  m.repo.abiertaPorClave = async () => { throw new TablaAlertasFaltanteError(); };
  const orig = console.error; console.error = () => {};
  try { await s.registrarAlerta({ tipo: 'subida', titulo: 'x', grabacionId: GID }); } finally { console.error = orig; }
  assert.equal(correos.length, 0);
});
