// Firma de Gmail de Vale en TODOS los correos a pacientes (pedido de Vale, 19 oct 2026, rama firma-correos).
// Arma cada correo REAL de src/lib/email.ts con datos de prueba (Resend reemplazado por un doble que no
// envía nada; base en memoria) y comprueba:
//   • correos a pacientes: terminan con "Un saludo," + firma (sello + href wa.me + href /agenda), y debajo
//     solo el registro de la Superintendencia en letra chica (si ya lo tenían);
//   • avisos internos a Vale: sin firma.
// Con VO_CORREOS_DIR=<carpeta> guarda cada HTML ahí (para mirarlos en el navegador a 375 y 600+ px).
// Correr: pnpm test
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { CIERRE_TEXTO, FIRMA_GMAIL, FIRMA_TEXTO, REGISTRO_SUPERINTENDENCIA_HTML } from '../firmaCorreo';

const STUB = pathToFileURL(join(import.meta.dirname, 'pruebas', 'supabaseGlobal.ts')).href;
// Doble de Resend: guarda lo que se le pasa a emails.send y responde OK (no sale ningún correo).
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
  // Fuera de Vite no existe import.meta.env (email.ts lee EMAIL_FROM al cargar).
  export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (!/\\/src\\/lib\\/email\\.ts$/.test(url) || r.source == null) return r;
    return { ...r, source: String(r.source).replace(/import\\.meta\\.env\\.EMAIL_FROM/g, 'undefined') };
  }`)}`, { data: { stub: STUB, resend: RESEND } });

process.env.RESEND_API_KEY = 're_prueba_no_envia';
process.env.ADMIN_SECRET = 'secreto-admin-de-prueba-0123456789';

type Msg = { to: string | string[]; subject: string; html: string; text?: string };
let email: typeof import('../email');
let db: SupabaseMemoria;
const enviados = () => ((globalThis as { __voEnviados?: Msg[] }).__voEnviados ??= []);

before(async () => { email = await import('../email'); });
beforeEach(() => {
  db = new SupabaseMemoria();
  (globalThis as { __voSupabasePrueba?: unknown }).__voSupabasePrueba = db;
  (globalThis as { __voEnviados?: Msg[] }).__voEnviados = [];
});

const DIR = process.env.VO_CORREOS_DIR;
function guardar(nombre: string, html: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  const doc = /^\s*<!doctype/i.test(html) ? html
    : `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${nombre}</title></head><body style="margin:0;background:#fff;">${html}</body></html>`;
  writeFileSync(join(DIR, `${nombre}.html`), doc);
}

const PACIENTE = 'camila@ejemplo.cl';
const reserva = {
  patient_name: 'Camila Rojas', patient_email: PACIENTE, patient_phone: '+56912345678', session_type: 'presencial',
  session_date: '2030-03-14', session_time: '18:00:00', amount: 40000, payment_method: 'flow', is_new_patient: true,
  booking_id: '00000000-0000-4000-8000-000000000001',
};
const vitrina = {
  inscripcion_id: 'i1', name: 'Camila Rojas', email: PACIENTE, phone: '+56912345678', item_title: 'Taller de apego',
  item_type: 'taller' as const, modality: 'online' as const, starts_at: '2030-03-14T22:00:00Z', duration_min: 90, amount: 15000,
  meet_url: 'https://meet.google.com/abc-defg-hij',
};

