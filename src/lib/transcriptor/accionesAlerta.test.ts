// Pruebas de las acciones que reparan los avisos (decisión A, 16 oct noche). Sin red ni base:
// dobles para la base, Fly, B2, AssemblyAI y los chequeos. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCIONES_AVISO, INFO_ACCION, accionesDisponibles, audioViejoBorrable, alertaSuperada, claseDe, ejecutarAccionAviso, instruccionDe,
  lanzarMaquinaRespaldo, revisarAvisosSueltos, umbralExito, type AccionAviso, type OpsAcciones, type ResultadoBorrado,
} from './accionesAlerta';
import { armarCorreo, crearAlertas, urlAccion, type AlertaAbierta, type AlertaFila, type RepoAlertas, type SesionDeAlerta } from './alertas';
import { ejecutarSalud, VARIABLES_REQUERIDAS, type FuentesSalud } from './salud';
import type { OpsReintento } from './reintentoAlerta';
import type { EstadoGrabacion } from './tipos';
import vercelJson from '../../../vercel.json';

const GID = '11111111-2222-4333-8444-555555555555';
const AID = 'aaaaaaaa-2222-4333-8444-555555555555';
const FIN_FUTURO = () => new Date(Date.now() + 3600_000).toISOString();
const FIN_PASADO = '2026-01-01T00:00:00Z';

function ses(estado: EstadoGrabacion, antes: EstadoGrabacion | null = null, p: Partial<SesionDeAlerta> = {}): SesionDeAlerta {
  return {
    session_date: '2026-10-16', inicio_at: null, origen: 'presencial', estado, estado_antes_error: antes, patient_id: null, paciente: null,
    hora_fin_prevista: null, bot_machine_id: null, segmentos_subidos: 0, b2_pendientes: 0, ...p,
  };
}

function alerta(clave: string, p: Partial<AlertaFila> = {}): AlertaFila {
  const tipo = (p.tipo ?? (clave.startsWith('bot') ? 'bot' : clave.startsWith('subida') ? 'subida' : clave.startsWith('resumen') ? 'resumen'
    : clave.startsWith('respaldo') ? 'respaldo' : clave.startsWith('config') ? 'config' : clave.startsWith('transcripcion') || clave.startsWith('sin-voz') ? 'transcripcion' : 'salud')) as AlertaFila['tipo'];
  return {
    id: AID, creada_at: '2026-10-16T12:00:00Z', tipo, titulo: 'x', detalle: null, grabacion_id: clave.includes(GID) ? GID : null,
    accion: 'revisar', clave, veces: 1, ultima_vez: '2026-10-16T12:00:00Z', resuelta_at: null, resuelta_por: null, correo_enviado_at: null, ...p,
  };
}

