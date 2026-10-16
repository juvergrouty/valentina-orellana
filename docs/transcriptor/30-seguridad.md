# Transcriptor IA — Diseño de seguridad (appsec + nube + datos de salud)

Fecha: 15 oct 2026. Autor: ingeniería de seguridad del equipo. Base: `00-decisiones.md` (no se re-discute).
Alcance: grabación presencial (iPhone → panel `/admin`), bot de Meet (Fly.io), transcripción (AssemblyAI),
resumen y preguntas (Anthropic), almacenamiento cifrado (Cloudflare R2 + Backblaze B2), ficha (Supabase).

Todo lo marcado **[verificado]** se revisó hoy en la documentación oficial (URL al lado). Lo marcado
**[por verificar]** no está en la documentación y debe probarse antes de lanzar.

---

## 0. Lo que ya existe en el sitio (revisado en el código, sin cambios)

| Pieza | Cómo funciona hoy | Consecuencia para el transcriptor |
|---|---|---|
| Login del panel (`src/pages/api/admin/login.ts`) | Una sola contraseña (`ADMIN_PASSWORD`), comparación en tiempo constante, límite de 5 intentos/IP en 15 min registrado en `admin_logs`. | **Un solo factor.** Hoy protege agenda y notas; con el transcriptor protegerá sesiones completas y un Q&A sobre todas ellas. Ver riesgo crítico R1. |
| Sesión (`src/lib/adminSession.ts`) | Cookie `vo_admin_token` = `v1.<vence>.<HMAC-SHA256(ADMIN_SECRET)>`, 8 h, `httpOnly`, `SameSite=lax`, `secure` en prod. Revocación al cerrar sesión (lista en `settings`, caché 30 s). | Sirve tal cual para las rutas del transcriptor. Una grabación de 50 min cabe en 8 h, pero si la sesión vence a mitad de la subida, los trozos quedan en IndexedDB hasta volver a entrar (aceptable). |
| Middleware (`src/middleware.ts`) | Protege `/admin/*` y `/api/admin/*` (salvo `/api/admin/login`). En POST revisa Origin/Referer, **pero si el navegador no envía ninguno, deja pasar**. `Cache-Control: private, no-store` en todo el panel. | Las rutas del transcriptor deben vivir bajo `/api/admin/transcriptor/*` (heredan la protección). Para estas rutas el control de origen debe **fallar cerrado** (ver §8). |
| `astro.config.mjs` | `security.checkOrigin: false` (por Flow). | Sin protección CSRF de Astro: la del middleware es la única. |
| Cliente Supabase (`src/lib/supabase.ts`) | `SUPABASE_SERVICE_ROLE_KEY` en servidor; RLS activado sin políticas anon. | Correcto: el navegador nunca habla con Supabase. Mantener. |
| Webhooks existentes | Resend (`src/pages/api/webhooks/resend.ts`): firma Svix HMAC + tolerancia 5 min + `timingSafeEqual`. Flow (`src/pages/api/flow/confirm.ts`): no confía en el cuerpo, **re-consulta el estado a la API de Flow**. Cron (`src/lib/cronAuth.ts`): Bearer con `CRON_SECRET`, falla cerrado. | AssemblyAI no firma con HMAC: se combina el patrón de Flow (re-consultar a la API) + secreto en cabecera (ver §1 y §4.3). |
| `vercel.json` | `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()` en `/(.*)`. Sin Content-Security-Policy. | Hay que abrir el micrófono **solo** en la ruta del grabador (ver §4.4). Falta CSP en el panel (ver checklist). |
| Logger (`src/lib/logger.ts`) | `logError(ctx, msg, data)` guarda `data` tal cual en `admin_logs`. | Riesgo de filtrar texto clínico a los registros si alguien pasa la transcripción en `data`. Regla en checklist. |
| Consentimientos (`supabase/migrations/0004_consentimientos.sql`) | Tabla `consents` con `accept_recording`, `version`, `signed_at`, `revoked_at`. | El servidor debe exigir consentimiento v3 vigente (ambos miembros en pareja) antes de entregar URLs de subida o lanzar el bot. |

---

## 1. Hechos verificados en documentación oficial

**AssemblyAI**
- Webhooks: no hay firma HMAC; se configura una cabecera propia con `webhook_auth_header_name` / `webhook_auth_header_value`. El cuerpo trae solo `transcript_id` y `status` (`completed`/`error`); el texto se pide aparte con GET. Envíos desde IP fijas `44.238.19.20` (US) y `54.220.25.36` (EU). Debe responderse 2xx en 10 s; hasta 10 intentos; un 4xx no se reintenta. [verificado] https://www.assemblyai.com/docs/deployment/webhooks
- `DELETE /v2/transcript/{id}` borra los datos del transcript y lo marca como borrado; los archivos subidos por `/upload` se borran junto con él. [verificado] https://www.assemblyai.com/docs/api-reference/transcripts/delete
- Retención: el audio entregado por `audio_url` sigue el ciclo de vida del transcript (con TTL o BAA se borra al vencer el TTL, mínimo 1 h); el borrado usa TTL de DynamoDB y puede demorar de minutos a algunos días; se conserva metadato para facturación. [verificado] https://assemblyai.com/docs/faq/how-long-does-aai-retain-data — Vale ya fijó TTL 1 día + BAA: es la red de seguridad; el borrado activo (DELETE) es la medida principal.

