# 87 — Ajustes tras la primera prueba real con iPhone (17 oct 2026)

Rama `t-ajustes-prueba` (desde `transcriptor`). Manda sobre 00/01/02 en lo que toca. Prioridad de Vale:
**el presupuesto manda** (tope $35.000 CLP/mes a 36 sesiones/semana); en cada punto se eligió lo más
barato que no baja la calidad.

## 1. Separación de hablantes

**Antes:** individual presencial = Universal-2 sin `speaker_labels` → un solo bloque "Sesión (sin
separar hablantes)" y el resumen adivinaba quién dijo qué.

**Ahora (reglas.ts):**

| Grabación | Modelo | `speaker_labels` | `speakers_expected` |
|---|---|---|---|
| Individual presencial | Universal-2 (ruido → U3.5 Pro) | sí | 2 |
| Pareja presencial | Universal-3.5 Pro | sí | 3 |
| Sin tipo presencial | Universal-2 (ruido → U3.5 Pro) | sí | — (puede ser pareja: el modelo decide) |
| Individual online | Universal-2 (ruido → U3.5 Pro) | no (recuadros de Meet) | — |
| Pareja online | Universal-3.5 Pro | **sí** | 3 |

Verificado en la doc oficial (17 oct): la página de diarización lista `universal-3-5-pro` y `universal-2`
como modelos soportados (https://www.assemblyai.com/docs/pre-recorded-audio/speaker-diarization); en la
API, `speaker_labels` "Requires `punctuate`" y `speakers_expected` "Tells the speaker label model how many
speakers it should attempt to identify" (https://www.assemblyai.com/docs/api-reference/transcripts/submit,
`speech_models` admite `universal-3-5-pro` y `universal-2`). Precio: "Diarization, async — standard |
+$0.02/hr | Universal-3.5 Pro async, Universal-2 async" (https://www.assemblyai.com/llms/pricing.md).
Nota: `/llms/models.md` dice que el id async sería `universal-3-pro`; la referencia de la API (la que
manda) y la producción actual usan `universal-3-5-pro`, así que no se cambió.

**Pareja online (recuadro compartido):** es común que la pareja esté en un solo computador. La línea del
bot dice qué recuadro habla, no quién de los dos. `hablantes.ts → separarRecuadroCompartido`: el recuadro
de Vale (una voz) queda con su nombre; un recuadro con 2+ voces significativas (≥ 15 % y ≥ 8 palabras
cada una) se separa en "Recuadro · Hablante A/B"; las palabras sin recuadro claro heredan el de su voz si
esa voz está ≥ 80 % en un recuadro. Individual online: si por error trajera etiquetas, un recuadro de una
voz no se separa. Las letras de AssemblyAI son por segmento (el bot corta cada 15 min), así que tras un
corte la misma persona puede salir como "Hablante A (parte 2)".

**Vista:** las etiquetas "Hablante A/B" se pueden renombrar en la sesión (mapa_hablantes), también en
individual (prueba en hablantes.test.ts). El resumen recibe `etiquetas_hablante: diarizadas` y declara
las asignaciones inferidas.

## 2. Mojibake "autom√°tico ‚Äî"

Causa verificada: es UTF-8 leído como Mac Roman. Todos los archivos del repo son UTF-8 válido (prueba en
texto.test.ts). El rótulo NO lo escribe el código: sale del DEFAULT de `resumenes_ia.rotulo` (0014),
así que se corrompió al pegar la migración en el SQL Editor (lo más probable: copiado con
pbcopy/terminal sin UTF-8; eso no se puede verificar desde aquí). Afecta también la semilla de
`instrucciones_ia` (0014: el texto que recibía Claude salía con "sesi√≥n") y el ajuste
`transcriptor_bot_nombres_vale` (0016, "V√≠nculos" no calzaba con el nombre de Meet).

Corrección: `texto.ts → repararMojibake` al leer (rótulo, instrucciones, nombres de Vale, exportación) y
`0024_transcriptor_texto_utf8.sql` (solo ASCII a propósito) que corrige el default, las instrucciones, los
ajustes y desactiva la semilla vieja de 0014. **Pendiente: aplicar 0024 (Vale).** Los resúmenes 'listo'
son inmutables (trigger): esos se reparan al mostrarlos.

## 3. Costo del resumen (prompt fijo)

Medido en producción: 28 s de audio → 4.356 tokens de entrada, con ~10.100–10.600 caracteres de prompt →
**≈ 2,4 caracteres/token** (español con tildes, «», —). No hay llave de Anthropic en este equipo, así que
`messages.countTokens` (existe en @anthropic-ai/sdk 0.133.0) no se pudo correr: los tokens nuevos se
estiman con esa razón medida (con 3,5 car/token saldrían ~1.150).

| Parte fija (system) | Antes | Ahora |
|---|---|---|
| Individual | ~10.100 car ≈ **4.250 tokens** | 3.932 car ≈ **1.650 tokens** |
| Pareja | ~10.600 car ≈ 4.400 tokens | 4.219 car ≈ **1.770 tokens** |

