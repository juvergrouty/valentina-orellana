// Pruebas del chequeo diario (salud.ts) y del reporte mensual (reporte.ts) con datos falsos.
// Sin red ni base. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  borrarTranscriptsHuerfanos, calcularGastoUsd, clasificarHuerfanos, ejecutarSalud, fechaRespaldo, filaSalud, mesChile,
  revisarReglaMicrofono, VARIABLES_REQUERIDAS, type FuentesSalud, type ResultadoP8, type TranscriptAai,
} from './salud';
import { armarReporte, mesAnterior } from './reporte';
import type { NuevaAlerta } from './alertas';
import vercelJson from '../../../vercel.json';

const AHORA = new Date('2026-10-16T11:00:00Z');
const hace = (h: number) => new Date(AHORA.getTime() - h * 3600_000).toISOString();
const ENV_COMPLETO: Record<string, string> = Object.fromEntries([...VARIABLES_REQUERIDAS, 'TRANSCRIPTOR_KEK_V1'].map((n) => [n, 'x']));
ENV_COMPLETO.TRANSCRIPTOR_KEK_ACTIVA = 'v1';

function fuentesSanas(extra: Partial<FuentesSalud> = {}): FuentesSalud {
  return {
    async ajustes() { return { activo: true, botActivo: false, presupuestoClp: 35000, usdClp: 950 }; },
    env: (n) => ENV_COMPLETO[n],
    async grabacionesNoTerminales() { return []; },
    async segmentosPendientesDeBorrar() { return []; },
    async transcripcionesSinCopiaB2() { return []; },
    async objetosAudioR2() { return []; },
    async ultimoRespaldo() { return '20261012T030000Z\nrespaldos/supabase-20261012T030000Z.dump.age\nabc'; },
    async costosMes() { return { audio: [], usdResumenes: 0, usdPreguntas: 0 }; },
    async grabacionesConAlertaAbierta() { return new Set(); },
    async probarR2() {}, async probarB2() {}, async probarAssemblyAI() {}, async probarAnthropic() {},
    vercel: () => vercelJson,
    ...extra,
  };
}

async function correr(f: FuentesSalud, previas: Parameters<typeof filaSalud>[0][] = []) {
  const alertas: NuevaAlerta[] = [];
  const resueltas: { prefijo: string; salvo: readonly string[] }[] = [];
  let guardadas: ReturnType<typeof filaSalud>[] = [];
  const r = await ejecutarSalud({
    fuentes: f, ahora: AHORA, timeoutMs: 200,
    registrar: async (a) => { alertas.push(a); },
    resolverPorPrefijo: async (prefijo, salvo) => { resueltas.push({ prefijo, salvo }); return 0; },
    saludPrevia: async () => previas as never,
    guardarSalud: async (filas) => { guardadas = filas; },
  });
  return { r, alertas, resueltas, guardadas };
}

test('todo sano: ninguna alerta, se guarda cada chequeo y se cierran las alertas viejas', async () => {
  const { r, alertas, guardadas, resueltas } = await correr(fuentesSanas());
  assert.equal(r.ok, true);
  assert.deepEqual(alertas, []);
  const nombres = guardadas.map((g) => g.chequeo).sort();
  assert.deepEqual(nombres, ['aai_borrado', 'aai_huerfanos', 'anthropic', 'assemblyai', 'atascadas', 'audio_borrado', 'b2', 'config', 'copias_b2', 'gasto', 'permisos_microfono', 'r2', 'respaldo_supabase']);
  assert.ok(guardadas.every((g) => g.ok && g.fallo_desde === null && g.ultimo_ok_at === AHORA.toISOString()));
  assert.ok(resueltas.some((x) => x.prefijo === 'salud:respaldo_supabase' && x.salvo.length === 0));
});

test('transcriptor apagado: no revisa llaves ni proveedores, solo datos y micrófono', async () => {
  let llamado = false;
  const f = fuentesSanas({
    async ajustes() { return { activo: false, botActivo: false, presupuestoClp: 35000, usdClp: 950 }; },
    env: () => undefined,
    async probarR2() { llamado = true; throw new Error('no'); },
  });
  const { r, alertas, guardadas } = await correr(f);
  assert.equal(r.ok, true); assert.equal(r.activo, false); assert.equal(llamado, false);
  assert.deepEqual(alertas, []);
  assert.ok(!guardadas.some((g) => g.chequeo === 'config' || g.chequeo === 'r2'));
});

