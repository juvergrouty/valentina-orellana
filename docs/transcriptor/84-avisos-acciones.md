# 84 — Avisos del transcriptor: qué acción repara cada uno

Decisión A (02-decisiones-16oct-noche.md). Código: `src/lib/transcriptor/accionesAlerta.ts`
(catálogo, cierre automático, ejecución), `alertas.ts` (avisos y correo), `salud.ts` (chequeos),
`src/components/admin/AlertasTranscriptor.astro` (aviso rojo), `src/pages/api/admin/transcriptor/alertas.ts`
(POST de las acciones) y `src/pages/admin/transcriptor/accion.astro` (página de los enlaces del correo).
Pruebas: `accionesAlerta.test.ts`.

## Reglas

- Ya **no existe "Marcar como resuelto"** (sin botón, endpoint ni función). Todo aviso cerrado tiene
  `resuelta_por = 'sistema'`.
- Un aviso se cierra solo cuando el problema está arreglado:
  - **Avisos de una sesión**: cuando la grabación pasa el paso que falló (función `alertaSuperada`).
    Se revisa al mostrar el panel, cuando el aviso consulta tras "Reintentar" (cada 15 s, hasta 10 min),
    al abrir la página de acción, con "Volver a revisar" y en el chequeo diario. "Reintentar" por sí
    solo **no** cierra nada.
  - **Avisos de un chequeo** (`salud:*`): cuando ese chequeo vuelve a salir bien. "Volver a revisar"
    lo re-ejecuta al instante (`ejecutarSalud(…, { solo: [chequeo] })`).
- Toda acción va por **POST** con la protección del panel (`guardiaPanel`: Origin propio, cabecera
  `X-Panel: 1`, sesión válida y no revocada; middleware estricto + passkey cuando es obligatoria) y
  queda en `transcriptor_auditoria` (`reintentar` o `alerta`, con `op`, `cerrada` y conteos, sin
  contenido clínico).
- "Volver a revisar" está siempre. Si no hay arreglo automático, el aviso trae el texto exacto de qué
  hacer (`instruccionDe`).

## Tabla

Paso al que tiene que llegar la sesión para que el aviso se cierre: `bot_lanzando → bot_en_lobby`,
`bot_en_lobby → grabando`, `creada/grabando/pausada/subiendo → subida`, `subida → transcribiendo`,
`transcribiendo → transcrita`, `transcrita/resumiendo → lista`. Una sesión terminada (lista, sin audio,
cancelada, no admitida) o borrada cierra sus avisos (salvo el de copia en B2, que mira la copia).