**Anthropic**
- API comercial: no entrena con entradas/salidas por defecto. [verificado] https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training
- Retención estándar: borra entradas y salidas dentro de 30 días; si un sistema de seguridad marca una infracción, hasta 2 años. [verificado] https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- **Batch API (`/v1/messages/batches`): NO es elegible para ZDR ni para HIPAA**; guarda solicitudes y respuestas hasta 29 días; se puede borrar con `DELETE /v1/messages/batches/{id}` después de procesar. [verificado] https://platform.claude.com/docs/en/manage-claude/api-and-data-retention y https://platform.claude.com/docs/en/build-with-claude/batch-processing
- Messages API sí es elegible para ZDR y HIPAA; HIPAA se activa en Console (Data retention) y **es permanente**; con HIPAA activo, las funciones no elegibles (incluido Batch) devuelven 400. ZDR se pide a ventas. Los esquemas JSON de structured outputs no reciben protección PHI: no poner datos del paciente en esquemas. [verificado] misma URL. Los modelos elegidos (`claude-sonnet-5-5`, `claude-haiku-5-5`) no están en la lista de "Covered Models" que exigen 30 días. [verificado]

**Vercel**
- Cuerpo máximo de request **y de respuesta** de una función: **4,5 MB** (error 413 `FUNCTION_PAYLOAD_TOO_LARGE`). Hobby: duración máxima 300 s (el sitio fija 60 s). [verificado] https://vercel.com/docs/functions/limitations
- Precedencia entre dos reglas de `headers` de `vercel.json` que ponen la misma cabecera: **no documentada** en la página revisada. [por verificar con `curl -I`] → el diseño evita depender de ello (§3.4).

**Cloudflare R2**
- Cifrado en reposo AES-256 (GCM) automático con llaves de Cloudflare; TLS en tránsito. [verificado] https://developers.cloudflare.com/r2/reference/data-security/
- Tokens: Admin R&W, Admin R, **Object Read & Write**, Object Read; los "Object" se pueden limitar a buckets concretos; el Secret Access Key se muestra una sola vez. [verificado] https://developers.cloudflare.com/r2/api/tokens/
- URLs prefirmadas: máx. 7 días, GET/HEAD/PUT/DELETE (no POST de formulario), **solo en `<ACCOUNT_ID>.r2.cloudflarestorage.com`** (no dominio propio — calza con "no agregar el dominio a Cloudflare"), son tokens portador reutilizables hasta vencer, fijar `ContentType` en PUT; CORS en el bucket para uso desde navegador. [verificado] https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Multipart: partes de 5 MiB a 5 GiB, todas iguales salvo la última, máx. 10.000 partes; las subidas incompletas expiran a los 7 días por defecto. [verificado] https://developers.cloudflare.com/r2/objects/upload-objects/ y https://developers.cloudflare.com/r2/api/error-codes/
- **Sin versionado y sin Object Lock S3** (`PutBucketVersioning`, `PutObjectLockConfiguration` no implementados). SSE-C sí soportado. [verificado] https://developers.cloudflare.com/r2/api/s3/api/ — Existen "bucket locks" propios de R2 (retención por prefijo, removibles; impiden vaciar el bucket). [verificado] https://developers.cloudflare.com/r2/buckets/bucket-locks/
- Reglas de ciclo de vida por prefijo; borrado típicamente dentro de 24 h desde el vencimiento. [verificado] https://developers.cloudflare.com/r2/buckets/object-lifecycles/

**Backblaze B2**
- Llaves de aplicación limitables a un bucket y a un prefijo de nombre, con capacidades concretas y duración (`validDurationSeconds`, < 1000 días); la llave maestra tiene acceso total y no debe usarse. [verificado] https://www.backblaze.com/docs/cloud-storage-application-keys
- SSE-B2 (AES-256, llave por archivo) como cifrado por defecto del bucket; SSE-C disponible. [verificado] https://www.backblaze.com/docs/cloud-storage-server-side-encryption
- **Por defecto B2 guarda todas las versiones**: un archivo "borrado"/reemplazado queda oculto pero descargable por su id hasta que una regla `daysFromHidingToDeleting` o un borrado de versión lo elimine. [verificado] https://www.backblaze.com/docs/cloud-storage-lifecycle-rules
- Object Lock: modo governance (removible con capacidad) y compliance (nadie lo quita); una vez activado en el bucket no se desactiva; bloquea borrados antes de vencer. [verificado] https://www.backblaze.com/docs/cloud-storage-object-lock

**Fly.io**
- Token mínimo para manejar máquinas de una app: **deploy token con alcance de app** (`fly tokens create deploy --name … --expiry …`); machine-exec y SSH no sirven para crear/destruir. [verificado] https://docs.fly.io/security/tokens — La Machines API usa `Authorization: Bearer <token>`. [verificado] https://docs.fly.io/machines/api/working-with-machines-api
- Secrets: bóveda cifrada por app; se inyectan como variables de entorno al arrancar cada máquina de la app (incluidas las creadas por Machines API); no se pueden leer de vuelta; quien puede desplegar puede exfiltrarlos con código. [verificado] https://docs.fly.io/apps/secrets

**Web Crypto AES-GCM**
- IV único por cada cifrado con la misma llave ("never reuse an IV with the same key"), 96 bits recomendado; `additionalData` autenticado y obligatorio al descifrar si se usó; `tagLength` por defecto 128. [verificado] https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams y https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt

---

## 2. Modelo de amenazas (STRIDE breve)

### 2.1 Flujo y límites de confianza

```
[iPhone Safari /admin/grabar] --cookie panel--> [Vercel /api/admin/transcriptor/*]
      |  (trozos en IndexedDB)                         |  crea multipart + URLs prefirmadas PUT (15 min)
      +--PUT partes (TLS, prefirmado)--> [R2 bucket audio-temporal]  <--GET prefirmado (≤6 h)-- [AssemblyAI]
                                                       |                                         |
[Vercel] --POST /v2/transcript (audio_url, webhook_url, cabecera secreta)-->                     |
[AssemblyAI] --webhook {id,status} + cabecera--> [Vercel /api/webhooks/assemblyai]               |
[Vercel] --GET transcript (API key)--> texto --> cifra --> [R2 transcripciones] + [B2 copia]     |
[Vercel] --DELETE transcript--> [AssemblyAI];  DELETE audio --> [R2 audio-temporal]
[Vercel] --Batch (texto)--> [Anthropic] --resultado--> resumen --> [Supabase ficha]; DELETE batch
[Vercel cron/panel] --Machines API (deploy token)--> [Fly máquina efímera bot]
[Bot] --entra a Meet (Vale lo admite)--> graba --> pide URLs a [Vercel /api/bot/*] con token de sesión --> PUT a R2
```