/** Mundo falso: un aviso, su grabación y los proveedores. Cada operación queda en `llamadas`. */
function mundo(a: AlertaFila, s: SesionDeAlerta | null, op: {
  chequeoOk?: boolean; resumenModo?: string; calendarioFalla?: boolean; borrar?: ResultadoBorrado; flyFalla?: boolean;
  copiaFalla?: boolean; apagado?: { activo: boolean; pendientes: number }; respaldo?: { ok: boolean; mensaje: string };
} = {}) {
  const st = { alerta: structuredClone(a), sesion: s ? structuredClone(s) : null, modo: op.resumenModo ?? 'batch', chequeoOk: op.chequeoOk ?? false };
  const llamadas: string[] = [];
  const reintento: OpsReintento = {
    async leer() { return st.sesion ? { grabacion: st.sesion, resumenErrorId: null } : null; },
    async reintentar() {
      llamadas.push('reintentar');
      if (st.sesion?.estado !== 'error' || !st.sesion.estado_antes_error) return null;
      st.sesion = { ...st.sesion, estado: st.sesion.estado_antes_error, estado_antes_error: null };
      return { estado: st.sesion.estado };
    },
    async soltar() { llamadas.push('soltar'); return true; },
    async reabrirResumen() { llamadas.push('reabrir'); return true; },
  };
  const cerrar = () => { if (st.alerta.resuelta_at) return false; st.alerta.resuelta_at = '2026-10-16T13:00:00Z'; st.alerta.resuelta_por = 'sistema'; return true; };
  const ops: OpsAcciones = {
    async obtenerAlerta(id) { return id === st.alerta.id ? structuredClone(st.alerta) : null; },
    async cerrarAlerta() { llamadas.push('cerrar'); return cerrar(); },
    async leerSesion() { return st.sesion ? structuredClone(st.sesion) : null; },
    reintento,
    async rescatar() {
      llamadas.push('rescatar');
      if (st.sesion?.estado !== 'error') return null;
      const hacia = (st.sesion.segmentos_subidos ?? 0) > 0 ? 'subida' as const : 'cancelada' as const;
      st.sesion = { ...st.sesion, estado: hacia, estado_antes_error: null };
      return { hacia };
    },
    async apagarBot(m) { llamadas.push(`apagar:${m}`); if (op.flyFalla) throw new Error('Fly no pudo destruir la máquina (500)'); },
    async copiarB2(g) {
      llamadas.push(`copiarB2:${g ?? 'todas'}`);
      if (op.copiaFalla) return { copiadas: 0, fallidas: 1 };
      if (st.sesion) st.sesion.b2_pendientes = 0;
      st.chequeoOk = true;
      return { copiadas: 1, fallidas: 0 };
    },
    async borrarAai() { llamadas.push('borrarAai'); const r = op.borrar ?? { borrados: 2, omitidos: 0, fallidos: 0 }; st.chequeoOk = !r.omitidos && !r.fallidos; return r; },
    async borrarHuerfanos() { llamadas.push('borrarHuerfanos'); const r = op.borrar ?? { borrados: 1, omitidos: 0, fallidos: 0 }; st.chequeoOk = !r.omitidos && !r.fallidos; return r; },
    async borrarAudio() { llamadas.push('borrarAudio'); const r = op.borrar ?? { borrados: 3, omitidos: 0, fallidos: 0 }; st.chequeoOk = !r.omitidos && !r.fallidos; return r; },
    async lanzarRespaldo() { llamadas.push('lanzarRespaldo'); return op.respaldo ?? { ok: true, mensaje: 'Listo: el respaldo empezó.' }; },
    async usarDirecto() { llamadas.push('usarDirecto'); st.modo = 'directo'; },
    async leerModoResumen() { return st.modo; },
    async revisarChequeo(ch) {
      llamadas.push(`chequeo:${ch}`);
      // Como el diario: si el chequeo sale bien cierra sus avisos 'salud:<ch>…'; si no, suma una vez.
      if (st.alerta.clave.startsWith(`salud:${ch}`)) { if (st.chequeoOk) cerrar(); else st.alerta.veces++; }
    },
    async revisarSaludCompleta() { llamadas.push('saludCompleta'); return { registroOk: st.chequeoOk }; },
    async generarReporte() { llamadas.push('reporte'); },
    async probarCalendario() { llamadas.push('calendario'); if (op.calendarioFalla) throw new Error('401 invalid_grant'); },
    async apagadoConPendientes() { return op.apagado ?? { activo: false, pendientes: 2 }; },
  };
  return { ops, st, llamadas };
}

// ─── Catálogo: cada aviso que existe tiene una acción que lo repara ─────────────

/** Todas las claves que generan pipeline.ts, salud.ts, el cron de salud y el bot (vía pipeline). */
const CLAVES_EXISTENTES: { clave: string; sesion?: SesionDeAlerta | null; repara: AccionAviso | null }[] = [
  { clave: `bot:${GID}`, sesion: ses('error', 'bot_lanzando', { origen: 'online', hora_fin_prevista: FIN_FUTURO() }), repara: 'reintentar' },
  { clave: `bot:${GID}`, sesion: ses('error', 'bot_lanzando', { origen: 'online', hora_fin_prevista: FIN_PASADO }), repara: 'rescatar' },
  { clave: `bot-maquina:${GID}`, sesion: ses('grabando', null, { origen: 'online', bot_machine_id: 'm123456' }), repara: 'apagar_bot' },
  { clave: `bot-vigilante:${GID}`, sesion: ses('transcribiendo'), repara: null },
  { clave: 'bot:calendario', repara: null },
  { clave: `subida:${GID}`, sesion: ses('error', 'subida'), repara: 'rescatar' },
  { clave: `transcripcion:${GID}`, sesion: ses('error', 'transcribiendo'), repara: 'reintentar' },
  { clave: `transcripcion:${GID}`, sesion: ses('error', 'subida'), repara: 'reintentar' },
  { clave: `sin-voz:${GID}`, sesion: ses('transcrita'), repara: null },
  { clave: `resumen:${GID}`, sesion: ses('error', 'resumiendo'), repara: 'reintentar_resumen' },
  { clave: `respaldo:${GID}`, sesion: ses('transcrita', null, { b2_pendientes: 1 }), repara: 'copiar_b2' },
  { clave: 'config:resumen-modo', repara: 'usar_directo' },
  { clave: 'config:apagado-con-pendientes', repara: null },
  { clave: 'salud:config', repara: null },
  { clave: 'salud:r2', repara: null }, { clave: 'salud:b2', repara: null },
  { clave: 'salud:assemblyai', repara: null }, { clave: 'salud:anthropic', repara: null },
  { clave: `salud:atascadas:${GID}:transcribiendo`, sesion: ses('transcribiendo'), repara: 'reintentar' },
  { clave: `salud:atascadas:${GID}:resumiendo`, sesion: ses('error', 'resumiendo'), repara: 'reintentar_resumen' },
  { clave: `salud:atascadas:${GID}:creada`, sesion: ses('creada'), repara: null }, // audio en el teléfono: instrucción
  { clave: 'salud:audio_borrado', repara: 'borrar_audio' },
  { clave: 'salud:aai_borrado', repara: 'borrar_aai' },
  { clave: 'salud:aai_huerfanos', repara: 'borrar_huerfanos' },
  { clave: 'salud:copias_b2', repara: 'copiar_b2' },
  { clave: 'salud:respaldo_supabase', repara: 'lanzar_respaldo' },
  { clave: 'salud:gasto', repara: null },
  { clave: 'salud:permisos_microfono', repara: null },
  { clave: 'salud:r2:no_revisado', repara: null },
  { clave: 'salud:cron', repara: null }, { clave: 'salud:reporte', repara: null }, { clave: 'salud:registro', repara: null },
];

