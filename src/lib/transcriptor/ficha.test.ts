// Pruebas de la ficha estilo historial, "Para revisar hoy" y la decisión F (passkey solo al entrar)
// — 02-decisiones-16oct-noche B y F. Sin red. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AVISO_IA_PUEDE_ERRAR, armarHistorial, bloqueParaRevisarHoy, sessionTypeDeGrabacion } from './panel';
import { EJ1_RESUMEN, EJ3_RESUMEN } from './resumen.fixtures';

const leer = (ruta: string) => readFileSync(new URL(`../../../${ruta}`, import.meta.url), 'utf8');

test('historial: una entrada por sesión (reserva + nota + grabación), por booking o por fecha, de la más nueva a la más antigua', () => {
  const reservas = [
    { id: 'b1', session_date: '2026-10-15', session_time: '16:00:00', session_type: 'presencial', status: 'confirmed' },
    { id: 'b2', session_date: '2026-10-08', session_time: '16:00:00', session_type: 'pareja-online', status: 'confirmed' },
    { id: 'b3', session_date: '2026-10-01', session_time: '10:00:00', session_type: 'online', status: 'cancelled' },
    { id: 'b4', session_date: '2026-12-01', session_time: '10:00:00', session_type: 'online', status: 'confirmed' },
  ];
  const notas = [
    { id: 'n1', booking_id: 'b1', session_date: '2026-10-15', session_type: 'presencial' },
    { id: 'n2', booking_id: null, session_date: '2026-09-30', session_type: 'online' },
  ];
  const tarjetas = [
    { g: { id: 'g1', booking_id: 'b1', session_date: '2026-10-15', inicio_at: '2026-10-15T19:02:00Z', tipo: 'individual', origen: 'presencial' } },
    { g: { id: 'g2', booking_id: null, session_date: '2026-09-30', inicio_at: '2026-09-30T13:00:00Z', tipo: 'individual', origen: 'online' } },
  ];
  const h = armarHistorial({ notas, tarjetas, reservas, hoy: '2026-10-16' });
  assert.deepEqual(h.map((e) => [e.fecha, e.hora, e.sessionType, e.notas.map((n) => n.id), e.ia.map((t) => t.g.id)]), [
    ['2026-10-15', '16:00', 'presencial', ['n1'], ['g1']],
    ['2026-10-08', '16:00', 'pareja-online', [], []],          // sin nota: botón "Escribir evolución"
    ['2026-09-30', '10:00', 'online', ['n2'], ['g2']],          // sin reserva: se junta por fecha; hora de la grabación (Chile)
  ]);
  assert.equal(sessionTypeDeGrabacion({ tipo: 'pareja', origen: 'presencial' }), 'pareja-presencial');
});

test('"Para revisar hoy": Para trabajar + Tareas del último resumen que las tenga', () => {
  const t = (id: string, fecha: string, contenido: string | null) => ({ g: { id, session_date: fecha }, contenido });
  const b = bloqueParaRevisarHoy([t('viejo', '2026-10-01', EJ3_RESUMEN), t('nuevo', '2026-10-08', EJ1_RESUMEN), t('sin', '2026-10-15', null)])!;
  assert.equal(b.grabacionId, 'nuevo');
  assert.match(b.md, /^### Para trabajar en esta sesión\n- Retomar "la que puede con todo"/);
  assert.match(b.md, /### Tareas que quedaron\n- Camila: anotar en el celular/);
  assert.equal(bloqueParaRevisarHoy([t('x', '2026-10-01', '### Puntos más importantes\n- a')]), null);
});

test('ficha: "Para revisar hoy" arriba (fuera de las pestañas), historial, buscador, filtro, descarga y panel de IA', () => {
  const f = leer('src/pages/admin/pacientes/[id].astro');
  const hoy = f.indexOf('Para revisar hoy</p>');
  assert.ok(hoy > 0 && hoy < f.indexOf('<!-- Tabs -->') && hoy < f.indexOf('<!-- Consentimiento de datos'), 'arriba de todo, en cualquier pestaña');
  for (const x of ['Escribir evolución', 'Resumen IA', 'Ver más', 'Buscar por palabras clave', 'hist-filtro', '/exportar', 'Preguntar a la IA', 'Escribe tu pregunta…', 'AVISO_IA_PUEDE_ERRAR', 'resumenes-archivados', 'ConsentimientoParejaAnexos']) {
    assert.ok(f.includes(x), `la ficha incluye ${x}`);
  }
  assert.equal(AVISO_IA_PUEDE_ERRAR, 'La IA puede cometer errores. Revisa las respuestas.');
  // F: con passkey los resúmenes se ven siempre (ya no dependen de la pestaña Notas).
  assert.doesNotMatch(f, /Fuera de Notas no se muestra texto/);
});

test('F: retomar una grabación pausada nunca pide passkey (ni toca el servidor)', () => {
  const g = leer('src/pages/admin/grabar.astro');
  const ini = g.indexOf('async function continuar()');
  const fin = g.indexOf('\n  }\n', ini);
  const continuar = g.slice(ini, fin);
  assert.ok(ini > 0);
  assert.doesNotMatch(continuar, /fetch\(|passkey|webauthn|\/admin\/seguridad/i);
  // Los endpoints del grabador solo exigen la sesión del panel (guardiaPanel), no reconfirmar passkey.
  for (const ep of ['grabacion-iniciar.ts', 'subida-url.ts', 'grabacion-finalizar.ts']) {
    const src = leer(`src/pages/api/admin/transcriptor/${ep}`);
    assert.match(src, /guardiaPanel\(/);
    assert.doesNotMatch(src, /exigirAccesoClinico|accesoClinico/);
  }
});

test('transcripciones: siempre externas — nada las escribe en Supabase', () => {
  for (const f of ['pipeline.ts', 'archivo.ts', 'exportacion.ts', 'resumen.ts']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\('transcripciones'\)\s*\.(insert|update|upsert)\([^)]*(segmentos|tramos|texto)/);
  }
  const pre = leer('src/pages/api/admin/transcriptor/preguntar.ts');
  assert.doesNotMatch(pre, /tramos[^;]*\.insert|segmentos[^;]*\.insert/);
});
