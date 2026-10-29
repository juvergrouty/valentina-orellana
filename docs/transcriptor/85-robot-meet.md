# 85 — Robot de Meet "Notas Ps. Valentina Orellana": cómo entra como participante amigable

Fecha: 16 oct 2026. Decisión G de `02-decisiones-16oct-noche.md`. Paquete P-bot (rama `t-n-bot`).

## 1. Resumen para Vale

- **Nombre**: el robot se llama exactamente **"Notas Ps. Valentina Orellana"** en todo el código, la configuración y los textos.
- **Recomendación: opción (a)**. El robot tiene **su propia cuenta de Gmail**. El sitio lo agrega solo como invitado de cada sesión online, sin mandarle correo a nadie. Así entra a Meet **sin pedir permiso**, **con su nombre y la foto de la marca**, y sin el aviso de "no inició sesión". Si algo falla, entra como hoy: como invitado anónimo, y tú lo admites. La sesión nunca se pierde por esto.
- **Costo**: $0 extra. La cuenta de Gmail es gratis y la máquina de Fly es la misma de siempre.
- **Lo que tienes que hacer tú**: crear la cuenta de Google del robot con el correo `notas@valentinaorellana.cl` (yo no puedo crear cuentas) siguiendo los pasos de la §7.1. Después, iniciar sesión UNA vez en esa cuenta dentro de la máquina del robot (§7.2.4, unos 5 minutos).
- **Actualización 29 oct 2026 (cuándo entra)**: medido con Fly y Calendar, el robot tardaba unos 70 s en entrar desde el clic de Vale (descarga 23 s, arranque 24 s y entrada a Meet 17 s). Vale decidió que entre solo, unos 2 minutos antes: el cron lo manda una vez a cada sesión online reservada en el sitio desde 4 min antes del inicio (`enVentanaAutomatica` en `pipeline.ts`). Sigue grabando solo con Vale en la llamada. Si otro robot sigue en una llamada, espera, porque la cuenta entra a una reunión a la vez. El clic de Vale funciona igual que antes.
- **Actualización 17 oct 2026**: el modo 'invitado' NO sirve desde las IPs de Fly. En la primera prueba real Google le mostró al robot un reCAPTCHA ("bloqueo de invitado automatizado", en `transcriptor_auditoria`). La solución es este modo 'cuenta'. El módulo que faltaba (§6.3) ya está construido (rama `t-bot-sesion`).
- Mientras tanto todo sigue en **modo 'invitado'**, el modo por defecto. Nada cambia hasta que la cuenta exista y pongamos el ajuste en 'cuenta'.

## 2. Qué dice Google (verificado en fuentes oficiales)

