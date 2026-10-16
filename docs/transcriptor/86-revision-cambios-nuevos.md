# 86 — Revisión independiente de los cambios nuevos (16 oct noche)

Alcance: rama `transcriptor` desde `d746392` (correcciones de 83) hasta `86bec9b`: t-n-pareja (`58f083b`),
t-n-avisos, t-n-bot, t-n-ficha, decisión H (`b594c74`) y t-n-pulido. 100 archivos, +7451/−886.
Vara: 02-decisiones-16oct-noche (A–H, manda), 30-seguridad, 81, 83. Revisión solo lectura (no se tocó código).

## Veredicto

**Apto para seguir en la rama; NO publicar sin aplicar 0020 + 0021 (+ 0022) en el mismo paso del deploy.**
Sin bloqueos de seguridad. Dos hallazgos medios, ambos de orden de despliegue/migración (M1, M2).

## Verificaciones ejecutadas

| Qué | Resultado |
|---|---|
| `pnpm -s test` | 348/348 ok |
| `npx astro build` | ok |
| `node scripts/verificar-secretos-build.mjs` | ok: ninguna de las 33 llaves en `.vercel/output` |
| `tsc --noEmit` (TS 5.6.3) rama vs `origin/main` (4fb223b) | 9 = 9, mismos archivos (comprobantes, correoDominio, apigateway ×4, google/callback, bookings, flow/confirm) |
| `bot/`: `npm ci` + `tsc --noEmit` + `npm test` (copia limpia) | ok, 20/20 |
| Migraciones 0014→0022 en PGlite 0.2.17 (tablas base mínimas + roles con privilegios por defecto tipo Supabase), 2 pasadas | 18/18 ok, idempotentes |
| Trigger 0020 | listo no cambia cifrado; archivar sin B2 o sin vaciar texto → rechazado; archivado correcto → ok; después no se reescribe texto ni llave; `oculto_at` sí; DELETE rechazado |
| 0021 / 0022 | `persona` default 1, check 1–2; `consent_anexos` único (consent_id, tipo), service_role solo select+insert; `transcriptor_bot_sesion` id=1 y `VOS1.` obligatorios; `transcriptor_bot_modo = invitado`; 0 privilegios anon/authenticated |
| `destinoSeguro` (?volver=) con 17 entradas hostiles (`//`, `\`, `%2e%2e`, `@`, esquemas, `/ADMIN`, `/admin/login`) | todas rechazadas o normalizadas dentro de /admin |
| PDF de prueba (400 bloques, tildes, ñ, «», paréntesis, `\`, emoji) | se abre bien (render con sips), 25 páginas, 20 KB; emoji → `?`, ✓ → `v` |
| ZIP de prueba | `unzip -t` sin errores (deflate) |

## Verificado por punto (OK)

1. **Avisos (A)**: no queda "Marcar como resuelto" (ni botón, endpoint, ni función; pruebas lo exigen). Cada clave de
   aviso creada en pipeline/salud/avisosRobot tiene clase y acción (`accionesAlerta.ts:105-133`); cierre solo por
   `alertaSuperada` o chequeo OK, `resuelta_por='sistema'`. `/admin/transcriptor/accion` no ejecuta por GET: botón
   "Hacerlo ahora" → POST con `guardiaPanel` (Origin obligatorio + `X-Panel` + sesión estricta) y bitácora.
   Login `?volver=` validado en middleware, login.astro, api/login y passkey/acceso (sin redirección abierta).
2. **Ficha (B, C, F)**: archivo = R2 + copia B2 + lectura de vuelta de ambas antes de vaciar la fila (`archivo.ts:186-206`),
   con sobre ligado al `resumen_id`; si B2 falla el texto sigue en la base. Lectura R2→B2. "Para revisar hoy" arriba
   en cualquier pestaña. Exportación: `guardiaPanel` + passkey (`exigirAccesoClinico`), bitácora obligatoria ANTES de
   leer, todo en memoria, `no-store`, tope 4,4 MB con 413 y opción por año, `maxDuration` 300 s. Supresión eliminada
   (`supresion.ts`/`suprimir.ts` borrados; queda "excluir de la IA"). Resumen: 3 secciones fijas + notas opcionales,
   riesgo primero, neutro, con minuto y línea de "no es evaluación"; `estructuraFija` lo impone en código.
3. **Pareja (D, E)**: la reserva manda (session_type o `services_catalog.type`), falla cerrado si no se leen reservas;
   2 firmas = 2 RUT distintos; token `randomBytes(24)`; la página de la persona 2 no muestra ni precarga datos de la
   ficha, no copia su RUT/correo a la ficha; QR en servidor sin red; anexo = HTML exacto enviado + SHA-256, servido
   con CSP `sandbox`.
4. **Robot (G, H)**: `invitado` por defecto (código, migración y sin tabla); `cuenta` rechazado sin sesión
   (`panel.ts validarModoBot`, `ajustes.ts`), y aun en `cuenta` sin sesión vigente el bot entra como invitado. Errores
   del robot → aviso inmediato. Endpoint de aprovisionamiento dormido: 404 sin `BOT_APROVISIONAR_SECRET` (≥ 32).
5. **Sitio en vivo sin migraciones nuevas**: consentimiento público y su API usan `select('*')` (sirven sin 0021);
   persona 1 se crea sin columna `persona`; correos de confirmación no fallan (errores atrapados); robot sin 0022 = invitado.

## Hallazgos

**M1 (media — orden de deploy) Anexo del aviso v2 se pierde para siempre si se despliega antes de 0021.**
`src/lib/email.ts:113-116` → `avisoV2.ts registrarAvisoMostrado`: primero inserta `consent_avisos` (0019) y después
`consent_anexos` (0021); si el anexo falla solo hay `console.warn`. El aviso queda "mostrado" (no se repite) y la
copia fiel (decisión E) no existe. Lo mismo ante un fallo transitorio del segundo insert. Corrección: aplicar 0021
antes del deploy; idealmente guardar el anexo primero o no registrar el aviso si el anexo no se guardó.

**M2 (media — orden de deploy) Sin 0020 (con 0014–0019 aplicadas) los resúmenes desaparecen sin aviso.**
`src/pages/admin/pacientes/[id].astro:126` (error del select ignorado → ficha sin resúmenes ni "Para revisar hoy"),
`[id]/sesion/[gid].astro:82`, `api/admin/transcriptor/preguntar.ts:104`, `exportacion.ts:164` (→ 502) y
`resumen.ts:812` (sin contexto previo) piden `archivo_*`/`archivado_at`. Corrección: aplicar 0020 junto con el
deploy; mostrar "falta la migración 0020" en vez de una ficha vacía.

**B1 (baja) Callejón sin salida en fichas "pareja" sin reserva de pareja.** `consentimiento.ts:203` sigue exigiendo
2 firmas por nombre "X y Y" o 2 firmantes, pero el link de la persona 2 solo existe con reserva de pareja
(`api/admin/consent.ts:239`, `ConsentimientoParejaAnexos.astro:31-49`). D dice que manda la reserva: o se ofrece el
link cuando `fichaEsPareja` es true, o se quita la heurística del nombre.

**B2 (baja) Acciones `pareja_*` de `api/admin/consent.ts:222-256` sin `guardiaPanel` ni bitácora** (crean el
consentimiento de la persona 2 y mandan correo a una dirección libre). El middleware valida Origin solo si viene y la
cookie es SameSite=lax: riesgo bajo, pero no cumple el estándar de 30-seguridad para endpoints nuevos.

**B3 (baja) El correo de la pareja sí queda guardado** en `admin_logs` (`logger.ts:20` vía `email.ts:1094`), aunque la
UI dice que no se guarda. Ajustar el texto o enmascarar el destinatario en el log.

**B4 (baja) Correos de avisos de una sesión solo traen "Volver a revisar"** cuando el aviso nació con `accion='revisar'`
(p. ej. `bot:<id>` en `pipeline.ts:331`, `subida:` en `:497`): `alertas.ts:158` calcula sin sesión. La página de acción
sí ofrece la reparadora como "otra acción", pero A pide que el correo traiga el botón que repara.

**B5 (baja) Exportación** busca reservas con `eq('patient_email', …)` (`exportacion.ts:152`), sensible a mayúsculas;
`pareja.ts:42` usa `ilike`. Puede omitir reservas en el PDF legal.

**I1 (info) GET con efecto idempotente**: abrir la ficha crea el link pendiente de la persona 2
(`ConsentimientoParejaAnexos.astro:65`); `accion.astro:57` y `GET alertas.ts:61` cierran avisos ya superados. Aceptable.
**I2 (info)** `qr.ts:4` menciona `qr.test.ts`, que no existe (el QR no tiene prueba propia).
**I3 (info)** No se hizo revisión visual (desktop/375 px) de ficha, exportar, accion y transcriptor en esta pasada.

## Antes de publicar

1. Aplicar en Supabase 0014→0022 en orden (o, si 0014–0019 ya están, 0020, 0021, 0022) y desplegar en el mismo paso.
2. Corregir M1 si es posible (o confirmar que 0021 entra antes del primer correo con aviso v2).
3. Revisión visual de las 4 páginas tocadas (regla del proyecto).
