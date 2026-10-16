# 83 — Revisión final independiente (código + seguridad + ética) — 16 oct 2026

Alcance: `git diff origin/main...transcriptor` en `7472aab` (incluye t-fix-seguridad `c11d113`, t-fix-logica
`b8f17fd` y t-fix-secretos-sitio `1059896`). La rama está al día con `origin/main` (0 commits detrás; merge
limpio). Revisión de solo lectura: no se modificó código. Todo lo de abajo se verificó leyendo el código
(archivo:línea) o ejecutándolo; lo que no se pudo verificar se dice.

## 0. Veredicto

**Se puede publicar con el transcriptor apagado, con 1 condición:** antes de publicar (o junto con el
deploy) hay que **aplicar en Supabase las migraciones 0014→0019**, o corregir N1 (abajo). Sin 0019, el botón
"Retirar consentimiento" de la ficha (función que ya está en vivo) responde 500 y no deja registrar un
retiro (Ley 21.719). Las migraciones son aditivas, idempotentes y dejan todo apagado (probado, §4), así que
aplicarlas antes es seguro.

Otras dos condiciones de despliegue que no se pueden comprobar sin desplegar:
- **Fluid compute activo** en Vercel (`astro.config.mjs` pasó a `maxDuration: 300`; sin Fluid, en Hobby el
  deploy falla). El commit dice que se verificó en el dashboard; confirmarlo con un deploy de Preview.
- En ese Preview: `curl -I /admin/grabar` y `curl -I /admin` (una sola `Permissions-Policy`, micrófono solo
  en `/admin/grabar`, CSP en ambas), como indica `70-cron.md`.

No hay hallazgos críticos ni altos nuevos.

## 1. Pruebas ejecutadas

| Prueba | Resultado |
|---|---|
| `pnpm -s test` | **259/259 ok** (antes 219) |
| `npx astro build` | ok (`_render.func`, `maxDuration: 300`) |
| `node scripts/verificar-secretos-build.mjs` | **OK: ninguna de las 31 llaves** aparece en `.vercel/output` (incluye KEK, Flow, Google, Meta, SII, Resend webhook) |
| `tsc --noEmit` (TS 5.6.3) rama vs `origin/main` | **9 = 9**, mismos archivos (comprobantes, correoDominio, apigateway ×4, google/callback, bookings, flow/confirm). La rama no agrega errores. (tsc no revisa `.astro`.) |
| `bot/`: `npm ci` (lockfile nuevo) + `tsc --noEmit` + `npm test` | ok, 16/16 |
| Migraciones 0014→0019 en PGlite (2 pasadas seguidas, con grants por defecto tipo Supabase a anon/authenticated) | ok las 12 ejecuciones; ver §4 |
| Humo del servidor construido (handler real de `.vercel/output` + PostgREST simulado), modo "sin migraciones" y modo "con migraciones, sin llaves del transcriptor" | ver §3 |
| Marcadores de conflicto (`<<<<<<<`, `=======`, `>>>>>>>`) | ninguno |

## 2. Verificación de cada hallazgo de 80 / 81 / 82

### 80 — Seguridad