test('cada tipo de aviso tiene su acción que repara y siempre "Volver a revisar"; sin arreglo automático hay instrucción', () => {
  for (const c of CLAVES_EXISTENTES) {
    const a = alerta(c.clave);
    const acc = accionesDisponibles(a, c.sesion ?? null);
    assert.ok(acc.length >= 1, c.clave);
    assert.equal(acc.at(-1), 'revisar', `${c.clave}: "Volver a revisar" siempre al final`);
    if (c.repara) assert.equal(acc[0], c.repara, c.clave);
    else {
      assert.deepEqual(acc, ['revisar'], c.clave);
      assert.ok(instruccionDe(a, c.sesion ?? null), `${c.clave}: sin arreglo automático debe decir exactamente qué hacer`);
    }
    for (const x of acc) assert.ok(INFO_ACCION[x].etiqueta && INFO_ACCION[x].queHace, x);
  }
});

test('no existe "resuelto manual": ni acción, ni endpoint, ni botón, ni función', () => {
  assert.ok(!(ACCIONES_AVISO as readonly string[]).includes('resolver'));
  const servicio = crearAlertas({ repo: {} as RepoAlertas });
  assert.equal((servicio as unknown as Record<string, unknown>).resolverAlerta, undefined);
  const raiz = new URL('../../../', import.meta.url);
  const leer = (p: string) => readFileSync(new URL(p, raiz), 'utf8');
  for (const p of ['src/components/admin/AlertasTranscriptor.astro', 'src/pages/api/admin/transcriptor/alertas.ts', 'src/pages/admin/transcriptor/accion.astro']) {
    const t = leer(p);
    assert.doesNotMatch(t, /Marcar como resuelto/i, p);
    assert.doesNotMatch(t, /accion\s*===?\s*'resolver'|'resolver'/, p);
    assert.doesNotMatch(t, /resuelta_por:\s*'vale'|'vale'\)/, p);
  }
  assert.doesNotMatch(leer('src/lib/transcriptor/alertas.ts'), /resuelta_por: por|export async function resolverAlerta\(/);
});

// ─── Cierre automático: solo cuando el paso sale bien ────────────────────────