Límites de confianza: navegador ↔ Vercel; Vercel ↔ cada proveedor; bot (Fly) ↔ Vercel; Meet ↔ bot.

### 2.2 Amenazas y controles

| # | STRIDE | Amenaza | Control (obligatorio salvo que diga "recomendado") |
|---|---|---|---|
| S1 | Spoofing | Alguien obtiene la contraseña del panel (phishing, reutilización) y lee/consulta todas las sesiones. | Segundo factor (passkey/WebAuthn o TOTP) **antes de lanzar** (R1). Límite de intentos ya existe. Alerta por correo en login desde IP nueva. |
| S2 | Spoofing | Webhook falso a `/api/webhooks/assemblyai` para inyectar un texto o disparar procesos. | Cabecera secreta en tiempo constante + el cuerpo **nunca** se usa como dato: solo `transcript_id`, que debe existir en `transcripciones` en estado `procesando`; el texto se pide a AssemblyAI con nuestra API key. Opcional: aceptar solo desde `44.238.19.20`. |
| S3 | Spoofing | Un tercero se hace pasar por el bot y sube audio a nombre de una sesión, o pide URLs. | Token por sesión de 256 bits, guardado solo como HMAC, ligado a `booking_id`, vence al terminar la sesión + 2 h, revocado al finalizar; rate limit; respuestas 404 genéricas (§5). |
| S4 | Spoofing | El bot entra a una reunión equivocada (link manipulado). | El link de Meet sale **solo** de la reserva en Supabase; ninguna API acepta un `meet_url` del cliente. |
| T1 | Tampering | Alteración de una transcripción en R2/B2. | AES-256-GCM con AAD que incluye la clave del objeto y la versión: un objeto movido o modificado falla al descifrar. SHA-256 del cifrado guardado en Supabase. |
| T2 | Tampering | Subida de un archivo no-audio o enorme vía URL prefirmada. | URL ligada a `Content-Type` y a una clave de objeto generada por el servidor; partes de tamaño fijo; validar tamaño total antes de mandar a AssemblyAI; tope de duración. |
| T3 | Tampering / Elevation | Inyección de instrucciones en la transcripción ("ignora lo anterior…") que altera el resumen o el Q&A. | El modelo no tiene herramientas ni acceso a otros datos: el impacto queda en el texto que lee Vale. Prompt con la transcripción delimitada como dato; salida renderizada como texto (nunca HTML). Etiqueta "Resumen automático (IA)". |
| T4 | Tampering | CSRF: otra página hace que el navegador de Vale borre transcripciones o lance el bot. | Rutas mutantes del transcriptor exigen `Origin` presente y propio (fallar cerrado, a diferencia del middleware actual) + cabecera `X-Panel: 1` (fuerza preflight CORS) + cookie `SameSite=lax`. |
| R1 | Repudiation | No poder demostrar quién vio o borró una sesión (Ley 20.584 / 21.719). | Bitácora de accesos solo-agregar (§7). |
| I1 | Info disclosure | Filtración del bucket R2/B2 o de la llave de R2. | Cifrado de aplicación (§3): sin la llave maestra de Vercel, los objetos son ruido. Claves de objeto opacas (UUID), sin nombres ni fechas. Acceso público (r2.dev) desactivado. |
| I2 | Info disclosure | Audio en claro en tránsito/temporal (R2 audio-temporal, AssemblyAI). | URLs cortas; borrado activo apenas llega el webhook (R2 `DeleteObject` + AssemblyAI `DELETE`); regla de ciclo de vida 1 día en el bucket temporal; TTL 1 día + BAA en AssemblyAI; autochequeo diario. |
| I3 | Info disclosure | Retención en Anthropic (Batch 29 días, no ZDR/HIPAA). | `DELETE` del batch tras leer resultados; no poner datos del paciente en esquemas JSON; decisión pendiente R2 (ver §9). |
| I4 | Info disclosure | Texto clínico en registros (`admin_logs`, logs de Vercel, mensajes de error). | Prohibido pasar transcripción/resumen/pregunta a `log*()` o `console.*`; errores de proveedores se registran solo con código y id. Test que lo revise. |
| I5 | Info disclosure | XSS en el panel al mostrar transcripción (texto controlado por lo que se dice en sesión) o salida de la IA. | Nunca `set:html` con estos textos; `textContent`/escape de Astro. CSP en `/admin/*` (recomendado fuerte). |
| I6 | Info disclosure | iPhone perdido con trozos en IndexedDB. | Borrar trozos al confirmar la subida (ETag verificado); iPhone con código + Face ID; no usar navegación privada. Recomendado: cifrar trozos con llave Web Crypto **no exportable** guardada en IndexedDB (dificulta copiar los archivos del almacenamiento del navegador; no protege contra alguien con el teléfono desbloqueado). |
| I7 | Info disclosure | Variables de entorno de producción visibles en despliegues Preview/ramas. | Llaves del transcriptor **solo en el entorno Production** de Vercel y marcadas "Sensitive"; Preview usa buckets y llaves de prueba sin datos reales. |
| I8 | Info disclosure | Respaldo semanal de Supabase en B2 en claro. | El volcado se cifra con `BACKUP_KEK` (distinta) antes de subir; prefijo y llave B2 propios. |
| D1 | DoS | Spam al webhook o a `/api/bot/*` que agota funciones o el crédito de AssemblyAI/Anthropic. | Rechazo temprano (cabecera/token) antes de tocar Supabase; límites de gasto ya fijados (Anthropic US$20); tope diario de transcripciones por día en código (p. ej. 12) con alerta. |
| D2 | DoS | El iPhone pierde la grabación (llamada, bloqueo). | Fuera de seguridad pura: Wake Lock + IndexedDB + aviso rojo (definido en 00-decisiones). |
| E1 | Elevation | Token de Fly robado permite crear máquinas o desplegar imagen maliciosa. | Deploy token con alcance **solo a la app del bot** y vencimiento; la app del bot no tiene secretos permanentes con valor (§5); rotación anual. |
| E2 | Elevation | `SUPABASE_SERVICE_ROLE_KEY` filtrada. | Ya es "llave maestra" del sitio. El transcriptor no la agrava porque el contenido clínico extenso está cifrado fuera de Supabase con otra llave. |

