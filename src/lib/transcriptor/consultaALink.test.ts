// "Cambiar a link de pago" (pedido de Vale, 20 oct 2026, rama consulta-a-link): una hora "Paga en consulta"
// pasa a hora por pagar normal (solo se quita la marca PagoEnConsulta; fecha, hora y monto igual), queda
// registrado en /admin/logs y "💳 Cobrar" ofrece el link combinado /pagar/<ficha>, que ofrece Flow y
// transferencia; el correo y el WhatsApp del link lo dicen.
// Base en memoria (SupabaseMemoria) y Resend reemplazado por un doble que no envía nada.
// Correr: pnpm test
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';

const STUB = pathToFileURL(join(import.meta.dirname, 'pruebas', 'supabaseGlobal.ts')).href;
const RESEND = 'data:text/javascript,' + encodeURIComponent(`
  export class Resend {
    constructor() { this.emails = { send: async (m) => { (globalThis.__voEnviados ??= []).push(m); return { data: { id: 'prueba' }, error: null }; } }; }
  }`);
register(`data:text/javascript,${encodeURIComponent(`
  let stub, resend;
  export function initialize(d) { stub = d.stub; resend = d.resend; }
  export async function resolve(spec, ctx, next) {
    if (spec === 'resend') return { url: resend, format: 'module', shortCircuit: true };
    const r = await next(spec, ctx);
    return /\\/src\\/lib\\/supabase\\.ts$/.test(r.url) ? { ...r, url: stub, shortCircuit: true } : r;
  }
  export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (!/\\/src\\/lib\\/email\\.ts$/.test(url) || r.source == null) return r;
    return { ...r, source: String(r.source).replace(/import\\.meta\\.env\\.EMAIL_FROM/g, 'undefined') };
  }`)}`, { data: { stub: STUB, resend: RESEND } });

process.env.RESEND_API_KEY = 're_prueba_no_envia';

type Msg = { to: string; subject: string; html: string };
let db: SupabaseMemoria;
const enviados = () => ((globalThis as { __voEnviados?: Msg[] }).__voEnviados ??= []);
beforeEach(() => {
  db = new SupabaseMemoria();
  (globalThis as { __voSupabasePrueba?: unknown }).__voSupabasePrueba = db;
  (globalThis as { __voEnviados?: Msg[] }).__voEnviados = [];
});

let cal: typeof import('../consultaALink');
let pec: typeof import('../pagoEnConsulta');
let cp: typeof import('../cobrosProximos');
let email: typeof import('../email');
before(async () => {
  cal = await import('../consultaALink');
  pec = await import('../pagoEnConsulta');
  cp = await import('../cobrosProximos');
  email = await import('../email');
});

const leer = (ruta: string) => readFileSync(new URL(`../../../${ruta}`, import.meta.url), 'utf8');
// Fecha y hora de Chile dentro de h horas.
const en = (h: number) => {
  const d = new Date(Date.now() + h * 3600e3);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return { session_date: `${v('year')}-${v('month')}-${v('day')}`, session_time: `${v('hour')}:${v('minute')}:00` };
};
const reserva = (o: Record<string, unknown>) => ({
  id: 'b-consulta', session_type: 'presencial', session_date: '2026-10-22', session_time: '18:00:00', status: 'confirmed',
  amount: 40000, paid_at: null, payment_note: null, debt_voided: false, payment_method: 'manual', created_by_admin: true,
  notes: 'Viene derivada\nPagoEnConsulta', patient_name: 'Ana Pérez', patient_email: 'ana@ejemplo.cl', patient_phone: '+56912345678',
  google_event_id: 'ev1', ...o,
});

test('cambiar a link: quita solo la marca; fecha, hora, monto, estado y demás notas quedan igual; queda registrado', async () => {
  db.tabla('patients').push({ id: 'p-ana', name: 'Ana Pérez', email: 'ana@ejemplo.cl', phone: '+56912345678', active: true });
  db.tabla('bookings').push(reserva({}));
  const antes = { ...db.tabla('bookings')[0] };
  assert.equal(pec.esPagoEnConsulta(antes), true);

  const r = await cal.cambiarConsultaALink('b-consulta');
  assert.deepEqual(r, { ok: true, patientId: 'p-ana' });
  const b = db.tabla('bookings')[0];
  assert.equal(b.notes, 'Viene derivada', 'solo se quitó la línea de la marca');
  for (const k of ['session_date', 'session_time', 'amount', 'status', 'payment_method', 'paid_at', 'debt_voided', 'google_event_id']) {
    assert.deepEqual(b[k], antes[k], `${k} sin cambios`);
  }
  assert.equal(pec.esPagoEnConsulta(b), false, 'ya no es "Paga en consulta"');
  const log = db.tabla('admin_logs').find((l) => l.context === 'agenda/consulta-a-link');
  assert.ok(log, 'registro en /admin/logs');
  assert.match(String(log!.message), /Ana Pérez del 2026-10-22 18:00 cambiada de "Paga en consulta" a link de pago/);
  assert.equal(enviados().length, 0, 'no se le envía nada a la paciente sin que Vale lo pida');

  // No se repite: la segunda vez dice que ya no está en consulta y no registra de nuevo.
  const r2 = await cal.cambiarConsultaALink('b-consulta');
  assert.deepEqual(r2, { ok: false, error: 'no_en_consulta' });
  assert.equal(db.tabla('admin_logs').filter((l) => l.context === 'agenda/consulta-a-link').length, 1);
});