| Hecho | Fuente |
|---|---|
| Las cuentas personales tienen los controles de acceso de Meet. Por defecto toda reunión nueva queda en **TRUSTED**, y "Anyone who is invited to a meeting via a Google Calendar invite will be considered as 'trusted'" (entra sin tocar la puerta). | Google Workspace Updates, "Simplified access controls for Google Meet", jun 2023: <https://workspaceupdates.googleblog.com/2023/06/simplified-access-controls-for-google-meet.html> ("Available to all Google Workspace customers and users with personal Google Accounts") |
| Definiciones: *Trusted*: entran sin tocar los invitados externos por Calendar. *Restricted*: entran sin tocar los "Guests invited via a Calendar link". *Open*: cualquiera con el enlace. | Ayuda de Meet, "Manage meeting access settings": <https://support.google.com/a/users/answer/12172260> |
| En reuniones de cuentas personales, "Users who haven't signed in to a Google Account must request to join". **Un invitado anónimo SIEMPRE tiene que pedir permiso**, sin importar el ajuste. | Ayuda de Meet, "Join a meeting": <https://support.google.com/meet/answer/9303069> |
| `events.patch`: "Array fields, if specified, overwrite the existing arrays". Hay que mandar la lista completa de invitados. `sendUpdates=none`: "No notifications are sent." | Calendar API v3, events.patch: <https://developers.google.com/workspace/calendar/api/v3/reference/events/patch> |
| Google bloquea el inicio de sesión desde navegadores con automatización ("This browser or app may not be secure"). | Google Developers Blog, ago 2020: <https://developers.googleblog.com/2020/08/guidance-for-our-effort-to-block-less-secure-browser-and-apps.html> |
| Términos de Google: prohíben el "abuse" y "using automated means to access content from any of our services in violation of the machine-readable instructions" (robots.txt). También dicen "Google may suspend or terminate your access…". | <https://policies.google.com/terms> |
| Google Meet Media API (acceso oficial al audio): "Developer Preview… no longer accepting new signups". | <https://developers.google.com/workspace/meet/media-api/guides/overview> |
| Desde fines de marzo de 2026, Meet separa a quienes piden entrar en dos filas. Los bots van a "With potential risks" y por defecto quedan **rechazados**: el anfitrión tiene que admitirlos a mano (⋮ → Admit). | Secundarias: Neowin <https://www.neowin.net/news/google-meet-gets-a-new-update-to-stop-bots-from-joining-meetings/>, UC Today <https://www.uctoday.com/security-compliance-risk/google-meet-launches-update-to-better-screen-suspicious-bots/>, Fireflies <https://guide.fireflies.ai/articles/9554534786-how-fireflies-joins-and-records-your-meetings-faqs>, Avoma <https://help.avoma.com/admitting-avomas-notetaker-in-google-meet>. No encontré el anuncio oficial. |
| Device Bound Session Credentials (las cookies de Google quedan atadas al hardware) ya es GA en Chrome para Windows (may 2026). En macOS está anunciado, sin fecha confirmada. | Workspace Updates may 2026: <https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html>; The Hacker News abr 2026: <https://thehackernews.com/2026/04/google-rolls-out-dbsc-in-chrome-146-to.html> |

## 3. Cómo lo resuelven otros

| Servicio | Cómo entra | Fuente |
|---|---|---|
| **Recall.ai** | Por defecto entra anónimo. Eso produce el aviso "may not be who they claim", no permite foto y lo bloquean en reuniones solo para usuarios con sesión. Con un **bot con sesión iniciada** cuyo correo está en el evento de Calendar, "will be able to skip the waiting room". Exige un **Google Workspace dedicado y pagado** con SSO SAML. La cuenta da el nombre y la foto, y `bot_name` se ignora. El inicio de sesión con usuario y contraseña está *deprecated*. | <https://docs.recall.ai/docs/google-meet-login-getting-started>, <https://docs.recall.ai/docs/troubleshooting-google-meet-waiting-room>, <https://docs.recall.ai/v1.10/docs/bot-login-credentials> |
| **Vexa** (de donde viene nuestro bot) | "Authenticated mode": una persona inicia sesión a mano una vez (`make login`, navegador visible o por VNC en `:6080`). Se guarda un subconjunto de unos 200 KB (cookies, localStorage). Cada bot lo restaura en un perfil efímero y **lo vuelve a escribir al terminar**, porque Google rota cookies. **Un bot por sesión a la vez**, porque la misma sesión en varias IP es "a textbook account-risk signal". Recomienda una IP de salida estable y reuniones de "keep-warm". Recomienda una cuenta dedicada, "never a personal one". | <https://docs.vexa.ai/authenticated-bots> |
| **Attendee** (open source) | Igual que Recall: Workspace + SAML SSO y asignación round-robin de varias cuentas por límites de concurrencia. | <https://www.mintlify.com/attendee-labs/attendee/guides/signed-in-bots> |
| **MeetingBaaS** | No encontré documentación pública sobre bots con sesión en Meet. | (búsqueda sin resultados) |
| **Fireflies** | "Fred" (fred@fireflies.ai) entra como **invitado**. Hay que admitirlo y desde 2026 aparece en "With potential risks". | <https://guide.fireflies.ai/articles/9554534786-how-fireflies-joins-and-records-your-meetings-faqs> |
| **Read.ai** | Si la reunión no es "Open", alguien del Workspace del creador tiene que admitirlo. | <https://support.read.ai/hc/en-us/articles/28164245127059-Why-is-Read-not-joining-all-of-my-Meet-meetings> |
| **Otter, tl;dv** | No encontré su documentación específica. Otros proveedores con la misma mecánica (Fyxer, Metaview, Claap) describen sala de espera + admisión manual + fila de "potential risks". | <https://support.fyxer.com/article/when-notetaker-joins-a-meeting-rules-and-expectations>, <https://help.claap.io/en/articles/14232832-admitting-the-bot-in-google-meet> |