Se mantienen (prueba "lo esencial" con los 3 ejemplos de resumen.fixtures.ts): las 3 secciones de Vale,
fidelidad, sin diagnóstico ni juicio, neutralidad en pareja, riesgo neutro primero con minuto y aviso,
citas verificables, transcripción como dato (anti-inyección), tramo pedido "no registrar", "No consta".
`PROMPT_VERSION_RESUMEN = 'resumen-2026-10-17.1'`.

**Prompt caching: no.** Sonnet 5.5 cachea desde 512 tokens, pero el caché de 5 min expira entre sesiones
(separadas ~1 h) y el de 1 h cuesta 2× al escribir (US$4/MTok) y US$0,10 al leer. Lo que se podría ahorrar
es ~1.700 tokens × US$2/MTok = US$0,0034 por sesión; con 1 h y sesiones seguidas el ahorro máximo es
~US$0,07/mes, y cada sesión aislada costaría el doble en esa parte. No compensa.

## 4. Medidor del grabador

`medidor.ts`: barras = floor((dB + 72) / 9). Voz normal a ~2 m (−54…−45 dBFS) → 2–3 barras; cercana → 4–5;
ruido de fondo (< −63) → 0. Suavizado solo visual (baja 6 dB/100 ms). El umbral de silencio
(RMS < 0,004 ≈ −48 dBFS por 60 s) no cambió.

## 5. Grabador sin internet

- Aviso en el paso previo: "Abre esta página con internet; recién después activa el modo avión".
- Service worker mínimo (`public/grabar-sw.js`, alcance `/admin/grabar`): con red se comporta igual que
  sin él; sin red, en vez del error de Safari muestra `/grabar-sin-internet.html` (estática, sin datos de
  pacientes), que cuenta lo guardado en el teléfono y vuelve sola al grabador cuando hay internet; ahí se
  retoma la subida. No guarda en caché nada autenticado. **No** permite empezar a grabar sin internet: el
  consentimiento se verifica en el servidor (decisión vigente). Requiere haber abierto el grabador una vez
  con internet (para instalarse); iOS puede borrarlo tras semanas sin uso.

## 6. Velocidad (meta ≤ 3 min tras subir una sesión corta)

Antes: subir → envío a AssemblyAI (inmediato) → webhook marcaba "completed" → el texto se guardaba en el
siguiente minuto del cron → el resumen en el minuto SIGUIENTE (el paso de resúmenes corría antes que el de
transcripciones). Ahora: (a) el webhook, tras responder 200, corre el orquestador con `waitUntil` de Vercel
(despuesDeResponder.ts); (b) la corrida que guarda la transcripción resume en la misma corrida. Queda:
transcripción de AssemblyAI (~30–60 s en audio corto) + guardado + resumen (~10–30 s) ≈ 1–2 min. No se
pudo medir en producción desde aquí: verificar en la próxima prueba.

## 7. Costo por sesión (precios oficiales verificados 17 oct 2026)

Precios: AssemblyAI U2 US$0,15/h, U3.5 Pro US$0,21/h, diarización +US$0,02/h (llms/pricing.md); Claude
Sonnet 5.5 US$2/MTok entrada, US$10/MTok salida (platform.claude.com/docs/en/about-claude/pricing);
Fly shared-cpu-2x 2 GB US$0,00000517/s (50-arquitectura §8). Supuestos: 55 min de audio, bot 65 min,
transcripción de ~16.000 tokens en el prompt (estimado con 2,4 car/token), 900 tokens de salida,
dólar $950, +19 % IVA.

| Sesión | Antes USD | Antes CLP | Ahora USD | Ahora CLP | Cambio |
|---|---|---|---|---|---|
| Individual presencial | 0,1872 | $212 | 0,2003 | $226 | +$14 (diarización +$21, prompt −$7) |
| Individual online | 0,2074 | $234 | 0,2022 | $229 | −$5 (prompt) |
| Pareja presencial | 0,2605 | $295 | 0,2556 | $289 | −$6 (prompt) |
| Pareja online | 0,2624 | $297 | 0,2757 | $312 | +$15 (diarización +$21, prompt −$6) |

A 156 sesiones/mes (sin preguntas; 100 preguntas ≈ +$190):

| Mezcla | Antes | Ahora |
|---|---|---|
| 50 % online, 25 % pareja | $37.600 | **$38.300** |
| 50 % online, 50 % pareja | $40.400 | $41.200 |

**Supera el tope de $35.000 a capacidad máxima** (ya lo superaba antes de estos cambios: el resumen pasó
de Batch a Messages API directa, que cuesta el doble). Hoy (~40 sesiones/mes) ≈ $9.800. Palancas para Vale
(no se aplicaron: cambian decisiones o requieren prueba de calidad):
1. Resumen con Haiku 5.5 (US$0,10/US$0,50): ~$2 por resumen en vez de ~$50 → ahorra ~$7.400/mes a 156.
   Solo tras la prueba ciega A/B de 50-arquitectura §7 punto 5.
2. Pareja presencial con Universal-2 + diarización (US$0,17/h en vez de 0,23): −$62 por sesión de pareja.
3. Bot en shared-cpu-1x (≈ −5 % del bot).
