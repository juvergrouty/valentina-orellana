// Vista previa, aviso de cierre duplicado y "Enviarme una prueba" del correo masivo (pedido de Vale,
// 19 oct 2026, rama masivo-vista-previa). Resend reemplazado por un doble que NO envía nada; base en memoria.
// Comprueba:
//   • la vista previa usa el MISMO armado que el envío real (htmlCorreoMasivo === HTML de sendBulkEmail);
//   • detección del cierre duplicado ("Un saludo", "Saludos", "Un abrazo", "Cariños", "Valentina");
//   • la prueba va SOLO al correo de avisos de Vale, con "[Prueba] …", sin contar como envío masivo.
// Con VO_CORREOS_DIR=<carpeta> guarda el HTML de la vista previa (para mirarlo en el navegador).
// Correr: pnpm test
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { FIRMA_GMAIL, LOGO_HEADER_HTML } from '../firmaCorreo';
import { AVISO_CIERRE_DUPLICADO, asuntoPrueba, htmlCorreoMasivo, terminaConCierre, textoMasivoAHtml } from '../correoMasivo';

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
process.env.ADMIN_SECRET = 'secreto-admin-de-prueba-0123456789';

type Msg = { to: string | string[]; subject: string; html: string };
let email: typeof import('../email');
let db: SupabaseMemoria;
const enviados = () => ((globalThis as { __voEnviados?: Msg[] }).__voEnviados ??= []);
const RAIZ = join(import.meta.dirname, '..', '..', '..');
const leer = (p: string) => readFileSync(join(RAIZ, p), 'utf8');

before(async () => { email = await import('../email'); });
beforeEach(() => {
  db = new SupabaseMemoria();
  (globalThis as { __voSupabasePrueba?: unknown }).__voSupabasePrueba = db;
  (globalThis as { __voEnviados?: Msg[] }).__voEnviados = [];
});

const TEXTO = 'Les cuento que en noviembre cambio mi horario.\nLos jueves atenderé hasta las 20:00 <importante> & más.';

// ─── 1. Vista previa = envío real ────────────────────────────────────────────────────────────────
test('vista previa: el HTML es idéntico al que arma el envío real (sendBulkEmail)', async () => {
  const cuerpo = textoMasivoAHtml(TEXTO);
  await email.sendBulkEmail([{ name: 'Camila Rojas', email: 'camila@ejemplo.cl' }], 'Novedades', cuerpo);
  assert.equal(enviados().length, 1);
  const vista = htmlCorreoMasivo({ nombre: 'Camila Rojas', cuerpoHtml: cuerpo });
  assert.equal(enviados()[0].html, vista, 'mismo HTML exacto');
  if (process.env.VO_CORREOS_DIR) {
    mkdirSync(process.env.VO_CORREOS_DIR, { recursive: true });
    writeFileSync(join(process.env.VO_CORREOS_DIR, 'masivo-vista-previa.html'), `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#fff;">${vista}</body></html>`);
  }
});

test('vista previa: con píxel de apertura, el envío real es el mismo armado + el píxel', async () => {
  const cuerpo = textoMasivoAHtml(TEXTO);
  await email.sendBulkEmail([{ name: 'Camila Rojas', email: 'camila@ejemplo.cl', pixelId: '0b3c-uuid' }], 'Novedades', cuerpo);
  assert.equal(enviados()[0].html, htmlCorreoMasivo({ nombre: 'Camila Rojas', cuerpoHtml: cuerpo, pixelId: '0b3c-uuid' }));
  assert.match(enviados()[0].html, /api\/abierto\/0b3c-uuid\.gif/);
  // Un id raro no se inyecta en el HTML.
  assert.doesNotMatch(htmlCorreoMasivo({ nombre: 'x', cuerpoHtml: '', pixelId: '"><script>' }), /script/);
});

test('vista previa: logo, "Hola <nombre>,", el texto (escapado), "Un saludo," y la firma, en ese orden', () => {
  const h = htmlCorreoMasivo({ nombre: 'Ana <b>', cuerpoHtml: textoMasivoAHtml(TEXTO) });
  const i = [LOGO_HEADER_HTML, 'Hola Ana &lt;b&gt;,', 'cambio mi horario.<br>Los jueves', '&lt;importante&gt; &amp; más', 'Un saludo,', FIRMA_GMAIL].map((s) => h.indexOf(s));
  i.forEach((n, k) => assert.ok(n >= 0, `parte ${k} presente`));
  assert.deepEqual([...i].sort((a, b) => a - b), i, 'orden correcto');
  assert.equal((h.match(/Un saludo,/g) ?? []).length, 1);
  assert.equal(textoMasivoAHtml('  hola\r\nchao  '), 'hola<br>chao', 'recorta y normaliza saltos de Windows');
});

test('la página y el endpoint usan el mismo armado (correoMasivo.ts), no uno propio', () => {
  const pagina = leer('src/pages/admin/comunicaciones.astro');
  assert.match(pagina, /import \{[^}]*htmlCorreoMasivo[^}]*\} from '..\/..\/lib\/correoMasivo'/);
  assert.match(pagina, /frame\.srcdoc = /);
  assert.match(pagina, /<iframe id="com-prev-frame"[^>]*sandbox="[^"]*"/, 'iframe con sandbox');
  assert.doesNotMatch(pagina.match(/<iframe id="com-prev-frame"[^>]*>/)![0], /allow-scripts/, 'sin scripts dentro de la vista previa');
  assert.match(pagina, /data-ancho="375"[^>]*>Celular</);
  assert.match(pagina, /data-ancho="600"[^>]*>Computador</);
  const api = leer('src/pages/api/admin/comunicaciones.ts');
  assert.match(api, /const bodyHtml = textoMasivoAHtml\(body\);/);
  const em = leer('src/lib/email.ts');
  const bulk = em.slice(em.indexOf('export async function sendBulkEmail'), em.indexOf('export async function sendBulkTestEmail'));
  assert.match(bulk, /htmlCorreoMasivo\(\{ nombre: r\.name, cuerpoHtml: bodyHtml, pixelId: r\.pixelId \}\)/);
});