test('config: variables faltantes (solo nombres), KEK activa sin su llave, y las del bot si está activo', async () => {
  const env = { ...ENV_COMPLETO, TRANSCRIPTOR_KEK_ACTIVA: 'v2' } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY;
  const f = fuentesSanas({
    env: (n) => env[n],
    async ajustes() { return { activo: true, botActivo: true, presupuestoClp: 35000, usdClp: 950 }; },
  });
  const { alertas } = await correr(f);
  const a = alertas.find((x) => x.clave === 'salud:config')!;
  assert.equal(a.tipo, 'config');
  for (const n of ['ANTHROPIC_API_KEY', 'TRANSCRIPTOR_KEK_V2', 'FLY_API_TOKEN', 'BOT_TOKEN_SECRET']) assert.match(a.detalle!, new RegExp(n));
  assert.doesNotMatch(a.detalle!, /=\s*x\b/, 'nunca valores');
});

test('proveedores: cada uno que falla da su alerta con su clave; uno colgado cae por tiempo', async () => {
  const f = fuentesSanas({
    async probarR2() { throw new Error('AccessDenied 403'); },
    async probarAssemblyAI() { throw new Error('la llave fue rechazada (HTTP 401)'); },
    probarAnthropic: () => new Promise(() => {}), // nunca responde
  });
  const { r, alertas } = await correr(f);
  assert.equal(r.ok, false);
  const claves = alertas.map((a) => a.clave).sort();
  assert.deepEqual(claves, ['salud:anthropic:no_revisado', 'salud:assemblyai', 'salud:r2']);
  assert.match(alertas.find((a) => a.clave === 'salud:r2')!.titulo, /Cloudflare R2/);
  assert.ok(r.resultados.find((x) => x.chequeo === 'anthropic')!.revisado === false);
});

test('atascadas: >2 h en estado intermedio; error sin aviso; respeta avisos ya abiertos y teléfono a las 12 h', async () => {
  const f = fuentesSanas({
    async grabacionesNoTerminales() {
      return [
        { id: 'g-trans', estado: 'transcribiendo', estado_antes_error: null, origen: 'online', updated_at: hace(3), hora_fin_prevista: null },
        { id: 'g-res', estado: 'resumiendo', estado_antes_error: null, origen: 'presencial', updated_at: hace(5), hora_fin_prevista: null },
        { id: 'g-reciente', estado: 'subida', estado_antes_error: null, origen: 'online', updated_at: hace(1), hora_fin_prevista: null },
        { id: 'g-err', estado: 'error', estado_antes_error: 'transcrita', origen: 'online', updated_at: hace(1), hora_fin_prevista: null },
        { id: 'g-err-con-aviso', estado: 'error', estado_antes_error: 'subida', origen: 'online', updated_at: hace(1), hora_fin_prevista: null },
        { id: 'g-err-bot', estado: 'error', estado_antes_error: 'grabando', origen: 'online', updated_at: hace(1), hora_fin_prevista: null },
        { id: 'g-online-futura', estado: 'creada', estado_antes_error: null, origen: 'online', updated_at: hace(48), hora_fin_prevista: new Date(AHORA.getTime() + 3600_000).toISOString() },
        { id: 'g-tel-6h', estado: 'creada', estado_antes_error: null, origen: 'presencial', updated_at: hace(6), hora_fin_prevista: null },
        { id: 'g-tel-13h', estado: 'creada', estado_antes_error: null, origen: 'presencial', updated_at: hace(13), hora_fin_prevista: null },
        { id: 'g-tel-abandonada', estado: 'creada', estado_antes_error: null, origen: 'presencial', updated_at: hace(24 * 9), hora_fin_prevista: null },
      ];
    },
    async grabacionesConAlertaAbierta() { return new Set(['g-err-con-aviso']); },
  });
  const { alertas, resueltas } = await correr(f);
  const por = new Map(alertas.map((a) => [a.grabacionId, a]));
  assert.deepEqual([...por.keys()].sort(), ['g-err', 'g-err-bot', 'g-res', 'g-tel-13h', 'g-trans']);
  assert.equal(por.get('g-err-bot')!.accion, 'revisar', 'online caído en grabando: no hay reintento posible');
  assert.equal(por.get('g-trans')!.tipo, 'transcripcion'); assert.equal(por.get('g-trans')!.accion, 'reintentar');
  assert.equal(por.get('g-res')!.tipo, 'resumen'); assert.equal(por.get('g-res')!.accion, 'reintentar_resumen');
  assert.equal(por.get('g-err')!.accion, 'reintentar_resumen');
  assert.equal(por.get('g-tel-13h')!.accion, 'revisar'); assert.match(por.get('g-tel-13h')!.titulo, /teléfono/);
  assert.equal(por.get('g-trans')!.clave, 'salud:atascadas:g-trans');
  const r = resueltas.find((x) => x.prefijo === 'salud:atascadas')!;
  assert.ok(r.salvo.includes('salud:atascadas:g-trans'), 'no cierra las que siguen fallando');
});