| Aviso (clave) | Lo genera | Acción que repara | Qué hace | Se cierra cuando |
|---|---|---|---|---|
| `bot:<id>` — no se pudo enviar el asistente (Fly falló) | pipeline `lanzar` | **Reintentar** (si la sesión no ha terminado) | Apaga la máquina anterior si quedó, vuelve a `bot_lanzando` con intentos en 0; el cron lo relanza en el próximo minuto | el bot llega a la sala de espera |
| `bot:<id>` — el asistente nunca llegó / la sesión ya terminó | pipeline `vigilar` | **Cerrar la sesión como no grabada** (o **Transcribir lo que alcanzó a grabarse** si subió audio) | `error → cancelada` sin audio; `error → subida` con audio (borra segmentos sin subir, revoca el token del bot, apaga la máquina) | la sesión avanza / termina |
| `bot-maquina:<id>` — no se pudo apagar la máquina | pipeline `vigilar` | **Apagar el asistente ahora** | `DELETE` de la máquina en Fly (Machines API, `force=true`) y revoca el token | Fly confirma (o la sesión ya salió de `bot_*`/`grabando`) |
| `bot-vigilante:<id>` — el asistente no salió solo (informativo) | pipeline `vigilar` | Volver a revisar | Re-lee la sesión | la transcripción queda guardada (o la sesión termina) |
| `bot:calendario` — no se pudo leer Google Calendar | pipeline `despacharBots` | Volver a revisar + instrucción (reconectar Google en Configuración) | Vuelve a pedir los eventos de la próxima hora | Calendar responde (también lo revisa el chequeo diario) |
| `bot-error:<id>:<paso>` — el robot informó un error (evento `error`), al instante | `bot.ts` (`avisosRobot.ts`) | Volver a revisar + instrucción; si la sesión cae en error: **Reintentar** o **Cerrar con lo grabado** | Lo de cada acción | la sesión pasa ese paso (llega a la sala, entra a grabar o el audio queda subido) |
| `robot:sesion` — el robot no tiene sesión de Google / se venció (modo cuenta), al instante | `bot.ts` (`avisosRobot.ts`) | Volver a revisar + instrucción (volver a iniciar sesión, 85-robot-meet §7.3) | Revisa que la sesión esté vigente o que el modo sea 'invitado' | se sube una sesión nueva, se pasa a modo invitado o "Volver a revisar" la ve vigente (también el chequeo diario) |
| `robot-invitado:<id>` — el robot no quedó como invitado del evento (informativo), al instante | `bot.ts` (`avisosRobot.ts`) | Volver a revisar (admitirlo en Meet) | Re-lee la sesión | el robot entra a grabar (o la sesión termina) |
| `subida:<id>` — no llegó audio | pipeline `reintentarEnvios` | **Cerrar la sesión como no grabada** | `error → cancelada` con nota | la sesión queda cerrada |
| `transcripcion:<id>` — no se pudo enviar / transcribir / guardar | pipeline `enviarSegmentos`, `errorDefinitivoAAI`, `procesarTranscripciones` | **Reintentar** | `error →` paso anterior (subida/transcribiendo) con intentos en 0; el cron reenvía a AssemblyAI | la transcripción queda guardada (`transcrita`) |
| `sin-voz:<id>` — transcripción vacía (informativo) | pipeline `guardar` | Volver a revisar | Re-lee la sesión | la sesión queda `lista` (con su nota "no se reconoció voz") |
| `resumen:<id>` — no se pudo preparar / generar el resumen | pipeline `resumirUna` | **Reintentar resumen** | `error → resumiendo`/`transcrita`, reabre el resumen en `error` (intentos 0); el cron lo pide a Claude | el resumen queda listo (`lista`) |
| `respaldo:<id>` — copia en B2 pendiente | pipeline `asegurarCopiaB2` | **Rehacer copia en B2** | Copia ahora a B2 las transcripciones cifradas de esa sesión sin copia y guarda `b2_key` | no queda ninguna sin copia (el paso `respaldos` del cron también lo cierra) |
| `config:resumen-modo` — el ajuste no dice "directo" | pipeline `resumir` | **Usar modo "directo"** | Guarda `transcriptor_resumen_modo = directo` (bitácora `cambiar_ajuste`) | el ajuste dice "directo" |
| `config:apagado-con-pendientes` | pipeline `correr` | Volver a revisar + instrucción (encender en Transcriptor) | Cuenta las grabaciones a mitad de proceso | el transcriptor está encendido o no quedan pendientes |
| `salud:config` — faltan variables | salud `config` | Volver a revisar + instrucción (agregarlas en Vercel y redeploy) | Re-ejecuta el chequeo `config` | no falta ninguna |
| `salud:r2` / `b2` / `assemblyai` / `anthropic` — proveedor no responde | salud `chequeoProveedor` | Volver a revisar + instrucción (renovar la llave nombrada) | Re-ejecuta la prueba de ese proveedor | el proveedor responde |
| `salud:atascadas:<id>:<paso>` — sesión detenida > 2 h (o en error sin aviso) | salud `atascadas` | **Reintentar** / **Reintentar resumen** según el paso; **Cerrar con lo grabado** si el bot ya no puede volver; grabación en el teléfono: instrucción (abrir Grabar con internet) | Igual que arriba (suelta la toma vencida o sale de `error`) | la sesión pasa ese paso |
| `salud:audio_borrado` — audio que debió borrarse | salud `audio_borrado` | **Borrar el audio ahora** | Borra de R2 el audio de sesiones ya transcritas con transcripción guardada (o canceladas/sin audio) y los archivos de audio de más de 26 h; luego re-ejecuta el chequeo | el chequeo sale bien |
| `salud:aai_borrado` — AssemblyAI guarda transcripts que debían borrarse | salud `aai_borrado` | **Borrar en AssemblyAI ahora** | `borrarTranscriptTrasGuardar` (solo si la transcripción cifrada ya está guardada) o borrado directo si la sesión está cancelada/sin audio; nunca borra uno sin guardar | el chequeo sale bien |
| `salud:aai_huerfanos` — transcripts sueltos en AssemblyAI | salud `aai_huerfanos` | **Borrar transcripciones sueltas en AssemblyAI** (pide confirmar) | Lista `GET /v2/transcript`, clasifica y borra los de > 2 h completados/con error, **incluidos los desconocidos** (decisión explícita de Vale al tocar) | el chequeo sale bien |
| `salud:copias_b2` — transcripciones sin copia en B2 | salud `copias_b2` | **Rehacer copia en B2** | Copia todas las pendientes y re-ejecuta el chequeo | el chequeo sale bien |
| `salud:respaldo_supabase` — respaldo semanal viejo o ausente | salud `respaldo_supabase` | **Lanzar respaldo ahora** + Volver a revisar | Fly Machines API: `GET /v1/apps/{app}/machines`, busca `respaldo-semanal` y `POST …/{id}/start`. Sin `FLY_API_TOKEN_RESPALDO` responde con la instrucción exacta (`fly machine list` / `fly machine start <id> -a vo-respaldo-supabase`) | "Volver a revisar" encuentra `respaldos/ultimo.txt` de < 8 días |
| `salud:gasto` — gasto ≥ 90 % o proyección sobre el presupuesto | salud `gasto` | Volver a revisar + instrucción (no hay arreglo automático) | Re-calcula el gasto | el gasto/proyección baja del presupuesto (mes siguiente o presupuesto mayor) |
| `salud:permisos_microfono` — cambió la regla de vercel.json | salud `permisos_microfono` | Volver a revisar + instrucción (restaurar la regla y desplegar) | Re-lee la regla | la regla vuelve a estar bien |
| `salud:<chequeo>:no_revisado` — el chequeo no alcanzó a correr | salud (timeout) | Volver a revisar | Corre ese chequeo ahora | el chequeo corre |
| `salud:cron` / `salud:registro` — el chequeo diario no corrió / no se guardó | cron `transcriptor-salud` / salud | Volver a revisar | Corre el chequeo diario completo | corre (y, para `registro`, se guarda) |
| `salud:reporte` — no se generó el reporte mensual | cron `transcriptor-salud` | Volver a revisar | `reporteDelMesAnteriorSiFalta()` | el reporte se genera |

