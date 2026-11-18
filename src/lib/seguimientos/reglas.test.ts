// Pruebas de los seguimientos automáticos (18 nov 2026). Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fechaEnPalabras, sumarDias, diasEntre, enHorarioDeEnvio, primerNombre, normalizarTelefono, mismoTelefono,
  detectarCodigo, intervaloHabitual, pasoConsulta, pasoPaciente, cobroPendienteVencido, elegirCanal,
  enviadosRecientes, sePuedeReintentar, DIA_MS, type Consulta,
} from './reglas';
import { textoWhatsapp, correoTextoPlano, PLANTILLAS, variablesPlantilla } from './textos';

// Reloj de pared de Chile (como lo entrega nowCL): campos locales = hora de Chile.
const reloj = (iso: string) => { const [d, t] = iso.split('T'); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, m - 1, dd, h, mi); };

test('fecha en palabras', () => {
  assert.equal(fechaEnPalabras('2026-11-17'), 'martes 17 de noviembre');
  assert.equal(fechaEnPalabras('2026-11-01'), 'domingo 1 de noviembre');
  assert.equal(sumarDias('2026-12-30', 3), '2027-01-02');
  assert.equal(diasEntre('2026-11-01', '2026-12-01'), 30);
});

test('horario de envío: lunes a sábado de 10:00 a 20:00, sin feriados', () => {
  assert.equal(enHorarioDeEnvio(reloj('2026-11-16T10:00')), true);   // lunes
  assert.equal(enHorarioDeEnvio(reloj('2026-11-16T09:59')), false);
  assert.equal(enHorarioDeEnvio(reloj('2026-11-16T19:59')), true);
  assert.equal(enHorarioDeEnvio(reloj('2026-11-16T20:00')), false);
  assert.equal(enHorarioDeEnvio(reloj('2026-11-21T12:00')), true);   // sábado
  assert.equal(enHorarioDeEnvio(reloj('2026-11-22T12:00')), false);  // domingo
  assert.equal(enHorarioDeEnvio(reloj('2026-12-08T12:00'), new Set(['2026-12-08'])), false); // feriado
});

test('nombres, teléfonos y código del sitio', () => {
  assert.equal(primerNombre('maría josé pérez'), 'María');
  assert.equal(primerNombre(''), '');
  assert.equal(primerNombre('+56912345678'), '');
  assert.equal(normalizarTelefono('+56 9 1234 5678'), '56912345678');
  assert.equal(normalizarTelefono('912345678'), '56912345678');
  assert.equal(normalizarTelefono('12'), null);
  assert.equal(mismoTelefono('56912345678', '9 1234 5678'), true);
  assert.equal(mismoTelefono('56912345678', '56912345679'), false);
  assert.equal(detectarCodigo('Hola Valentina, me gustaría saber más. (código G-7K3Q)'), 'G-7K3Q');
  assert.equal(detectarCodigo('codigo m7k3q'), 'M-7K3Q');
  assert.equal(detectarCodigo('Hola, soy tu prima'), null);
  assert.equal(detectarCodigo('código G-7K3O'), null); // la O no existe en el alfabeto del sitio
});

test('intervalo habitual entre sesiones', () => {
  assert.equal(intervaloHabitual(['2026-11-01']), 7);
  assert.equal(intervaloHabitual(['2026-10-01', '2026-10-15', '2026-10-29']), 14);
  assert.equal(intervaloHabitual(['2026-10-01', '2026-10-08', '2026-10-15', '2026-11-12']), 7); // mediana, no promedio
  assert.equal(intervaloHabitual(['2026-10-01', '2026-10-01']), 7); // misma fecha repetida
});

// ─── Secuencia 1 ───
const T0 = Date.parse('2026-11-02T15:00:00Z'); // respuesta de Vale
const base: Consulta = { estado: 'activa', no_escribir: false, ultimo_entrante_at: '2026-11-02T14:00:00Z', ultima_respuesta_vale_at: new Date(T0).toISOString() };

test('1A: solo después de su respuesta, a los 3 días y sin mensaje nuevo', () => {
  assert.equal(pasoConsulta({ ...base, ultima_respuesta_vale_at: null }, [], false, T0 + 10 * DIA_MS).paso, null);
  assert.equal(pasoConsulta(base, [], false, T0 + 3 * DIA_MS - 1).paso, null);
  assert.equal(pasoConsulta(base, [], false, T0 + 3 * DIA_MS).paso, '1A');
  // Le escribió después de la respuesta de Vale: le toca a Vale.
  assert.equal(pasoConsulta({ ...base, ultimo_entrante_at: new Date(T0 + DIA_MS).toISOString() }, [], false, T0 + 5 * DIA_MS).paso, null);
});

test('1B: 7 días después de 1A; después "No siguió"', () => {
  const a = { paso: '1A', enviado_at: new Date(T0 + 3 * DIA_MS).toISOString() };
  assert.equal(pasoConsulta(base, [a], false, T0 + 9 * DIA_MS).paso, null);
  assert.equal(pasoConsulta(base, [a], false, T0 + 10 * DIA_MS).paso, '1B');
  const b = { paso: '1B', enviado_at: new Date(T0 + 10 * DIA_MS).toISOString() };
  const d = pasoConsulta(base, [a, b], false, T0 + 30 * DIA_MS);
  assert.equal(d.paso, null);
  assert.equal(d.nuevoEstado, 'no_siguio');
});

