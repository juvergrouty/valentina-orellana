#!/usr/bin/env node
// Prueba de que NINGUNA llave queda escrita en el build (revisión de seguridad 16 oct 2026, A2/M1).
//
// Hace `astro build` con valores FALSOS únicos en cada variable secreta y busca esos valores en
// toda la salida (.vercel/output: funciones del servidor y archivos estáticos). Si aparece
// alguno de la lista OBLIGATORIA, termina con código 1. Al final borra .vercel/output (queda con
// los valores falsos; no son llaves reales, pero no sirve para desplegar).
//
// Uso (desde la raíz del repo):
//   export PATH=~/pinokio/bin/miniconda/bin:$PATH   # si node no está en el PATH
//   node scripts/verificar-secretos-build.mjs
// Opcional: --sin-build   revisa un .vercel/output ya generado con estos mismos valores.
//           --conservar   no borra .vercel/output al terminar.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RAIZ = resolve(new URL('..', import.meta.url).pathname);
const SALIDA = join(RAIZ, '.vercel', 'output');
const args = new Set(process.argv.slice(2));

// Llaves que NUNCA pueden quedar en el bundle (transcriptor, sesión del panel y resto del sitio:
// pagos Flow, Google, Meta/Instagram, SII/APIGateway, webhook de Resend). Todas se leen con
// secreto('NOMBRE') de src/lib/secretos.ts. Si aparece cualquiera, la prueba falla.
const OBLIGATORIAS = [
  'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY',
  'ASSEMBLYAI_API_KEY', 'ASSEMBLYAI_WEBHOOK_SECRET',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'B2_KEY_ID', 'B2_APPLICATION_KEY',
  'FLY_API_TOKEN', 'BOT_TOKEN_SECRET', 'BOT_APROVISIONAR_SECRET', 'FLY_API_TOKEN_RESPALDO',
  'TRANSCRIPTOR_KEK_V1', 'TRANSCRIPTOR_KEK_V2', 'TRANSCRIPTOR_KEK_V3', 'TRANSCRIPTOR_KEK_V4', 'TRANSCRIPTOR_KEK_V5',
  'BACKUP_KEK_V1',
  'ADMIN_SECRET', 'ADMIN_PASSWORD', 'CRON_SECRET',
  'FLOW_API_KEY', 'FLOW_SECRET_KEY', 'FLOW_SANDBOX_API_KEY', 'FLOW_SANDBOX_SECRET_KEY',
  'GOOGLE_CLIENT_SECRET', 'META_APP_SECRET', 'INSTAGRAM_ACCESS_TOKEN', 'GOOGLE_PLACES_API_KEY',
  'APIGATEWAY_APIKEY', 'SII_CLAVE', 'RESEND_WEBHOOK_SECRET',
];

const falso = (n) => `FALSO_${n.replace(/[^A-Z0-9]/g, '')}_9f3c`;

if (!args.has('--sin-build')) {
  const env = { ...process.env, SUPABASE_URL: process.env.SUPABASE_URL || 'https://falso.supabase.co' };
  for (const n of OBLIGATORIAS) env[n] = falso(n);
  console.log('Build con valores falsos…');
  const r = spawnSync('npx', ['astro', 'build'], { cwd: RAIZ, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) { console.error('El build falló.'); process.exit(2); }
}
if (!existsSync(SALIDA)) { console.error('No existe .vercel/output.'); process.exit(2); }

function* archivos(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) yield* archivos(p);
    else if (s.size < 50 * 1024 * 1024) yield p;
  }
}

const hallados = new Map(); // nombre → [archivos]
const buscados = OBLIGATORIAS.map((n) => [n, falso(n)]);
for (const f of archivos(SALIDA)) {
  const t = readFileSync(f).toString('latin1');
  for (const [n, v] of buscados) if (t.includes(v)) hallados.set(n, [...(hallados.get(n) ?? []), f.slice(RAIZ.length + 1)]);
}

const malos = OBLIGATORIAS.filter((n) => hallados.has(n));
for (const n of malos) console.error(`FALLA: ${n} quedó escrita en el build:\n  ${hallados.get(n).slice(0, 5).join('\n  ')}`);

if (!args.has('--conservar')) rmSync(SALIDA, { recursive: true, force: true });

if (malos.length) { console.error(`\n${malos.length} llave(s) secreta(s) en el build.`); process.exit(1); }
console.log(`OK: ninguna de las ${OBLIGATORIAS.length} llaves secretas aparece en .vercel/output.`);
