// Decisiones de Vale tras la auditoría del panel (19 oct 2026, rama decisiones-auditoria):
//   1. Pago por devolver o reagendar + botón "Resuelto" (sin borrar datos).
//   2. Anular una hora: casilla "Avisar a la paciente por correo", desmarcada por defecto.
//   3. "Pago en consulta" se ve como "Paga en consulta" (sin plazo de 24 h, box ni link).
//   4. Consentimiento: aviso de arriba solo con horas vigentes; ficha y lista siguen diciendo "Sin consentimiento firmado".
//   5. Pareja: solo reservas de pareja vigentes o realizadas (no anuladas ni vencidas).
// Base en memoria (SupabaseMemoria) y doble de email.ts que no envía, igual que auditoriaPanel.test.ts.
// Correr: pnpm test
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { limpiarNotasPaciente } from '../notasPaciente';

const STUB = pathToFileURL(join(import.meta.dirname, 'pruebas', 'supabaseGlobal.ts')).href;
const nombresEmail = [...readFileSync(new URL('../email.ts', import.meta.url), 'utf8')
  .matchAll(/^export (?:async function|function|const|let) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
const EMAIL = 'data:text/javascript,' + encodeURIComponent(nombresEmail.map((n) => n === 'ADMIN_EMAIL_FALLBACK'
  ? `export const ${n} = 'vale@ejemplo.cl';`
  : `export function ${n}(...a) { (globalThis.__voCorreos ??= []).push('${n}'); return { sent: true }; }`).join('\n'));
register(`data:text/javascript,${encodeURIComponent(`
  let stub, email;
  export function initialize(d) { stub = d.stub; email = d.email; }
  export async function resolve(spec, ctx, next) {
    const r = await next(spec, ctx);
    if (/\\/src\\/lib\\/email\\.ts$/.test(r.url)) return { ...r, url: email, format: 'module', shortCircuit: true };
    return /\\/src\\/lib\\/supabase\\.ts$/.test(r.url) ? { ...r, url: stub, shortCircuit: true } : r;
  }`)}`, { data: { stub: STUB, email: EMAIL } });

let db: SupabaseMemoria;
beforeEach(() => {
  db = new SupabaseMemoria();
  (globalThis as { __voSupabasePrueba?: unknown }).__voSupabasePrueba = db;
  (globalThis as { __voCorreos?: string[] }).__voCorreos = [];
});

let ppd: typeof import('../pagosPorDevolver');
let anular: typeof import('../anularReserva');
let correo: typeof import('../correoAnulacion');
let pec: typeof import('../pagoEnConsulta');
let consent: typeof import('../consent');
let estado: typeof import('./estadoConsentimiento');
let pareja: typeof import('./pareja');
let consentimiento: typeof import('./consentimiento');
before(async () => {
  ppd = await import('../pagosPorDevolver');
  anular = await import('../anularReserva');
  correo = await import('../correoAnulacion');
  pec = await import('../pagoEnConsulta');
  consent = await import('../consent');
  estado = await import('./estadoConsentimiento');
  pareja = await import('./pareja');
  consentimiento = await import('./consentimiento');
});

let n = 0;
const reserva = (o: Record<string, unknown>) => ({
  id: `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, '0')}`, session_type: 'presencial', session_date: '2026-10-22', session_time: '18:00:00',
  status: 'confirmed', amount: 40000, paid_at: null, payment_note: null, debt_voided: false, notes: null, created_by_admin: true,
  patient_name: 'Ana Pérez', patient_email: 'ana@ejemplo.cl', ...o,
});
const leer = (ruta: string) => readFileSync(new URL(`../../../${ruta}`, import.meta.url), 'utf8');
const quien = { sesion: 'passkey' as const, ip: '200.1.2.3', navegador: 'Safari' };

// ─── 1. Pago por devolver o reagendar ────────────────────────────────────────

test('1. pago por devolver: solo sesiones pagadas (con monto) que se anularon o vencieron; texto con paciente, fecha y monto', async () => {
  db.tabla('patients').push({ id: 'p-ana', name: 'Ana Pérez', email: 'ana@ejemplo.cl' });
  db.tabla('bookings').push(
    reserva({ id: 'anulada-pagada', status: 'cancelled', paid_at: '2026-10-18T12:00:00Z', payment_note: 'Transferencia' }),
    reserva({ id: 'vencida-pagada', patient_name: 'Luis Soto', patient_email: 'luis@ejemplo.cl', status: 'expired', paid_at: '2026-10-18T12:00:00Z', session_date: '2026-10-21', amount: 35000 }),
    reserva({ id: 'anulada-sin-pagar', status: 'cancelled' }),
    reserva({ id: 'anulada-sin-costo', status: 'cancelled', paid_at: '2026-10-18T12:00:00Z', payment_note: 'Sin costo', amount: 0 }),
    reserva({ id: 'vigente-pagada', paid_at: '2026-10-18T12:00:00Z' }),
  );
  const avisos = await ppd.avisosPagosPorDevolver();
  assert.deepEqual(avisos.map((a) => a.id), ['vencida-pagada', 'anulada-pagada']);
  const ana = avisos.find((a) => a.id === 'anulada-pagada')!;
  assert.equal(ppd.textoPagoPorDevolver(ana).replace(/\s/g, ' '), 'Pago por devolver o reagendar: Ana Pérez, 22-10-2026 18:00, $40.000');
  // "Ver sesión" lleva a la ficha (la agenda no muestra sesiones anuladas); sin ficha, a la búsqueda.
  assert.equal(ana.href, '/admin/pacientes/p-ana?tab=sesiones#s-anulada-pagada');
  assert.equal(avisos.find((a) => a.id === 'vencida-pagada')!.href, '/admin/pacientes?q=Luis%20Soto');
});

test('1. "Resuelto": el aviso desaparece, la reserva NO cambia (ni pago ni notas) y queda quién/cuándo; un 2.º clic no pisa el registro', async () => {
  const b = reserva({ id: 'prueba-pagada', status: 'cancelled', paid_at: '2026-10-18T12:00:00Z', payment_note: 'Flow', notes: 'Boleta Folio 12' });
  db.tabla('bookings').push(b);
  const antes = JSON.stringify(db.tabla('bookings'));
  assert.equal((await ppd.avisosPagosPorDevolver()).length, 1);

  assert.deepEqual(await ppd.marcarPagoResuelto('prueba-pagada', quien), { ok: true });
  assert.deepEqual(await ppd.avisosPagosPorDevolver(), []);
  assert.equal(JSON.stringify(db.tabla('bookings')), antes, 'la reserva queda idéntica (no se borra ni se toca la boleta)');
  const fila = db.tabla('settings').find((s) => s.key === 'pago_devolver_ok:prueba-pagada')!;
  const reg = JSON.parse(fila.value);
  assert.equal(reg.sesion, 'passkey');
  assert.equal(reg.ip, '200.1.2.3');
  assert.match(reg.resuelto_at, /^\d{4}-\d{2}-\d{2}T/);
  // Bitácora visible en /admin/logs.
  assert.ok(db.tabla('admin_logs').some((l) => l.context === 'pagos/resuelto' && l.data?.bookingId === 'prueba-pagada'));

  // Segundo clic (otra pestaña): no pisa quién/cuándo de la primera vez.
  assert.deepEqual(await ppd.marcarPagoResuelto('prueba-pagada', { sesion: 'contrasena', ip: '1.1.1.1', navegador: 'X' }), { ok: true });
  assert.equal(JSON.parse(db.tabla('settings').find((s) => s.key === 'pago_devolver_ok:prueba-pagada')!.value).ip, '200.1.2.3');
});

test('1. "Resuelto" solo sirve para un pago por devolver real', async () => {
  db.tabla('bookings').push(reserva({ id: 'vigente', paid_at: '2026-10-18T12:00:00Z' }));
  assert.deepEqual(await ppd.marcarPagoResuelto('vigente', quien), { ok: false, error: 'no_aplica' });
  assert.deepEqual(await ppd.marcarPagoResuelto('no-existe', quien), { ok: false, error: 'no_existe' });
  assert.deepEqual(await ppd.marcarPagoResuelto('x/../../y', quien), { ok: false, error: 'no_existe' });
  assert.equal(db.tabla('settings').length, 0);
});

test('1. el aviso sale en todas las páginas (layout) y en el Inicio, con botón "Resuelto"', () => {
  const l = leer('src/components/admin/AdminLayout.astro');
  assert.match(l, /action="\/api\/admin\/pago-resuelto"/);
  assert.match(l, />Resuelto<\/button>/);
  assert.match(l, /Pago por devolver o reagendar:/);
  const i = leer('src/pages/admin/index.astro');
  assert.match(i, /action: '\/api\/admin\/pago-resuelto', campos: \{ id: p\.id, redirect: vuelta \}, texto: 'Resuelto'/);
  // Sin migración: no hay archivo nuevo en supabase/migrations para esto.
  assert.match(leer('src/lib/pagosPorDevolver.ts'), /PREFIJO_RESUELTO = 'pago_devolver_ok:'/);
});

// ─── 2. Anular una hora ──────────────────────────────────────────────────────

function dobles() {
  const eventos: string[] = [];
  const correos: { d: Record<string, unknown>; key: string }[] = [];
  return {
    eventos, correos,
    deps: {
      borrarEvento: async (id: string) => { eventos.push(id); },
      enviarCorreo: async (d: Record<string, unknown>, o: { idempotencyKey: string }) => { correos.push({ d, key: o.idempotencyKey }); return { sent: true }; },
    },
  };
}

test('2. anular SIN marcar la casilla: se anula y se borra el evento, sin correo', async () => {
  db.tabla('bookings').push(reserva({ id: 'h1' }));
  const x = dobles();
  assert.deepEqual(await anular.anularReserva('h1', { avisar: anular.quiereAvisar(null) }, x.deps), { ok: true, correo: 'no_pedido' });
  assert.equal(db.tabla('bookings')[0].status, 'cancelled');
  assert.deepEqual(x.eventos, ['h1']);
  assert.equal(x.correos.length, 0);
});

test('2. anular marcando "Avisar a la paciente por correo": un solo correo (con llave anti-duplicado); si ya estaba anulada no se repite', async () => {
  db.tabla('bookings').push(reserva({ id: 'h2', paid_at: '2026-10-18T12:00:00Z', payment_note: 'Flow' }));
  const x = dobles();
  assert.deepEqual(await anular.anularReserva('h2', { avisar: anular.quiereAvisar('on') }, x.deps), { ok: true, correo: 'enviado' });
  assert.equal(x.correos.length, 1);
  assert.equal(x.correos[0].key, 'anulacion-h2');
  assert.deepEqual(x.correos[0].d, { patient_name: 'Ana Pérez', patient_email: 'ana@ejemplo.cl', session_date: '2026-10-22', session_time: '18:00:00', pagada: true, sinCosto: false });
  // Doble clic: ya estaba anulada → no se manda otro.
  assert.deepEqual(await anular.anularReserva('h2', { avisar: true }, x.deps), { ok: true, correo: 'ya_anulada' });
  assert.equal(x.correos.length, 1);
});

test('2. anular con aviso: sin correo o cobro sin fecha no envía; si la base falla no se borra el evento ni se avisa', async () => {
  db.tabla('bookings').push(reserva({ id: 'h3', patient_email: '' }), reserva({ id: 'h4', session_date: '2099-12-31' }));
  const x = dobles();
  assert.deepEqual(await anular.anularReserva('h3', { avisar: true }, x.deps), { ok: true, correo: 'sin_correo' });
  assert.deepEqual(await anular.anularReserva('h4', { avisar: true }, x.deps), { ok: true, correo: 'sin_fecha' });
  assert.equal(x.correos.length, 0);
  const y = dobles();
  assert.deepEqual(await anular.anularReserva('no-existe', { avisar: true }, y.deps), { ok: false, error: 'No se encontró la sesión.' });
  assert.equal(y.eventos.length + y.correos.length, 0);
});

test('2. el panel: casilla "Avisar a la paciente por correo" DESMARCADA por defecto y se desmarca al abrir cada sesión; Google sin aviso propio', () => {
  const a = leer('src/pages/admin/agenda.astro');
  const caja = a.slice(a.indexOf('id="sp-cancel-form"'), a.indexOf('id="sp-cancel-volver"'));
  assert.match(caja, /<input type="checkbox" name="notify_patient" id="sp-cancel-notify">/);
  assert.doesNotMatch(caja, /notify_patient"[^>]*checked/);
  assert.match(caja, /Avisar a la paciente por correo/);
  assert.match(a, /casilla\.checked = false;/);
  assert.match(leer('src/pages/api/admin/bookings.ts'), /anularReserva\(id, \{ avisar: quiereAvisar\(form\.get\('notify_patient'\)\) \}\)/);
  // El borrado del evento nunca dispara el aviso de Google (así el correo es el único aviso).
  assert.match(leer('src/lib/googleCalendar.ts'), /events\/\$\{eventId\}\?sendUpdates=none`/);
});

test('2. correo de anulación: solo avisa que la sesión fue anulada (decisión de Vale 19 oct)', () => {
  const d = { patient_name: 'Ana Pérez', session_date: '2026-10-22', session_time: '18:00:00' };
  assert.equal(correo.asuntoAnulacion(d), 'Tu sesión del jueves 22 de octubre fue anulada — Ps. Valentina Orellana');
  const t = correo.textoAnulacion(d);
  assert.equal(t, 'Hola Ana, te escribo para avisarte que tu sesión del jueves 22 de octubre a las 18:00 fue anulada.\n\nUn saludo,\nValentina');
  for (const v of [{ ...d, pagada: true }, { ...d, sinCosto: true }]) {
    assert.equal(correo.textoAnulacion(v), t, 'el texto no cambia por pago o sin costo');
    assert.doesNotMatch(correo.htmlAnulacion(v), /\/agenda|wa\.me|devuelv|pagad/);
  }
  const h = correo.htmlAnulacion({ ...d, patient_name: '<b>Ana</b> Pérez' });
  assert.match(h, /&lt;b&gt;Ana&lt;\/b&gt;/);
  assert.doesNotMatch(h, /<a /, 'sin botones ni enlaces');
});

// ─── 3. Pago en consulta ─────────────────────────────────────────────────────

const en = (h: number) => {
  const d = new Date(Date.now() + h * 3600e3);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return { session_date: `${v('year')}-${v('month')}-${v('day')}`, session_time: `${v('hour')}:${v('minute')}:00` };
};

test('3. "Paga en consulta": solo con la marca (las horas antiguas "manual" siguen como por pagar); vigente y sin pagar', () => {
  assert.equal(pec.esPagoEnConsulta({ status: 'confirmed', notes: 'PagoEnConsulta' }), true);
  assert.equal(pec.esPagoEnConsulta({ status: 'confirmed', notes: 'nota de Vale\nPagoEnConsulta' }), true);
  assert.equal(pec.esPagoEnConsulta({ status: 'confirmed', notes: null }), false, 'antigua "manual" sin marca');
  assert.equal(pec.esPagoEnConsulta({ status: 'confirmed', notes: 'PagoEnConsulta', paid_at: '2026-10-19T12:00:00Z' }), false, 'ya pagada');
  assert.equal(pec.esPagoEnConsulta({ status: 'cancelled', notes: 'PagoEnConsulta' }), false);
  assert.equal(pec.esPagoEnConsulta({ status: 'confirmed', notes: 'PagoEnConsulta', debt_voided: true }), false);
  // Solo horas "manual" del panel; una reserva web (flow) con esa línea no cuenta, y la paciente no puede escribirla.
  assert.equal(pec.esPagoEnConsulta({ status: 'confirmed', notes: 'PagoEnConsulta', payment_method: 'flow' }), false);
  assert.equal(pec.esPagoEnConsulta({ status: 'confirmed', notes: 'PagoEnConsulta', payment_method: 'manual' }), true);
  assert.equal(limpiarNotasPaciente('PagoEnConsulta'), 'Pago-EnConsulta');
  // "Agendar hora" con "Pago en consulta" deja la marca.
  assert.match(leer('src/pages/api/admin/bookings.ts'), /: payment_mode === 'manual'\s*\? \[notesText, MARCA_PAGO_EN_CONSULTA\]\.filter\(Boolean\)\.join\('\\n'\)/);
});

test('3. aviso de cobro (32 h): "Paga en consulta" sale distinto, sin WhatsApp de link ni plazo/box', async () => {
  const { cobrosProximos } = await import('../cobrosProximos');
  db.tabla('bookings').push(
    reserva({ patient_name: 'Paga Consulta', patient_email: 'a@x.cl', patient_phone: '912345678', notes: 'PagoEnConsulta', ...en(10) }),
    reserva({ patient_name: 'Debe Pagar', patient_email: 'b@x.cl', patient_phone: '912345679', ...en(11) }),
  );
  const cs = await cobrosProximos('https://x');
  const c = cs.find((x) => x.paciente === 'Paga Consulta')!;
  assert.equal(c.enConsulta, true);
  assert.equal(c.waUrl, null);
  assert.equal(c.sinLink, false);
  const d = cs.find((x) => x.paciente === 'Debe Pagar')!;
  assert.equal(d.enConsulta, false);
  assert.ok(d.waUrl);
  const l = leer('src/components/admin/AdminLayout.astro');
  assert.match(l, /\{!c\.enConsulta && c\.presencial && <> · si no paga, mueve el box/);
  // /admin/por-cobrar: sin WhatsApp con link ni correo de cobro para "Paga en consulta".
  assert.match(leer('src/pages/admin/por-cobrar.astro'), /const waUrl = !enConsulta && payUrl/);
  const i = leer('src/pages/admin/index.astro');
  const ini = i.indexOf('if (c.enConsulta) {');
  assert.ok(ini > 0 && i.indexOf('continue;', ini) < i.indexOf('pago vence', ini), 'Inicio: "Paga en consulta" antes de "pago vence"');
});

test('3. agenda y ficha muestran "Paga en consulta" y la agenda no ofrece el link de pago', () => {
  const a = leer('src/pages/admin/agenda.astro');
  assert.match(a, /pago_en_consulta: esPagoEnConsulta\(b\)/);
  assert.match(a, /const canSendPaylink = !isPaid && !isVoided && !b\.pago_en_consulta/);
  assert.match(a, /badge\.textContent = 'Paga en consulta'/);
  assert.match(a, /if \(enConsulta\) base \+= ' ev-pay-consulta';/);
  const f = leer('src/pages/admin/pacientes/[id].astro');
  assert.match(f, /enConsulta \? ETIQUETA_PAGO_EN_CONSULTA : 'Por pagar'/);
});

// ─── 4. Consentimiento (sin cambio: se fija) ─────────────────────────────────

test('4. consentimiento: el aviso de arriba solo con horas vigentes, pero ficha y lista siguen diciendo "Sin consentimiento firmado"', async () => {
  db.tabla('patients').push(
    { id: 'p1', name: 'Marta Anulada', email: 'marta@ejemplo.cl', active: true },
    { id: 'p2', name: 'Diego Vigente', email: 'diego@ejemplo.cl', active: true },
  );
  db.tabla('bookings').push(
    reserva({ patient_name: 'Marta Anulada', patient_email: 'marta@ejemplo.cl', status: 'cancelled' }),
    reserva({ patient_name: 'Diego Vigente', patient_email: 'diego@ejemplo.cl' }),
  );
  assert.deepEqual((await consent.getConsentAlerts()).map((a) => a.name), ['Diego Vigente']);
  const est = await estado.estadosConsentimientoEnBase([{ id: 'p1', name: 'Marta Anulada', email: 'marta@ejemplo.cl' }, { id: 'p2', name: 'Diego Vigente', email: 'diego@ejemplo.cl' }], db.cliente);
  assert.equal(est.get('p1'), 'sin_firma');
  assert.equal(est.get('p2'), 'sin_firma');
  assert.equal(estado.etiquetaConsentimiento(est.get('p1')), 'Sin consentimiento firmado');
});

// ─── 5. Pareja: solo reservas vigentes o realizadas ──────────────────────────

test('5. pareja: una reserva de pareja anulada o vencida no cuenta; por pagar, confirmada o realizada sí', () => {
  const svc = new Map<string, { type: string; name: string }>([['s-par', { type: 'pareja', name: 'Terapia de pareja' }]]);
  for (const status of ['cancelled', 'expired']) {
    assert.equal(pareja.esReservaPareja({ session_type: 'pareja-online', status }, svc), false, status);
    assert.equal(pareja.esReservaPareja({ service_id: 's-par', status }, svc), false, status);
    assert.equal(pareja.esReservaPareja({ custom_title: 'Sesión de pareja', status }, svc), false, status);
  }
  for (const status of ['pending_payment', 'confirmed', undefined]) {
    assert.equal(pareja.esReservaPareja({ session_type: 'pareja-online', status }, svc), true, String(status));
  }
});

test('5. pareja en base: ficha con su reserva de pareja anulada NO pide 2 firmas (grabar, link y ficha); con una confirmada sí', async () => {
  db.tabla('services_catalog').push({ id: 's-par', name: 'Terapia de pareja', type: 'pareja' }, { id: 's-ind', name: 'Sesión individual', type: 'individual' });
  db.tabla('patients').push({ id: 'p-ana', name: 'Ana Pérez', email: 'ana@ejemplo.cl', active: true, birthdate: '1990-01-01' });
  db.tabla('consents').push({
    id: 'c1', patient_id: 'p-ana', version: '2026-10-v4', persona: 1, signed_at: '2026-10-02T12:00:00Z', signer_name: 'Ana Pérez', signer_rut: '11.111.111-1',
    signer_email: null, accept_treatment: true, accept_recording: true, revoked_at: null, recording_revoked_at: null,
  });
  db.tabla('bookings').push(
    reserva({ id: 'par-anulada', session_type: 'pareja-presencial', service_id: 's-par', status: 'cancelled' }),
    reserva({ id: 'par-vencida', session_type: 'pareja-online', service_id: 's-par', status: 'expired', created_by_admin: false }),
    reserva({ id: 'ind', session_type: 'presencial', service_id: 's-ind' }),
  );
  assert.equal(await consentimiento.fichaEsParejaEnBase('p-ana', db.cliente), false);
  const ev = await consentimiento.evaluarEnBase('p-ana', 'individual', db.cliente);
  assert.equal(ev.requeridas, 1);
  assert.equal(ev.puede, true, 'puede grabar individual');
  const fichas = [{ id: 'p-ana', name: 'Ana Pérez', email: 'ana@ejemplo.cl', rut: '11.111.111-1' }];
  assert.equal((await estado.estadosConsentimientoEnBase(fichas, db.cliente)).get('p-ana'), 'firmado');

  // Una reserva de pareja realizada (confirmada y pagada en el pasado) sí cuenta.
  db.tabla('bookings').push(reserva({ id: 'par-realizada', session_type: 'pareja-presencial', service_id: 's-par', session_date: '2026-09-01', paid_at: '2026-08-30T12:00:00Z' }));
  assert.equal(await consentimiento.fichaEsParejaEnBase('p-ana', db.cliente), true);
  assert.equal((await consentimiento.evaluarEnBase('p-ana', 'individual', db.cliente)).requeridas, 2);
  assert.equal((await estado.estadosConsentimientoEnBase(fichas, db.cliente)).get('p-ana'), 'falta_pareja');
});