---

## 3. Cifrado

### 3.1 Dónde se cifra
- **En el servidor (función de Vercel, Node, `globalThis.crypto.subtle`)**, justo después de recibir el texto de AssemblyAI y antes de escribir en R2/B2. El navegador nunca tiene llaves de cifrado de transcripciones; el bot tampoco.
- El audio **no** se cifra a nivel de aplicación: AssemblyAI debe poder leerlo con una URL prefirmada (no puede mandar cabeceras SSE-C). Se compensa con: bucket separado, vida < 1 día, borrado activo, cifrado en reposo de R2.

### 3.2 Llaves (envelope encryption)
- **KEK (llave maestra)**: 32 bytes aleatorios en base64, en Vercel como `TRANSCRIPTOR_KEK_V1` (Production, Sensitive). Vale la genera con `openssl rand -base64 32` en su Mac y la pega directo en Vercel; **copia offline** en su gestor de contraseñas (si se pierde la KEK, se pierden todas las transcripciones: no hay recuperación).
- **DEK (llave por objeto)**: 32 bytes aleatorios nuevos para **cada** objeto (`crypto.getRandomValues`). Cifra el contenido con AES-256-GCM.
- La DEK se **envuelve** con la KEK (AES-256-GCM, IV propio de 12 bytes) y la DEK envuelta se guarda **dentro de la cabecera del objeto** (autocontenido: si Supabase se pierde entre respaldos, el objeto sigue siendo recuperable con la KEK). Además se copia en Supabase (para poder destruirla, ver 3.6).
- `TRANSCRIPTOR_KEK_ACTIVA=v1` indica con qué versión se cifra lo nuevo. Al descifrar se usa la versión escrita en la cabecera.
- Llaves separadas por propósito: `TRANSCRIPTOR_KEK_*` (transcripciones y textos derivados guardados fuera de Supabase), `BACKUP_KEK_*` (volcados de Supabase en B2), `BOT_TOKEN_SECRET` (HMAC de tokens del bot). Nunca reutilizar `ADMIN_SECRET`.
- Con DEK única por objeto, el límite de GCM de ~2^32 cifrados con IV aleatorio por llave no aplica en la práctica (la KEK envuelve unos pocos miles de DEK al año).

### 3.3 Formato del objeto (binario, `application/octet-stream`)

```
offset  largo  campo
0       4      magia "VOT1"
4       1      versión de formato = 0x01
5       1      versión de KEK (1, 2, …)
6       12     iv_envoltura (aleatorio)
18      48     DEK envuelta (32 bytes + tag 16)
66      12     iv_contenido (aleatorio, nunca repetido)
78      n+16   contenido cifrado + tag GCM (128 bits)
```
- **AAD del contenido** = bytes 0–77 (cabecera completa) + `"|" + clave_objeto + "|" + tipo` (p. ej. `t/3f2c…bin|transcripcion`). **AAD de la envoltura** = `"VOT1|kek=v1|" + clave_objeto`. Así un objeto copiado a otra clave o con la cabecera alterada no descifra.
- Contenido en claro antes de cifrar: JSON `{ v:1, idioma, modelo, duracion_s, hablantes:[…], segmentos:[{inicio, fin, hablante, texto}] }`, comprimido con gzip (compresión antes de cifrar; no hay riesgo tipo CRIME porque no hay atacante que inyecte texto y observe tamaños en línea).
- Tamaño: una sesión de 50 min ≈ 50–80 KB de texto; muy por debajo de 4,5 MB, así que lectura y descifrado pasan por Vercel sin problema.

### 3.4 Qué queda en claro (mínimo)
- En R2/B2: **solo** el nombre opaco (`t/<uuid>.bin`), tamaño, fecha de subida y `Content-Type: application/octet-stream`. **Nada de `x-amz-meta-*`**, ni nombre, RUT, fecha de sesión ni id de paciente en la clave.
- En AssemblyAI y Anthropic: el contenido viaja en claro por TLS (necesario para procesar). No mandar nombre completo, RUT ni correo en metadatos de la solicitud (`metadata`, `custom_id` de batch = id opaco).

### 3.5 Qué se guarda en Supabase
Tabla nueva `transcripciones` (RLS activado, sin políticas anon, `grant select, insert, update, delete … to service_role`):
`id uuid`, `patient_id`, `booking_id`, `origen` (`presencial`|`online`), `modelo`, `ruido boolean`, `estado` (`subiendo`|`procesando`|`lista`|`error`|`borrada`), `r2_key`, `b2_key`, `formato_v`, `kek_v`, `dek_envuelta bytea`, `sha256_cifrado`, `bytes`, `duracion_s`, `assemblyai_id` (se pone en null tras confirmar el DELETE), `audio_r2_key` (null tras borrar), `audio_borrado_at`, `assemblyai_borrado_at`, `batch_id`, `batch_borrado_at`, `consent_ids uuid[]`, `created_at`, `deleted_at`, `motivo_borrado`.
- El **resumen automático** va en la ficha (como las notas de sesión actuales, con su historial y sin borrado físico — migración 0007). Es parte de la ficha clínica.
- **No** se guarda la transcripción completa en Supabase (decisión de Vale: fuera del sitio). Tampoco el texto de las preguntas Q&A en claro: si se quiere historial, se guarda cifrado en R2 con el mismo formato.