test('alertaSuperada: el aviso de un paso se cierra recién cuando la grabación pasa ese paso', () => {
  const t = alerta(`transcripcion:${GID}`);
  assert.equal(alertaSuperada(t, ses('error', 'transcribiendo')), false);
  assert.equal(alertaSuperada(t, ses('transcribiendo')), false, 'recién reintentado: todavía no');
  assert.equal(alertaSuperada(t, ses('transcrita')), true);
  assert.equal(alertaSuperada(t, ses('error', 'resumiendo')), true, 'falló después: la transcripción sí salió');
  assert.equal(alertaSuperada(t, ses('lista')), true);
  assert.equal(alertaSuperada(t, null), true, 'la grabación ya no existe');
  assert.equal(alertaSuperada(t, undefined), false, 'si no se pudo leer, no se cierra nada');
  const b = alerta(`bot:${GID}`);
  assert.equal(alertaSuperada(b, ses('bot_lanzando', null, { origen: 'online' })), false);
  assert.equal(alertaSuperada(b, ses('bot_en_lobby', null, { origen: 'online' })), true);
  assert.equal(alertaSuperada(b, ses('cancelada')), true);
  const r = alerta(`resumen:${GID}`);
  assert.equal(alertaSuperada(r, ses('resumiendo')), false);
  assert.equal(alertaSuperada(r, ses('lista')), true);
  assert.equal(alertaSuperada(alerta(`respaldo:${GID}`), ses('lista', null, { b2_pendientes: 1 })), false, 'lista pero sin copia en B2');
  assert.equal(alertaSuperada(alerta(`respaldo:${GID}`), ses('lista', null, { b2_pendientes: 0 })), true);
  assert.equal(alertaSuperada(alerta(`bot-maquina:${GID}`), ses('grabando', null, { bot_machine_id: 'm1' })), false);
  assert.equal(alertaSuperada(alerta(`bot-maquina:${GID}`), ses('subida', null, { bot_machine_id: 'm1' })), true);
  assert.equal(alertaSuperada(alerta(`salud:atascadas:${GID}:subiendo`), ses('subiendo')), false);
  assert.equal(alertaSuperada(alerta(`salud:atascadas:${GID}:subiendo`), ses('subida')), true);
  assert.equal(alertaSuperada(alerta('salud:config'), null), false, 'los de chequeos se cierran al re-ejecutar el chequeo');
  assert.equal(umbralExito('bot_lanzando'), 'bot_en_lobby');
  assert.equal(claseDe(alerta(`salud:atascadas:${GID}`, { tipo: 'resumen' })).k, 'paso', 'clave vieja sin paso');
});

test('listar cierra solos los avisos cuyo paso ya salió bien; si no se pudo leer la sesión, no cierra nada', async () => {
  const filas: AlertaAbierta[] = [
    { ...alerta(`transcripcion:${GID}`, { id: 'a1' }), sesion: ses('transcrita') },
    { ...alerta(`resumen:${GID}`, { id: 'a2' }), sesion: ses('error', 'resumiendo') },
    { ...alerta(`bot:${GID}`, { id: 'a3' }), sesion: null, sesion_desconocida: true },
    { ...alerta('salud:config', { id: 'a4' }), sesion: null },
  ];
  const cerradas: string[] = [];
  const repo = {
    async listarAbiertas() { return filas; },
    async resolver(f: { id?: string }) { cerradas.push(f.id!); return 1; },
  } as unknown as RepoAlertas;
  const lista = await crearAlertas({ repo }).listarAlertasAbiertas();
  assert.deepEqual(cerradas, ['a1']);
  assert.deepEqual(lista.map((x) => x.id), ['a2', 'a3', 'a4']);
});

// ─── Cada acción desde cada estado ───────────────────────────────────────────

test('Reintentar (subida/transcripción/bot): deja la sesión lista para el cron y el aviso sigue abierto hasta que el paso salga bien', async () => {
  for (const [clave, antes, accion, exito] of [
    [`transcripcion:${GID}`, 'transcribiendo', 'reintentar', 'transcrita'],
    [`transcripcion:${GID}`, 'subida', 'reintentar', 'transcrita'],
    [`resumen:${GID}`, 'resumiendo', 'reintentar_resumen', 'lista'],
    [`bot:${GID}`, 'bot_lanzando', 'reintentar', 'bot_en_lobby'],
  ] as const) {
    const s = ses('error', antes, clave.startsWith('bot') ? { origen: 'online', hora_fin_prevista: FIN_FUTURO() } : {});
    const m = mundo(alerta(clave), s);
    const r = await ejecutarAccionAviso(AID, accion, m.ops);
    assert.equal(r.ok, true, clave); assert.equal(r.cerrada, false, `${clave}: reintentar no cierra`);
    assert.ok(m.llamadas.includes('reintentar'));
    assert.match(r.mensaje, /se cierra solo cuando/);
    assert.equal(m.st.alerta.resuelta_at, null);
    // Volver a revisar antes de que el cron lo haga: sigue abierto.
    assert.equal((await ejecutarAccionAviso(AID, 'revisar', m.ops)).cerrada, false);
    // El cron hizo el paso → revisar (o listar / la consulta del aviso) lo cierra.
    m.st.sesion = { ...m.st.sesion!, estado: exito };
    const rv = await ejecutarAccionAviso(AID, 'revisar', m.ops);
    assert.equal(rv.cerrada, true, clave);
    assert.equal(m.st.alerta.resuelta_por, 'sistema');
  }
});

