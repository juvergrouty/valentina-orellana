// Pruebas de la reparación de mojibake Mac Roman. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repararMojibake } from './texto';
import { ROTULO_RESUMEN } from './tipos';

test('repara el rótulo tal como se vio en producción (17 oct)', () => {
  assert.equal(repararMojibake('Resumen autom√°tico (IA) ‚Äî no revisado'), ROTULO_RESUMEN);
  assert.equal(repararMojibake('Valentina Orellana|V√≠nculos que sostienen'), 'Valentina Orellana|Vínculos que sostienen');
  assert.equal(repararMojibake('Resume la sesi√≥n en espa√±ol ¬øs√≠?'), 'Resume la sesión en español ¿sí?');
});

test('no toca texto correcto ni texto con √ legítimo', () => {
  for (const t of [ROTULO_RESUMEN, 'Ñuñoa — «cita» ¿qué?', '√2 es irracional', 'plain ascii', '']) {
    assert.equal(repararMojibake(t), t);
  }
  assert.equal(repararMojibake(null), null);
  assert.equal(repararMojibake(undefined), undefined);
});

test('ningún archivo de src/ ni de las migraciones trae mojibake (√° · ‚Äî)', () => {
  const raiz = join(import.meta.dirname, '..', '..', '..');
  const malos: string[] = [];
  const recorrer = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { recorrer(p); continue; }
      if (!/\.(ts|astro|sql|mjs|js|css|json)$/.test(n) || n === 'texto.test.ts' || n === 'texto.ts') continue;
      const s = readFileSync(p, 'utf8');
      if (/√[°©≠≥∫±]|‚Ä[îî¶ú]/.test(s)) malos.push(p);
    }
  };
  recorrer(join(raiz, 'src'));
  recorrer(join(raiz, 'supabase', 'migrations'));
  assert.deepEqual(malos, []);
});
