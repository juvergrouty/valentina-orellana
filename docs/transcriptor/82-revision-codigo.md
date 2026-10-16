# Revisión de código independiente — rama `transcriptor` (16 oct 2026)

Alcance: `git diff origin/main...transcriptor` (121 archivos, +21 868 líneas), con foco en errores de
**integración** entre los 8 paquetes. No se modificó código. Todo lo de abajo se verificó leyendo el
código (archivo:línea) o ejecutando; lo que no se pudo verificar se dice.

## 0. Resultado de las pruebas

| Prueba | Resultado |
|---|---|
| `pnpm -s test` | 219/219 ok |
| `npx astro build` | ok (una sola función `_render.func`, `maxDuration: 60`) |
| `tsc --noEmit` (TS 5.6.3) | **9 errores en la rama = 9 en `origin/main`** (mismos archivos: comprobantes, correoDominio, apigateway ×4, google/callback, bookings, flow/confirm). La rama no agrega ninguno. Nota: tsc no revisa `.astro`. |
| `bot/`: `tsc --noEmit` + `npm test` (copia limpia con `npm install`) | ok, 14/14 |
| Columnas usadas vs. 0014–0017 (script sobre todos los `.from('<tabla>')…select/eq/update/insert`) | sin columnas inexistentes |
| Transiciones `transicionar(...)` de todos los archivos vs. `TRANSICIONES` | todas válidas |

## 1. Hallazgos (por severidad)

### ALTA

**A1 — El resumen de Sonnet puede no caber en 60 s y fallar siempre.**
`astro.config.mjs:16` (`maxDuration: 60`, global), `pipeline.ts:39` (`PRESUPUESTO_MS = 50_000`),
`pipeline.ts:690` (`timeoutMs: queda() - 2000`, ≈ 43–47 s tras vigilar + bots), `claude.ts:35` (`maxTokens: 8000`).
Escenario: sesión de pareja de 60 min (~15–20 k tokens de entrada) → Sonnet escribe 2–3 k tokens de
salida a ~50–80 tok/s = 35–60 s + latencia inicial. Si pasa de ~45 s, el stream se corta, se paga lo
generado, se reintenta igual al minuto siguiente y tras `MAX_RESUMEN = 4` queda en `error`. Es
determinista para sesiones largas: el reintento no lo arregla.
Datos verificados (docs oficiales de Vercel, `functions/limitations`, actualizado 24 ago 2026): con
**Fluid compute** el plan **Hobby tiene 300 s de default y de máximo**; sin Fluid el máximo de Hobby es 60 s.
`@astrojs/vercel` 11 empaqueta todas las rutas en una sola función (`.vercel/output/functions/_render.func/.vc-config.json`)
y solo acepta `maxDuration` global; `functions` de `vercel.json` no aplica a la salida Build Output API.
**No existe configuración por ruta** con este adaptador. Propuesta exacta:
1. Verificar en Vercel → Settings → Functions que Fluid compute está activado (si no, un `maxDuration > 60` hace fallar el deploy).
2. `astro.config.mjs`: `maxDuration: 300` (es solo un techo: las demás rutas siguen terminando en ms).
3. `pipeline.ts`: mantener 50 s para los pasos cortos, pero dar al resumen su propio tope:
   `PRESUPUESTO_MS = 270_000`, o separar `LIMITE_RESUMEN_MS = 240_000` y pasar `timeoutMs: Math.min(240_000, queda() - 5_000)`.
   Con eso basta procesar 1 resumen por corrida (las corridas solapadas no se pisan: hay toma por fila).
4. `docs/transcriptor/70-cron.md`: `timeout_milliseconds := 290000` en el job de pg_net (hoy 58 000; no
   verifiqué si Vercel corta la función cuando pg_net cierra la conexión, así que mejor no depender de eso).
5. Actualizar los comentarios "maxDuration 60 s" en `pipeline.ts:38`, `cron/transcriptor.ts:8` y `70-cron.md`.