/** Correos a pacientes: [nombre, envío, ¿lleva el registro de la Superintendencia debajo?]. */
const correosPaciente: [string, () => Promise<unknown>, boolean][] = [
  ['confirmacion', () => email.sendConfirmationToClient(reserva, { skipToggle: true }), true],
  ['sesion-actualizada', () => email.sendSessionUpdatedEmail({ ...reserva, reason: 'Tu sesión fue reagendada' }), true],
  ['anulacion', () => email.sendCancellationEmail({ patient_name: 'Camila Rojas', patient_email: PACIENTE, session_date: '2030-03-14', session_time: '18:00:00' }), false],
  ['link-pago', () => email.sendPaymentLinkEmail({ patientName: 'Camila Rojas', patientEmail: PACIENTE, serviceName: 'Sesión Individual Online', amount: 40000, sessionDate: '2030-03-14', sessionTime: '18:00', paymentUrl: 'https://www.valentinaorellana.cl/pagar/x' }), true],
  ['saldo-pendiente', () => email.sendDebtReminderEmail({ patientName: 'Camila Rojas', patientEmail: PACIENTE, amount: 80000, sessionsCount: 2, payUrl: 'https://www.valentinaorellana.cl/pagar/x' }), true],
  ['recordatorio', () => email.sendReminderEmail(reserva), true],
  ['reserva-liberada', () => email.sendPendingExpiredEmail({ patient_name: 'Camila Rojas', patient_email: PACIENTE, session_date: '2030-03-14', session_time: '18:00', recoverUrl: 'https://www.valentinaorellana.cl/recuperar/x' }), true],
  ['resena', () => email.sendReviewRequestEmail({ patientName: 'Camila Rojas', patientEmail: PACIENTE, reviewUrl: 'https://g.page/r/x' }), true],
  ['evaluacion', () => email.sendEvaluationEmail({ patientName: 'Camila Rojas', patientEmail: PACIENTE }), true],
  ['pasos-a-seguir', () => email.sendStepsEmail({ patientName: 'Camila Rojas', patientEmail: PACIENTE, clinicAddress: 'Av. Apoquindo 4499, Las Condes' }), true],
  ['boleta', () => email.sendBoletaEmail({ to: PACIENTE, patientName: 'Camila Rojas', folio: 123, pdfBase64: 'JVBERi0=' }), true],
  ['masivo', () => email.sendBulkEmail([{ name: 'Camila Rojas', email: PACIENTE, pixelId: 'p1' }], 'Novedades', '<p>Texto del correo masivo.</p>'), true],
  ['consentimiento', () => email.sendConsentLinkEmail({ patientName: 'Camila Rojas', patientEmail: PACIENTE, url: 'https://www.valentinaorellana.cl/consentimiento/x' }), true],
  ['consentimiento-pareja', () => email.sendConsentLinkEmail({ patientName: '', patientEmail: PACIENTE, url: 'https://www.valentinaorellana.cl/consentimiento/y', destinatarioEnLog: 'c***@ejemplo.cl' }), true],
  ['consentimiento-copia', () => email.sendConsentSignedCopy({ to: [PACIENTE, 'vale@ejemplo.cl'], signerName: 'Camila Rojas', signerRut: '12.345.678-5', signedAt: '19-10-2026 10:00', plainText: 'Texto del consentimiento.', marcadas: ['Grabar el audio'] }), false],
  ['vitrina-confirmacion', () => email.sendVitrinaConfirmation(vitrina), true],
];

const ADMIN = 'vale@ejemplo.cl';
const correosInternos: [string, () => Promise<unknown>][] = [
  ['notif-admin', () => email.sendNotificationToAdmin(reserva, ADMIN)],
  ['hora-liberada-admin', () => email.sendExpiredBookingAdminAlert(reserva, ADMIN)],
  ['reagendo-admin', () => email.sendRescheduleAdminAlert({ patient_name: 'Camila Rojas', patient_email: PACIENTE, old_date: '2030-03-14', old_time: '18:00', new_date: '2030-03-15', new_time: '18:00' }, ADMIN)],
  ['contacto', () => email.sendContactFormEmail({ nombre: 'Camila', email: PACIENTE, mensaje: 'Hola' }, ADMIN)],
  ['transferencia', () => email.sendTransferReceiptAdmin({ to: ADMIN, patientName: 'Camila Rojas', patientEmail: PACIENTE, total: 40000, sesiones: [{ label: '14 mar', amount: 40000 }], fileName: 'c.pdf', fileBase64: 'JVBERi0=', panelUrl: 'https://www.valentinaorellana.cl/admin' })],
  ['vitrina-admin', () => email.sendVitrinaAdminNotification(vitrina, ADMIN)],
];

async function armar(envio: () => Promise<unknown>): Promise<Msg> {
  await envio();
  assert.equal(enviados().length, 1, 'se armó exactamente un correo');
  return enviados()[0];
}