Conclusión: los que entran "amigables" lo hacen **con sesión iniciada en una cuenta invitada al evento**. Los que entran como invitados (Fireflies, Read, Otter) tienen que ser admitidos y hoy caen en la fila de riesgo.

## 4. Opciones evaluadas (Vale usa Gmail personal, no Workspace)

| | (a) Cuenta Gmail propia del robot, invitada por Calendar | (b) Seguir como invitado anónimo | (c1) Google Workspace (notas@valentinaorellana.cl) | (c2) Recall.ai u otro servicio con bots con sesión | (c3) Meet Media API | (c4) Usar la cuenta de Vale |
|---|---|---|---|---|---|---|
| **Qué ve Vale** | "Notas Ps. Valentina Orellana" con la foto de la marca entra solo al empezar. En su Calendar, el correo del robot aparece como invitado. | Tiene que admitirlo cada vez, desde la sección "With potential risks" (⋮ → Admit), porque por defecto queda rechazado. | Igual que (a). | Igual que (a). | Diálogo de consentimiento de Google. | Ella misma duplicada. |
| **Qué ve el paciente** | Un participante con nombre y foto, sin aviso de "no inició sesión". En eventos creados por el sitio **no ve la lista de invitados** (`guestsCanSeeOtherGuests=false`). | Un invitado sin foto, con aviso de anónimo. | Igual que (a). | Igual que (a). | Aviso de Google. | — |
| **Entra sin pedir permiso** | **Sí**, si Vale es la organizadora del evento y el acceso es Trusted (por defecto) o Open. Si no, pide unirse y Vale lo admite. | **No, nunca** (anónimo = siempre pide). | Sí (mismo mecanismo que a). | Sí. | n/a | n/a |
| **Riesgos** | Google puede pedir verificación o vencer la sesión: el robot entra como invitado y Vale recibe aviso. Posible suspensión de la cuenta del robot por uso automatizado (zona gris de los Términos; solo se pierde la cuenta del robot, no la de Vale). Las cookies podrían quedar atadas al hardware (DBSC) en el futuro. | reCAPTCHA o bloqueo desde IPs de centros de datos. La fila de "potential risks" rechaza por defecto: si Vale no lo admite a mano, no se graba. | Los mismos de (a). Con SAML se evita el vencimiento de cookies, pero hay que montar un proveedor de identidad. | Otro encargado más que procesa audio clínico: hay que cambiar el consentimiento y la política. Pago por hora. Exige Workspace. | Cerrada a nuevas inscripciones. | Las cookies de TODA su cuenta (correo, Drive, Calendar) quedarían en una máquina en la nube. |
| **Costo** | $0 | $0 | ~US$7–8,40/usuario/mes (Business Starter, precio global; verificar en CLP) | Por hora + Workspace | — | $0 |
| **Mantenimiento** | Volver a iniciar sesión cuando venza (el sistema avisa). No se sabe cada cuánto: depende de Google. | Ninguno (salvo cambios de Meet). | Administrar Workspace + SAML. | Contrato y DPA. | — | — |
| **Veredicto** | **Recomendada** | Respaldo automático | Solo si algún día la consulta pasa a Workspace | Descartada | Descartada | **Descartada** |

Sobre "que Meet no lo marque como externo": en una reunión de cuenta personal no hay "organización", así que no existe la etiqueta "externo" de Workspace. Lo que molesta hoy es (1) el aviso de usuario sin sesión y (2) la fila "With potential risks". Con (a) desaparece (1). Además el robot no toca la puerta, porque está invitado y la reunión es Trusted, así que (2) no aplica. **Por verificar en la primera prueba real**: Recall advierte que, si Google igual muestra su aviso de "potential risk", tener sesión iniciada no lo quita.

## 5. Qué quedó implementado (rama t-n-bot)

Todo queda detrás del ajuste **`transcriptor_bot_modo`** (`'invitado'` por defecto, lo siembra la migración 0022).