test('audio que debió borrarse (base y bucket) y transcripts de AssemblyAI sin borrar', async () => {
  const f = fuentesSanas({
    async segmentosPendientesDeBorrar() {
      return [
        { grabacion_id: 'g1', estado_grabacion: 'lista', audio_borrado_at: null, aai_transcript_id: 't1', aai_estado: 'completed', aai_borrado_at: null, referencia_at: hace(3) },
        { grabacion_id: 'g2', estado_grabacion: 'transcrita', audio_borrado_at: null, aai_transcript_id: 't2', aai_estado: 'completed', aai_borrado_at: null, referencia_at: hace(0.5) }, // en gracia
        { grabacion_id: 'g3', estado_grabacion: 'transcribiendo', audio_borrado_at: null, aai_transcript_id: 't3', aai_estado: 'processing', aai_borrado_at: null, referencia_at: hace(5) }, // en curso
        { grabacion_id: 'g4', estado_grabacion: 'lista', audio_borrado_at: hace(4), aai_transcript_id: 't4', aai_estado: 'completed', aai_borrado_at: null, referencia_at: hace(5) },
      ];
    },
    async objetosAudioR2() { return [{ key: 'a/x.m4a', modificado: new Date(AHORA.getTime() - 30 * 3600_000) }, { key: 'a/y.m4a', modificado: new Date(AHORA.getTime() - 3600_000) }]; },
  });
  const { alertas, guardadas } = await correr(f);
  const audio = alertas.find((a) => a.clave === 'salud:audio_borrado')!;
  assert.match(audio.detalle!, /1 audio\(s\) de 1 sesión/);
  assert.match(audio.detalle!, /1 archivo\(s\) de audio con más de 1 día/);
  const aai = alertas.find((a) => a.clave === 'salud:aai_borrado')!;
  assert.match(aai.detalle!, /^2 transcript/);
  assert.deepEqual(guardadas.find((g) => g.chequeo === 'aai_borrado')!.detalle, { transcripts: 2, grabaciones: 2 });
});

test('copias en B2 faltantes y respaldo semanal viejo o ausente', async () => {
  const { alertas } = await correr(fuentesSanas({
    async transcripcionesSinCopiaB2() { return [{ id: 't1', grabacion_id: 'g1', created_at: hace(2) }]; },
    async ultimoRespaldo() { return '20261005T030000Z\nrespaldos/x\nabc'; },
  }));
  assert.equal(alertas.find((a) => a.clave === 'salud:copias_b2')!.tipo, 'respaldo');
  assert.match(alertas.find((a) => a.clave === 'salud:respaldo_supabase')!.titulo, /tiene 11 días/);
  const sin = await correr(fuentesSanas({ async ultimoRespaldo() { return null; } }));
  assert.match(sin.alertas.find((a) => a.clave === 'salud:respaldo_supabase')!.titulo, /No se encontró/);
  assert.equal(fechaRespaldo('basura'), null);
  assert.equal(fechaRespaldo('20261012T030000Z')!.toISOString(), '2026-10-12T03:00:00.000Z');
});