test('Reintentar en una sesión atascada sin error: suelta la toma; teléfono: no hay reintento, solo instrucción', async () => {
  const m = mundo(alerta(`salud:atascadas:${GID}:transcribiendo`, { grabacion_id: GID }), ses('transcribiendo'));
  const r = await ejecutarAccionAviso(AID, 'reintentar', m.ops);
  assert.equal(r.ok, true); assert.equal(r.cerrada, false); assert.deepEqual(m.llamadas, ['soltar']);
  const t = mundo(alerta(`salud:atascadas:${GID}:creada`, { grabacion_id: GID }), ses('creada'));
  const rt = await ejecutarAccionAviso(AID, 'reintentar', t.ops);
  assert.equal(rt.ok, false); assert.match(rt.mensaje, /ya no corresponde/);
  assert.match(instruccionDe(t.st.alerta, t.st.sesion)!, /teléfono/);
});

test('Rescatar: sesión online caída → transcribe lo subido o cierra como no grabada; el aviso se cierra', async () => {
  const conAudio = mundo(alerta(`salud:atascadas:${GID}:grabando`, { tipo: 'bot', grabacion_id: GID }), ses('error', 'grabando', { origen: 'online', segmentos_subidos: 2 }));
  assert.deepEqual(accionesDisponibles(conAudio.st.alerta, conAudio.st.sesion), ['rescatar', 'revisar']);
  const r = await ejecutarAccionAviso(AID, 'rescatar', conAudio.ops);
  assert.equal(r.ok, true); assert.equal(r.cerrada, true); assert.equal(conAudio.st.sesion!.estado, 'subida'); assert.match(r.mensaje, /transcribe/);
  const sinAudio = mundo(alerta(`subida:${GID}`), ses('error', 'subida'));
  const r2 = await ejecutarAccionAviso(AID, 'rescatar', sinAudio.ops);
  assert.equal(r2.cerrada, true); assert.equal(sinAudio.st.sesion!.estado, 'cancelada');
  // Reintentar no se ofrece donde no repararía (no llegó audio / el bot ya no puede volver).
  assert.equal((await ejecutarAccionAviso(AID, 'reintentar', mundo(alerta(`subida:${GID}`), ses('error', 'subida')).ops)).ok, false);
});

test('Apagar el asistente: si Fly confirma, se cierra; si Fly falla, sigue abierto con el motivo', async () => {
  const s = ses('grabando', null, { origen: 'online', bot_machine_id: 'm123456' });
  const ok = mundo(alerta(`bot-maquina:${GID}`), s);
  const r = await ejecutarAccionAviso(AID, 'apagar_bot', ok.ops);
  assert.equal(r.cerrada, true); assert.ok(ok.llamadas.includes('apagar:m123456'));
  const mal = mundo(alerta(`bot-maquina:${GID}`), s, { flyFalla: true });
  const r2 = await ejecutarAccionAviso(AID, 'apagar_bot', mal.ops);
  assert.equal(r2.ok, false); assert.equal(r2.cerrada, false); assert.match(r2.mensaje, /FLY_API_TOKEN/);
});

test('Rehacer copia en B2: de una sesión y del chequeo; se cierra solo si quedó copiada', async () => {
  const g = mundo(alerta(`respaldo:${GID}`), ses('transcrita', null, { b2_pendientes: 1 }));
  const r = await ejecutarAccionAviso(AID, 'copiar_b2', g.ops);
  assert.equal(r.cerrada, true); assert.ok(g.llamadas.includes(`copiarB2:${GID}`));
  const c = mundo(alerta('salud:copias_b2'), null);
  const rc = await ejecutarAccionAviso(AID, 'copiar_b2', c.ops);
  assert.equal(rc.cerrada, true); assert.deepEqual(c.llamadas.slice(0, 2), ['copiarB2:todas', 'chequeo:copias_b2']);
  const f = mundo(alerta(`respaldo:${GID}`), ses('transcrita', null, { b2_pendientes: 1 }), { copiaFalla: true });
  const rf = await ejecutarAccionAviso(AID, 'copiar_b2', f.ops);
  assert.equal(rf.cerrada, false); assert.match(rf.mensaje, /B2_KEY_ID/);
});