**A2 — Secretos incrustados en el bundle del servidor (contradice 30-seguridad / entorno.ts).**
`bot.ts:296` y `:498`, `alertas.ts:309`, `salud.ts:500` leen `import.meta.env` como **objeto entero**.
Vite/Astro lo reemplaza por un literal con *todas* las variables privadas presentes en el build: en el
build local `.vercel/output/.../chunks/transcriptor-salud_*.mjs` contiene `SUPABASE_SERVICE_ROLE_KEY`,
`R2_SECRET_ACCESS_KEY`, `B2_APPLICATION_KEY`, `ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY`,
`BOT_TOKEN_SECRET`, `FLY_API_TOKEN`, `RESEND_API_KEY` en claro (`bot_*.mjs` igual). Si `TRANSCRIPTOR_KEK_V1`
está en el entorno del build de Vercel, también quedaría escrita. Escenario: cualquiera con acceso a la
salida del deploy (o un log de bundle) obtiene las llaves; además rotar una llave exige redeploy.
Corrección: usar el patrón de `entorno.ts` (process.env en tiempo de ejecución + `import.meta.env.X`
literal solo para no secretos) en esos 4 sitios. Verificar después con
`grep -l '"ASSETS_PREFIX"' .vercel/output/functions/_render.func/.vercel/output/server/chunks/*.mjs` (debe salir vacío o sin llaves).

### MEDIA

