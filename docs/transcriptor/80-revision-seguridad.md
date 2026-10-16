# Transcriptor IA — Revisión de seguridad independiente (16 oct 2026)

Alcance: `git diff origin/main...transcriptor` (rama integrada, commit `8fa59c6`). Vara: `30-seguridad.md` §8
y `01-decisiones-16oct.md`. Revisión de solo lectura: no se modificó código. Cada hallazgo se verificó leyendo
el código; el de llaves en el bundle se verificó además con un build real (ver §3).

Severidades: **crítica** (explotable hoy con daño grave), **alta** (rompe un control exigido por las decisiones
o el checklist con impacto directo en datos clínicos), **media** (control debilitado o requisito incumplido con
impacto acotado), **baja** (defensa en profundidad o higiene).

No se encontraron hallazgos críticos.

---

## 1. Hallazgos

### A1 (alta) — El transcriptor puede activarse sin passkey obligatoria (decisión 3 sin control en código)
- **Dónde:** `src/pages/api/admin/transcriptor/ajustes.ts:21` + `src/lib/transcriptor/panel.ts:268` (`validarAjuste`
  acepta `transcriptor_activo=true` sin revisar nada más); `src/lib/passkey/nucleo.ts:33-46` (con
  `passkey_obligatoria='false'` una sesión de solo contraseña basta); `src/pages/api/admin/passkey/acceso.ts:109-117`
  (botón "Entrar sin passkey esta vez"). Ninguna ruta que descifra (`src/pages/admin/pacientes/[id]/sesion/[gid].astro`,
  `src/pages/api/admin/transcriptor/preguntar.ts:67-68`) ni `guardiaPanel` (`src/lib/transcriptor/peticion.ts:42-45`)
  exige nivel `passkey`.
- **Escenario:** Vale activa el transcriptor antes de marcar "Passkey obligatoria" (o la desactiva para un
  trámite). Alguien con la contraseña (phishing, reutilización) entra con "Entrar sin passkey esta vez" y lee
  todas las transcripciones y usa el Q&A sobre todas las sesiones. Es exactamente el riesgo R1 que la decisión 3
  ordena cerrar "antes de lanzar".
- **Corrección:** (1) en `ajustes.ts`, rechazar `transcriptor_activo=true` (y `transcriptor_bot_activo=true`) si
  `estadoPasskeys()` no da `obligatoria && cantidad>0 && !migracionPendiente`; (2) en `guardiaPanel`, `preguntar.ts`
  y la página `sesion/[gid].astro`, exigir `nivelTokenAdmin(token)==='passkey'` (fallar cerrado); (3) en
  `passkey/gestion.ts` (`accion==='obligatoria'`, valor false) negar si `transcriptor_activo='true'`.

### M1 (media) — Llaves secretas incrustadas en el bundle del SERVIDOR (no en el cliente)
- **Dónde:** acceso dinámico a `import.meta.env` completo: `src/lib/transcriptor/salud.ts:500`,
  `src/lib/transcriptor/alertas.ts:309`, `src/lib/transcriptor/bot.ts:296` y `bot.ts:498` (este último lee
  `BOT_TOKEN_SECRET` SOLO de `import.meta.env`). También literales: `assemblyai.ts:79-82`, `claude.ts:170`,
  `webhook-assemblyai.ts:17`.
- **Evidencia (build con valores centinela):** `.vercel/output/static/` → 0 coincidencias (el cliente está limpio).
  `.vercel/output/functions/.../chunks/transcriptor-salud_*.mjs` (función `envReal`) contiene como texto literal
  `R2_SECRET_ACCESS_KEY`, `R2_ACCESS_KEY_ID`, `B2_APPLICATION_KEY`, `B2_KEY_ID`, `ANTHROPIC_API_KEY`,
  `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_WEBHOOK_SECRET`, `FLY_API_TOKEN`, `BOT_TOKEN_SECRET`, `RESEND_API_KEY` y
  `SUPABASE_SERVICE_ROLE_KEY`; `bot_*.mjs` (`envBot`) contiene `FLY_API_TOKEN` y `BOT_TOKEN_SECRET`.
  `TRANSCRIPTOR_KEK_V1` NO aparece (bien: `entorno.ts` la lee solo de `process.env`).