| Hallazgo | Corrección (archivo:línea) | Estado |
|---|---|---|
| A1 passkey obligatoria para encender | `api/admin/transcriptor/ajustes.ts:31-38` + `panel.ts:295-302` (sin caché, falla cerrado); `passkey/gestion.ts:101-107` (no se quita la obligatoriedad con el transcriptor encendido); nivel passkey en `acceso.ts:43-49` usado por `[gid].astro:30`, `[id].astro:96`, `preguntar.ts:61`, `hablantes.ts`, `regenerar-resumen.ts` | **OK** (ver N3: falta en `suprimir.ts`) |
| M1 llaves en el bundle del servidor | `src/lib/secretos.ts` (process.env en runtime; respaldo DEV eliminado en build); `bot.ts`, `alertas.ts:306`, `salud.ts:607` sin `import.meta.env` entero; script verificado | **OK** |
| M2 fallo abierto si Supabase no responde | `middleware.ts:+57-+69` (`estricto` en rutas del transcriptor → 503), `adminSession.ts` `tokenRevocado({estricto})`, `passkey/servidor.ts` `sesionAceptada({estricto})`, `peticion.ts:48-51`, `acceso.ts:56-63` | **OK** |
| M3 borrado de transcripción | `api/admin/transcriptor/suprimir.ts` + `supresion.ts:54-99` (motivo, canal, frase BORRAR, bitácora obligatoria antes, R2+B2, `dek_envuelta=null`, `deleted_at`, preguntas IA borradas) | **OK** (ver N3) |
| M4 huérfanos en AssemblyAI | `salud.ts:316-380` lista `GET /v2/transcript`, borra los propios, avisa los desconocidos; `grabacion-finalizar.ts:171-177` y `pipeline.ts:447` borran duplicados | **OK** (el `DELETE` fallido de `pipeline.ts:668` sigue sin lista "por borrar", pero lo barre el chequeo diario) |
| B1 CSP en `/admin/grabar` | `vercel.json` regla `/admin/grabar` con la misma CSP | **OK** (falta curl en Preview) |
| B2 `/api/admin/settings` | `settings.ts:+31-35` + `acceso.ts:76-79` (`transcriptor_*`, `passkey_*`, `cron_interno_secret`, `admin_tokens_revocados`) | **OK** |
| B3 revoke anon/authenticated | `0018_transcriptor_permisos.sql` (probado: 0 grants a anon/authenticated tras 0018+0019) | **OK** |
| B4 audio sin copia B2 | `pipeline.ts:559-563, 605-629` (reintenta con backoff; tras `MAX_GUARDADO` sigue, deja aviso y el paso `respaldos` reintenta) | **OK** (aceptado y documentado, como permitía 80) |
| B5 reasignar sin consentimiento | `asignar.ts:37-56` | **OK** |
| B6 bot sandbox / lockfile / digest | `bot/Dockerfile:15` (digest), `npm ci` + `bot/package-lock.json`, `argumentos.ts` sandbox por defecto | **OK** (el digest no se pudo verificar contra el registro) |
| B7 tope por segmento del bot | `bot.ts:42, 632` (300 MB) | **OK** |
| B8 detalles | tope por IP (`nucleo.ts:61-67`), saneo de errores del bot (`bot/src/saneo.ts`), `preguntar` con X-Panel | **Parcial**: siguen pendientes (bajas) exigir RUT en pareja y cifrar los trozos en IndexedDB |

### 81 — Ética y clínica

| Hallazgo | Corrección | Estado |
|---|---|---|
| H1 retirar solo la grabación, por persona | `consent.ts:36-72` (`consent_id` obligatorio, `revoke_recording` con canal), `consentimiento.ts` trata `recording_revoked_at` como revocado, UI `[id].astro:386-429`, 0019 | **OK con migración**; sin 0019 rompe el retiro existente (**N1**) |
| H2 pareja deducida en el servidor | `consentimiento.ts` `fichaEsPareja` + `evaluarEnBase`; `grabacion-iniciar.ts:79-85`; online `pipeline.ts:382-383` | **OK** |
| H3 consentimiento al reasignar | `asignar.ts:37-56` | **OK** |
| H4 aviso v2 | `avisoV2.ts`, `email.ts:126-130, 228-230`, tabla `consent_avisos` (0019) | **OK** (ver N2) |
| H5 excluir de la IA | `supresion.ts:101-115`, `preguntar.ts:85-98`, `resumen.ts:733` | **OK** |
| H6 `ver_resumen` en bitácora | `[id].astro:136-160` y `[gid].astro:116-131`, ambos ANTES de descifrar | **OK** |
| H7 resumen cifrado | `resumenCifrado.ts`, `pipeline.ts:797`, edición cifrada en `regenerar-resumen.ts`, trigger de 0019 protege `contenido_cifrado` (probado) | **OK** |
| H8 / H9 / H14 / H16 prompt | `resumen.ts:95, 101, 107, 128, 174`, `pipeline.ts:731`, `PROMPT_VERSION_RESUMEN = 'resumen-2026-10-16.2'` | **OK** |
| H10 rótulo completo | `resumen.ts:252, 260-268` (`avisoAnexoResumen`, usado en ficha y sesión) | **OK** (`AVISO_RESUMEN` de `panel.ts:18` quedó importado y sin uso) |
| H11 pausa online | — | **Pendiente** (baja; tampoco se agregó al protocolo) |
| H12 15 s de un tercero | — | **Pendiente** (baja) |
| H13 huecos por interrupción | `hablantes.ts:263, 337` + pruebas | **OK** |
| H15 ejemplos/documentos | fixtures EJ3 corregido, `20-clinico.md:239, 316` | **Parcial**: falta la nota en `10-etica-legal.md` §4.1 |
| H17 correos sin tipo de terapia | `pipeline.ts:152-157` (`etiquetaSesion` sin tipo) | **OK** |
| Integrar `origin/main` | merge `8fb1c0b`; hoy 0 commits detrás | **OK** |

### 82 — Código