**M1 — Carrera en "Regenerar resumen": fila `pendiente` huérfana para siempre.**
`regenerar-resumen.ts:96` pasa la grabación `lista → resumiendo` y recién en `:103` inserta la fila nueva.
Si el cron corre entre ambas, `pipeline.ts:607` (`filaResumen`) ve como última versión IA la `listo`
anterior y cierra la grabación en `lista`. Luego se inserta la `pendiente`, que nadie procesa (el cron
solo mira grabaciones `transcrita/resumiendo`); el botón queda bloqueado por `:81` ("Ya se está
escribiendo…") y la ficha muestra "generando" para siempre. Ventana de ms, pero sin salida.
Corrección: insertar la fila `pendiente` primero y luego transicionar; si la transición devuelve null,
marcar esa fila `error`. (Respuesta a la pregunta: en el caso normal el pipeline SÍ procesa la fila
creada por Regenerar —toma la última versión IA `pendiente`— y no crea otra.)

**M2 — "Reintentar" da un solo intento y sin backoff (no reinicia `intentos`).**
`estados.ts:158` (`reintentar`) no pone `intentos: 0` ni `proximo_intento_at: null`; `pipeline.ts:258`
dejó `intentos = max`. Escenario: envío a AssemblyAI agotado (6) → Reintentar → `subida` con
`intentos = 6` → el primer fallo transitorio da `n = 7 ≥ 6` → `error` inmediato. Igual para guardar (5)
y lanzar bot (3). Corrección: en `reintentar()` agregar `intentos: 0, proximo_intento_at: null`.

**M3 — Reintentar de un bot caído antes de grabar no relanza nunca el bot.**
`bot.ts:613` hace `marcarError(..., 'bot_lanzando'|'bot_en_lobby')` → `estado_antes_error = 'bot_lanzando'`
con `bot_machine_id` ya puesto. Tras Reintentar (P7 o P8), el relanzamiento de `pipeline.ts:390` exige
`bot_machine_id is null` **y** `intentos > 0`: no se cumple → queda en `bot_lanzando` hasta que el
vigilante (fin + 40 min) la vuelve a marcar en error. El botón "Reintentar" del aviso no hace nada útil.
Corrección: en el reintento hacia `bot_lanzando` limpiar `bot_machine_id`, y en `:390` quitar
`.gt('intentos', 0)` (la toma ya evita el doble lanzamiento).

**M4 — Doble envío a AssemblyAI: transcript huérfano que nunca se borra (privacidad + doble cobro).**
`grabacion-finalizar.ts:141→162-167` pasa a `subida` y envía los segmentos **sin tomar la fila**; en ese
mismo lapso `pipeline.ts:453` (`reintentarEnvios`) puede tomar la grabación `subida` y enviar el mismo
segmento. Ambos hacen `update aai_transcript_id` sin condición (`finalizar:166`, `pipeline.ts:420`):
el primer id se pierde, nadie lo borra en AssemblyAI (el webhook no encuentra el segmento) y queda texto
clínico en el proveedor. Corrección: `tomar()`/`soltar()` alrededor del envío en finalizar, y hacer el
update condicional `.is('aai_transcript_id', null)`; si devuelve 0 filas, `aai.borrar(id)` del recién creado.

**M5 — Dos endpoints de Reintentar con reglas distintas.**
`/api/admin/transcriptor/reintentar` (P7, usado en la ficha y en /admin/transcriptor) vs
`/api/admin/transcriptor/alertas` + `reintentoAlerta.ts` (P8, aviso rojo). P7: reabre el resumen con
`estado: 'pendiente'` **sin** `intentos: 0` (`reintentar.ts:45`), así `pipeline.ts:686` calcula
`intento = 5 ≥ MAX_RESUMEN` y el primer fallo es definitivo; y no tiene la protección de P8 para online
hacia `grabando/subiendo` (`reintentoAlerta.ts:39`), ni cierra la alerta. Corrección: que
`reintentar.ts` llame a `ejecutarReintento(..., opsReintentoSupabase())` (una sola lógica) o, como
mínimo, `intentos: 0, ultimo_error: null` en `:45` (o no tocar el resumen: `filaResumen` ya reabre los `error`).

### BAJA

- **B1** `AlertasTranscriptor.astro:44` enlaza a `/admin/pacientes/<id>?tab=ia`, pestaña que no existe
  (`[id].astro:320-322` solo tiene info/sesiones/notas) → página de la ficha sin contenido. Usar
  `?tab=notas#ia-<grabacion_id>` (como `[id].astro:483`).
- **B2** Nombres de variables desactualizados en `50-arquitectura.md:445,483,569-579,616`: `R2_BUCKET`,
  `B2_APP_KEY`, `TRANSCRIPTOR_CLAVE_V1`, `FLY_APP`, `BOT_HMAC_SECRET`. El código, `src/env.d.ts`,
  `60-config-buckets.md` y `bot/README.md` usan `R2_BUCKET_AUDIO`/`R2_BUCKET_TRANSCRIPCIONES`,
  `B2_APPLICATION_KEY`, `TRANSCRIPTOR_KEK_V1`+`TRANSCRIPTOR_KEK_ACTIVA=v1`, `FLY_APP_BOT`, `BOT_TOKEN_SECRET`
  (entre código, env.d.ts, 60 y bot/README son consistentes). Falta una lista única para Vale:
  60-config no menciona `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`
  (solo 30-seguridad/50-arquitectura), y `.env.example` no tiene ninguna del transcriptor.
- **B3** Sin migraciones, `/api/cron/transcriptor-salud` (ya en `vercel.json`) responderá 500 una vez al
  día (`salud.ts:645` lanza por `transcriptor_salud` inexistente). No manda correo (la alerta se
  descarta con `TablaAlertasFaltanteError`), solo ruido en logs. Opcional: devolver 200 "migración pendiente".
- **B4** Menú: "Grabar sesión", "Transcriptor" y "Seguridad" aparecen en producción antes de las
  migraciones; las páginas muestran "error de lectura"/"apagado" sin romperse. Aceptable; se puede ocultar
  hasta `transcriptor_activo`.
- **B5** `/admin/grabar` queda sin `Content-Security-Policy` (`vercel.json`, regla nueva sin CSP). Copiar
  la CSP de la regla general.

## 2. Revisión punto por punto

1. **Máquina de estados.** Todas las llamadas a `transicionar` (pipeline, bot, assemblyai webhook,
   subida-url, grabacion-finalizar, regenerar-resumen) son transiciones válidas de `estados.ts:9-26`, y
   `marcarError` siempre parte de un estado que admite `error`. `estado_antes_error` del SQL acepta todo lo
   que escribe `estadoParaReintentar`. Webhook `subida→transcribiendo` (`assemblyai.ts:451`) es
   compatible con `reintentarEnvios` (también procesa `transcribiendo` con segmentos sin enviar).
   Incoherencias reales: M1–M5.
2. **Columnas/tablas.** Coinciden con 0014–0017 (incluidas `proximo_intento_at` y `aai_errores` de 0016,
   y `transcriptor_alertas` de 0017; `settings.updated_at` existe en `schema.sql:73`). Valores de checks
   (tipo/acción de alertas, actor de auditoría, `modo`, `estado`) calzan con lo que escribe el código.
3. **Variables de entorno.** Ver A2 y B2. Contrato sitio→bot (`bot.ts:258-270` vs `bot/src/config.ts`):
   mismos nombres (`GRABACION_ID, MEET_URL, BOT_NOMBRE, EVENTO_URL, BOT_TOKEN, HORA_FIN, ESPERA_ADMISION_MS,
   SOLO_MS, MAX_EXTRA_MS, SEGMENTO_MS, SOLAPAMIENTO_MS, MAX_HUMANOS, VALE_NOMBRES`).
4. **Duración.** Ver A1.
5. **AdminLayout / agenda / ficha.** AdminLayout: solo agrega 3 ítems de menú, iconos, `AlertasTranscriptor`
   y la franja de passkey; nada existente se quitó. Agenda: botón "Grabar" oculto por defecto, usa
   `isOnlineSession`, `b.session_date`, `b.status` ya definidos en `openSessionDetail`. Ficha: la consulta
   de grabaciones va en try y con `!eg`; el modo demo solo existe con `import.meta.env.DEV`. Bien, salvo B1.
6. **Producción sin migraciones.** Login: `estadoPasskeys` trata tabla inexistente (incluido el HEAD 404
   vacío que supabase-js convierte en "sin error, count null") como "sin passkeys" → entra con contraseña
   como hoy; si Supabase falla, el login se rechaza (falla cerrado, cambio de comportamiento menor).
   Middleware: `sesionAceptada` deja pasar ante cualquier error. AdminLayout: `avisoPasskey` → null;
   `listarAlertasAbiertas` → [] (PGRST205). Ficha y páginas nuevas: manejan el error. `/api/admin/settings`
   solo ignora claves `passkey_*`. Resultado: el panel y el login siguen iguales (costo: +2–3 consultas
   por página del panel, la de passkeys cacheada 30 s). Única salida visible: B3.
7. **Bot.** Compila y pasa pruebas. Eventos (`lobby, activo, pide_url, segmento_subido, fin, error`),
   `motivo`s, `linea_hablantes`, `Authorization: Bearer`, respuesta `{url}` de `pide_url` y manejo de
   404 = token rechazado calzan con `parsearEventoBot` / `procesarEventoBot`. El bot espera las subidas
   (`segs.vaciar()`) antes de enviar `fin`, así el borrado de segmentos sin `subido_at` en `bot.ts:628` no
   pierde el último trozo.
8. **Pruebas.** Ver §0.

## 3. Orden sugerido de corrección antes de publicar
A2 → M4 → A1 (verificar Fluid primero) → M2/M3/M5 (pequeños, en `estados.ts`/`reintentar.ts`/`pipeline.ts:390`) → M1 → B1–B5.
Ninguno impide publicar el código con el transcriptor apagado y sin migraciones, salvo A2 (las llaves
quedan en el bundle desde el primer deploy en que existan en Vercel).