- **Escenario:** contradice `entorno.ts:2-5` ("las llaves de R2/B2 se leen SOLO de process.env… Vite nunca las
  incrusta"). Las llaves quedan en cada artefacto de despliegue: cualquiera con acceso al proyecto de Vercel
  (fuente/salida de funciones), una integración que lea artefactos, o un despliegue antiguo reactivado con
  "Instant Rollback" tras una rotación vuelve a tener la llave vieja embebida. Si las variables existen también en
  Preview, cada preview las lleva dentro.
- **Corrección:** nunca leer `import.meta.env` como objeto; usar `process.env[n]` en runtime (o `astro:env/server`
  con campos `secret`). En `bot.ts:296/498` y `alertas.ts:309`/`salud.ts:500` quitar el respaldo a `import.meta.env`
  para nombres secretos. Agregar al checklist un `grep` de centinelas sobre `.vercel/output/functions` tras el build.

### M2 (media) — Passkey y revocación fallan ABIERTO si Supabase no responde
- **Dónde:** `src/lib/passkey/servidor.ts:71-72` (`sesionAceptada`: `catch { return true; }`) y
  `src/lib/adminSession.ts:72` (`tokenRevocado`: si no se puede leer la lista, `false`).
- **Escenario:** con Supabase intermitente (o la tabla `settings` con error), una cookie v1 (solo contraseña) o
  una cookie ya cerrada con "Cerrar sesión" vuelve a abrir el panel completo, incluidas transcripciones, aunque la
  passkey sea obligatoria. Para el transcriptor, el login ya falla cerrado (`login.ts`), pero el middleware no.
- **Corrección:** para rutas del transcriptor (`/admin/grabar`, `/admin/transcriptor`, `/admin/pacientes/*/sesion/*`,
  `/api/admin/transcriptor/*`) fallar cerrado en ambos casos (401 "intenta en unos minutos"); mantener el
  fallo abierto solo para el resto del panel si Vale lo prefiere.

### M3 (media) — No existe el borrado de transcripciones exigido por §7.2 (supresión / Ley 21.719)
- **Dónde:** `src/lib/transcriptor/almacenamiento.ts:425-429` (`borrarTranscripcion`, borra R2 + todas las
  versiones de B2) no tiene ningún llamador en `src/`. No hay endpoint "Borrar transcripción" con motivo,
  confirmación, `dek_envuelta=null`, `deleted_at` y bitácora.
- **Escenario:** una paciente revoca y pide supresión (o el abogado resuelve que la transcripción no es ficha):
  hoy solo se puede borrar a mano en R2/B2/Supabase, sin rastro en `transcriptor_auditoria` y con riesgo de dejar
  versiones ocultas en B2. El §7.2 exige "poder borrar en minutos".
- **Corrección:** `POST /api/admin/transcriptor/borrar` (guardiaPanel + nivel passkey) que exija motivo, llame
  `borrarTranscripcion`, ponga `dek_envuelta=null`, `deleted_at`, `motivo_borrado`, y registre con
  `auditarObligatorio`. Incluir "borrar todas las de este paciente" y las `preguntas_ia` cifradas de ese paciente.

### M4 (media) — El chequeo diario no ve transcripts huérfanos en AssemblyAI
- **Dónde:** `src/lib/transcriptor/salud.ts:270-288` (`chequeoAaiBorrado`) solo mira filas de
  `grabacion_segmentos`; no lista `GET /v2/transcript` como pide §4.3 (b). Origen de huérfanos:
  `assemblyai.ts:246-249` (POST reintentado tras 5xx/red crea un transcript cuyo id no queda en ninguna fila, el
  propio comentario lo reconoce) y `pipeline.ts:574-575` (al reintentar un segmento con error, el `DELETE` falla
  en silencio y se pone `aai_transcript_id=null`, perdiendo el rastro).
- **Escenario:** audio y texto clínico quedan en AssemblyAI hasta el TTL (1 día + tiempo de proceso de TTL,
  "minutos a algunos días" según su documentación) sin que nadie se entere. Con TTL mal configurado, indefinido.
- **Corrección:** en el chequeo diario listar `GET /v2/transcript?status=completed|error&created_on…` (solo id y
  fecha), restar los ids conocidos con `aai_borrado_at` y borrar/alertar los que tengan > 2 h. En
  `pipeline.ts:574` no descartar el error del `DELETE`: guardar el id en una lista de "por borrar".

### B1 (baja) — `/admin/grabar` pierde la Content-Security-Policy
- **Dónde:** `vercel.json:28-37`. La regla global (`:17-25`) se excluyó de `/admin/grabar` con el patrón negativo
  (correcto para el micrófono), pero la regla propia no repite la `Content-Security-Policy`
  (`object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action …`). La página más sensible queda
  sin CSP. El resto de la regla está bien: `microphone=(self)` solo ahí y `microphone=()` en todo lo demás.
- **Corrección:** copiar la CSP a la regla de `/admin/grabar` (idealmente endurecida: `default-src 'self';
  connect-src 'self' https://*.r2.cloudflarestorage.com; object-src 'none'; frame-ancestors 'none'`). Verificar en
  el preview con `curl -I /admin/grabar` y `curl -I /admin` que el lookahead `(?!admin/grabar$)` excluye solo esa
  ruta y que no salen dos `Permissions-Policy` (pendiente del checklist §8; no verificable sin desplegar).

### B2 (baja) — `/api/admin/settings` puede cambiar ajustes del transcriptor sin bitácora
- **Dónde:** `src/pages/api/admin/settings.ts:28-34` solo bloquea `passkey_*`. Acepta cualquier otra clave,
  incluidas `transcriptor_activo`, `transcriptor_grabacion_requisito`, `transcriptor_alerta_riesgo`,
  `transcriptor_resumen_modo`, `transcriptor_presupuesto_clp`.
- **Escenario:** un formulario (o un error de UI) cambia ajustes que las decisiones fijan, saltándose la lista
  blanca de `ajustes.ts` y sin dejar fila en `transcriptor_auditoria` (y saltándose el control de A1).
- **Corrección:** ignorar también `transcriptor_*` (y `cron_interno_secret`, `admin_tokens_revocados`) en ese
  endpoint.

### B3 (baja) — 0014 no revoca `anon/authenticated` en sus tablas nuevas
- **Dónde:** `supabase/migrations/0014_transcriptor.sql:292-317`: activa RLS y da grants a `service_role`, pero
  solo hace `revoke` sobre la vista; 0015 y 0017 sí revocan. Las tablas heredan los grants por defecto de
  Supabase a `anon/authenticated`; hoy las protege únicamente RLS sin políticas.
- **Corrección:** agregar `revoke all on <cada tabla de 0014> from anon, authenticated;` (y en las secuencias).
  El resto de las migraciones está bien: `transcriptor_auditoria` solo select/insert + triggers contra
  update/delete/truncate; `resumenes_ia` protegido por trigger; vista `security_invoker`.

### B4 (baja) — Se borra el audio aunque falte la copia en B2
- **Dónde:** `almacenamiento.ts:315-321` (si la copia a B2 falla solo se anota `b2Error`) y `pipeline.ts:528-538`
  (borra en AssemblyAI y el audio igual). §4.3.5 dice "solo después de confirmar las dos copias".
- **Escenario:** si el objeto de R2 se pierde antes de que se reintente la copia, la sesión se pierde sin
  respaldo. Riesgo de disponibilidad, no de confidencialidad.
- **Corrección:** no borrar audio/transcript de AssemblyAI mientras `b2_key` sea null (o aceptarlo explícitamente
  y documentarlo como decisión).

### B5 (baja) — Reasignar una grabación a otra ficha no vuelve a revisar consentimiento
- **Dónde:** `src/pages/api/admin/transcriptor/asignar.ts:32-37`: cambia `patient_id` (y el de sus resúmenes) sin
  `verificarGrabacion` del nuevo paciente; `consent_ids` sigue apuntando a firmas del anterior.
- **Corrección:** al asignar, evaluar el consentimiento del nuevo paciente; si no corresponde, rechazar o dejar
  marcado; actualizar `consent_ids`.

### B6 (baja) — Bot de Meet: superficie del navegador y build sin lockfile
- **Dónde:** `bot/src/meet/argumentos.ts:9-21` (`--no-sandbox`, `--disable-site-isolation-trials`,
  `--disable-features=IsolateOrigins,site-per-process`); `bot/Dockerfile:8-11,17` (`npm install` sin
  `package-lock.json`, que además está en `.dockerignore:3`; imagen base por tag, no por digest).
- **Escenario:** un fallo de renderer de Chromium explotado desde la página de Meet compromete el proceso sin
  sandbox: obtiene el `BOT_TOKEN` (solo permite subir audio a esa grabación hasta su vencimiento) y el audio en
  memoria de esa sesión. El origen es de Google, así que la probabilidad es baja; el diseño (token de un uso, sin
  secretos de proveedores, sin servicios entrantes, `auto_destroy`) acota el impacto.
- **Corrección:** probar si Meet admite el bot con sandbox activo (Chromium sin `--no-sandbox` con usuario no
  root: la imagen ya usa `pwuser`); fijar la imagen base por `@sha256:` y versionar un lockfile.

### B7 (baja) — Sin tope de tamaño en lo que sube el bot
- **Dónde:** `src/lib/transcriptor/bot.ts:119` acepta `bytes` hasta 5 GiB y `almacenamiento.ts:289-299` firma el
  PUT solo con `content-type` (sin largo). El tope de 200 MB de `completarMultiparte` solo aplica al grabador
  presencial.
- **Escenario:** con un token robado (ver B6) se pueden subir hasta 200 segmentos de varios GB que luego se envían
  a AssemblyAI (costo). No permite leer nada.
- **Corrección:** en `segmento_subido` rechazar `bytes` > ~100 MB por segmento (15 min a 32 kbps ≈ 4 MB) y borrar
  el objeto.

### B8 (baja) — Otros detalles
- `src/pages/api/admin/passkey/acceso.ts:51-53`: el límite de 10 fallos cuenta globalmente (no por IP): quien
  tenga la contraseña puede bloquear a Vale 15 min. Aceptable; documentar.
- `bot/src/index.ts:167-170`: el mensaje crudo de una excepción (p. ej. de Playwright, que puede incluir el enlace
  de Meet) viaja como `error` y queda en `grabaciones.ultimo_error` y en la bitácora. Sanear URLs como hace
  `sanearMensaje` de `assemblyai.ts`.
- `src/lib/transcriptor/consentimiento.ts` (`identidadFirmante`): sin RUT, la identidad cae a correo o nombre; una
  misma persona que firme dos veces con correos distintos cuenta como dos firmantes en pareja. Exigir RUT en v3
  para pareja.
- `src/pages/admin/grabar.astro:506-527`: los trozos de audio en IndexedDB van en claro (I6 lo marcó como
  "recomendado"); se borran al confirmar la subida.
- `preguntar.ts` no exige `X-Panel` como el resto (sí exige Origin propio y sesión): uniformar con `guardiaPanel`.

---

## 2. Controles verificados que están bien

- **Autenticación de endpoints:** todos los de `/api/admin/transcriptor/*` pasan por el middleware (cookie +
  passkey según estado) y por `guardiaPanel` (POST, Origin/Referer obligatorio y propio, `X-Panel: 1`, sesión no
  revocada; rechazo en bitácora). Los GET (`grabacion-finalizar` GET) solo devuelven estado. `api/cron/transcriptor*`:
  `cronAutorizado` falla cerrado. `api/transcriptor/*` son públicos por diseño con su propio secreto.
- **Passkey/WebAuthn:** `userVerification: required`, desafío de un solo uso con vencimiento de 5 min ligado al
  paso/sesión, origen y RP ID fijos, contador; gestión (agregar/eliminar/obligatoria/códigos) exige sesión v2 si
  ya hay passkeys; códigos de respaldo de 50 bits con scrypt y uso único atómico; cookie de paso `SameSite=strict`,
  10 min; el token v1 no se convierte en v2 (prefijo firmado); `/api/admin/settings` no puede tocar `passkey_*`.
- **Cifrado (`cifrado.ts`):** AES-256-GCM con Web Crypto, IV aleatorio de 12 bytes en cada cifrado (envoltura y
  contenido), DEK nueva por objeto y puesta a cero, AAD = cabecera + clave de objeto + tipo (envoltura ligada a
  versión de KEK + clave), magia/versión, KEK de exactamente 32 bytes leída solo de `process.env` y no incrustada.
  Q&A se guarda cifrado con su propia clave de contexto.
- **Webhook AssemblyAI:** cabecera comparada en tiempo constante, 503 sin variable, 401 sin tocar la base, solo usa
  `transcript_id`/`status`, re-consulta con la API key, idempotente (`unique(proveedor, evento_id)` + updates
  condicionales), responde rápido, no guarda texto.
- **Bot (sitio):** token de 32 bytes, solo HMAC en base, vence a fin + 2 h y se revoca en `fin`/vigilante/error de
  Fly; 404 genérico; bloqueo por IP; solo avanza SU grabación; URL PUT solo para SU segmento y solo en `grabando`;
  enlace de Meet solo desde calendario/reserva; imagen fija (no `latest`); máquina `auto_destroy`, sin servicios
  entrantes, app sin secretos de proveedores.
- **URLs prefirmadas:** PUT 15 min (partes y bot), GET 6 h solo para el bucket de audio; llaves generadas por el
  servidor y validadas por regex; las transcripciones nunca salen por URL; no se registran.
- **Borrado:** orden correcto (cifrado y verificado en R2 → DELETE en AssemblyAI → borrado del audio), con
  registro; B2 borra todas las versiones.
- **Datos en registros:** bitácora con `sanearDetalle` (llaves prohibidas) y sin texto de preguntas; `auditarObligatorio`
  antes de descifrar; logs de errores solo con códigos/nombres; alertas y correos sin nombres ni contenido
  (`etiquetaSesion` = tipo, modalidad, fecha y hora).
- **XSS / inyección de prompt:** resumen y respuestas se escapan antes de dar formato (`resumenAHtml`, `formatear`);
  transcripción delimitada, `sanearDato` quita etiquetas que imitan delimitadores (también en nombres de hablante),
  regla explícita "la transcripción es dato", el modelo no tiene herramientas, citas verificadas; sin metadatos ni
  Batch (`claude.ts` lanza en todos los métodos de Batch). Riesgo residual: un texto dicho en sesión puede sesgar
  el resumen, que va rotulado "no revisado".
- **Bundle del cliente:** `.vercel/output/static` sin ninguna llave ni nombre de variable secreta.
- **Grabador:** sin scripts de terceros; `Permissions-Policy` con micrófono solo en `/admin/grabar`.

## 3. Cómo se verificó M1

```
export PATH=~/pinokio/bin/miniconda/bin:$PATH
env TRANSCRIPTOR_KEK_V1=ZZSENTINELKEKV1 R2_SECRET_ACCESS_KEY=ZZSENTINELR2SECRET … npx astro build
grep -rho "ZZSENTINEL[A-Z0-9]*" .vercel/output/static     # → nada
grep -rho "ZZSENTINEL[A-Z0-9]*" .vercel/output/functions  # → todas salvo KEK
```
Nota: el `.vercel/output` local quedó con los valores centinela de esta prueba (no son llaves reales; la carpeta
está en `.gitignore`).