| Hallazgo | Corrección | Estado |
|---|---|---|
| A1 resumen > 60 s | `astro.config.mjs` 300 s; `pipeline.ts:41-49, 794` (240 s por llamada, 285 s por corrida); `70-cron.md:30, 45, 98` pg_net 290 000 | **OK** (condición: Fluid activo) |
| A2 secretos en el bundle | igual que 80-M1 | **OK** |
| M1 carrera en Regenerar | `regenerar-resumen.ts` inserta la fila y luego transiciona; si no puede, la marca `error` | **OK** |
| M2 Reintentar sin reiniciar | `estados.ts` `limpiezaReintento` (`intentos: 0`, `proximo_intento_at: null`) | **OK** |
| M3 bot caído no se relanza | `limpiezaReintento` limpia `bot_machine_id`; `pipeline.ts:412` sin `.gt('intentos', 0)` | **OK** |
| M4 doble envío a AssemblyAI | `grabacion-finalizar.ts:164-187` (`tomar`/`soltar`, update condicional, borra el duplicado) | **OK** |
| M5 dos lógicas de Reintentar | `reintentar.ts:26` usa `ejecutarReintento` + `opsReintentoSupabase` | **OK** |
| B1 enlace `?tab=ia` | `AlertasTranscriptor.astro:44` → `?tab=notas#ia-<id>` | **OK** |
| B2 nombres de variables en docs | — | **Pendiente** (`50-arquitectura.md` aún nombra `B2_APP_KEY`, `TRANSCRIPTOR_CLAVE_V1`, `BOT_HMAC_SECRET`; `.env.example` sin variables del transcriptor) |
| B3 cron de salud 500 sin migraciones | `salud.ts` guarda con try; humo: **200** | **OK** |
| B4 menú visible antes de migrar | aceptado | **OK (aceptado)** |
| B5 CSP `/admin/grabar` | igual que 80-B1 | **OK** |

### Conflictos resueltos en la ficha y en la sesión

- `src/pages/admin/pacientes/[id]/sesion/[gid].astro`: el control de acceso (`accesoClinicoCookies`, línea 30)
  corre **antes de cualquier consulta**; sin passkey no se lee ni descifra nada (401 + botón a Seguridad).
  `auditarObligatorio('ver_transcripcion')` (91-93) va antes de `leerTranscripcion` (100); `ver_resumen`
  (122) va antes de `conContenidoClaro` (124); si la bitácora falla, el texto se anula. **Conviven bien.**
- `src/pages/admin/pacientes/[id].astro`: sin passkey solo se cuenta si hay grabaciones (96-102); con passkey
  se leen filas, pero el texto solo se descifra en la pestaña Notas y después de `auditarObligatorio`
  (136-160); fuera de Notas el contenido se vacía sin descifrar. **Conviven bien.**

## 3. Sitio en vivo al publicar esta rama

Humo con el handler real construido y un PostgREST simulado (tablas nuevas → `PGRST205`; columnas de 0019 →
`42703`). Sesión v1 (solo contraseña, como hoy).

| Ruta | Sin migraciones | Con 0014–0019, sin llaves del transcriptor |
|---|---|---|
| `GET /admin/login`, `POST /api/admin/login` (correcta / incorrecta) | 200; 302 `/admin` / 302 `?error=1` | igual |
| `/admin`, `/admin/agenda`, `/admin/pacientes`, ficha (info y notas), `/admin/configuracion`, `/admin/seguridad`, `/admin/transcriptor`, `/admin/grabar` | 200 | 200 |
| `/admin/pacientes/<id>/sesion/<gid>` (v1) | 401 con aviso de passkey (esperado) | igual |
| `/api/cron/transcriptor-salud` | 200 (la alerta se descarta sin tabla) | 200 |
| `/api/cron/transcriptor` | 207 (no hay job de pg_cron que lo llame hasta activarlo) | 200 |
| `/api/transcriptor/webhook-assemblyai` | 503 `no_configurado` | igual |
| **`POST /api/admin/consent` acción `revoke`** | **500 "No se pudo leer el consentimiento"** (N1) | 200 |

Por lectura de código (no ejecutable sin credenciales): pagos Flow, boletas SII/APIGateway, Google Calendar,
Instagram, Google Reviews y webhook de Resend solo cambiaron `import.meta.env.X` → `secreto('X')`
(process.env en runtime): mismos nombres, misma lógica; tsc sin errores nuevos. Correos de confirmación:
`avisoV2ParaCorreo` revisa primero `transcriptor_activo` (apagado → `null`) y nunca lanza; el correo sale
igual. Con las migraciones aplicadas y el transcriptor apagado, el chequeo diario no corre `config` ni
proveedores (no avisa por llaves faltantes).

## 4. Migraciones 0014→0019