- **Nombre**: `BOT_NOMBRE = 'Notas Ps. Valentina Orellana'` (`src/lib/transcriptor/tipos.ts`), `NOMBRE_ROBOT` en `bot/src/config.ts`, panel y documentos.
- **Migración `0022_transcriptor_bot_cuenta.sql`** (sin aplicar): tabla `transcriptor_bot_sesion` de una sola fila con la sesión **cifrada** (AES-256-GCM, formato `VOS1.`, llave derivada con HKDF de `BOT_TOKEN_SECRET`, AAD con el correo), el estado (`vigente`/`vencida`) y un candado (`en_uso_por`, `en_uso_hasta`, `version`). Tiene RLS sin políticas y solo service_role puede usarla.
- **`src/lib/transcriptor/botCuenta.ts`** (nuevo): filtro de la sesión (solo cookies y almacenamiento de `google.com`, y exige `SID`/`__Secure-1PSID`/`__Secure-3PSID`), cifrado, candado (un bot a la vez; vence a la hora de fin + 45 min), renovación, "vencida" y recepción de la **sesión inicial** (`procesarSesionInicial`, Bearer `BOT_APROVISIONAR_SECRET`).
- **`src/lib/googleCalendar.ts`**: una función nueva y aislada, `agregarInvitadoSinAviso`. Lee el evento, suma el correo a la lista completa y hace PATCH con `sendUpdates=none`. Solo actúa si Vale es la organizadora. No toca nada más.
- **`src/lib/transcriptor/bot.ts`**: `lanzarBot` → `prepararCuenta`. Si el modo es 'cuenta' y hay una sesión vigente, invita al robot al evento (`google_event_id`) y lanza la máquina con `BOT_MODO=cuenta` y `BOT_CUENTA_EMAIL`. **La sesión NO viaja en la config de la máquina.** Sin sesión, la lanza como invitado y deja un aviso en la bitácora (`robot_sin_sesion`). Si la invitación falla, deja el aviso `robot_no_invitado` y el bot pide unirse. Eventos nuevos (`EventoBotCuenta`): `pide_sesion` (solo en `bot_lanzando`), `sesion_actualizada` y `sesion_invalida`. `fin` suelta el candado. La bitácora nunca guarda cookies.
- **`/api/transcriptor/bot-evento`**: además, con la cabecera `X-VO-Aprovisionar: 1`, recibe la sesión inicial.
- **Bot** (`bot/`):
  - `config.ts`: lee `BOT_MODO` y `BOT_CUENTA_EMAIL`.
  - `sitio.ts`: `pedirSesion()` solo acepta la sesión de la cuenta esperada.
  - `sesion.ts`: validación y filtro.
  - `meet/entrar.ts`, `entrarConCuenta`: si aparece "Your name" o lo redirige a accounts.google.com, la sesión no sirvió. En ese caso avisa `sesion_invalida` y entra como invitado. Si no, apaga micrófono y cámara y pulsa "Join now" (o "Ask to join").
  - `index.ts`: la sesión vive solo en memoria y se devuelve renovada antes de `fin`.
- **Foto de perfil**: `bot/perfil/foto-robot.png`, 800×800 con los colores y la tipografía de la marca: verde `#576352`, dorado `#F5A623`, "VO" en Domine y "NOTAS".
- **Pruebas**: `src/lib/transcriptor/botCuenta.test.ts` (11), `bot.test.ts` (+5) y `bot/src/unidad.test.ts` (+4). Sin red.

## 6. Inicio de sesión UNA vez: diseño y pendiente

### 6.1 Por qué no hay contraseñas en ninguna parte
La contraseña la escribe Vale con sus manos en la pantalla de Google. El sistema guarda solo el **estado de sesión** (cookies), cifrado. No queda nada en el repo ni en variables de entorno.

