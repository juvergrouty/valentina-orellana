// Auditoría del panel "como Vale" (19 oct 2026, rama auditoria-vale): regresiones de lógica que ella
// vería en el panel o que harían enviar algo indebido. Base en memoria (SupabaseMemoria) en lugar de
// src/lib/supabase.ts, igual que presencialRutas.test.ts.
// Correr: pnpm test
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';

const STUB = pathToFileURL(join(import.meta.dirname, 'pruebas', 'supabaseGlobal.ts')).href;
// src/lib/email.ts → doble que NO envía y anota cada llamada en globalThis.__voCorreos (email.ts lee
// import.meta.env al cargar, que fuera de Astro no existe). Mismos nombres exportados que el real.
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
});

let consent: typeof import('../consent');
let tareas: typeof import('../tareasEnvio');
before(async () => {
  consent = await import('../consent');
  tareas = await import('../tareasEnvio');
});

const reserva = (o: Record<string, unknown>) => ({
  id: 'b' + Math.random().toString(36).slice(2), session_type: 'presencial', session_date: '2026-10-20', session_time: '17:00:00',
  status: 'confirmed', amount: 40000, paid_at: null, debt_voided: false, notes: null, created_by_admin: true, ...o,
});

test('aviso de consentimiento: ficha sin correo con hora vigente SÍ sale; con su única hora anulada o sin horas, no', async () => {
  db.tabla('patients').push(
    { id: 'p1', name: 'Rosa Sin Correo', email: null, active: true },
    { id: 'p2', name: 'Ricardo Toro', email: 'ricardo@ejemplo.cl', active: true },
    { id: 'p3', name: 'Sofía Sin Horas', email: null, active: true },
    { id: 'p4', name: 'Diego Herrera', email: 'diego@ejemplo.cl', active: true },
    { id: 'p5', name: 'Marta Anulada', email: null, active: true },
  );
  db.tabla('bookings').push(
    // "Pago en consulta" de una ficha sin correo: la reserva queda con correo vacío y el nombre (otras tildes/mayúsculas).
    reserva({ patient_name: 'rosa sin  correo', patient_email: '' }),
    reserva({ patient_name: 'Ricardo Toro', patient_email: 'ricardo@ejemplo.cl', status: 'cancelled' }),
    reserva({ patient_name: 'Diego Herrera', patient_email: 'diego@ejemplo.cl' }),
    reserva({ patient_name: 'Marta Anulada', patient_email: '', status: 'cancelled' }),
  );
  const nombres = (await consent.getConsentAlerts()).map((a) => a.name).sort();
  assert.deepEqual(nombres, ['Diego Herrera', 'Rosa Sin Correo']);
});

test('envíos en cola: una hora pagada y después anulada no manda confirmación, aviso ni evento', async () => {
  const b = reserva({ patient_name: 'Camila Rojas', patient_email: 'camila@ejemplo.cl', paid_at: '2026-10-19T12:00:00Z', status: 'cancelled' });
  db.tabla('bookings').push(b);
  for (const t of ['confirmacion', 'aviso_admin', 'calendario', 'calendario_pagado']) {
    const r = await tareas.ejecutarTarea(String(b.id), `${t}#pago1`);
    assert.equal(r.descartada, true, t);
    assert.equal(r.nota, 'la reserva está anulada', t);
  }
  // Vencida: lo mismo.
  const v = reserva({ patient_name: 'Valeria', patient_email: 'valeria@ejemplo.cl', paid_at: '2026-10-19T12:00:00Z', status: 'expired' });
  db.tabla('bookings').push(v);
  assert.equal((await tareas.ejecutarTarea(String(v.id), 'confirmacion#pago2')).descartada, true);
  assert.deepEqual((globalThis as { __voCorreos?: string[] }).__voCorreos ?? [], [], 'no se envió ningún correo');
  // Control: la misma hora vigente sí confirma (el doble anota el envío).
  const ok = reserva({ patient_name: 'Camila Rojas', patient_email: 'camila@ejemplo.cl', paid_at: '2026-10-19T12:00:00Z' });
  db.tabla('bookings').push(ok);
  assert.equal((await tareas.ejecutarTarea(String(ok.id), 'confirmacion#pago3')).ok, true);
  assert.deepEqual((globalThis as { __voCorreos?: string[] }).__voCorreos, ['sendConfirmationToClient']);
});