test('gasto: alerta al 90 % del presupuesto y cuando la proyección se pasa', async () => {
  // 30 h de universal-3-5-pro = US$6,3 + US$24 de resúmenes = US$30,3 → × 950 × 1,19 ≈ $34.254 (≥ 90 % de 35.000)
  const caro = await correr(fuentesSanas({ async costosMes() { return { audio: [{ seg: 30 * 3600, modelo: 'universal-3-5-pro', diarizacion: false }], usdResumenes: 24, usdPreguntas: 0 }; } }));
  const a = caro.alertas.find((x) => x.clave === 'salud:gasto')!;
  assert.equal(a.tipo, 'costo');
  assert.match(a.titulo, /98 % del presupuesto/);
  // Día 16: $17.000 a la fecha → proyección ≈ $32.938 (bajo 35.000): sin alerta. $20.000 → proyección > 35.000: alerta.
  const usd = (clp: number) => clp / 950 / 1.19;
  const ok = await correr(fuentesSanas({ async costosMes() { return { audio: [], usdResumenes: usd(17000), usdPreguntas: 0 }; } }));
  assert.ok(!ok.alertas.some((x) => x.clave === 'salud:gasto'));
  const proy = await correr(fuentesSanas({ async costosMes() { return { audio: [], usdResumenes: usd(20000), usdPreguntas: 0 }; } }));
  assert.match(proy.alertas.find((x) => x.clave === 'salud:gasto')!.titulo, /se pasa del presupuesto/);
  const g = calcularGastoUsd({ audio: [{ seg: 3600, modelo: 'universal-2', diarizacion: true }], usdResumenes: 1, usdPreguntas: 0.5 });
  assert.ok(Math.abs(g.assemblyai - 0.17) < 1e-9 && g.anthropic === 1.5 && Math.abs(g.total - 1.67) < 1e-9);
});

test('regla del micrófono: la de vercel.json actual pasa; se detecta si se rompe', async () => {
  assert.deepEqual(revisarReglaMicrofono(vercelJson), { ok: true });
  const copia = structuredClone(vercelJson) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
  const grabar = copia.headers.find((h) => h.source === '/admin/grabar')!;
  grabar.headers.find((h) => h.key === 'Permissions-Policy')!.value = 'camera=(), microphone=(), geolocation=()';
  assert.equal(revisarReglaMicrofono(copia).ok, false);
  const copia2 = structuredClone(vercelJson) as typeof copia;
  copia2.headers.find((h) => h.source === '/((?!admin/grabar$).*)')!.headers.find((h) => h.key === 'Permissions-Policy')!.value = 'camera=(), microphone=*';
  assert.equal(revisarReglaMicrofono(copia2).ok, false);
  const { alertas } = await correr(fuentesSanas({ vercel: () => copia }));
  assert.equal(alertas.find((a) => a.clave === 'salud:permisos_microfono')!.tipo, 'config');
});

test('fila de salud: fallo_desde se conserva mientras siga fallando y se limpia al volver a OK', () => {
  const malo: ResultadoP8 = { chequeo: 'r2', ok: false, alertas: [{ tipo: 'salud', titulo: 'x', clave: 'salud:r2' }] };
  const f1 = filaSalud(undefined, malo, AHORA);
  assert.equal(f1.fallo_desde, AHORA.toISOString()); assert.equal(f1.ultimo_ok_at, null); assert.equal(f1.alertado_at, AHORA.toISOString());
  const despues = new Date(AHORA.getTime() + 86400_000);
  const f2 = filaSalud(f1, malo, despues);
  assert.equal(f2.fallo_desde, AHORA.toISOString());
  const f3 = filaSalud(f2, { chequeo: 'r2', ok: true, alertas: [] }, despues);
  assert.equal(f3.fallo_desde, null); assert.equal(f3.ultimo_ok_at, despues.toISOString()); assert.equal(f3.alertado_at, despues.toISOString());
});

test('si no se puede guardar transcriptor_salud, se avisa', async () => {
  const alertas: NuevaAlerta[] = [];
  await ejecutarSalud({
    fuentes: fuentesSanas(), ahora: AHORA,
    registrar: async (a) => { alertas.push(a); }, resolverPorPrefijo: async () => 0,
    saludPrevia: async () => [], guardarSalud: async () => { throw new Error('relation does not exist'); },
  });
  assert.equal(alertas.length, 1); assert.equal(alertas[0].clave, 'salud:registro');
});