for (const [nombre, envio, conRegistro] of correosPaciente) {
  test(`paciente · ${nombre}: termina con "Un saludo," + firma de Gmail (enlaces clickeables)`, async () => {
    const m = await armar(envio);
    guardar(nombre, m.html);
    const h = m.html;
    assert.ok(h.includes(FIRMA_GMAIL), 'lleva la firma completa');
    assert.match(h, /<img src="https:\/\/www\.valentinaorellana\.cl\/firma\/sello\.png"/, 'sello');
    const firma = h.slice(h.indexOf(FIRMA_GMAIL));
    assert.match(firma, /<a href="https:\/\/wa\.me\/56972735696"[^>]*>WhatsApp<\/a>/, 'WhatsApp clickeable');
    assert.match(firma, /<a href="https:\/\/www\.valentinaorellana\.cl"[^>]*>valentinaorellana\.cl<\/a>/, 'sitio clickeable');
    assert.match(firma, /<a href="https:\/\/www\.valentinaorellana\.cl\/agenda"[^>]*>Agenda tu hora<\/a>/, 'agenda clickeable');
    // "Un saludo," justo antes de la firma, y después de ella no queda nada visible salvo el registro.
    const antes = h.slice(0, h.indexOf(FIRMA_GMAIL));
    assert.match(antes, /Un saludo,<\/p>\s*$/, '"Un saludo," inmediatamente antes de la firma');
    assert.equal((h.match(/Un saludo,/g) ?? []).length, 1);
    const despues = firma.slice(FIRMA_GMAIL.length);
    assert.equal(despues.includes(REGISTRO_SUPERINTENDENCIA_HTML), conRegistro, conRegistro ? 'registro debajo de la firma' : 'sin registro (no lo tenía)');
    assert.equal(despues.replace(REGISTRO_SUPERINTENDENCIA_HTML, '').replace(/<[^>]+>/g, '').trim(), '', 'la firma es lo último del correo');
    assert.equal((h.match(/Reg\. Superintendencia/g) ?? []).length, conRegistro ? 1 : 0, 'el registro aparece una sola vez');
    // El cierre antiguo ya no está.
    assert.doesNotMatch(h, /Ps\. Valentina Orellana · Psicóloga · Reg\./);
    assert.doesNotMatch(h, /background:#1A1A18;padding:28px 32px/, 'sin el pie oscuro antiguo de Pasos a seguir');
  });
}

test('paciente · anulación: la versión texto plano termina con "Un saludo," + firma en texto', async () => {
  const m = await armar(correosPaciente.find(([n]) => n === 'anulacion')![1]);
  assert.ok(m.text?.endsWith(`\n\n${CIERRE_TEXTO}`));
  assert.match(FIRMA_TEXTO, /https:\/\/wa\.me\/56972735696/);
  assert.match(FIRMA_TEXTO, /https:\/\/www\.valentinaorellana\.cl\/agenda/);
});

test('paciente · el contenido y los botones de cada correo siguen ahí (solo cambió el cierre)', async () => {
  const conf = await armar(correosPaciente[0][1]);
  assert.match(conf.html, /Tu sesión está confirmada/);
  assert.match(conf.html, /Escribir por WhatsApp/);
  assert.match(conf.html, /Reagendar mi sesión/);
  (globalThis as { __voEnviados?: Msg[] }).__voEnviados = [];
  const pasos = await armar(correosPaciente.find(([n]) => n === 'pasos-a-seguir')![1]);
  assert.match(pasos.html, /Pasos a seguir/);
  assert.match(pasos.html, /condiciones del servicio y la política de privacidad/);
  (globalThis as { __voEnviados?: Msg[] }).__voEnviados = [];
  const masivo = await armar(correosPaciente.find(([n]) => n === 'masivo')![1]);
  assert.match(masivo.html, /api\/abierto\/p1\.gif/, 'el píxel de apertura sigue');
});

for (const [nombre, envio] of correosInternos) {
  test(`interno a Vale · ${nombre}: sin firma`, async () => {
    const m = await armar(envio);
    guardar(nombre, m.html);
    assert.equal(m.to, ADMIN);
    assert.doesNotMatch(m.html, /firma\/sello\.png/);
    assert.doesNotMatch(m.html, /Un saludo,/);
    assert.doesNotMatch(m.html, /Agenda tu hora/);
  });
}
