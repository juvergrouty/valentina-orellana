# Bot de Meet "Notas Ps. Valentina Orellana" (paquete P5)

Bot que entra **como invitado** al Google Meet de una sesión online, espera que Vale lo
admita, graba el audio de la reunión, registra quién habla y se va solo. Corre en una
**máquina efímera de Fly.io** (región `iad`) que se crea por sesión y se **autodestruye** al
terminar. Derivado de [Vexa](https://github.com/Vexa-ai/vexa) (Apache-2.0): ver `LICENSE` y
`NOTICE` (qué se copió y qué se cambió).

Diseño: `docs/transcriptor/50-arquitectura.md` §1.3 y §5, `30-seguridad.md` §5.

## Cómo funciona

1. El cron del sitio (`/api/cron/transcriptor`, paquete P6) llama a
   `sesionesOnlineProximas()` de `src/lib/transcriptor/bot.ts`: lee Google Calendar, cruza con
   `bookings`/`patients`, y por cada sesión online con consentimiento crea la grabación
   (`bot_lanzando`) y llama a `lanzarBot()`.
2. `lanzarBot()` genera un **token de un uso** (32 bytes), guarda **solo su HMAC**
   (`BOT_TOKEN_SECRET`) y su vencimiento (fin de la sesión + 2 h), y crea la máquina con la
   Machines API: `POST https://api.machines.dev/v1/apps/<FLY_APP_BOT>/machines` con
   `config.auto_destroy: true` ("If true, the Machine destroys itself once it's complete",
   docs.fly.io/machines/api/machines-resource), `restart.policy: "no"`, `shared-cpu 2x / 2 GB`.
3. En la máquina: Xvfb + Chromium (Playwright 1.64.1) con idioma fijo en inglés. Abre el
   enlace, escribe el nombre, apaga cámara y micrófono, "Ask to join" (clics con entrada X11
   real vía `xdotool`, porque Meet ignora los clics sintéticos). Avisa `lobby`.
4. Espera hasta **20 min**. Rechazado o sin admitir → `fin {no_admitido}` (panel: "no fue
   admitido"). Página de error / reCAPTCHA → `error` + `fin {error}`.
5. Admitido → `activo`. Mezcla todas las pistas de audio remotas en el navegador y graba
   `audio/webm;codecs=opus` 32 kbps, en **segmentos de 15 min con 3 s de solapamiento**. Cada
   segmento: `pide_url {seq}` → PUT directo a R2 (URL prefirmada de 15 min) →
   `segmento_subido {seq, bytes, offset_ms, duracion_ms}` (el sitio verifica el tamaño con HEAD).
   El audio vive solo en memoria; nunca toca disco; no se toman capturas de pantalla.
6. Línea de hablantes: lee el tile iluminado de Meet (clases conocidas) y registra
   `{t_ms, nombre, on}` relativo al inicio de la grabación, sin el propio bot.
7. Sale con lo primero que ocurra: Vale sale (20 s sin su tile) · quedan solo bots 60 s · hay
   más humanos de los esperados 15 s (individual 2, pareja 3: no graba a terceros sin
   consentimiento) · lo expulsan · `HORA_FIN + 30 min`. Sube lo pendiente, sale de la reunión,
   envía `fin {motivo, linea_hablantes}` y el proceso termina → la máquina se destruye.
   Además hay un tope duro interno (`HORA_FIN + 40 min`) y el vigilante del sitio
   (`matarBot`, `hora_fin_prevista + 45 min`). **La Machines API no tiene campo de duración
   máxima** (verificado en la referencia): por eso el tope está en el bot y en el vigilante.
8. `fin` en el sitio: revoca el token (vence ya), guarda la línea de hablantes, descarta
   segmentos pedidos y nunca confirmados, y deja la grabación en `subida` (o `sin_audio`). Desde
   ahí sigue el mismo camino que una presencial (AssemblyAI, cifrado, resumen).

### Modo 'cuenta' (robot con cuenta de Google propia — decisión G, 16 oct noche)

Detrás del ajuste `transcriptor_bot_modo` (`'invitado'` por defecto; migración 0022). Con
`'cuenta'` y una sesión vigente guardada: el sitio agrega el correo del robot como invitado del
evento de Calendar (sin avisar a nadie), la máquina recibe `BOT_MODO=cuenta` y
`BOT_CUENTA_EMAIL`, el bot pide la sesión (`pide_sesion`, solo en memoria), entra con la cuenta
("Join now": invitado del calendario, sin pedir permiso, con nombre y foto de la cuenta) y al
salir devuelve la sesión renovada (`sesion_actualizada`) antes de `fin`. Si Meet no reconoce la
sesión, avisa `sesion_invalida` y entra como invitado anónimo (Vale lo admite). Investigación,
riesgos y pasos para Vale: `docs/transcriptor/85-robot-meet.md`. Foto de perfil de la cuenta:
`perfil/foto-robot.png`.

Inicio de sesión UNA vez (`MODO=iniciar_sesion`, `src/iniciar-sesion.ts`): la misma imagen abre
un Chromium normal, sin automatización, visible por noVNC en `[::]:6080` (solo por `fly proxy`).
Vale inicia sesión con sus manos, y la máquina exporta las cookies de google.com, confirma la
cuenta y las sube al sitio (`X-VO-Aprovisionar`). Nunca toca contraseñas. Comandos exactos:
`docs/transcriptor/85-robot-meet.md` §7.2.4.

El bot **no tiene ninguna llave de proveedor** (ni R2, ni Supabase, ni AssemblyAI). Solo
conoce `/api/transcriptor/bot-evento` y su token, que únicamente permite avanzar SU grabación
y pedir URLs PUT de SU audio. Ningún endpoint del bot devuelve datos.

## Variables

En **Vercel** (Production, Sensitive; nombres de `src/env.d.ts`):

| Variable | Qué es |
|---|---|
| `FLY_API_TOKEN` | Deploy token **solo de la app del bot**, con vencimiento (ver paso 3). |
| `FLY_APP_BOT` | Nombre de la app, p. ej. `vo-bot-meet`. |
| `FLY_IMAGEN` | `registry.fly.io/vo-bot-meet:v1` (tag fijo; `latest` se rechaza). |
| `BOT_TOKEN_SECRET` | 32 bytes aleatorios (`openssl rand -base64 32`). Mínimo 32 caracteres. |
| `PUBLIC_SITE_URL` | Ya existe; arma `EVENTO_URL`. |

En **Supabase `settings`** (opcional): `transcriptor_bot_nombres_vale` = nombres con que
aparece Vale en Meet, separados por `|`. Por defecto `Valentina Orellana|Vínculos que sostienen`.
**Vale debe confirmar el nombre visible de su cuenta de Google** (si no calza, la regla "sale
cuando Vale sale" no se activa y el bot sale por "quedan solo bots" o por hora máxima).

En **Fly (app del bot)**: ninguna. Todo llega en la config de cada máquina.

## Despliegue (cuando existan las cuentas; lo hace Vale o Claude con ella)

Requisitos: `flyctl` instalado y sesión iniciada en la cuenta de Fly de Vale (con 2FA).

```bash
cd bot
# 1. Crear la app (una vez). Si el nombre está tomado, usar otro y cambiar fly.toml.
fly apps create vo-bot-meet

# 2. Construir y publicar la imagen (builder remoto de Fly; NO usar `fly deploy` a secas).
fly deploy --build-only --push --image-label v1
#    → registry.fly.io/vo-bot-meet:v1  (cada cambio del bot: v2, v3… y actualizar FLY_IMAGEN)

# 3. Token de alcance mínimo: deploy token de ESTA app, con vencimiento de 1 año.
fly tokens create deploy -a vo-bot-meet --name vercel-transcriptor --expiry 8760h
#    → pegarlo tal cual en Vercel como FLY_API_TOKEN (el sitio manda "Bearer <token>").
#    Anotar en el calendario renovarlo antes de que venza.
```

4. En Vercel: `FLY_API_TOKEN`, `FLY_APP_BOT`, `FLY_IMAGEN`, `BOT_TOKEN_SECRET`. Redeploy.
5. Prueba de humo con `transcriptor_bot_activo = 'false'` (el cron no lanza nada solo):
   reunión de prueba de Vale con 2 cuentas ficticias; lanzar el bot a mano (botón del panel,
   P7). Casos (50-arquitectura §7, plan de pruebas 4): admitido, no admitido 20 min, Vale sale,
   todos salen, expulsión, tercera persona entra, máquina destruida a mitad
   (`fly machine destroy --force <id> -a vo-bot-meet`), pareja desde un dispositivo.
6. Verificar que no quedan máquinas: `fly machines list -a vo-bot-meet` (debe estar vacío
   después de cada sesión). El chequeo diario `fly` (P8) alerta si hay máquinas > 3 h.

Probar localmente (sin cuentas):

```bash
cd bot && npm install && npm test        # pruebas unitarias (config, vigía, línea, subida, sitio)
npx tsc -p tsconfig.json --noEmit        # tipos
docker build -t vo-bot-meet .            # si hay Docker
```

## Respaldo semanal de Supabase (`infra/respaldo-supabase/`)

El plan Free de Supabase no tiene respaldos. Una **máquina programada de Fly** en una app
**separada** (`vo-respaldo-supabase`, la única con secretos) corre `respaldo.sh` una vez por
semana: `pg_dump` del esquema `public` → verificación (`pg_restore --list`, tablas clave) →
cifrado con **age** a la llave **pública** de Vale (la máquina no puede descifrar) → subida a B2
con SigV4 → verificación de tamaño → `respaldos/ultimo.txt` (fecha, llave, sha256) para el
chequeo diario `respaldo_supabase` (P8).

Cómo se dispara: `fly machine run --schedule weekly` ("starts the Machine on a fuzzy hourly,
daily, weekly, or monthly cycle"; la primera ejecución es inmediata; docs.fly.io/machines/flyctl/fly-machine-run).
La hora exacta no está garantizada; el chequeo diario alerta si el último respaldo tiene > 8 días.

Pasos (una vez):

```bash
# a) En el Mac de Vale (NO en la nube): par de llaves age. La privada se guarda offline
#    (llavero + copia impresa/USB). Sin ella los respaldos no se pueden abrir.
brew install age && age-keygen -o ~/vo-respaldo-llave.txt    # muestra "Public key: age1…"

# b) Backblaze: bucket privado (p. ej. vo-respaldo, SSE-B2) y una llave de aplicación SOLO
#    para ese bucket con prefijo "respaldos/" y capacidades writeFiles + readFiles (sin
#    listFiles/deleteFiles). Regla de ciclo de vida en el prefijo respaldos/:
#    daysFromUploadingToHiding = 56, daysFromHidingToDeleting = 1 (rotación de 8 semanas).

# c) App y secretos del respaldo
cd infra/respaldo-supabase
fly apps create vo-respaldo-supabase
fly secrets set -a vo-respaldo-supabase \
  DATABASE_URL='<Supabase → Connect → Session pooler, puerto 5432>' \
  B2_ENDPOINT='https://s3.<region>.backblazeb2.com' B2_REGION='<region>' B2_BUCKET='vo-respaldo' \
  B2_KEY_ID='…' B2_APPLICATION_KEY='…' RESPALDO_AGE_RECIPIENT='age1…'
fly deploy --build-only --push --image-label v1

# d) Máquina programada semanal (corre una vez al crearla = primera prueba)
fly machine run registry.fly.io/vo-respaldo-supabase:v1 -a vo-respaldo-supabase \
  --region iad --schedule weekly --restart no --vm-memory 512 --name respaldo-semanal
fly logs -a vo-respaldo-supabase      # debe terminar con "respaldo: listo (...)"
```

Restaurar (prueba trimestral recomendada, en un proyecto Supabase de prueba):

```bash
age -d -i ~/vo-respaldo-llave.txt supabase-<fecha>.dump.age > db.dump
pg_restore --clean --if-exists --no-owner --no-privileges -d '<DATABASE_URL destino>' db.dump
```

Por qué Session pooler: la conexión directa de Supabase es solo IPv6; el pooler en modo
sesión acepta `pg_dump` por IPv4. `pg_dump` 17 sirve para servidores 15 y 17.

## Riesgos (no verificables en documentación)

1. **Google puede bloquear invitados anónimos automatizados** ("You can't join this video
   call", reCAPTCHA) sobre todo desde IPs de centros de datos como las de Fly. El bot no
   resuelve desafíos: avisa `error` y la grabación queda en error (con "Reintentar"). Si pasa
   seguido, las salidas son: entrar con una cuenta de Google dedicada al bot (modo 'cuenta', ver
   arriba y 85-robot-meet.md) o usar la grabación presencial.
2. **Google cambia el DOM de Meet** sin aviso: selectores, clases "hablando" (ofuscadas) y
   tiles. Todo está aislado en `src/meet/selectores.ts`. Síntomas: no aparece el campo de
   nombre / "Ask to join" (error al entrar), línea de hablantes vacía, o el bot sale enseguida
   por "solo" (si no puede leer participantes avisa `error` "no pudo leer los participantes").
   Revisar contra los cambios de Vexa upstream.
3. **Detección por tiles visibles**: si Meet no muestra el tile de alguien (p. ej. con
   presentación en pantalla y muchos participantes), puede contarlo como ausente. Con 2–3
   personas no debería pasar. Pareja conectada desde un solo dispositivo = un solo nombre.
4. **Nombre visible de Vale**: si no está en `transcriptor_bot_nombres_vale`, la regla "Vale
   salió" no funciona (ver Variables).
5. **Expulsión vs. fin de la llamada**: si Vale termina la llamada para todos, el bot lo toma
   como "Vale salió" (se conserva lo grabado).
6. **Costo**: máquina shared-cpu-2x 2 GB ≈ US$0,0000052/s mientras viva. El tope interno y el
   vigilante del sitio evitan máquinas huérfanas.
7. **IP compartida**: el bloqueo de 15 min tras 10 tokens inválidos es por IP; las máquinas de
   Fly pueden compartir IP de salida con otros clientes de Fly (caso raro).

8. **Sandbox de Chromium** (revisión de seguridad 16 oct, B6). El bot lanza Chromium CON su
   sandbox de espacios de nombres (`chromiumSandbox: true`, sin `--no-sandbox`) como `pwuser`,
   el usuario sin privilegios de la imagen de Playwright. No se pudo probar en Fly desde aquí
   (no hay Docker local ni cuenta): depende de que el kernel de la máquina permita espacios de
   nombres sin privilegios. Si no arranca, el bot relanza **sin sandbox** para no perder la sesión
   y deja en el log de Fly `Chromium sin sandbox: el sandbox no arrancó (…)`. En la primera
   prueba real revisar `fly logs`: si sale `Chromium con sandbox`, quedó bien. Si sale "sin
   sandbox", las opciones son aceptar el riesgo (bajo: la página es de Google, el token sirve
   solo para subir audio de esa sesión hasta su vencimiento) o investigar el kernel de Fly.
   `CHROMIUM_SANDBOX=0` fuerza el modo sin sandbox. Las banderas de aislamiento de sitios de
   Vexa (`IsolateOrigins`, `site-per-process`) se mantienen: no se probó Meet sin ellas.
9. **Cadena de suministro**: imagen base fijada por digest y dependencias con `npm ci` desde
   `package-lock.json` (ver comentario del Dockerfile para actualizar ambos juntos).

## Pendientes

- **Vale**: crear la app de Fly y el token (pasos de arriba), confirmar su nombre visible en
  Meet, generar la llave age y guardarla offline, bucket y llave B2 del respaldo.
- **P1**: `src/lib/transcriptor/almacenamiento.ts` debe exportar `almacenamiento` (objeto con
  `urlSubida` y `head` del contrato `Almacenamiento`; `urlSubida` firma un PUT en el bucket de
  audio). El endpoint lo carga solo si existe; mientras tanto `pide_url` responde 503.
- **P6**: insertar la grabación en `bot_lanzando` (con `meet_url`, `hora_fin_prevista`, `tipo`)
  antes de `lanzarBot()`; `lanzarBot` ya guarda `bot_machine_id`.
- **P8**: chequeo `respaldo_supabase` leyendo `respaldos/ultimo.txt` en B2.
