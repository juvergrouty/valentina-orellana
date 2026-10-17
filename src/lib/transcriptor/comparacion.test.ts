// Pruebas sin red de la prueba ciega Sonnet vs Haiku (comparacion.ts + fixtures). Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { CONFIG_RESUMEN, costoUsd, paramsMensaje, type ClienteMensajes } from './claude';
import {
  MODELO_HAIKU, MODELO_SONNET, TOPE_CORRIDA_USD, azarSeguro, configComparacion, contarPalabras, costoCorrida,
  detalleDe, estimarCostoCasoUsd, rangoRelato, evaluarResumen, generarPar, realesBajoTope, minutosSinTramo, nombreModelo, numeroEnPalabras, problemasDe,
  promptComparacion, puedeRevelar, revelar, sortearOrden, terminosSinSustento, type CasoParaRevelar, type EntradaPar,
} from './comparacion';
import { CASOS_SINTETICOS, casoSintetico, tramosDeGuion } from './pruebas/comparacion';
import { PROMPT_VERSION_RESUMEN, estimarTokens, formatearTranscripcion, parsearResumen } from './resumen';

function mensaje(texto: string, usage = { input_tokens: 9000, output_tokens: 600 }) {
  return {
    id: 'msg_x', type: 'message', role: 'assistant', model: 'x',
    content: [{ type: 'text', text: texto }], stop_reason: 'end_turn',
    usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/** Cliente falso que responde según el modelo pedido (o lanza un error con status). */
function falso(porModelo: Record<string, unknown>) {
  const llamadas: Anthropic.MessageStreamParams[] = [];
  const cliente: ClienteMensajes = {
    messages: {
      stream(params) {
        llamadas.push(params);
        const r = porModelo[params.model as string];
        return { finalMessage: async () => { if ((r as { status?: number })?.status) throw r; return r as never; } };
      },
    },
  };
  return { cliente, llamadas };
}

function entradaDe(clave: string): EntradaPar {
  const c = casoSintetico(clave)!;
  return {
    plantilla: c.plantilla,
    instrucciones: 'Tono sobrio.',
    transcripcion: tramosDeGuion(c.guion, c.finSeg),
    sesion: { fecha: c.fecha, modalidad: c.modalidad, duracionMin: c.duracionMin, participantes: c.participantes, pausas: c.pausas ?? [] },
  };
}

// ─── Parámetros por modelo ───────────────────────────────────────────────────

test('configComparacion: Sonnet = producción (between_tools); Haiku sin pensamiento (disabled); mismo esfuerzo y tope', () => {
  const s = configComparacion(MODELO_SONNET);
  const h = configComparacion(MODELO_HAIKU);
  assert.equal(s.modelo, 'claude-sonnet-5-5');
  assert.equal(h.modelo, 'claude-haiku-5-5');
  assert.deepEqual(s, { ...CONFIG_RESUMEN, thinking: { type: 'between_tools' } });
  assert.deepEqual(s.thinking, { type: 'between_tools' });   // Sonnet 5.5: 'disabled' → 400
  assert.deepEqual(h.thinking, { type: 'disabled' });        // Haiku 5.5: 'disabled' válido con esfuerzo ≤ high
  assert.equal(s.esfuerzo, 'medium');
  assert.equal(h.esfuerzo, s.esfuerzo);
  assert.equal(h.maxTokens, s.maxTokens);
  assert.ok(['low', 'medium', 'high'].includes(h.esfuerzo), 'between_tools/disabled exigen esfuerzo ≤ high');
  assert.throws(() => configComparacion('claude-opus-5-5'));
});

test('paramsMensaje: mismo system y messages para los dos modelos, sin metadata, esfuerzo en output_config', () => {
  const prompt = promptComparacion(entradaDe('sint-individual-25'));
  const ps = paramsMensaje({ uso: configComparacion(MODELO_SONNET), ...prompt });
  const ph = paramsMensaje({ uso: configComparacion(MODELO_HAIKU), ...prompt });
  assert.deepEqual(ps.system, ph.system);
  assert.deepEqual(ps.messages, ph.messages);
  assert.equal('metadata' in ps, false);
  assert.equal('temperature' in ph, false);   // Haiku/Sonnet 5.5: sampling no por defecto → 400
  assert.deepEqual(ps.output_config, { effort: 'medium' });
  assert.deepEqual(ph.output_config, { effort: 'medium' });
  assert.equal(ps.model, MODELO_SONNET);
  assert.equal(ph.model, MODELO_HAIKU);
  assert.match(JSON.stringify(ps.system), /### Menciones de temas de riesgo[^]*### Resumen de la sesión/); // es el prompt de producción
});

// ─── Orden ciego ─────────────────────────────────────────────────────────────

test('sortearOrden: la mitad baja da Sonnet como 1, la alta Haiku como 1; azarSeguro está en [0,1) y reparte parejo', () => {
  assert.deepEqual(sortearOrden(() => 0.1), { modelo_1: MODELO_SONNET, modelo_2: MODELO_HAIKU });
  assert.deepEqual(sortearOrden(() => 0.9), { modelo_1: MODELO_HAIKU, modelo_2: MODELO_SONNET });
  let sonnetPrimero = 0;
  for (let i = 0; i < 4000; i++) {
    const x = azarSeguro();
    assert.ok(x >= 0 && x < 1);
    const o = sortearOrden(() => x);
    assert.notEqual(o.modelo_1, o.modelo_2);
    if (o.modelo_1 === MODELO_SONNET) sonnetPrimero++;
  }
  assert.ok(sonnetPrimero > 1700 && sonnetPrimero < 2300, `sesgo: ${sonnetPrimero}/4000`);
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

test('fixtures: tres casos inventados que se leen, ordenados, con hablantes A/B(/C) y largo suficiente', () => {
  assert.equal(CASOS_SINTETICOS.length, 3);
  for (const c of CASOS_SINTETICOS) {
    const tr = tramosDeGuion(c.guion, c.finSeg);
    assert.ok(tr.length >= (c.esperado.corta ? 80 : 150), `${c.clave}: ${tr.length} tramos`);
    for (let i = 1; i < tr.length; i++) assert.ok(tr[i].inicio_ms >= tr[i - 1].inicio_ms, `${c.clave} desordenado en ${i}`);
    assert.ok(tr.every((t) => /^[ABC]$/.test(t.hablante) && t.fin_ms > t.inicio_ms && t.fin_ms <= c.finSeg * 1000 + 1000));
    for (const p of c.pausas ?? []) assert.ok(!tr.some((t) => t.inicio_ms > p.desde_ms && t.inicio_ms < p.hasta_ms), 'tramo dentro de la pausa');
  }
  const ind = tramosDeGuion(casoSintetico('sint-individual-25')!.guion, 0).map((t) => t.texto).join(' ');
  assert.match(ind, /no despertar/);
  assert.match(ind, /no lo anotes/);
  const par = casoSintetico('sint-pareja-25')!;
  assert.equal(par.plantilla, 'pareja');
  assert.ok(tramosDeGuion(par.guion, par.finSeg).some((t) => t.hablante === 'C'));
  assert.throws(() => tramosDeGuion('[00:01] hola sin hablante', 10));
});

test('costo estimado de una corrida (3 sintéticos + 4 reales del tamaño del mayor) < US$0,30', () => {
  let usd = 0;
  let mayor = 0;
  for (const c of CASOS_SINTETICOS) {
    const p = promptComparacion(entradaDe(c.clave));
    const entrada = estimarTokens(JSON.stringify(p.system) + JSON.stringify(p.messages)); // ≈3 caracteres por token (conservador)
    mayor = Math.max(mayor, entrada);
    for (const m of [MODELO_SONNET, MODELO_HAIKU]) usd += costoUsd(m, { entrada, salida: 900, cacheEscritura: 0, cacheLectura: 0 });
  }
  for (let i = 0; i < 4; i++) for (const m of [MODELO_SONNET, MODELO_HAIKU]) usd += costoUsd(m, { entrada: mayor, salida: 900, cacheEscritura: 0, cacheLectura: 0 });
  assert.ok(usd < TOPE_CORRIDA_USD, `estimado US$${usd.toFixed(4)}`);
});

test('realesBajoTope: elige casos reales en orden mientras la corrida estimada quede bajo US$0,30', () => {
  const sint = CASOS_SINTETICOS.map((c) => c.duracionMin);
  const base = sint.reduce((a, m) => a + estimarCostoCasoUsd(m), 0);
  assert.ok(base < TOPE_CORRIDA_USD / 2, `sintéticos: US$${base.toFixed(4)}`);
  const cortos = [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, minutos: 30 }));
  assert.equal(realesBajoTope(cortos, sint).length, 4);                       // tope de casos
  const largos = [1, 2, 3, 4].map((i) => ({ id: i, minutos: 60 }));
  const elegidos = realesBajoTope(largos, sint);
  const total = base + elegidos.reduce((a, r) => a + estimarCostoCasoUsd(r.minutos), 0);
  assert.ok(elegidos.length < 4 && elegidos.length >= 1 && total <= TOPE_CORRIDA_USD, `${elegidos.length} casos, US$${total.toFixed(4)}`);
  assert.deepEqual(realesBajoTope([{ minutos: 600 }, { minutos: 20 }], sint).map((r) => r.minutos), [20]); // uno enorme se salta
});

// ─── Generación con cliente falso ────────────────────────────────────────────

const RESUMEN_BUENO = `### Menciones de temas de riesgo
- Se habló de que a veces piensa que sería más fácil no despertar — Dicho por: Martina (inferido) — [12:28]
  «pienso que sería más fácil no despertar al otro día»
_Mención consignada automáticamente. No es una evaluación de riesgo; revisar la transcripción completa._
### Resumen de la sesión
Martina refiere una semana pesada: la cambiaron de equipo y tiene una jefa nueva. Relata que revisa el correo en la noche, queda dándole vueltas y duerme cuatro a cinco horas por noche [01:07]. Expresa que siente que la nueva jefa la está evaluando todo el rato [02:19].

Se explora la noche del jueves, cuando despertó a las tres y media y pensó que el informe estaba mal; ella lo describe como «una película completa a las cuatro de la mañana» [05:40]. También cuenta que dejó el yoga hace como tres semanas y que el jueves lloró en el baño de la oficina.

Se prepara cómo preguntarle a la jefa por el horario en que espera respuestas. Martina dice sentirse más liviana y, al cierre, «Más ordenada. Con un plan.» [21:30]

Como tarea, se acuerda un registro de sueño cada mañana, preguntar a la jefa por el horario de respuesta el lunes y practicar la respiración cuatro siete ocho dos veces al día.
### Tareas
- Martina: registro de sueño cada mañana — hasta la próxima sesión [06:21]
- Martina: preguntar a la jefa por el horario de respuesta — lunes [08:09]
- Martina: respiración cuatro siete ocho dos veces al día [08:31]
- Terapeuta: enviar la guía de higiene del sueño — hoy [08:47]
### Para trabajar en la próxima sesión
- Cómo le fue con la jefa [21:05].
### Notas sobre la transcripción
- En [18:31] se pidió que algo no quedara registrado; ese tramo no se resume.`;

test('generarPar: los dos modelos reciben el mismo prompt, se verifican las citas y un error no tumba al otro', async () => {
  const { cliente, llamadas } = falso({
    [MODELO_SONNET]: mensaje(RESUMEN_BUENO),
    [MODELO_HAIKU]: mensaje(`${RESUMEN_BUENO}\n- Dijo «esto no está en la transcripción para nada» [03:00]`),
  });
  const e = entradaDe('sint-individual-25');
  const [a, b] = await generarPar(e, [MODELO_HAIKU, MODELO_SONNET], { cliente, intentos: 1 });
  assert.equal(llamadas.length, 2);
  assert.deepEqual(llamadas[0].system, llamadas[1].system);
  assert.deepEqual(llamadas[0].messages, llamadas[1].messages);
  assert.deepEqual(llamadas.map((l) => l.model).sort(), [MODELO_HAIKU, MODELO_SONNET].sort());
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(a.r.modelo, MODELO_HAIKU);
  assert.equal(a.r.verificacion.eliminadas, 1);           // la cita inventada se quitó
  assert.equal(b.r.verificacion.eliminadas, 0);
  assert.match(a.r.contenido, /^## Resumen automático \(IA\)/);
  assert.ok(a.r.costoUsd < b.r.costoUsd, 'Haiku cuesta menos');

  const { cliente: c2 } = falso({ [MODELO_SONNET]: { status: 400 }, [MODELO_HAIKU]: mensaje(RESUMEN_BUENO) });
  const [x, y] = await generarPar(e, [MODELO_SONNET, MODELO_HAIKU], { cliente: c2, intentos: 1 });
  assert.deepEqual(x, { ok: false, modelo: MODELO_SONNET, codigo: 'peticion_invalida' });
  assert.ok(y.ok);
});

// ─── Evaluación automática ───────────────────────────────────────────────────

test('evaluarResumen: un resumen fiel del caso individual no tiene problemas graves', async () => {
  const { cliente } = falso({ [MODELO_SONNET]: mensaje(RESUMEN_BUENO), [MODELO_HAIKU]: mensaje(RESUMEN_BUENO) });
  const e = entradaDe('sint-individual-25');
  const [a] = await generarPar(e, [MODELO_SONNET, MODELO_HAIKU], { cliente, intentos: 1 });
  assert.ok(a.ok);
  if (!a.ok) return;
  const caso = casoSintetico('sint-individual-25')!;
  const ev = evaluarResumen({ textoModelo: a.r.textoModelo, contenido: a.r.contenido, verificacion: a.r.verificacion, tramos: e.transcripcion, truncado: false, conocidos: ['Martina', 'Valentina'], esperado: caso.esperado });
  assert.deepEqual(ev.seccionesFaltantes, []);
  assert.equal(ev.seccionesExtra, 0);
  assert.equal(ev.citas.noVerificadas, 0);
  assert.deepEqual(ev.prohibidosEncontrados, []);
  assert.deepEqual(ev.tareasFaltantes, []);
  assert.equal(ev.riesgo.consignado, true);
  assert.deepEqual(ev.minutosSinTramo, []);
  assert.deepEqual(ev.terminosSinSustento, []);
  assert.deepEqual(ev.terminosRelato, []);
  assert.equal(ev.relatoEnVinetas, 0);
  assert.equal(ev.vinetasSinMinuto, 0);      // el relato no exige minuto por frase
  assert.deepEqual(ev.rango, [69, 115]);    // 23 min × 3–5 palabras
  // El relato de ejemplo (~145 palabras) se escribió para el tope anterior; con 3–5 palabras/min queda largo para 23 min.
  assert.equal(ev.palabras > 0, true);
  const graves = problemasDe(ev).filter((p) => !/^Largo del relato/.test(p.texto));
  assert.equal(graves.length, 0, graves.map((p) => p.texto).join(' | '));
  // El riesgo quedó aparte, antes del relato, y no dentro.
  const secs = parsearResumen(a.r.contenido).secciones;
  assert.deepEqual(secs.slice(0, 2).map((s) => s.titulo), ['Menciones de temas de riesgo', 'Resumen de la sesión']);
  assert.doesNotMatch(secs[1].cuerpo, /Se habló de|Mención consignada/);
});

test('evaluarResumen: detecta tramo no registrado, riesgo omitido, sección faltante, sección extra, minuto y nombre inventados', () => {
  const e = entradaDe('sint-individual-25');
  const caso = casoSintetico('sint-individual-25')!;
  const malo = `### Resumen de la sesión
Martina cuenta que su pareja tiene deudas por apuestas online [19:05]. Su amiga Fernanda la acompaña al yoga [24:59]. Duerme 4 horas y llora 37 veces [01:07].
- Sesión productiva.
### Resumen general
- Sesión productiva.
### Tareas
- Martina: yoga el sábado [10:24]`;
  const ev = evaluarResumen({ textoModelo: malo, contenido: malo, verificacion: { total: 2, verificadas: 1, minutosCorregidos: 0, eliminadas: 1 }, tramos: e.transcripcion, truncado: false, conocidos: ['Martina'], esperado: caso.esperado });
  assert.deepEqual(ev.seccionesFaltantes, ['Para trabajar en la próxima sesión']);
  assert.equal(ev.seccionesExtra, 1);
  assert.deepEqual(ev.prohibidosEncontrados, ['apuesta', 'apuestas']);
  assert.equal(ev.riesgo.consignado, false);
  assert.equal(ev.riesgo.esperado, true);
  assert.ok(ev.minutosSinTramo.includes('24:59'));
  assert.ok(ev.terminosSinSustento.includes('Fernanda'));
  assert.ok(ev.terminosRelato.includes('Fernanda'));
  assert.equal(ev.relatoEnVinetas, 1);
  assert.match(problemasDe(ev).map((p) => p.texto).join(' '), /en el relato\.[\s\S]*1 línea en viñeta/);
  assert.ok(ev.terminosSinSustento.includes('37'));
  assert.ok(!ev.terminosSinSustento.includes('4'), '4 = "cuatro" sí está en la transcripción');
  assert.deepEqual(ev.tareasFaltantes, ['registro de sueño', 'jefa', 'respiración', 'guía']);
  const graves = problemasDe(ev).filter((p) => p.grave).map((p) => p.texto).join(' | ');
  assert.doesNotMatch(graves, /no registrar/); // 17 oct: ya no es falta (todo es registro clínico)
  assert.match(graves, /mención de riesgo/);
  assert.match(graves, /1 cita no coincidía/);
});

test('evaluación de un caso REAL se guarda sin texto (solo conteos)', () => {
  const tramos = [{ inicio_ms: 0, fin_ms: 5000, hablante: 'A', texto: 'hola' }];
  const md = '### Resumen de la sesión\nAna refiere que habla de Rodolfo [00:00].\n### Tareas\n- No consta en la transcripción.\n### Para trabajar en la próxima sesión\n- No consta en la transcripción.';
  const ev = evaluarResumen({ textoModelo: md, contenido: md, verificacion: { total: 0, verificadas: 0, minutosCorregidos: 0, eliminadas: 0 }, tramos, truncado: false });
  assert.deepEqual(ev.terminosSinSustento, ['Rodolfo']);
  const d = detalleDe({ modelo: MODELO_HAIKU, contenido: md, textoModelo: md, verificacion: ev.citas as never, uso: { entrada: 1, salida: 1, cacheEscritura: 0, cacheLectura: 0 }, costoUsd: 0, truncado: false, ms: 1 }, ev, true);
  assert.deepEqual(d.evaluacion.terminosSinSustento, []);
  assert.deepEqual(d.evaluacion.terminosRelato, []);
  assert.equal((d.evaluacion as { terminosRelatoN?: number }).terminosRelatoN, 1);
  assert.equal(d.evaluacion.terminosSinSustentoN, 1);
  assert.equal(d.promptVersion, PROMPT_VERSION_RESUMEN);
  assert.ok(!JSON.stringify(d).includes('Rodolfo'));
  assert.match(problemasDe(d.evaluacion).map((p) => p.texto).join(' '), /1 término/);
});

test('contarPalabras no cuenta títulos, minutos, citas ni el bloque de riesgo; numeroEnPalabras', () => {
  const md = '## Resumen automático (IA)\n*Sesión individual · algo*\n\n### Puntos más importantes\n- Se habló de algo — Dicho por: X — [00:01]\n  «cita larga de muchas palabras»\n_Mención consignada automáticamente. No es una evaluación de riesgo; revisar la transcripción completa._\n- Uno dos tres [00:02].';
  assert.equal(contarPalabras(md), 3); // formato antiguo
  // Relato: solo cuenta el relato (no el bloque de riesgo, ni Tareas, ni minutos ni citas).
  const rel = `### Menciones de temas de riesgo\n- Se habló de x — Dicho por: Y — [00:01]\n  «a b c»\n### Resumen de la sesión\nAna refiere uno dos [00:02].\n\nSe explora «cita» tres.\n### Tareas\n- Ana: algo largo de varias palabras [00:03]`;
  assert.equal(contarPalabras(rel), 7);
  assert.deepEqual(rangoRelato(50, false), [150, 250]);
  assert.deepEqual(rangoRelato(15, true), [50, 90]);
  assert.deepEqual(rangoRelato(5, false), [50, 90]);
  assert.equal(numeroEnPalabras(4), 'cuatro');
  assert.equal(numeroEnPalabras(70), 'setenta');
  assert.equal(numeroEnPalabras(25), 'veinticinco');
  assert.equal(numeroEnPalabras(42), 'cuarenta y dos');
  assert.equal(numeroEnPalabras(101), null);
  assert.deepEqual(minutosSinTramo('[00:03] y [10:00]', [{ inicio_ms: 0, fin_ms: 60_000, hablante: 'A', texto: 'x' }]), ['10:00']);
  assert.deepEqual(terminosSinSustento('- Cuenta que Ana vino.', [{ inicio_ms: 0, fin_ms: 1, hablante: 'A', texto: 'vino ana' }]), []);
});

// ─── Revelado ────────────────────────────────────────────────────────────────

function caso(p: Partial<CasoParaRevelar>): CasoParaRevelar {
  return {
    id: 'c', estado: 'listo', modelo_1: MODELO_SONNET, modelo_2: MODELO_HAIKU, preferencia: null,
    costo_usd_1: 0.02, costo_usd_2: 0.001,
    detalle_1: { uso: { entrada: 9000, salida: 600, cacheEscritura: 0, cacheLectura: 0 } },
    detalle_2: { uso: { entrada: 9000, salida: 500, cacheEscritura: 0, cacheLectura: 0 } },
    ...p,
  };
}

test('revelar: nada hasta que todos los listos tengan voto y no quede nada generándose', () => {
  assert.equal(revelar([]), null);
  assert.equal(puedeRevelar([caso({ preferencia: '1' }), caso({ preferencia: null })]), false);
  assert.equal(puedeRevelar([caso({ preferencia: '1' }), caso({ estado: 'generando' })]), false);
  assert.equal(puedeRevelar([caso({ preferencia: '1' }), caso({ estado: 'pendiente' })]), false);
  assert.equal(puedeRevelar([caso({ estado: 'error' })]), false);
  assert.equal(puedeRevelar([caso({ preferencia: '2' }), caso({ estado: 'error' })]), true); // un error no bloquea para siempre
});

test('revelar: atribuye cada voto al modelo correcto según el orden sorteado, y suma costos y tokens', () => {
  const r = revelar([
    caso({ id: 'a', preferencia: '1' }),                                                   // Sonnet era 1 → Sonnet
    caso({ id: 'b', modelo_1: MODELO_HAIKU, modelo_2: MODELO_SONNET, preferencia: '1', costo_usd_1: 0.001, costo_usd_2: 0.02,
      detalle_1: { uso: { entrada: 9000, salida: 500, cacheEscritura: 0, cacheLectura: 0 } },
      detalle_2: { uso: { entrada: 9000, salida: 600, cacheEscritura: 0, cacheLectura: 0 } } }), // Haiku era 1 → Haiku
    caso({ id: 'c', preferencia: 'iguales' }),
    caso({ id: 'd', estado: 'error', costo_usd_1: null, costo_usd_2: null }),
  ]);
  assert.ok(r);
  if (!r) return;
  assert.deepEqual(r.porCaso.map((x) => [x.id, x.preferido]), [['a', MODELO_SONNET], ['b', MODELO_HAIKU], ['c', 'iguales']]);
  assert.equal(r.iguales, 1);
  const s = r.totales.find((t) => t.modelo === MODELO_SONNET)!;
  const h = r.totales.find((t) => t.modelo === MODELO_HAIKU)!;
  assert.equal(s.preferido, 1);
  assert.equal(h.preferido, 1);
  assert.equal(s.costoUsd, 0.06);
  assert.equal(h.costoUsd, 0.003);
  assert.equal(s.salida, 1800);
  assert.equal(h.entrada, 27000);
  assert.equal(nombreModelo(MODELO_HAIKU), 'Haiku 5.5');
  assert.equal(costoCorrida([caso({}), caso({ costo_usd_1: null })]), 0.022);
});

test('formatearTranscripcion de un fixture muestra la pausa (Notas)', () => {
  const c = casoSintetico('sint-corta-15')!;
  assert.match(formatearTranscripcion(tramosDeGuion(c.guion, c.finSeg), c.pausas), /\[Grabación pausada 08:00–11:40\]/);
});