test('cambiar a link: con solo la marca en notas queda vacío; sin ficha la crea (para el link /pagar)', async () => {
  db.tabla('bookings').push(reserva({ notes: 'PagoEnConsulta' }));
  const r = await cal.cambiarConsultaALink('b-consulta');
  assert.equal(r.ok, true);
  assert.equal(db.tabla('bookings')[0].notes, '');
  const ficha = db.tabla('patients').find((p) => p.email === 'ana@ejemplo.cl');
  assert.ok(ficha, 'se creó la ficha');
  assert.equal(r.ok && r.patientId, ficha!.id);
});

test('cambiar a link: no toca horas pagadas, anuladas, canceladas, sin marca o inexistentes', async () => {
  db.tabla('bookings').push(
    reserva({ id: 'pagada', paid_at: '2026-10-19T12:00:00Z' }),
    reserva({ id: 'anulada', debt_voided: true }),
    reserva({ id: 'cancelada', status: 'cancelled' }),
    reserva({ id: 'normal', notes: 'Viene derivada' }),
    reserva({ id: 'web', payment_method: 'flow' }),
  );
  for (const id of ['pagada', 'anulada', 'cancelada', 'normal', 'web']) {
    const antes = db.tabla('bookings').find((b) => b.id === id)!.notes;
    assert.deepEqual(await cal.cambiarConsultaALink(id), { ok: false, error: 'no_en_consulta' }, id);
    assert.equal(db.tabla('bookings').find((b) => b.id === id)!.notes, antes, `${id}: notas intactas`);
  }
  assert.deepEqual(await cal.cambiarConsultaALink('no-existe'), { ok: false, error: 'no_encontrada' });
  // Sin correo no hay link /pagar: no se quita la marca (si no, quedaría "Por pagar" sin "Cobrar").
  db.tabla('bookings').push(reserva({ id: 'sin-correo', patient_email: '' }));
  assert.deepEqual(await cal.cambiarConsultaALink('sin-correo'), { ok: false, error: 'sin_correo' });
  assert.equal(db.tabla('bookings').find((b) => b.id === 'sin-correo')!.notes, 'Viene derivada\nPagoEnConsulta');
  assert.equal(db.tabla('admin_logs').filter((l) => l.context === 'agenda/consulta-a-link').length, 0);
});

test('después del cambio, el aviso de cobro la trata como hora por pagar: WhatsApp con /pagar, plazo y Flow o transferencia', async () => {
  db.tabla('patients').push({ id: 'p-ana', name: 'Ana Pérez', email: 'ana@ejemplo.cl', active: true });
  db.tabla('bookings').push(reserva({ ...en(30) }));
  let c = (await cp.cobrosProximos('https://x.cl')).find((x) => x.id === 'b-consulta')!;
  assert.equal(c.enConsulta, true);
  assert.equal(c.waUrl, null, 'antes: sin link');
  await cal.cambiarConsultaALink('b-consulta');
  c = (await cp.cobrosProximos('https://x.cl')).find((x) => x.id === 'b-consulta')!;
  assert.equal(c.enConsulta, false);
  const texto = decodeURIComponent(new URL(c.waUrl!).searchParams.get('text') ?? '');
  assert.match(texto, /https:\/\/x\.cl\/pagar\/p-ana/);
  assert.match(texto, /plazo máximo de 24 horas/);
  assert.ok(texto.includes(cp.FORMAS_DE_PAGO), 'dice Flow y transferencia');
  assert.ok(texto.includes(cp.AVISO_REAGENDAR));
});