### 6.2 Diseño recomendado (igual que Vexa)
1. Una máquina efímera de Fly con la **misma imagen, la misma región (iad) y el mismo Chromium** que el bot, en modo `MODO=iniciar_sesion`. Así Google ve siempre el mismo tipo de dispositivo y la misma zona. Si iniciara sesión en su Mac (Chile, Chrome con DBSC a futuro) y las cookies se usaran desde EE.UU., la sesión podría invalidarse.
2. Chromium se abre como **proceso normal, sin automatización**, porque Google bloquea el inicio de sesión en navegadores automatizados. Vale lo ve con **noVNC** a través de `fly proxy 6080:6080 -a vo-bot-meet`, un túnel privado de su cuenta de Fly. La máquina no tiene puertos públicos.
3. Cuando aparecen las cookies de sesión y el correo correcto, la máquina sube el estado al sitio (`X-VO-Aprovisionar`, Bearer `BOT_APROVISIONAR_SECRET`). **Esta parte ya está implementada en el sitio.** Después borra el perfil temporal y se destruye (`--rm`).
4. Vale borra `BOT_APROVISIONAR_SECRET` de Vercel. Sin esa variable, la ruta de aprovisionamiento responde 404.

### 6.3 Módulo `MODO=iniciar_sesion` (hecho, rama `t-bot-sesion`, 17 oct 2026)
- **`bot/entrypoint.sh`**: con `MODO=iniciar_sesion` levanta Xvfb, `x11vnc` (solo en `127.0.0.1:5900`, con una **contraseña VNC aleatoria de 8 caracteres** que se imprime **una sola vez** en `fly logs`) y `websockify` con noVNC en **`[::]:6080`** (IPv6, red privada 6PN). Después ejecuta `dist/iniciar-sesion.js`. Sin `MODO`, el arranque del bot es idéntico al de antes (Xvfb + PulseAudio + `dist/index.js`).
- **`bot/Dockerfile`**: suma los paquetes `x11vnc`, `novnc` y `websockify` de Ubuntu noble. No se usan en el modo normal.
- **`bot/src/iniciar-sesion.ts`**:
  1. Abre el Chromium de la imagen como **proceso normal**, sin Playwright, sin `--remote-debugging`, sin `--enable-automation` y sin `AutomationControlled`. Usa un perfil temporal en `/tmp` y abre accounts.google.com en inglés. Si el sandbox no arranca, se relanza sin sandbox.
  2. Cada 3 s revisa el archivo `Cookies` del perfil. Solo mira los nombres, en texto plano; los valores van cifrados y no se leen. Espera `__Secure-1PSID` y `__Secure-3PSID` de google.com, o que Vale cierre el navegador. El plazo es de **15 min** (`PLAZO_INICIO_MS`). Cuando aparecen, avisa en el log, espera 20 s y cierra Chromium de forma ordenada para que guarde las cookies.
  3. Abre el **mismo perfil** con Playwright (`launchPersistentContext`) solo para exportar el `storageState`. No abre ninguna página de Google. Filtra a google.com y exige **`SID`, `__Secure-1PSID` y `__Secure-3PSID`**. Confirma el correo con `accounts.google.com/ListAccounts` (con respaldo en Mi cuenta), pedido desde Node con las cookies del perfil. Si la cuenta no es `BOT_CUENTA_EMAIL`, **no sube nada**.
  4. Sube `{tipo:'sesion_inicial', correo, sesion}` a `EVENTO_URL` con `X-VO-Aprovisionar: 1` y `Authorization: Bearer <BOT_APROVISIONAR>`. Es lo que espera `procesarSesionInicial`, que la guarda cifrada. Imprime **`LISTO`**, borra el perfil y sale con 0. Con error sale con 1 y un mensaje claro.
  - Nunca pide, lee ni registra contraseñas. Nunca imprime cookies ni el secreto. Los procesos de apoyo (Xvfb, x11vnc y websockify) arrancan sin `BOT_APROVISIONAR` (`env -u`). El módulo lo borra de su entorno antes de abrir Chromium y Playwright, así que ningún proceso hijo lo recibe.
- Lógica pura y pruebas sin red: `bot/src/aprovisionar.ts` y `bot/src/aprovisionar.test.ts`.
- **Por verificar en la primera ejecución real** (no hay Docker en el Mac de desarrollo, así que la imagen no se construyó localmente):
  - que la imagen construye;
  - que `websockify` escucha en IPv6;
  - que Google acepta el inicio de sesión en el Chromium de Playwright (es "Chrome for Testing" y muestra ese aviso arriba).