// ─── 2. Cierre duplicado ─────────────────────────────────────────────────────────────────────────
test('aviso: detecta textos que ya terminan con saludo/despedida o el nombre', () => {
  for (const fin of ['Un saludo', 'Un saludo,', 'Saludos', 'Saludos cordiales.', 'Un abrazo', 'Un abrazo grande!', 'Abrazos',
    'Cariños', 'Con cariño,', 'Muchos cariños', 'Valentina', 'Valentina Orellana', 'Ps. Valentina Orellana', 'Un saludo, Valentina', 'UN SALUDO',
    'Les mando un abrazo', 'Te mando un abrazo grande', 'Con mucho cariño', 'Atte., Valentina Orellana', 'Valentina O.', 'Vale 💛',
    'Un abrazo 🤍', 'Cordialmente', 'Un abrazo para todas']) {
    assert.ok(terminaConCierre(`Hola a todas.\nEl jueves no atiendo.\n\n${fin}\n  \n`), `"${fin}"`);
  }
  // Despedida y nombre en dos líneas.
  assert.ok(terminaConCierre('Texto.\nUn abrazo,\nValentina'));
});

test('aviso: no salta con textos normales', () => {
  for (const t of ['', '   ', 'El jueves no atiendo.', 'Saludos a todas las que vienen el jueves: recuerden que cambió la dirección de la consulta.',
    'Les mando el link.\nNos vemos pronto', 'Saludos a quienes se suman este mes', 'Abrazos y nos vemos el jueves',
    'Un saludo especial a quienes empiezan.', 'Besos a sus guaguas', 'Saludos cordiales y bienvenidas a las nuevas pacientes', 'Valentina estará fuera la semana del 3.', 'Un saludo, Valentina'.repeat(4)]) {
    assert.equal(terminaConCierre(t), false, JSON.stringify(t));
  }
  assert.match(AVISO_CIERRE_DUPLICADO, /Tu firma ya agrega 'Un saludo,' y tu nombre al final; puedes borrar el cierre de tu texto\./);
  // El panel solo avisa, no borra: el texto se manda tal cual.
  assert.match(textoMasivoAHtml('Hola\nUn abrazo'), /Un abrazo/);
});

// ─── 3. Prueba solo a Vale ───────────────────────────────────────────────────────────────────────
test('prueba: va SOLO al correo de avisos de Vale, con "[Prueba] …" y el mismo HTML, sin registrarse como masivo', async () => {
  db.tablas.settings = [{ key: 'notification_email', value: 'avisos-vale@ejemplo.cl' }];
  const cuerpo = textoMasivoAHtml(TEXTO);
  const r = await email.sendBulkTestEmail({ nombre: 'Camila Rojas', subject: 'Cambio de horario', bodyHtml: cuerpo });
  assert.deepEqual(r, { sent: true, to: 'avisos-vale@ejemplo.cl' });
  assert.equal(enviados().length, 1, 'un solo correo');
  const m = enviados()[0];
  assert.equal(m.to, 'avisos-vale@ejemplo.cl');
  assert.equal(m.subject, '[Prueba] Cambio de horario');
  assert.equal(m.subject, asuntoPrueba(' Cambio de horario '));
  assert.equal(m.html, htmlCorreoMasivo({ nombre: 'Camila Rojas', cuerpoHtml: cuerpo }), 'idéntico a la vista previa');
  assert.doesNotMatch(m.html, /api\/abierto\//, 'sin píxel de apertura');
  assert.equal((db.tablas.bulk_emails ?? []).length, 0, 'no cuenta como envío masivo');
  assert.equal((db.tablas.bulk_email_recipients ?? []).length, 0);
});

test('prueba: sin setting, va al correo de respaldo de Vale (nunca a una paciente)', async () => {
  const r = await email.sendBulkTestEmail({ nombre: 'Camila Rojas', subject: 'X', bodyHtml: 'y' });
  assert.equal(r.to, email.ADMIN_EMAIL_FALLBACK);
  assert.equal(enviados()[0].to, email.ADMIN_EMAIL_FALLBACK);
});

test('prueba: el endpoint pasa por guardiaPanel antes de enviar, no acepta destinatario y no registra el envío', () => {
  const api = leer('src/pages/api/admin/comunicaciones.ts');
  const ramo = api.slice(api.indexOf("includes('application/json')"), api.indexOf('const form    = await request.formData();'));
  const iG = ramo.indexOf("await guardiaPanel(ctx, 'correo_masivo_prueba')");
  const iS = ramo.indexOf('sendBulkTestEmail(');
  assert.ok(iG > 0 && iS > iG, 'guardia antes del envío');
  assert.match(ramo, /if \(rechazo\) return rechazo;/);
  assert.doesNotMatch(ramo, /bulk_emails|body\.(to|email|para|destinatario)/, 'sin registro masivo ni destinatario elegido por el cliente');
  const em = leer('src/lib/email.ts');
  assert.match(em, /export async function sendBulkTestEmail\(opts: \{ nombre: string; subject: string; bodyHtml: string \}\)/, 'la firma no admite destinatario');
  const pagina = leer('src/pages/admin/comunicaciones.astro');
  assert.match(pagina, /'X-Panel': '1'/);
  assert.match(pagina, /action: 'send-test'/);
});