test('mes de Chile y mes anterior', () => {
  const m = mesChile(new Date('2026-11-01T02:00:00Z')); // 31 oct 23:00 en Chile
  assert.equal(m.etiqueta, '2026-10');
  assert.equal(mesAnterior(new Date('2026-11-01T12:00:00Z')), '2026-10');
  assert.equal(mesAnterior(new Date('2026-01-01T12:00:00Z')), '2025-12');
  assert.equal(mesChile(AHORA).diasMes, 31);
});

test('reporte mensual: conteos, costos por proveedor y tiempos, sin ids ni texto', () => {
  const d = armarReporte({
    mes: '2026-10',
    grabaciones: [
      { id: 'g1', estado: 'lista', origen: 'presencial', tipo: 'individual', modelo: 'universal-3-5-pro', diarizacion: false, fin_at: '2026-10-10T15:00:00Z', intentos: 0 },
      { id: 'g2', estado: 'lista', origen: 'online', tipo: 'pareja', modelo: 'universal-2', diarizacion: false, fin_at: '2026-10-11T15:00:00Z', intentos: 1 },
      { id: 'g3', estado: 'error', origen: 'online', tipo: 'individual', modelo: 'universal-2', diarizacion: false, fin_at: null, intentos: 2 },
    ],
    segmentos: [{ grabacion_id: 'g1', aai_audio_seg: 3600 }, { grabacion_id: 'g2', aai_audio_seg: 1800 }, { grabacion_id: 'g2', aai_audio_seg: 1800 }],
    resumenes: [
      { grabacion_id: 'g1', estado: 'listo', autor: 'ia', costo_usd: 0.1, listo_at: '2026-10-10T15:30:00Z', intentos: 1 },
      { grabacion_id: 'g2', estado: 'listo', autor: 'ia', costo_usd: 0.1, listo_at: '2026-10-11T17:30:00Z', intentos: 1 },
      { grabacion_id: 'g2', estado: 'listo', autor: 'vale', costo_usd: null, listo_at: '2026-10-12T10:00:00Z', intentos: 0 },
    ],
    preguntas: [{ costo_usd: 0.01, error: null }, { costo_usd: null, error: 'x' }],
    alertas: [{ tipo: 'transcripcion', veces: 3, resuelta_por: 'vale' }, { tipo: 'salud', veces: 1, resuelta_por: null }],
    reintentosManuales: 1, usdClp: 950, presupuestoClp: 35000,
  }) as Record<string, any>;
  assert.equal(d.sesiones.total, 3); assert.equal(d.sesiones.listas, 2);
  assert.deepEqual(d.sesiones.por_origen, { presencial: 1, online: 2 });
  assert.deepEqual(d.audio.horas_por_modelo, { 'universal-3-5-pro': 1, 'universal-2': 1 });
  assert.equal(d.costos_usd.assemblyai, 0.36); assert.equal(d.costos_usd.anthropic_resumenes, 0.2); assert.equal(d.costos_usd.anthropic_preguntas, 0.01);
  assert.equal(d.costos_clp_con_iva.total, Math.round(0.57 * 950 * 1.19));
  assert.equal(d.fallas.alertas_total, 2); assert.equal(d.fallas.repeticiones_total, 4); assert.equal(d.fallas.abiertas, 1);
  assert.equal(d.fallas.grabaciones_en_error, 1); assert.equal(d.fallas.preguntas_con_error, 1);
  assert.deepEqual(d.tiempos.fin_sesion_a_resumen_min, { n: 2, media: 90, p50: 30, p90: 150, max: 150 });
  assert.equal(d.tiempos.resumen_en_menos_de_2h_pct, 50);
  const txt = JSON.stringify(d);
  assert.doesNotMatch(txt, /"g[123]"/, 'sin ids de grabación');
});

// ─── Transcripts huérfanos en AssemblyAI (revisión de seguridad 16 oct, M4) ───
const T = (id: string, h: number, status = 'completed', borrado = false): TranscriptAai => ({ id, created: hace(h), status, borrado });