test('Secuencia 1 se detiene: agenda, responde o "No escribir"', () => {
  const a = { paso: '1A', enviado_at: new Date(T0 + 3 * DIA_MS).toISOString() };
  const agendo = pasoConsulta(base, [], true, T0 + 5 * DIA_MS);
  assert.equal(agendo.paso, null); assert.equal(agendo.nuevoEstado, 'agendo');
  const respondio = pasoConsulta({ ...base, ultimo_entrante_at: new Date(T0 + 4 * DIA_MS).toISOString() }, [a], false, T0 + 20 * DIA_MS);
  assert.equal(respondio.paso, null); assert.equal(respondio.nuevoEstado, 'respondio');
  assert.equal(pasoConsulta({ ...base, no_escribir: true }, [], false, T0 + 5 * DIA_MS).paso, null);
  assert.equal(pasoConsulta({ ...base, estado: 'respondio' }, [], false, T0 + 5 * DIA_MS).paso, null);
});

test('1A con error anterior (sin enviado_at) se puede reintentar', () => {
  assert.equal(pasoConsulta(base, [{ paso: '1A', enviado_at: null }], false, T0 + 4 * DIA_MS).paso, '1A');
});

// ─── Secuencias 2 y 3 ───
const s = (session_date: string, extra: Record<string, unknown> = {}) => ({ session_date, status: 'confirmed', ...extra });

test('2A: intervalo habitual + 3 días, sin próxima hora', () => {
  const ses = [s('2026-10-20'), s('2026-10-27'), s('2026-11-03')]; // cada 7
  assert.deepEqual(pasoPaciente(ses, '2026-11-12'), { tipo: null, motivo: 'Al día (cada 7 días)' });
  const d = pasoPaciente(ses, '2026-11-13'); // 10 días = 7 + 3
  assert.equal(d.tipo, '2A');
  assert.equal(d.tipo && d.referencia, '2026-11-03');
  assert.equal(pasoPaciente([...ses, s('2026-11-20')], '2026-11-13').tipo, null); // tiene próxima hora
  assert.equal(pasoPaciente([...ses, s('2026-11-20', { status: 'cancelled' })], '2026-11-13').tipo, '2A');
  assert.equal(pasoPaciente([s('2026-11-03')], '2026-11-13').tipo, '2A'); // una sola sesión: 7 + 3
});

test('3A: 30 días o más; nunca Sin costo ni inasistencias como última sesión', () => {
  assert.equal(pasoPaciente([s('2026-10-01')], '2026-10-31').tipo, '3A');
  assert.equal(pasoPaciente([s('2026-10-01')], '2026-10-30').tipo, '2A');
  assert.equal(pasoPaciente([s('2026-10-01', { payment_note: 'Sin costo' })], '2026-10-31').tipo, null);
  const d = pasoPaciente([s('2026-10-01'), s('2026-10-25', { no_show: true })], '2026-10-31');
  assert.equal(d.tipo && d.ultima, '2026-10-01');
});

// ─── Secuencia 4 ───
test('4A: sin pagar, 2 a 7 días después, sin Sin costo, transferencias ni pago en consulta', () => {
  const b = { session_date: '2026-11-16', status: 'confirmed', amount: 45000, paid_at: null, notes: '' };
  assert.equal(cobroPendienteVencido(b, '2026-11-17'), false);
  assert.equal(cobroPendienteVencido(b, '2026-11-18'), true);
  assert.equal(cobroPendienteVencido(b, '2026-11-23'), true);
  assert.equal(cobroPendienteVencido(b, '2026-11-24'), false);
  assert.equal(cobroPendienteVencido({ ...b, paid_at: '2026-11-16T12:00:00Z' }, '2026-11-18'), false);
  assert.equal(cobroPendienteVencido({ ...b, payment_note: 'Sin costo' }, '2026-11-18'), false);
  assert.equal(cobroPendienteVencido({ ...b, amount: 0 }, '2026-11-18'), false);
  assert.equal(cobroPendienteVencido({ ...b, debt_voided: true }, '2026-11-18'), false);
  assert.equal(cobroPendienteVencido({ ...b, notes: 'ComprobanteTransferencia 2026-11-16T10:00 x.pdf' }, '2026-11-18'), false);
  assert.equal(cobroPendienteVencido({ ...b, notes: 'TransferenciaPorRevisar 2026-11-16' }, '2026-11-18'), false);
  assert.equal(cobroPendienteVencido({ ...b, notes: 'PagoEnConsulta', payment_method: 'manual' }, '2026-11-18'), false);
  assert.equal(cobroPendienteVencido({ ...b, status: 'cancelled' }, '2026-11-18'), false);
  assert.equal(cobroPendienteVencido({ ...b, session_date: '2099-12-31' }, '2026-11-18'), false);
});