## 7. Pasos exactos para Vale

### 7.1 Crear la cuenta del robot (Vale; yo no puedo crear cuentas)
La cuenta será una **cuenta de Google con un correo que ya existe**: `notas@valentinaorellana.cl`. Es un alias de ImprovMX con catch-all hacia tu Gmail. **No es un Gmail nuevo.** El código de verificación de Google llegará a tu Gmail por el reenvío de ImprovMX (si no lo ves, revisa Spam).
1. En una **ventana privada** de Chrome entra a <https://accounts.google.com/signup> → "Para mi uso personal".
2. **Nombre**: `Notas Ps.` · **Apellido**: `Valentina Orellana`. Meet mostrará "Notas Ps. Valentina Orellana". Si Google no acepta el punto, usa `Notas Ps` y avísanos para ajustar el nombre en el código: tiene que ser idéntico.
3. **Fecha de nacimiento**: la tuya (la cuenta debe ser de un adulto; Meet rechaza cuentas de menores). **Género**: "Prefiero no decirlo".
4. **Correo**: cuando Google proponga crear una dirección de Gmail, elige **"Usar tu dirección de correo electrónico existente"** y escribe `notas@valentinaorellana.cl`. Ingresa el código que llegue a tu Gmail.
5. **Contraseña**: larga y única. Guárdala en tu gestor (Llavero de iCloud). **No la mandes por chat ni la pongas en el sitio.**
6. **Teléfono**: el tuyo, para verificar y recuperar. **Correo de recuperación**: `vinculosquesostienen@gmail.com`. Recall recomienda tener ambos para evitar fallas de inicio de sesión.
7. Acepta los términos. Después, en <https://myaccount.google.com>:
   - **Idioma**: English (United States). El robot lee la interfaz de Meet en inglés.
   - **Foto de perfil**: Información personal → Foto → sube `bot/perfil/foto-robot.png` (te la paso). Visible para "Anyone".
   - **Verificación en 2 pasos**: actívala con el aviso de Google en tu teléfono. Protege la contraseña. El robot no la necesita, porque usa la sesión ya iniciada.
8. Abre una vez <https://meet.google.com> con esa cuenta y acepta los avisos iniciales. Si quedan pendientes, el robot se puede trabar (Recall lo documenta). Luego **cierra sesión** en esa ventana.
9. En **tu** cuenta, deja el acceso de tus reuniones como viene: **Trusted** (en Meet: Controles del organizador → Acceso a la reunión). Con "Restricted" también funciona. No uses "Open".

### 7.2 Encender el modo cuenta (con Claude)
1. Aplicar `supabase/migrations/0022_transcriptor_bot_cuenta.sql` en el SQL Editor de Supabase.
2. En Vercel: crear `BOT_APROVISIONAR_SECRET` (Sensitive) con `openssl rand -base64 48`, y redeploy.
3. Publicar la imagen del bot con el modo de inicio de sesión: en `bot/`, `fly deploy --build-only --push --image-label v2`. Luego cambiar `FLY_IMAGEN` en Vercel a `registry.fly.io/vo-bot-meet:v2` y hacer redeploy.
4. Iniciar sesión una vez (unos 5 minutos). En una terminal:
   ```bash
   fly machine run registry.fly.io/vo-bot-meet:v2 -a vo-bot-meet -r iad --rm --restart no \
     --vm-cpus 2 --vm-memory 2048 -n robot-sesion \
     -e MODO=iniciar_sesion -e BOT_CUENTA_EMAIL=notas@valentinaorellana.cl \
     -e EVENTO_URL=https://www.valentinaorellana.cl/api/transcriptor/bot-evento \
     -e BOT_APROVISIONAR='<el mismo valor de BOT_APROVISIONAR_SECRET de Vercel>'
   fly logs -a vo-bot-meet          # en una 2.ª terminal: aquí sale la contraseña VNC y luego "LISTO"
   fly proxy 6080:6080 -a vo-bot-meet --select   # en una 3.ª terminal (elige la máquina robot-sesion)
   ```
   - Abre <http://localhost:6080/vnc.html> → "Connect".
   - Escribe la **contraseña VNC** que aparece una sola vez en `fly logs`, en la línea "Contraseña VNC de esta máquina: …". Es aleatoria y solo sirve para esa máquina.
   - En el Chromium que aparece, inicia sesión en `notas@valentinaorellana.cl`: contraseña y el aviso en tu teléfono.
   - Cuando el log diga "sesión de Google detectada", no hagas nada más. A los pocos segundos debe decir **"LISTO"** y la máquina se borra sola (`--rm`).
   - Plazo: 15 min. Si se pasa, sale con "ERROR" y no sube nada; se repite el paso.
   - Si dice que la sesión no es de `notas@valentinaorellana.cl`, entraste con otra cuenta: repite el paso.
   - Escribe el comando `fly machine run` con un **espacio al inicio**. Así zsh/bash con `HIST_IGNORE_SPACE`/`HISTCONTROL=ignorespace` no lo guardan en el historial. Igual, el paso 5 deja inservible ese valor.
   - `BOT_APROVISIONAR` queda en la config de esa máquina solo mientras existe. `--rm` la destruye al terminar y el paso 5 deja inservible el valor.
