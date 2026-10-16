// Pruebas de los avisos inmediatos del robot de Meet (avisosRobot.ts + su clase y acción en
// accionesAlerta.ts). Sin red. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertaDeAvisoRobot, alertaDeErrorBot, CLAVE_ROBOT_SESION, esMotivoSinSesion, pasoDeErrorBot } from './avisosRobot';
import { accionesDisponibles, alertaSuperada, claseDe, ejecutarAccionAviso, etiquetaAccion, INFO_ACCION, instruccionDe, revisarAvisosSueltos, type OpsAcciones } from './accionesAlerta';
import { normalizarAlerta, type AlertaFila, type SesionDeAlerta } from './alertas';

const GID = '3f2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b';
const fila = (n: ReturnType<typeof normalizarAlerta>, extra: Partial<AlertaFila> = {}): AlertaFila => ({
  id: 'a1', creada_at: '2026-10-16T20:00:00Z', tipo: n.tipo, titulo: n.titulo, detalle: n.detalle, grabacion_id: n.grabacionId,
  accion: n.accion, clave: n.clave, veces: 1, ultima_vez: '2026-10-16T20:00:00Z', resuelta_at: null, resuelta_por: null, correo_enviado_at: null, ...extra,
});
const sesion = (estado: SesionDeAlerta['estado'], extra: Partial<SesionDeAlerta> = {}): SesionDeAlerta => ({
  session_date: '2026-10-16', inicio_at: null, origen: 'online', estado, estado_antes_error: null, patient_id: 'p1', paciente: 'X',
  hora_fin_prevista: '2026-10-16T23:00:00Z', bot_machine_id: 'm1', segmentos_subidos: 0, b2_pendientes: 0, ...extra,
});

test('rótulo: "Cerrar con lo grabado"', () => {
  assert.equal(INFO_ACCION.rescatar.etiqueta, 'Cerrar con lo grabado');
});

test('avisos del robot: claves, sin datos de pacientes y acción "Volver a revisar"', () => {
  const a = normalizarAlerta(alertaDeAvisoRobot('robot_sin_sesion'));
  const b = normalizarAlerta(alertaDeAvisoRobot('robot_sesion_vencida', { motivo: 'Google pidió iniciar sesión' }));
  assert.equal(a.clave, CLAVE_ROBOT_SESION);
  assert.equal(b.clave, CLAVE_ROBOT_SESION, 'sin sesión y vencida son el mismo problema: un solo aviso');
  assert.equal(a.grabacionId, null);
  assert.equal(a.accion, 'revisar');
  assert.match(a.detalle ?? '', /§7\.3/);
  assert.match(b.detalle ?? '', /Google pidió iniciar sesión/);
  const c = normalizarAlerta(alertaDeAvisoRobot('robot_no_invitado', { grabacionId: GID }));
  assert.equal(c.clave, `robot-invitado:${GID}`);
  assert.equal(c.grabacionId, GID);
  assert.equal(esMotivoSinSesion('sin_sesion'), true);
  assert.equal(esMotivoSinSesion('dañada'), true);
  assert.equal(esMotivoSinSesion('ocupada'), false);
  assert.equal(esMotivoSinSesion('carrera'), false);
});

test('error del robot: el aviso queda en el paso en que estaba y se cierra cuando lo pasa', () => {
  assert.equal(pasoDeErrorBot('bot_lanzando'), 'bot_lanzando');
  assert.equal(pasoDeErrorBot('bot_en_lobby'), 'bot_en_lobby');
  assert.equal(pasoDeErrorBot('grabando'), 'grabando');
  assert.equal(pasoDeErrorBot('pausada'), 'grabando');
  const lobby = fila(normalizarAlerta(alertaDeErrorBot(GID, 'bot_en_lobby', 'x')));
  assert.deepEqual(claseDe(lobby), { k: 'paso', paso: 'bot_en_lobby' });
  assert.equal(alertaSuperada(lobby, sesion('bot_en_lobby')), false, 'sigue en la sala: el aviso sigue');
  assert.equal(alertaSuperada(lobby, sesion('grabando')), true, 'entró a grabar: arreglado');
  const grab = fila(normalizarAlerta(alertaDeErrorBot(GID, 'grabando', 'x')));
  assert.deepEqual(claseDe(grab), { k: 'paso', paso: 'grabando' });
  assert.equal(alertaSuperada(grab, sesion('grabando')), false);
  assert.equal(alertaSuperada(grab, sesion('subida')), true, 'el audio quedó subido');
  // Si la sesión cae en error sin poder volver, la acción es "Cerrar con lo grabado".
  const caida = sesion('error', { estado_antes_error: 'grabando', segmentos_subidos: 2 });
  assert.deepEqual(accionesDisponibles(grab, caida), ['rescatar', 'revisar']);
  assert.equal(etiquetaAccion('rescatar', caida), 'Transcribir lo que alcanzó a grabarse');
  // Mientras el robot sigue grabando: solo "Volver a revisar" + qué hacer.
  assert.deepEqual(accionesDisponibles(grab, sesion('grabando')), ['revisar']);
  assert.ok(instruccionDe(grab, sesion('grabando')));
});

test('robot no invitado: informativo, se cierra cuando el robot entra a grabar', () => {
  const f = fila(normalizarAlerta(alertaDeAvisoRobot('robot_no_invitado', { grabacionId: GID })));
  assert.deepEqual(claseDe(f), { k: 'info', paso: 'bot_en_lobby' });
  assert.deepEqual(accionesDisponibles(f, sesion('bot_en_lobby')), ['revisar']);
  assert.equal(alertaSuperada(f, sesion('bot_en_lobby')), false);
  assert.equal(alertaSuperada(f, sesion('grabando')), true);
  assert.match(instruccionDe(f, sesion('bot_en_lobby')) ?? '', /admítelo en Meet/);
});

test('robot:sesion: "Volver a revisar" lo cierra solo si la sesión volvió (o modo invitado); el diario también lo revisa', async () => {
  const f = fila(normalizarAlerta(alertaDeAvisoRobot('robot_sin_sesion')));
  assert.deepEqual(claseDe(f), { k: 'robot_sesion' });
  assert.deepEqual(accionesDisponibles(f, undefined), ['revisar']);
  assert.match(instruccionDe(f, undefined) ?? '', /iniciar sesión en la cuenta del robot/);

  let ok = false;
  let cerrada = false;
  const ops = {
    obtenerAlerta: async () => ({ ...f, resuelta_at: cerrada ? 'x' : null }),
    cerrarAlerta: async () => { cerrada = true; return true; },
    robotSesionOk: async () => ok,
  } as unknown as OpsAcciones;
  const r1 = await ejecutarAccionAviso(f.id, 'revisar', ops);
  assert.equal(r1.cerrada, false);
  assert.match(r1.mensaje, /todavía no tiene una sesión vigente/);
  ok = true;
  const r2 = await ejecutarAccionAviso(f.id, 'revisar', ops);
  assert.equal(r2.cerrada, true);
  assert.equal(cerrada, true);

  cerrada = false;
  assert.equal(await revisarAvisosSueltos(ops, async () => [f]), 1, 'el chequeo diario también lo cierra');
});