## Correo de respaldo

Trae un botón por acción (la que repara primero y "Volver a revisar") con enlaces a
`/admin/transcriptor/accion?alerta=<id>&accion=<accion>`. El correo no lleva datos de la sesión.
La página exige sesión del panel (y passkey cuando es obligatoria; la lista de sesiones cerradas se
revisa fallando cerrado), muestra qué se va a hacer y un botón grande **"Hacerlo ahora"** que hace el
POST. Nunca ejecuta nada por GET. Si el aviso ya se resolvió (o su paso ya salió bien), lo dice.
Si la acción del enlace ya no corresponde, ofrece las que sirven ahora.

## Pendientes (fuera de este paquete)

- Vale: agregar en Vercel `FLY_API_TOKEN_RESPALDO` (token de la app `vo-respaldo-supabase`:
  `fly tokens create deploy -a vo-respaldo-supabase`) y, opcional, `FLY_APP_RESPALDO`, para que
  "Lanzar respaldo ahora" funcione desde el panel. Ya está en `secretos.ts` y en
  `scripts/verificar-secretos-build.mjs` (t-n-pulido).

Resuelto en t-n-pulido: el login vuelve a la página de acción después de entrar (`?volver=`, solo rutas
`/admin…`, `src/lib/passkey/regreso.ts`), y los errores del robot crean el aviso al instante (tabla de arriba).