### 3.6 Rotación y borrado criptográfico
- **Rotación programada** (anual o ante sospecha): agregar `TRANSCRIPTOR_KEK_V2`, cambiar `TRANSCRIPTOR_KEK_ACTIVA=v2`, redeploy. Un cron re-envuelve: lee cada objeto, desenvuelve la DEK con v1, la envuelve con v2, reescribe la cabecera (el contenido no cambia; los objetos son pequeños) y actualiza `kek_v`/`dek_envuelta`. Cuando `count(kek_v=1)=0`, se borra `V1` de Vercel.
- **Ante filtración de la KEK**: igual que arriba pero urgente, y además **re-cifrar el contenido con DEK nueva** (la DEK vieja pudo haberse expuesto).
- **Borrado criptográfico** (complemento, no reemplazo del borrado real): borrar el objeto en R2 y en B2 (todas las versiones) y poner `dek_envuelta = null`. Cualquier copia residual que aparezca después es ilegible sin esa DEK… salvo que la cabecera también exista en esa copia: por eso el borrado real en B2 de todas las versiones es obligatorio (§7.2).

---

## 4. Subida del audio y vida del audio

### 4.1 ¿Por Vercel o directo a R2?
- Una sesión de 50 min en AAC/Opus a 32–64 kbps pesa ≈ 12–24 MB; a mayor calidad más. **No cabe en una request a Vercel (4,5 MB)** [verificado]. Trozear en requests ≤ 4 MB a Vercel no sirve: AssemblyAI necesita un archivo, y las partes multipart de R2 deben ser ≥ 5 MiB.
- **Decisión: subida directa del iPhone a R2 con multipart prefirmado.**
  1. `POST /api/admin/transcriptor/iniciar` (cookie del panel, Origin propio): valida reserva, consentimiento v3 con `accept_recording` y sin `revoked_at` (ambos miembros si es pareja), crea fila `transcripciones` y `CreateMultipartUpload` en el bucket `audio-temporal` con clave `a/<uuid>` generada por el servidor.
  2. `POST /api/admin/transcriptor/partes` → devuelve URLs prefirmadas `UploadPart` para los números de parte pedidos, **vigencia 15 min**, `Content-Type` fijo. El navegador agrupa los trozos de IndexedDB en partes de **tamaño fijo 8 MiB** (la última puede ser menor).
  3. El navegador lee el `ETag` de cada respuesta (CORS debe exponer `ETag`) y solo entonces borra esos trozos de IndexedDB.
  4. `POST /api/admin/transcriptor/completar` con la lista de ETag → `CompleteMultipartUpload`; el servidor hace `HeadObject` para validar tamaño (tope, p. ej. 200 MB) y tipo.
- CORS del bucket `audio-temporal`: `AllowedOrigins: https://www.valentinaorellana.cl` (y `https://valentinaorellana.cl` si aplica), `AllowedMethods: PUT`, `ExposeHeaders: ETag`, `MaxAgeSeconds: 600`. Nada más.
- El iPhone **nunca** recibe credenciales de R2: solo URLs que permiten subir una parte concreta de un objeto concreto durante 15 min.

### 4.2 Cómo lee AssemblyAI el audio
- El servidor genera una URL prefirmada **GET** del objeto `a/<uuid>`, **vigencia 6 h** (cubre la cola de AssemblyAI; ajustar con datos reales) y llama `POST /v2/transcript` con `audio_url`, `webhook_url = https://www.valentinaorellana.cl/api/webhooks/assemblyai`, `webhook_auth_header_name = X-Webhook-Secret`, `webhook_auth_header_value = ASSEMBLYAI_WEBHOOK_SECRET`, y el modelo según la regla fija del sitio.
- La URL prefirmada es un token portador: no se registra en logs ni se guarda en Supabase.

### 4.3 Webhook y borrado en cadena
`POST /api/webhooks/assemblyai`:
1. Comparar `X-Webhook-Secret` en tiempo constante; si falla → 401 (sin tocar la base). Si falta la variable → 503 + `logError` (patrón de Resend).
2. Parsear solo `transcript_id`/`status`; buscar fila con ese `assemblyai_id` y `estado='procesando'`; si no existe → 200 sin hacer nada (evita reintentos y no revela nada).
3. Responder rápido (< 10 s): marcar la fila y procesar el resto en una tarea (patrón `tareasEnvio` existente) o en la misma función si cabe en 60 s.
4. `GET /v2/transcript/{id}` con la API key → texto → cifrar → `PutObject` en R2 `transcripciones` → copiar a B2 → verificar ambos (HEAD + SHA-256).
5. **Solo después de confirmar las dos copias**: `DELETE /v2/transcript/{id}` en AssemblyAI (borra también su copia del audio de `audio_url`), `DeleteObject` del audio en R2, `AbortMultipartUpload` de lo pendiente; registrar `assemblyai_borrado_at`, `audio_borrado_at`.
6. Encolar el resumen (Batch). Al leer resultados: guardar resumen en la ficha y **`DELETE /v1/messages/batches/{id}`**.
- Si `status=error`: igual borrar audio y transcript en AssemblyAI, marcar `error` y alertar.
- **Red de seguridad**: regla de ciclo de vida en `audio-temporal` = borrar a 1 día; TTL 1 día en AssemblyAI; autochequeo diario que (a) lista objetos de `audio-temporal` con más de 12 h, (b) lista transcripts en AssemblyAI (`GET /v2/transcript`) no borrados con más de 2 h, (c) busca batches no borrados, (d) busca filas con `audio_borrado_at` null y > 12 h. Alerta solo si algo aparece.