const leer = (ruta: string) => readFileSync(new URL(`../../../${ruta}`, import.meta.url), 'utf8');

test('calendario del panel: no muestra reservas vencidas (la hora ya se liberó)', () => {
  const a = leer('src/pages/admin/agenda.astro');
  const fetch = a.slice(a.indexOf('async function fetchBookings'), a.indexOf('const [bookingsRes'));
  assert.equal((fetch.match(/\.not\('status', 'in', '\(cancelled,expired\)'\)/g) ?? []).length, 3);
  assert.doesNotMatch(fetch, /\.neq\('status', 'cancelled'\)/);
});

test('ficha: reserva vencida = "Vencida", sin cobro ni correos; sin costo sin "Emitir boleta"; Pasos solo con sesiones vigentes', () => {
  const f = leer('src/pages/admin/pacientes/[id].astro');
  assert.match(f, /const isCancelled = b\.status === 'cancelled' \|\| b\.status === 'expired';/);
  assert.match(f, /b\.status === 'expired' \? \(b\.paid_at \? 'Vencida · pago por devolver o reagendar' : 'Vencida \(no se pagó\)'\)/);
  // Vencida pero pagada por Flow tarde (hora ocupada): el pago sigue a la vista para devolverlo.
  assert.match(f, /\(!isCancelled \|\| \(b\.status === 'expired' && isPaid\)\) && <span class=\{`badge \$\{payBadgeClass\}`\}>/);
  assert.match(f, /\) : isPaid && \(b\.amount \?\? 0\) > 0 \? \(\s*<button type="button" class="btn btn-outline btn-sm bol-emitir"/);
  assert.match(f, /tieneSesiones: patientBookings\.some\(\(b\) => b\.status !== 'cancelled' && b\.status !== 'expired' && b\.session_date !== '2099-12-31'\)/);
});

test('Inicio: una sesión sin costo dice "sin costo", no "pagada"', () => {
  const i = leer('src/pages/admin/index.astro');
  assert.match(i, /pago: b\.paid_at \? \(Number\(b\.amount\) > 0 \? 'pagada' : 'sin-cobro'\)/);
  assert.match(i, /'sin-cobro': 'sin costo'/);
});

test('aviso "Cobrar a…" (32 h): no pide cobrar a quien subió comprobante, ya pagó por Flow sin aviso o está pagando en Flow', async () => {
  const { cobrosProximos } = await import('../cobrosProximos');
  const en = (h: number) => {
    const d = new Date(Date.now() + h * 3600e3);
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const v = (t: string) => p.find((x) => x.type === t)!.value;
    return { session_date: `${v('year')}-${v('month')}-${v('day')}`, session_time: `${v('hour')}:${v('minute')}:00` };
  };
  db.tabla('bookings').push(
    reserva({ patient_name: 'Debe Pagar', patient_email: 'a@x.cl', ...en(10) }),
    reserva({ patient_name: 'Con Comprobante', patient_email: 'b@x.cl', status: 'pending_payment', notes: 'ComprobanteTransferencia 2026-10-19T12:00:00Z c/b.jpg', ...en(11) }),
    reserva({ patient_name: 'Flow Sin Aviso', patient_email: 'c@x.cl', notes: 'PagoSinAviso 2026-10-19', ...en(12) }),
    reserva({ patient_name: 'Pagando En Flow', patient_email: 'd@x.cl', status: 'pending_payment', created_by_admin: false, ...en(13) }),
    reserva({ patient_name: 'Anulada', patient_email: 'e@x.cl', status: 'cancelled', ...en(14) }),
  );
  assert.deepEqual((await cobrosProximos('https://x')).map((c) => c.paciente), ['Debe Pagar']);
});