test('Borrar en AssemblyAI / transcripciones sueltas / audio: borra y re-ejecuta su chequeo; si quedan, sigue abierto', async () => {
  for (const [clave, accion, ch] of [['salud:aai_borrado', 'borrar_aai', 'aai_borrado'], ['salud:aai_huerfanos', 'borrar_huerfanos', 'aai_huerfanos'], ['salud:audio_borrado', 'borrar_audio', 'audio_borrado']] as const) {
    const m = mundo(alerta(clave), null);
    const r = await ejecutarAccionAviso(AID, accion, m.ops);
    assert.equal(r.cerrada, true, clave); assert.ok(m.llamadas.includes(`chequeo:${ch}`));
    const q = mundo(alerta(clave), null, { borrar: { borrados: 1, omitidos: 2, fallidos: 0 } });
    const rq = await ejecutarAccionAviso(AID, accion, q.ops);
    assert.equal(rq.cerrada, false); assert.match(rq.mensaje, /todavía no tiene la transcripción guardada/);
  }
});

test('Lanzar respaldo ahora: no cierra solo (tarda); "Volver a revisar" lo cierra cuando el respaldo está', async () => {
  const m = mundo(alerta('salud:respaldo_supabase'), null);
  const r = await ejecutarAccionAviso(AID, 'lanzar_respaldo', m.ops);
  assert.equal(r.ok, true); assert.equal(r.cerrada, false);
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', m.ops)).cerrada, false, 'todavía no termina');
  m.st.chequeoOk = true;
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', m.ops)).cerrada, true);
  const sinToken = mundo(alerta('salud:respaldo_supabase'), null, { respaldo: { ok: false, mensaje: 'falta FLY_API_TOKEN_RESPALDO' } });
  assert.equal((await ejecutarAccionAviso(AID, 'lanzar_respaldo', sinToken.ops)).ok, false);
});