test('mensaje del link: "Flow o transferencia" solo con el link /pagar (el link directo de Flow no tiene transferencia)', () => {
  assert.equal(cp.FORMAS_DE_PAGO, 'Puedes pagar con tarjeta por Flow o por transferencia subiendo el comprobante.');
  assert.ok(cp.mensajeLinkPago('Ana Pérez', 'https://x.cl/pagar/p1').includes(cp.FORMAS_DE_PAGO));
  assert.ok(!cp.mensajeLinkPago('Ana Pérez', 'https://www.flow.cl/app/web/pay.php?token=t').includes('transferencia'));
});

test('correo del link (Cobrar → correo y al agendar con link): dice Flow o transferencia; ya no dice "sesión anterior"', async () => {
  await email.sendDebtReminderEmail({ patientName: 'Ana Pérez', patientEmail: 'ana@ejemplo.cl', amount: 40000, sessionsCount: 1, payUrl: 'https://x.cl/pagar/p1' });
  const h = enviados()[0].html;
  assert.ok(h.includes(cp.FORMAS_DE_PAGO));
  assert.ok(h.includes('href="https://x.cl/pagar/p1"'));
  assert.doesNotMatch(h, /anterior/, 'puede ser una sesión futura');
  await email.sendPaymentLinkEmail({ patientName: 'Ana', patientEmail: 'ana@ejemplo.cl', serviceName: 'Sesión', amount: 40000, sessionDate: '2030-03-14', sessionTime: '18:00', paymentUrl: 'https://x.cl/pagar/p1' });
  assert.ok(enviados()[1].html.includes(cp.FORMAS_DE_PAGO));
  await email.sendPaymentLinkEmail({ patientName: 'Ana', patientEmail: 'ana@ejemplo.cl', serviceName: 'Sesión', amount: 40000, paymentUrl: 'https://www.flow.cl/app/web/pay.php?token=t' });
  assert.ok(!enviados()[2].html.includes(cp.FORMAS_DE_PAGO), 'link directo de Flow: sin transferencia');
});

test('panel: botón en la sesión y en la ficha, acción del servidor y vuelta con "Cobrar" abierto (sin duplicar el flujo)', () => {
  const api = leer('src/pages/api/admin/bookings.ts');
  const ini = api.indexOf("if (action === 'consulta_a_link')");
  assert.ok(ini > 0);
  const bloque = api.slice(ini, api.indexOf('\n  }\n', ini));
  assert.match(bloque, /cambiarConsultaALink\(id\)/);
  assert.match(bloque, /saved=a-link&accion=cobrar/);
  assert.match(bloque, /'booking=' \+ encodeURIComponent\(id\)/);
  assert.doesNotMatch(bloque, /send|Email|whatsapp/i, 'no envía nada por su cuenta: el envío es el de "Cobrar"');

  const a = leer('src/pages/admin/agenda.astro');
  assert.match(a, /id="sp-btn-a-link"[^>]*>💳 Cambiar a link de pago</);
  assert.match(a, /name="action" value="consulta_a_link"/);
  assert.match(a, /getElementById\('sp-a-link-box'\)\.style\.display = \(b\.pago_en_consulta && !isPaid && !isVoided && b\.patient_email\)/);
  assert.match(a, /if \(confirm\('¿Cambiar esta sesión a link de pago\?/);
  // "Cobrar" sigue siendo el único envío y se ofrece en cuanto deja de ser "Paga en consulta".
  assert.match(a, /const canSendPaylink = !isPaid && !isVoided && !b\.pago_en_consulta/);
  assert.match(a, /if \(accion === 'cobrar'\)/);
  assert.match(a, /saved'\) === 'a-link'/);
  assert.ok(a.includes("'\\nPuedes pagar con tarjeta por Flow o por transferencia subiendo el comprobante.'"), 'WhatsApp de Cobrar = FORMAS_DE_PAGO');

  const f = leer('src/pages/admin/pacientes/[id].astro');
  assert.match(f, /\{enConsulta && b\.patient_email && \(\s*<form method="POST" action="\/api\/admin\/bookings"[\s\S]{0,700}value="consulta_a_link"[\s\S]{0,200}value=\{`\/admin\/agenda\?booking=\$\{b\.id\}`\}/);
  assert.match(f, /onsubmit="return confirm\('¿Cambiar esta sesión a link de pago\?/);
});

test('/pagar/<ficha>: ofrece Flow ("Ir a pagar") y transferencia con datos y comprobante, y lo dice arriba', () => {
  const p = leer('src/pages/pagar/[id].astro');
  assert.match(p, /\{FORMAS_DE_PAGO\}<\/p>/);
  assert.match(p, /id="btn-pagar"/);
  assert.match(p, /fetch\('\/api\/pagar-deuda'/);
  assert.match(p, /id="transfer-box"/);
  assert.match(p, /fetch\('\/api\/comprobante-transferencia'/);
  assert.match(p, /datosTransferencia\.map/);
});