### 4.4 Permissions-Policy (micrófono)
- No depender de la precedencia (no documentada) entre dos reglas de `vercel.json`. Cambiar la regla global para **excluir** la ruta del grabador con un patrón negativo, y poner una regla propia para ella:
  - global: `"source": "/((?!admin/grabar$).*)"` → `microphone=()` (igual que hoy).
  - grabador: `"source": "/admin/grabar"` → `camera=(), microphone=(self), geolocation=(), interest-cohort=()`.
- Verificar con `curl -I` en el preview: `/admin/grabar` debe mostrar `microphone=(self)` y cualquier otra ruta `microphone=()`. El bot de Meet no necesita esto (no usa el navegador de Vale).

---

## 5. Bot de Meet (Fly.io)

### 5.1 Lanzamiento
- Lo lanza **Vercel** (cron cada 5 min que mira sesiones online que empiezan en ≤ 3 min, o botón en el panel), nunca el propio bot. Vercel llama la Machines API con `FLY_API_TOKEN` (deploy token **solo de la app del bot**, con `--expiry`).
- Antes de lanzar, el servidor valida: reserva online confirmada, consentimiento v3 vigente (ambos si pareja), no hay ya un bot activo para esa reserva.
- Config de la máquina (env): `SITE_URL`, `BOOKING_REF` (id opaco), `MEET_URL` (desde la reserva en Supabase), `BOT_TOKEN` (ver 5.2), `BOT_NOMBRE="Notas Ps. Valentina Orellana"`. Máquina con `auto_destroy` y tope de duración (p. ej. 2 h) [por verificar nombre exacto del campo en la referencia de Machines].
- La app del bot en Fly **no tiene secretos permanentes con valor**: ni llaves de R2, ni AssemblyAI, ni Anthropic, ni Supabase. El bot solo sabe hablar con el sitio.

### 5.2 Autenticación del bot contra el sitio
- `BOT_TOKEN` = 32 bytes aleatorios (base64url), **uno por sesión**. Supabase guarda solo `HMAC-SHA256(BOT_TOKEN_SECRET, token)` en una tabla `bot_sesiones` (`booking_id`, `token_hmac`, `vence_at` = fin de la sesión + 2 h, `usado_para_completar boolean`, `revocado_at`, `machine_id`).
- Endpoints `/api/bot/*` (fuera de `/api/admin`, sin cookie): `Authorization: Bearer <token>`; el servidor calcula el HMAC y busca la fila (comparación por igualdad de un hash de 256 bits no es atacable por tiempo); exige no vencido, no revocado.
- El bot puede únicamente: `POST /api/bot/estado` (entró / esperando admisión / grabando / salió), `POST /api/bot/partes` (URLs prefirmadas para **su** objeto de audio) y `POST /api/bot/completar` (una sola vez; después el token queda revocado). Lo demás del flujo (AssemblyAI, cifrado) es igual al presencial.
- Al completar, o al vencer, o si Vale pulsa "Sacar bot": se revoca el token y se destruye la máquina vía Machines API.

### 5.3 ¿Y si alguien adivina los endpoints?
- Las rutas son públicas por naturaleza; la seguridad está en el token (2^256 combinaciones) y en su vida corta. Sin token válido: **404 genérico** igual para "no existe", "vencido" y "revocado" (no se revela si hay sesión).
- Rate limit por IP en `/api/bot/*` y en el webhook (registrar fallos y bloquear 15 min tras 10 fallos, como el login).
- Un token robado de la máquina (p. ej. por un fallo en el código del bot) permite como máximo **subir audio** a esa sesión antes de que venza; no permite leer nada. Ningún endpoint del bot devuelve transcripciones, resúmenes ni datos de pacientes.
- Rotular el bot con el nombre fijo ayuda a Vale a no admitir un impostor; el bot nunca se admite solo.

---

## 6. Variables de entorno (sin valores)

Todas en Vercel → **Production** solamente, tipo **Sensitive**. Preview/Development usan valores y buckets de prueba distintos.