5. Borrar `BOT_APROVISIONAR_SECRET` de Vercel.
6. En Supabase `settings`: `transcriptor_bot_modo` = `cuenta`.
7. Prueba de humo: una reunión tuya de prueba creada por el sitio. El robot debe entrar solo, con nombre y foto. Revisa `fly logs`: debe decir "entró con la cuenta del robot (sin pedir permiso)".

### 7.3 Cuando la sesión venza
El robot entra como invitado (tú lo admites) y queda en la bitácora `robot_sesion_vencida`. Repite el paso 7.2.4 con un `BOT_APROVISIONAR_SECRET` nuevo.

## 8. Riesgos y mitigaciones

1. **Vencimiento o desafío de Google** (frecuencia desconocida). Mitigación: respaldo automático a invitado, aviso en la bitácora, devolución de la sesión renovada en cada salida limpia y un solo uso a la vez.
2. **Suspensión de la cuenta del robot** por uso automatizado (Términos: "abuse" / "automated means"; zona gris). Impacto: solo esa cuenta, y se vuelve a modo invitado. No toca la cuenta de Vale.
3. **IP de salida variable de Fly** (Vexa recomienda una estable). Si Google desafía seguido, se puede asignar una IP de egreso fija a la app (costo aparte; verificar en la documentación de Fly antes de proponerlo).
4. **Eventos que no organiza Vale** (p. ej. de Encuadrado): no se puede agregar al robot, así que pide unirse y Vale lo admite (`robot_no_invitado` en la bitácora).
5. **Paciente que ve la lista de invitados** en eventos ajenos al sitio: vería el correo del robot. Está cubierto por el consentimiento, que menciona herramientas de apoyo para las notas.
6. **Cambios del DOM de Meet**: "Join now" y "Switch account" están aislados en `bot/src/meet/selectores.ts`.

## 9. Lo que otros paquetes deben saber
- **Panel (`src/pages/admin/transcriptor.astro`)** — hecho en t-n-pulido: ajuste "Cómo entra el asistente a Meet" (invitado / con su cuenta; 'cuenta' solo si la cuenta ya tiene sesión guardada) y estado de la sesión (sin sesión / activa / vencida). El texto "Tú lo admites en Meet" solo aparece cuando es cierto.
- **Avisos** — hecho en t-n-pulido (`avisosRobot.ts`): `robot_sin_sesion` / `robot_sesion_vencida` → aviso `robot:sesion` al instante (Volver a revisar + §7.3; se cierra solo al subir una sesión nueva o pasar a modo invitado); `robot_no_invitado` → `robot-invitado:<id>`; evento `error` → `bot-error:<id>:<paso>`.
- **`BOT_APROVISIONAR_SECRET`** — hecho en t-n-pulido: en `secretos.ts` (se lee con `secreto()` en runtime) y en OBLIGATORIAS de `scripts/verificar-secretos-build.mjs`.
- **tipos.ts**: solo cambió el valor de `BOT_NOMBRE`. Los eventos nuevos están en `EventoBotCuenta` (bot.ts), no en el contrato.