PGlite 0.2.17 con tablas base mínimas (patients, bookings, consents de 0004, settings de schema.sql,
session_notes) y roles anon/authenticated/service_role con privilegios por defecto como Supabase:
- 0014, 0015, 0016, 0017, 0018 y 0019 se aplican **en orden sin error**, y una **segunda pasada completa
  también** (idempotentes: `if not exists`, `on conflict do nothing`, `do $$ … duplicate_object`).
- Ajustes iniciales: todos apagados (`transcriptor_activo=false`, `passkey_obligatoria=false`, …); 2 filas en
  `instrucciones_ia` (no se duplican en la 2.ª pasada).
- Trigger de 0019: un resumen `listo` rechaza cambios en `contenido_cifrado`; `oculto_at` sí se puede poner.
- Bitácora: `UPDATE` en `transcriptor_auditoria` rechazado.
- Tras 0018/0019: 0 privilegios de anon/authenticated en las 16 tablas/vistas nuevas (incluida `consent_avisos`).
- Orden obligatorio: 0019 altera `grabaciones`, `resumenes_ia` y `transcripciones` → requiere 0014.

## 5. Hallazgos nuevos

**N1 (media — bloquea publicar SIN migrar) — El retiro de consentimiento existente se rompe sin 0019.**
`src/pages/api/admin/consent.ts:42-45`: la acción `revoke` (ya en vivo) ahora pide
`recording_revoked_at` en el `select`; sin 0019 PostgREST responde 42703 y el endpoint devuelve 500. Vale no
podría registrar un retiro de consentimiento hasta migrar. Verificado con el humo (§3).
Corrección: aplicar 0014→0019 antes del deploy (recomendado), o en `revoke` pedir solo
`id, patient_id, signed_at, revoked_at` y leer `recording_revoked_at` solo en `revoke_recording`.

**N2 (media, ética) — En pareja, el aviso v2 queda registrado como mostrado a quien no lo recibió.**
`src/lib/transcriptor/avisoV2.ts:62-76` + `registrarAvisoMostrado` (83-93): busca la ficha por el correo de
la reserva y registra en `consent_avisos` **todas** las firmas v2 pendientes de esa ficha (las dos personas
de la pareja), aunque el correo llegó solo a una dirección. La constancia diría que la otra persona fue
avisada, y nunca recibiría el aviso. Corrección: registrar (y considerar pendiente) solo la firma cuyo
`signer_email` coincide con el destinatario; para la otra, dejarla pendiente o avisar a Vale.

**N3 (media, seguridad) — La supresión irreversible no exige passkey.**
`src/pages/api/admin/transcriptor/suprimir.ts:18` usa solo `guardiaPanel`, sin `exigirAccesoClinico`.
Mientras el transcriptor esté encendido el middleware ya exige passkey (obligatoria), pero si después se
apaga y se quita "Passkey obligatoria", una sesión de solo contraseña puede borrar transcripciones de R2 y
todas sus versiones en B2 (ficha clínica, 15 años). Corrección: agregar
`?? (await exigirAccesoClinico(ctx, 'borrar_transcripcion'))` como en `preguntar.ts:61`.

**N4 (baja) — Constancia de aviso v2 con correos idempotentes.** `src/lib/email.ts:227-230`: si un primer
envío salió sin aviso y un reintento con la misma llave de idempotencia trae el aviso, Resend responde
`invalid_idempotent_request`, se cuenta como enviado y se registra el aviso aunque el correo entregado no lo
tenía. Corrección: registrar solo si `res.error` era null originalmente (no el convertido).

**N5 (baja) — Textos/comentarios desactualizados.** `src/pages/api/cron/transcriptor.ts:9` dice "maxDuration
de Vercel = 60 s"; `AVISO_RESUMEN` (`panel.ts:18`) importado en `[gid].astro:14` y sin uso; el botón "Grabar"
de la agenda y los ítems de menú se ven con el transcriptor apagado (aceptado en 82-B4).

## 6. Pendientes que no bloquean (bajas)

81-H11 (pausa online o protocolo), 81-H12 (recorte de los 15 s de un tercero), 81-H15 nota en
`10-etica-legal.md` §4.1, 80-B8 (RUT obligatorio en pareja; IndexedDB en claro), 82-B2 (nombres de variables
en `50-arquitectura.md` y `.env.example`).

## 7. Orden sugerido antes de publicar

1. Aplicar 0014→0019 en Supabase (o corregir N1). 2. Deploy de Preview: confirmar que no falla por
`maxDuration: 300` y hacer los `curl -I`. 3. N3 (1 línea). 4. N2 antes de encender el transcriptor (el aviso
solo sale con `transcriptor_activo = true`). 5. Resto cuando convenga.