| Nombre | Para qué | Permisos mínimos |
|---|---|---|
| `TRANSCRIPTOR_KEK_V1` (luego `_V2`…) | Llave maestra que envuelve las DEK. | 32 bytes aleatorios; copia offline de Vale. |
| `TRANSCRIPTOR_KEK_ACTIVA` | Versión con la que se cifra lo nuevo. | — |
| `BACKUP_KEK_V1` | Cifrar volcados semanales de Supabase antes de B2. | Distinta de la anterior. |
| `BOT_TOKEN_SECRET` | HMAC de los tokens por sesión del bot. | 32 bytes aleatorios. |
| `ASSEMBLYAI_API_KEY` | Crear, leer y borrar transcripts. | Llave de un proyecto AssemblyAI dedicado al sitio (AssemblyAI no ofrece llaves con alcance por operación [por verificar]); autopay con tope. |
| `ASSEMBLYAI_WEBHOOK_SECRET` | Valor de la cabecera `X-Webhook-Secret`. | 32 bytes aleatorios. |
| `ANTHROPIC_API_KEY` | Batch de resúmenes y Q&A. | Llave de un **workspace "transcriptor"** propio en Console, con límite de gasto; desactivar descarga de resultados de batch en Console para ese workspace. |
| `R2_ACCOUNT_ID` | Endpoint `<id>.r2.cloudflarestorage.com`. | — |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | S3 API de R2. | Token **Object Read & Write** limitado a los buckets `vo-transcripciones` y `vo-audio-temporal`. Nunca Admin. Con fecha de vencimiento si la UI lo permite; rotación anual. |
| `R2_BUCKET_TRANSCRIPCIONES`, `R2_BUCKET_AUDIO` | Nombres de bucket. | — |
| `B2_ENDPOINT`, `B2_REGION` | S3 API de B2. | — |
| `B2_KEY_ID` / `B2_APPLICATION_KEY` | Copia de transcripciones + respaldo Supabase. | Llave de aplicación **restringida a un bucket** (`vo-respaldo`), capacidades `listFiles, readFiles, writeFiles, deleteFiles` (sin `writeBuckets`, `writeBucketRetentions`, `bypassGovernance`), duración < 1000 días. Nunca la llave maestra. |
| `B2_BUCKET` | Nombre del bucket. | — |
| `FLY_API_TOKEN` | Crear/destruir máquinas del bot. | Deploy token **de la app del bot**, `--expiry` (p. ej. 1 año, renovar). |
| `FLY_APP_BOT` | Nombre de la app en Fly. | — |
| Ya existentes y reutilizadas | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SECRET`, `ADMIN_PASSWORD`, `CRON_SECRET`. | Sin cambios. |

En Fly (app del bot): **ningún secret de proveedor**. Solo variables no secretas en `fly.toml`; el `BOT_TOKEN` llega por la config de cada máquina y muere con ella.

Cloudflare/Backblaze/Fly/Anthropic/AssemblyAI: cuentas con 2FA activado (Vale), correos de alerta de facturación activos.

---

## 7. Registro de accesos y borrado

### 7.1 Bitácora (audit log)
Tabla nueva `transcriptor_accesos` (RLS, sin políticas anon). **Excepción a la regla del proyecto**: `grant select, insert on public.transcriptor_accesos to service_role;` **sin** `update, delete` + trigger que rechace `UPDATE`/`DELETE` — la bitácora debe ser solo-agregar. (La regla del proyecto busca que service_role tenga acceso; aquí se le da a propósito solo lo necesario.)

Campos: `id`, `created_at`, `actor` (`panel` + firma corta de la sesión | `bot:<machine_id>` | `sistema:<cron>` | `assemblyai-webhook`), `accion`, `transcripcion_id`, `patient_id`, `resultado` (`ok`|`denegado`|`error`), `ip`, `user_agent`, `detalle` (jsonb **sin contenido clínico**).

Acciones a registrar: iniciar grabación, completar subida, lanzar/sacar bot, admitido/salió (estado del bot), webhook recibido, transcripción guardada, borrado en AssemblyAI/R2 audio/batch, **ver transcripción**, **preguntar a la IA** (solo id y largo de la pregunta, nunca el texto), descargar/exportar, borrar transcripción, rotación de llave, login ok/fallido (ya existe en `admin_logs`).

Retención de la bitácora: mientras exista la ficha (15 años) + 1 año. Revisión mensual (Claude) incluye: accesos fuera del horario habitual, más de N vistas por hora, accesos desde IP nueva, denegados repetidos.

### 7.2 Borrado
- **Audio**: siempre, automático, tras transcribir (§4.3). Objetivo: < 1 h en R2 y en AssemblyAI (más el tiempo de proceso de TTL que AssemblyAI declara).
- **Plazo normal (15 años)**: cron mensual que detecta fichas con última atención > 15 años y borra sus transcripciones (R2 + B2 todas las versiones + DEK) y registra el borrado. El resumen sigue la suerte de la ficha.
- **Derecho de supresión (Ley 21.719)**: la obligación de conservar la ficha clínica 15 años limita la supresión de lo que sea ficha. **Pendiente del abogado**: si la transcripción completa es ficha. El sistema debe soportar ambas respuestas:
  - Botón "Borrar transcripción" por sesión (y "Borrar todas las de este paciente"), con confirmación, motivo obligatorio y registro.
  - Si se revoca el consentimiento de grabación (`consents.revoked_at`): no se pueden iniciar nuevas grabaciones ni bots para ese paciente (validado en servidor).
- **Cómo se borra de verdad**:
  - R2: `DeleteObject` (sin versionado, el borrado es definitivo) [verificado].
  - B2: borrar **todas las versiones** (`ListObjectVersions` + `DeleteObject` con `versionId`, o `b2_delete_file_version`); además, regla de ciclo de vida del bucket `daysFromHidingToDeleting = 1` para que nada oculto sobreviva. **No usar Object Lock en modo compliance** en el bucket de transcripciones (impediría cumplir una supresión); si se quiere protección contra borrado malicioso, governance corto (≤ 7 días) solo en el prefijo de respaldos de Supabase.
  - Supabase: `dek_envuelta = null`, `estado='borrada'`, `deleted_at`, se conserva la fila mínima (sin contenido) como prueba del borrado.
  - Respaldos semanales de Supabase en B2: rotación de 8 semanas; lo borrado desaparece de los respaldos a más tardar en ese plazo (declararlo en la política de privacidad).
  - Anthropic: `DELETE` del batch; Q&A (Messages API) sin forma de borrado manual → 30 días por política estándar (declararlo en el consentimiento).
- Respuesta a la persona: plazo legal; el sistema debe poder borrar en minutos.

---

## 8. Checklist de seguridad antes de lanzar (para la revisión de código)

**Autenticación y sesiones**
- [ ] Segundo factor en el login del panel (passkey/WebAuthn o TOTP) o, como mínimo, decisión explícita y escrita de Vale de lanzar sin él.
- [ ] Todas las rutas del transcriptor que usa Vale están bajo `/admin/*` o `/api/admin/*` (cubiertas por `src/middleware.ts`).
- [ ] Rutas mutantes del transcriptor rechazan si falta `Origin` o no es propio, y exigen `X-Panel: 1`.
- [ ] `/api/bot/*`: Bearer por sesión, HMAC con `BOT_TOKEN_SECRET`, vencimiento, revocación al completar, 404 genérico, rate limit.
- [ ] Webhook AssemblyAI: cabecera secreta en tiempo constante, falla cerrado sin variable (503), solo usa `transcript_id` y re-consulta con API key, responde < 10 s, idempotente (dos webhooks iguales no duplican nada).
- [ ] Ningún endpoint acepta `meet_url`, `r2_key`, `patient_id` de otro paciente ni nombres de objeto desde el cliente sin verificarlos contra la fila del servidor.
- [ ] Inicio de grabación/bot exige consentimiento v3 con `accept_recording` firmado y sin `revoked_at` (ambos miembros si es pareja), validado en servidor.

**Cifrado**
- [ ] AES-256-GCM con `crypto.subtle`; IV de 12 bytes nuevo por cada cifrado (test que cifre 2 veces lo mismo y compruebe IV y salida distintos).
- [ ] DEK única por objeto; AAD incluye cabecera + clave del objeto + tipo; test: mover/alterar un byte → descifrado falla.
- [ ] Formato con magia + versión de formato + versión de KEK; test de rotación v1→v2 (re-envuelve y sigue descifrando).
- [ ] Ninguna llave en el repo, en logs ni en respuestas; `grep` del diff sin secretos; llaves solo vía `import.meta.env`.
- [ ] Objetos con nombre opaco y sin `x-amz-meta-*`; `Content-Type: application/octet-stream`.
- [ ] Volcado de Supabase cifrado con `BACKUP_KEK_*` antes de subir a B2.

**Almacenamiento y proveedores**
- [ ] R2: acceso público (r2.dev) desactivado en ambos buckets; token Object R&W limitado a esos dos buckets.
- [ ] R2 `audio-temporal`: CORS exacto (origen del sitio, PUT, `ExposeHeaders: ETag`); ciclo de vida 1 día; aborto de multipart incompletos ≤ 1 día.
- [ ] URLs prefirmadas: PUT 15 min con `Content-Type` fijo; GET para AssemblyAI ≤ 6 h; nunca registradas.
- [ ] B2: llave restringida a un bucket con capacidades mínimas; `daysFromHidingToDeleting = 1`; borrado de todas las versiones probado; SSE-B2 por defecto activado; sin Object Lock compliance en transcripciones.
- [ ] AssemblyAI: TTL 1 día confirmado en Data Controls; entrenamiento desactivado; `DELETE` tras guardar las dos copias; test que confirme estado borrado vía GET.
- [ ] Anthropic: workspace propio con límite de gasto; `DELETE` del batch tras leer resultados; sin datos del paciente en `custom_id`, metadatos ni esquemas JSON; decisión registrada sobre HIPAA/ZDR (ver riesgo R2).
- [ ] Fly: deploy token de la app del bot con vencimiento; app sin secrets de proveedores; máquinas con autodestrucción y tope de duración; link de Meet solo desde Supabase.

**Datos, registros y salida**
- [ ] Nada de texto clínico (transcripción, resumen, pregunta, respuesta) en `logInfo/logWarn/logError`, `console.*`, mensajes de error al cliente ni `admin_logs`.
- [ ] Transcripción, resumen y respuestas Q&A se muestran como texto (sin `set:html`, sin `innerHTML`); CSP en `/admin/*` (al menos `default-src 'self'`, `connect-src 'self' https://*.r2.cloudflarestorage.com`, `object-src 'none'`, `frame-ancestors 'none'`).
- [ ] Respuestas del panel con `Cache-Control: private, no-store` (ya lo pone el middleware: verificar en las rutas nuevas).
- [ ] `transcriptor_accesos` solo-agregar (sin `update/delete` para service_role + trigger) y todas las acciones de §7.1 registradas.
- [ ] Migraciones con RLS activado, sin políticas anon y los `grant` correctos.

**Navegador / iPhone**
- [ ] `Permissions-Policy` con `microphone=(self)` solo en `/admin/grabar`, `microphone=()` en el resto (verificado con `curl -I` en preview y producción).
- [ ] Trozos de IndexedDB borrados solo tras ETag confirmado; no quedan trozos tras completar (test).
- [ ] La página del grabador no carga scripts de terceros (GTM, analítica) — el panel no debe medir nada que toque sesiones.

**Operación**
- [ ] Variables del transcriptor solo en Production y marcadas Sensitive; Preview con buckets/llaves de prueba.
- [ ] Autochequeo diario: audio > 12 h en R2, transcripts no borrados en AssemblyAI, batches no borrados, KEK presente, copia B2 = copia R2 (conteo y SHA-256 de una muestra). Alerta solo si falla.
- [ ] Prueba de restauración: descifrar un objeto de B2 con la KEK de la copia offline.
- [ ] Procedimiento escrito de "llave filtrada" (rotar KEK, revocar tokens R2/B2/Fly/AssemblyAI/Anthropic, revisar bitácora).
- [ ] Consentimiento v3 publicado con: grabación, IA, procesamiento en EE.UU., ambos de la pareja, retención (incluidos 30 días en Anthropic y respaldos 8 semanas), borrado del audio, derechos ARCO+.

---

## 9. Riesgos que requieren decisión

- **R1 (crítico) — Un solo factor en el panel.** Hoy una contraseña da acceso a toda la ficha; con el transcriptor dará acceso a sesiones completas y a un Q&A sobre todas. Recomendación: passkey (WebAuthn, funciona en Safari iPhone y Chrome Mac) antes de lanzar.
- **R2 (alto) — Batch API de Anthropic no es elegible para ZDR ni HIPAA** y guarda datos hasta 29 días. Con la política estándar, la Messages API igual retiene hasta 30 días, así que hoy la diferencia es menor; pero si Vale activa HIPAA readiness en Console (permanente), **los batch dejarán de funcionar (400)** y habría que pasar a la Messages API (≈ el doble de costo en resúmenes). Decidir antes de construir: (a) estándar + Batch + `DELETE` del batch, declarado en el consentimiento; o (b) HIPAA readiness + Messages API.
- **R3 (alto) — Pérdida de la KEK = pérdida total de las transcripciones.** Copia offline obligatoria y prueba de restauración.
- **R4 (medio) — CSRF del middleware actual deja pasar POST sin Origin/Referer.** Las rutas nuevas deben fallar cerrado; conviene corregirlo también en el resto del panel (cambio aparte).
- **R5 (medio) — Respaldo B2 por defecto guarda versiones ocultas**: si no se configura `daysFromHidingToDeleting` y el borrado por versión, un "borrado" no borra.