// ─── Canal, tope e idempotencia ───
test('canal: correo si hay; WhatsApp texto en 24 h; plantilla solo si está aprobada', () => {
  const ahora = Date.parse('2026-11-18T15:00:00Z');
  const p = { email: null, telefono: '56912345678', whatsappConectado: true, ultimoEntrante: null, plantillaAprobada: false, ahora };
  assert.deepEqual(elegirCanal({ ...p, email: 'a@b.cl' }), { canal: 'correo' });
  assert.deepEqual(elegirCanal({ ...p, ultimoEntrante: new Date(ahora - 3600e3).toISOString() }), { canal: 'whatsapp_texto' });
  assert.equal(elegirCanal(p).canal, null);
  assert.deepEqual(elegirCanal({ ...p, plantillaAprobada: true }), { canal: 'whatsapp_plantilla' });
  assert.equal(elegirCanal({ ...p, whatsappConectado: false, plantillaAprobada: true }).canal, null);
  assert.equal(elegirCanal({ ...p, telefono: null }).canal, null);
});

test('tope: máximo 2 automáticos en 30 días por teléfono o correo (3A y resumen no cuentan)', () => {
  const ahora = Date.parse('2026-11-18T15:00:00Z');
  const e = (paso: string, dias: number, extra: Record<string, unknown> = {}) => ({ paso, estado: 'enviado', enviado_at: new Date(ahora - dias * DIA_MS).toISOString(), telefono: '56912345678', email: null, ...extra });
  assert.equal(enviadosRecientes([e('1A', 10), e('1B', 3)], '912345678', null, ahora), 2);
  assert.equal(enviadosRecientes([e('1A', 40)], '56912345678', null, ahora), 0);
  assert.equal(enviadosRecientes([e('3A', 1), e('resumen', 1)], '56912345678', null, ahora), 0);
  assert.equal(enviadosRecientes([e('2A', 1, { telefono: null, email: 'Ana@Correo.cl' })], null, 'ana@correo.cl', ahora), 1);
  assert.equal(enviadosRecientes([e('2A', 1, { estado: 'error' })], '56912345678', null, ahora), 0);
});

test('idempotencia: nunca dos veces', () => {
  assert.equal(sePuedeReintentar({ estado: 'enviado', intentos: 1, tomada_en: null }), false);
  assert.equal(sePuedeReintentar({ estado: 'en_curso', intentos: 1, tomada_en: '2026-01-01T00:00:00Z' }), false); // aunque haya quedado cortado
  assert.equal(sePuedeReintentar({ estado: 'por_aprobar', intentos: 1, tomada_en: null }), false);
  assert.equal(sePuedeReintentar({ estado: 'descartado', intentos: 1, tomada_en: null }), false);
  assert.equal(sePuedeReintentar({ estado: 'error', intentos: 2, tomada_en: null }), true);
  assert.equal(sePuedeReintentar({ estado: 'error', intentos: 3, tomada_en: null }), false);
  assert.equal(sePuedeReintentar({ estado: 'aprobado', intentos: 1, tomada_en: null }), true);
});

test('textos aprobados, con mayúscula inicial', () => {
  assert.equal(textoWhatsapp('1A', { nombre: 'Ana' }), 'Hola Ana, ¿cómo estás? Cuéntame qué días y horarios te acomodan, y coordinamos tu primera sesión.');
  assert.equal(textoWhatsapp('4A', { nombre: 'Ana', fecha: 'martes 17 de noviembre', enlace: 'https://x.cl/pagar/1' }),
    'Hola Ana, ¿cómo estás? La sesión del martes 17 de noviembre me aparece pendiente de pago. Si ya la pagaste, avísame y lo reviso. Te dejo el enlace: https://x.cl/pagar/1');
  assert.equal(correoTextoPlano('1A', { nombre: 'Ana' }),
    'Hola Ana:\nTe escribo para saber si todavía quieres empezar terapia. Cuéntame qué días y horarios te acomodan y coordinamos tu primera sesión.\nUn abrazo,\nValentina Orellana, Psicóloga');
  assert.equal(correoTextoPlano('1B', { nombre: 'Ana' }), 'Hola Ana:\nSi todavía quieres empezar, me escribes con los días que te sirven y lo vemos.\nUn abrazo,\nValentina Orellana, Psicóloga');
  for (const paso of ['1A', '1B', '2A', '3A', '4A'] as const) {
    assert.match(textoWhatsapp(paso, { nombre: '' }), /^Hola, /);
  }
});

test('plantillas: Meta no acepta variables al inicio ni al final; cantidad de variables = ejemplo', () => {
  for (const p of PLANTILLAS) {
    assert.doesNotMatch(p.cuerpo, /^\s*\{\{/);
    assert.doesNotMatch(p.cuerpo, /\}\}\s*[.!?]?\s*$/);
    const n = (p.cuerpo.match(/\{\{\d\}\}/g) ?? []).length;
    assert.equal(p.ejemplo.length, n, p.nombre);
    assert.equal(variablesPlantilla(p.paso, { nombre: 'Ana', fecha: 'x', enlace: 'y' }).length, n);
    assert.match(p.nombre, /^[a-z0-9_]+$/);
  }
});