test('lanzarMaquinaRespaldo: Machines API list + start; sin token da la instrucción exacta', async () => {
  const sin = await lanzarMaquinaRespaldo({});
  assert.equal(sin.ok, false); assert.match(sin.mensaje, /FLY_API_TOKEN_RESPALDO/); assert.match(sin.mensaje, /fly machine start/);
  const pedidos: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    pedidos.push(`${init?.method ?? 'GET'} ${url}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer tok');
    if (url.endsWith('/machines')) return new Response(JSON.stringify([{ id: 'otra1234', name: 'x', state: 'stopped' }, { id: 'abc123456', name: 'respaldo-semanal', state: 'stopped' }]), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const r = await lanzarMaquinaRespaldo({ token: 'tok' }, f);
  assert.equal(r.ok, true);
  assert.deepEqual(pedidos, ['GET https://api.machines.dev/v1/apps/vo-respaldo-supabase/machines', 'POST https://api.machines.dev/v1/apps/vo-respaldo-supabase/machines/abc123456/start']);
  const corriendo = await lanzarMaquinaRespaldo({ token: 'tok' }, (async () => new Response(JSON.stringify([{ id: 'abc123456', name: 'respaldo-semanal', state: 'started' }]))) as typeof fetch);
  assert.match(corriendo.mensaje, /ya está corriendo/);
  const rechazo = await lanzarMaquinaRespaldo({ token: 'tok' }, (async () => new Response('no', { status: 401 })) as typeof fetch);
  assert.equal(rechazo.ok, false); assert.match(rechazo.mensaje, /401/);
});

test('Usar modo "directo" y Volver a revisar de los avisos sin arreglo automático (llave, calendario, apagado, salud, reporte)', async () => {
  const d = mundo(alerta('config:resumen-modo'), null);
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', d.ops)).cerrada, false);
  assert.equal((await ejecutarAccionAviso(AID, 'usar_directo', d.ops)).cerrada, true);

  const k = mundo(alerta('salud:config'), null);
  const rk = await ejecutarAccionAviso(AID, 'revisar', k.ops);
  assert.equal(rk.cerrada, false); assert.ok(k.llamadas.includes('chequeo:config'), 're-ejecuta ESE chequeo');
  assert.equal(k.st.alerta.veces, 2);
  k.st.chequeoOk = true; // Vale agregó la llave
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', k.ops)).cerrada, true);

  const nr = mundo(alerta('salud:anthropic:no_revisado'), null, { chequeoOk: true });
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', nr.ops)).cerrada, true); assert.ok(nr.llamadas.includes('chequeo:anthropic'));

  const cal = mundo(alerta('bot:calendario'), null, { calendarioFalla: true });
  const rc = await ejecutarAccionAviso(AID, 'revisar', cal.ops);
  assert.equal(rc.cerrada, false); assert.match(rc.mensaje, /invalid_grant/);
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', mundo(alerta('bot:calendario'), null).ops)).cerrada, true);

  assert.equal((await ejecutarAccionAviso(AID, 'revisar', mundo(alerta('config:apagado-con-pendientes'), null).ops)).cerrada, false);
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', mundo(alerta('config:apagado-con-pendientes'), null, { apagado: { activo: true, pendientes: 2 } }).ops)).cerrada, true);

  assert.equal((await ejecutarAccionAviso(AID, 'revisar', mundo(alerta('salud:cron'), null).ops)).cerrada, true);
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', mundo(alerta('salud:registro'), null).ops)).cerrada, false, 'sigue sin poder guardar');
  const rep = mundo(alerta('salud:reporte'), null);
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', rep.ops)).cerrada, true); assert.ok(rep.llamadas.includes('reporte'));

  const gasto = mundo(alerta('salud:gasto'), null);
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', gasto.ops)).cerrada, false);
  assert.match(instruccionDe(gasto.st.alerta, undefined)!, /presupuesto/);
});

test('Informativos (sin voz, asistente apagado por el vigilante): se cierran solos cuando la sesión termina', async () => {
  const m = mundo(alerta(`sin-voz:${GID}`), ses('transcrita'));
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', m.ops)).cerrada, false);
  m.st.sesion = { ...m.st.sesion!, estado: 'lista' };
  assert.equal((await ejecutarAccionAviso(AID, 'revisar', m.ops)).cerrada, true);
});

test('aviso ya resuelto o inexistente; acción que no corresponde; el paso ya salió bien antes de tocar', async () => {
  const r = mundo(alerta(`resumen:${GID}`, { resuelta_at: '2026-10-16T13:00:00Z', resuelta_por: 'sistema' }), ses('lista'));
  const rr = await ejecutarAccionAviso(AID, 'reintentar_resumen', r.ops);
  assert.equal(rr.cerrada, true); assert.match(rr.mensaje, /ya estaba resuelto/); assert.deepEqual(r.llamadas, []);
  assert.equal((await ejecutarAccionAviso('otra', 'revisar', r.ops)).ok, false);
  const x = mundo(alerta('salud:gasto'), null);
  assert.equal((await ejecutarAccionAviso(AID, 'borrar_aai', x.ops)).ok, false);
  assert.deepEqual(x.llamadas, [], 'una acción que no corresponde no ejecuta nada');
  const ya = mundo(alerta(`transcripcion:${GID}`), ses('lista'));
  const ry = await ejecutarAccionAviso(AID, 'reintentar', ya.ops);
  assert.equal(ry.cerrada, true); assert.ok(!ya.llamadas.includes('reintentar'));
});

test('revisarAvisosSueltos (chequeo diario) cierra calendario/ajuste/apagado cuando ya están bien', async () => {
  const m = mundo(alerta('config:resumen-modo'), null, { resumenModo: 'directo' });
  assert.equal(await revisarAvisosSueltos(m.ops, async () => [m.st.alerta]), 1);
  assert.equal(m.st.alerta.resuelta_por, 'sistema');
});

// ─── Correo con botones y página de acción ───────────────────────────────────

test('correo de respaldo: un botón por acción hacia /admin/transcriptor/accion, sin datos de la sesión', () => {
  const c = armarCorreo({ ...alerta(`resumen:${GID}`, { accion: 'reintentar_resumen', titulo: 'No se pudo generar el resumen', detalle: 'HTTP 529' }) }, 'https://www.valentinaorellana.cl/admin');
  const url = urlAccion('https://www.valentinaorellana.cl/admin', AID, 'reintentar_resumen');
  assert.equal(url, `https://www.valentinaorellana.cl/admin/transcriptor/accion?alerta=${AID}&accion=reintentar_resumen`);
  assert.ok(c.html.includes(url.replace(/&/g, '&amp;')));
  assert.ok(c.texto.includes(url));
  assert.ok(c.texto.includes(urlAccion('https://www.valentinaorellana.cl/admin', AID, 'revisar')));
  assert.match(c.html, /Reintentar resumen/); assert.match(c.html, /Volver a revisar/);
  assert.doesNotMatch(c.html + c.texto, /Marcar como resuelto/);
  const k = armarCorreo(alerta('salud:aai_huerfanos'), 'https://www.valentinaorellana.cl/admin');
  assert.match(k.texto, /accion=borrar_huerfanos/);
  const sinId = armarCorreo({ tipo: 'salud', titulo: 'x', detalle: null, veces: 1 }, 'https://www.valentinaorellana.cl/admin');
  assert.doesNotMatch(sinId.texto, /transcriptor\/accion/);
});

test('página de acción: nunca ejecuta por GET; POST con X-Panel al endpoint protegido; dice si ya se resolvió', () => {
  const t = readFileSync(new URL('../../pages/admin/transcriptor/accion.astro', import.meta.url), 'utf8');
  const frontmatter = t.split('---')[1];
  assert.doesNotMatch(frontmatter, /ejecutarAccionAviso/, 'el GET no ejecuta acciones');
  assert.match(t, /Hacerlo ahora/);
  assert.match(t, /method: 'POST'/);
  assert.match(t, /'X-Panel': '1'/);
  assert.match(t, /\/api\/admin\/transcriptor\/alertas/);
  assert.match(t, /Este aviso ya se resolvió/);
  assert.match(frontmatter, /tokenRevocado\(.*estricto: true/);
  const api = readFileSync(new URL('../../pages/api/admin/transcriptor/alertas.ts', import.meta.url), 'utf8');
  assert.match(api, /guardiaPanel\(ctx/);
  const get = api.slice(api.indexOf('export const GET'));
  assert.doesNotMatch(get, /ejecutarAccionAviso/, 'el GET del endpoint solo consulta');
});

// ─── "Volver a revisar" re-ejecuta SOLO ese chequeo ──────────────────────────

test('ejecutarSalud({ solo }): corre solo ese chequeo (aunque el transcriptor esté apagado) y cierra o mantiene su aviso', async () => {
  const env: Record<string, string> = Object.fromEntries([...VARIABLES_REQUERIDAS, 'TRANSCRIPTOR_KEK_V1'].map((n) => [n, 'x']));
  env.TRANSCRIPTOR_KEK_ACTIVA = 'v1';
  let probados = 0;
  const f: FuentesSalud = {
    async ajustes() { return { activo: false, botActivo: false, presupuestoClp: 35000, usdClp: 950 }; },
    env: (n) => env[n],
    async grabacionesNoTerminales() { throw new Error('no debía correr'); },
    async segmentosPendientesDeBorrar() { throw new Error('no debía correr'); },
    async transcripcionesSinCopiaB2() { return []; },
    async objetosAudioR2() { return []; },
    async ultimoRespaldo() { return null; },
    async costosMes() { return { audio: [], usdResumenes: 0, usdPreguntas: 0 }; },
    async grabacionesConAlertaAbierta() { return new Set(); },
    async probarR2() {}, async probarB2() {}, async probarAssemblyAI() {}, async probarAnthropic() { probados++; },
    vercel: () => vercelJson,
  };
  const resueltas: string[] = [];
  const guardadas: string[] = [];
  const r = await ejecutarSalud({
    fuentes: f, ahora: new Date('2026-10-16T12:00:00Z'), registrar: async () => {},
    resolverPorPrefijo: async (p) => { resueltas.push(p); return 1; },
    saludPrevia: async () => [], guardarSalud: async (fs) => { guardadas.push(...fs.map((x) => x.chequeo)); },
  }, { solo: ['anthropic'] });
  assert.equal(probados, 1);
  assert.deepEqual(r.resultados.map((x) => x.chequeo), ['anthropic']);
  assert.deepEqual(resueltas, ['salud:anthropic']);
  assert.deepEqual(guardadas, ['anthropic']);
});

test('auditoría seguridad: borrar_audio nunca borra (ni por antigüedad) el audio de una sesión sin transcripción guardada', () => {
  const limite = Date.parse('2026-10-16T00:00:00Z');
  const viejo = new Date('2026-10-15T00:00:00Z');
  const protegidas = new Set(['a/sin-transcribir.m4a']);
  assert.equal(audioViejoBorrable({ key: 'a/huerfano.m4a', modificado: viejo }, limite, protegidas), true);
  assert.equal(audioViejoBorrable({ key: 'a/sin-transcribir.m4a', modificado: viejo }, limite, protegidas), false);
  assert.equal(audioViejoBorrable({ key: 'a/nuevo.m4a', modificado: new Date('2026-10-16T10:00:00Z') }, limite, protegidas), false);
  assert.equal(audioViejoBorrable({ key: 'a/sin-fecha.m4a', modificado: null }, limite, protegidas), false);
});