test('clasificarHuerfanos: activos se ignoran; identificados y desconocidos > 2 h se cuentan', () => {
  const lista = [
    T('activo', 5),                       // su segmento sigue vivo → lo ve 'aai_borrado'
    T('ya-borrado-en-base', 5),           // segmento con aai_borrado_at pero sigue en AAI → identificado
    T('duplicado-webhook', 5),            // sin segmento, llegó su webhook con nuestro secreto → identificado
    T('desconocido', 5),                  // nadie lo reconoce → no se borra solo
    T('reciente', 1),                     // < 2 h: en gracia
    T('procesando', 5, 'processing'),     // huérfano, pero no se puede borrar aún
    T('borrado-aai', 5, 'completed', true),
  ];
  const h = clasificarHuerfanos(lista, {
    segmentos: [{ aai_transcript_id: 'activo', aai_borrado_at: null }, { aai_transcript_id: 'ya-borrado-en-base', aai_borrado_at: hace(4) }],
    webhooks: ['duplicado-webhook'],
  }, AHORA);
  assert.deepEqual(h, [
    { id: 'ya-borrado-en-base', clase: 'identificado', borrable: true },
    { id: 'duplicado-webhook', clase: 'identificado', borrable: true },
    { id: 'desconocido', clase: 'desconocido', borrable: true },
    { id: 'procesando', clase: 'desconocido', borrable: false },
  ]);
});

test('borrarTranscriptsHuerfanos: por defecto solo identificados; desconocidos solo si se pide', async () => {
  const h = [
    { id: 'a', clase: 'identificado' as const, borrable: true },
    { id: 'b', clase: 'desconocido' as const, borrable: true },
    { id: 'c', clase: 'identificado' as const, borrable: false },
    { id: 'd', clase: 'identificado' as const, borrable: true },
  ];
  const borrados: string[] = [];
  const r = await borrarTranscriptsHuerfanos(h, async (id) => { if (id === 'd') throw new Error('red'); borrados.push(id); });
  assert.deepEqual(r, { borrados: ['a'], fallidos: ['d'], omitidos: ['b', 'c'] });
  const r2 = await borrarTranscriptsHuerfanos(h, async () => {}, { incluirDesconocidos: true });
  assert.deepEqual(r2.borrados, ['a', 'b', 'd']);
});

test('chequeo diario: borra los huérfanos identificados y avisa en el panel por los desconocidos', async () => {
  const borrados: string[] = [];
  const { alertas, guardadas } = await correr(fuentesSanas({
    async listarTranscriptsAai() { return [T('nuestro', 6), T('ajeno', 6), T('activo', 6)]; },
    async origenTranscriptsAai(ids) {
      assert.deepEqual(ids.sort(), ['activo', 'ajeno', 'nuestro']);
      return { segmentos: [{ aai_transcript_id: 'activo', aai_borrado_at: null }], webhooks: ['nuestro'] };
    },
    async borrarTranscriptAai(id) { borrados.push(id); },
  }));
  assert.deepEqual(borrados, ['nuestro']);              // el desconocido NO se borra solo
  const a = alertas.find((x) => x.clave === 'salud:aai_huerfanos')!;
  assert.ok(a, 'alerta de huérfanos');
  assert.match(a.detalle!, /1 transcript\(s\) en AssemblyAI que ninguna sesión/);
  assert.ok(!a.detalle!.includes('ajeno'));            // sin ids en el texto
  const fila = guardadas.find((g) => g.chequeo === 'aai_huerfanos')!;
  assert.equal(fila.ok, false);
  assert.deepEqual(fila.detalle, { listados: 3, huerfanos: 2, borrados: 1, fallidos: 0, desconocidos: 1 });
});

test('chequeo diario: si todos los huérfanos eran nuestros y se borraron, queda OK y sin aviso', async () => {
  const { alertas, guardadas } = await correr(fuentesSanas({
    async listarTranscriptsAai() { return [T('nuestro', 6)]; },
    async origenTranscriptsAai() { return { segmentos: [{ aai_transcript_id: 'nuestro', aai_borrado_at: hace(5) }], webhooks: [] }; },
    async borrarTranscriptAai() {},
  }));
  assert.equal(alertas.filter((x) => x.clave === 'salud:aai_huerfanos').length, 0);
  assert.equal(guardadas.find((g) => g.chequeo === 'aai_huerfanos')!.ok, true);
});
