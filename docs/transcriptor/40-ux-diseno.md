# Transcriptor IA: diseño de experiencia (UX) y textos de interfaz

Fecha: 15 oct 2026 · Autor: diseño de producto y usabilidad · Base: `00-decisiones.md` (no se re-discute nada de ahí).
Mockup visual: `docs/transcriptor/mockup-grabador.html` (375 px, todos los estados uno debajo del otro).

> Principio rector: **en sesión Vale no mira el teléfono.** 1 toque para empezar, 1 gesto para terminar, y una señal que se lee de reojo a 1 metro: **punto rojo + cronómetro avanzando = está grabando**. Cualquier otra cosa (pausa, error, silencio) cambia la pantalla entera de color.

---

## 0. Lo que la web puede y no puede hacer en iPhone (con fuentes)

Esto define el diseño. Todo está verificado en fuentes; lo que es inferencia está marcado como tal.

| # | Hecho | Fuente | Consecuencia de diseño |
|---|---|---|---|
| 1 | `MediaRecorder` funciona por defecto en Safari iOS desde **14.5** (14.3 beta lo activó; antes estaba desactivado por defecto). | [caniuse: MediaRecorder](https://caniuse.com/mediarecorder) · [WebKit blog: MediaRecorder API](https://webkit.org/blog/11353/mediarecorder-api/) | Sin problema: cualquier iPhone actual lo tiene. |
| 2 | Safari graba en **MP4 (AAC)**, no en WebM/Opus. WebKit recomienda detectar con `MediaRecorder.isTypeSupported()`. | [WebKit blog: MediaRecorder API](https://webkit.org/blog/11353/mediarecorder-api/) · [MDN: MediaRecorder.mimeType](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/mimeType) | El grabador pide `audio/mp4` en iPhone y `audio/webm;codecs=opus` en Chrome Mac. AssemblyAI acepta ambos. Bajar `audioBitsPerSecond` (≈64 kbps) para que 50 min pesen ~24 MB. |
| 3 | **Screen Wake Lock** existe en Safari iOS desde **16.4**. | [caniuse: Screen Wake Lock](https://caniuse.com/wake-lock) · [WebKit: Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/) | Se pide al tocar "Grabar". Si el iPhone es < 16.4, aviso de que hay que subir "Bloqueo automático" a "Nunca" en Ajustes. |
| 4 | El Wake Lock **se suelta solo** cuando la página deja de estar visible, y el sistema puede negarlo o soltarlo con batería baja / modo de bajo consumo. Hay que volver a pedirlo en `visibilitychange`. | [MDN: Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) | Escuchar el evento `release`. Si se suelta grabando → aviso. Checklist: "Modo de bajo consumo apagado". |
| 5 | Wake Lock **no funcionaba en apps agregadas a la pantalla de inicio** (WebKit bug 254545, marcado resuelto; una fuente dice que quedó arreglado en iOS 18.4, MDN aún lo lista como limitación). | [WebKit bug 254545](https://bugs.webkit.org/show_bug.cgi?id=254545) · [MDN compat](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API#browser_compatibility) | **Usar el grabador en una pestaña normal de Safari** (favorito), no como ícono en la pantalla de inicio, hasta probarlo en su iPhone. |
| 6 | Una **llamada telefónica (GSM) silencia el micrófono**: la pista dispara `mute` pero **no** `ended`, ni siquiera al terminar la llamada. | [WebKit bug 213853](https://bugs.webkit.org/show_bug.cgi?id=213853) | Modo avión con Wi-Fi apagado (ya decidido). Además escuchar `mute` **y** medir silencio: si el nivel queda en 0 por 60 s, aviso. |
| 7 | Una pista silenciada por el sistema **no se puede reactivar** desde la web: hay que detenerla y pedir `getUserMedia` de nuevo. | [WebKit bug 218815](https://bugs.webkit.org/show_bug.cgi?id=218815) | "Tocar para seguir grabando" = nuevo `getUserMedia` + nuevo trozo. La web **no** puede reanudar sola (coincide con 00-decisiones). |
| 8 | Con la página en segundo plano (otra app, pantalla bloqueada), la pista de audio puede pasar a `ended` (~30 s en el reporte). | [WebKit bug 204681](https://bugs.webkit.org/show_bug.cgi?id=204681) · [WebKit bug 226620](https://bugs.webkit.org/show_bug.cgi?id=226620) | Si Vale bloquea la pantalla o cambia de app, se asume que la grabación se cortó: al volver, pantalla roja. Nunca prometer "sigue grabando con la pantalla apagada". |
| 9 | Después de que otra app (ej. WhatsApp) usó el micrófono, Safari puede entregar un micrófono **mudo** aunque se recargue. | [WebKit bug 179964](https://bugs.webkit.org/show_bug.cgi?id=179964) | La prueba de micrófono previa muestra el **medidor de nivel en vivo** antes de grabar: si no se mueve al hablar, no se empieza. |
| 10 | Safari no tiene Background Fetch ni `navigator.vibrate`; el almacenamiento escrito por scripts puede borrarse tras **7 días sin usar el sitio** (ITP). | [WebKit: Full Third-Party Cookie Blocking and More (7-day cap)](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) · [MDN: StorageManager.persist()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) | La subida ocurre **con la página abierta**. Si quedan trozos sin subir, aviso en todo el panel hasta subirlos. Pedir `navigator.storage.persist()`. No hay vibración: toda señal es visual. |
| 11 | `navigator.onLine` indica si hay conexión, pero Safari no expone el tipo de red. | [MDN: Navigator.onLine](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine) | Se puede comprobar "sin conexión" (= modo avión con Wi-Fi apagado), pero no distinguir Wi-Fi de datos. Con eso basta. |

**Inferencias (no verificadas en fuente, probar en su iPhone):** que Safari mantenga el permiso de micrófono si en *aA → Ajustes del sitio web → Micrófono* se elige "Permitir"; el peso real del MP4 a 64 kbps; que el modo de bajo consumo rechace el Wake Lock en su versión de iOS.

---

## 1. Dónde vive cada cosa en el panel

| Lugar | Qué agrega |
|---|---|
| **Nueva página `/admin/grabar`** | El grabador presencial. Única ruta con micrófono permitido (override del `Permissions-Policy` de `vercel.json`). En el menú lateral, sección secundaria junto a "Sala online": ícono micrófono, texto **"Grabar sesión"**. |
| **Inicio (`/admin`)**, tarjeta "Próxima sesión" | Si es presencial: botón **"Grabar esta sesión"** → `/admin/grabar?sesion=<id>`. Si es online: línea de estado del bot (ver §3). |
| **Sala online** | Debajo de "Estás entrando a la sesión de…": **"El asistente de notas entrará a tu Meet. Admítelo cuando aparezca."** |
| **Ficha del paciente → pestaña "Notas clínicas"** | Tarjeta **"Resumen automático (IA)"** por sesión, sobre la nota manual de esa fecha, y caja **"Preguntar a la IA"** fija a la derecha (abajo en celular). |
| **Franja de avisos (AdminLayout)** | Avisos de grabaciones sin subir, bot no admitido y errores de procesamiento (mismo estilo que las franjas verdes/rojas actuales). |

Estilo: se reutiliza lo del panel (`.card`, `.label`, `.btn`, `.alert-*`, Inter 14 px, nombre del paciente en Cormorant Garamond). Botón principal del grabador en **verde de marca `#576352`** (`forest` en `tailwind.config.mjs`, ya usado en las franjas del panel), rojo de alerta `#b91c1c` (el mismo de la franja urgente), etiqueta IA en dorado oscuro `#7A6544` (el `gold #A8906C` de marca no alcanza contraste para texto: 3,06:1; se usa solo como borde/decoración).

---

## 2. Flujo presencial (iPhone, Safari)

### 2.0 Preparación única (una vez, con Claude al lado)
1. En Safari, abrir `valentinaorellana.cl/admin/grabar` e iniciar sesión.
2. Tocar **aA → Ajustes del sitio web → Micrófono → Permitir** (así no aparece la pregunta del micrófono en plena sesión).
3. Agregar la página a **Favoritos** (no a la pantalla de inicio; ver hecho #5).
4. Ajustes → Pantalla y brillo → Bloqueo automático: dejar como está (el Wake Lock lo cubre en iOS ≥ 16.4). Si el iPhone es más antiguo, "Nunca".
5. Hacer una grabación de prueba de 2 minutos y ver el resumen en una ficha de prueba.

### 2.1 Antes de que entre el paciente (≈ 20 segundos)
1. Abre el favorito **"Grabar sesión"** (con internet, para que la página cargue y reconozca la sesión).
2. La página **ya eligió la sesión** (ver §2.6): *"Sesión de las 16:00 · Camila Rojas · Individual presencial"*.
3. Activa **Modo avión** y deja el **Wi-Fi apagado**. La lista de chequeo se marca sola:
   - **Modo avión ✓** · **Wi-Fi apagado ✓** (detecta "sin conexión")
   - **Micrófono funcionando ✓** (medidor se mueve al hablar)
   - **Batería: modo de bajo consumo apagado** (no se puede detectar: casilla que ella marca una vez por día; se recuerda hasta medianoche).
4. Opcional: activa **"Lugar con ruido"** si hay ruido de calle/obra.
5. Deja el teléfono sobre la mesa, pantalla hacia arriba, entre ella y el paciente.

### 2.2 Empezar (1 toque)
- Toca **"Grabar"** (botón de 96 px de alto, ancho completo).
- Si todo está ✓: empieza al instante. Pantalla pasa a **modo grabación** (fondo oscuro, punto rojo latiendo, cronómetro, medidor).
- Si todavía hay conexión: aparece una hoja con 2 botones (este es el único caso con un toque extra, a propósito):
  - **"Primero activo modo avión"** (botón principal) / **"Grabar igual"** (secundario).

### 2.3 Durante la sesión (no tocar nada)
- Lo que se ve de reojo: **● Grabando 00:23:41** grande, medidor de 5 barras, y abajo *"Pantalla encendida · Guardando en este teléfono"*.
- Cada 30 s el audio se guarda como trozo en el teléfono (IndexedDB). Si algo falla, como máximo se pierde lo último no guardado.
- Botón secundario pequeño **"Pausar"** (por si el paciente pide no grabar una parte). En pausa, la pantalla se pone **ámbar**, no roja, con **"En pausa por ti · Tocar para seguir"**.

### 2.4 Terminar (1 gesto)
- **"Mantén para terminar"**: mantener presionado 1 segundo (un anillo se llena). Evita terminar por un roce accidental sin agregar un segundo toque. *(Criterio de prueba §8: si en pruebas incomoda, pasa a 1 toque + "Deshacer" de 5 s.)*
- Pantalla: **"Sesión guardada en este teléfono ✓ · 50 min 12 s"** y el siguiente paso: *"Desactiva el modo avión para subirla. Puedes dejar esta página abierta y seguir con tu día."*

### 2.5 Subir y procesar (sin tocar nada más)
1. Al volver la conexión, sube sola: **"Subiendo… 7 de 12 partes"** (barra). Mantener la página abierta ~1 minuto.
2. **"Subida ✓. Transcribiendo…"** → **"Escribiendo el resumen…"** (puede tardar: el resumen va por Batch; se dice *"Te avisamos en la ficha cuando esté listo, normalmente en menos de 1 hora"*).
3. **"Listo ✓ El resumen está en la ficha de Camila Rojas"** → botón **"Ver ficha"**.
4. Si cerró Safari antes de subir: al abrir cualquier página del panel con internet aparece la franja **"Tienes 1 grabación sin subir (Camila Rojas, hoy 16:00). Subir ahora"** y se sube sola si está en `/admin/grabar`.

### 2.6 Cómo se elige paciente y sesión
Orden de búsqueda automático al abrir `/admin/grabar` (sin `?sesion=`):
1. Sesión **presencial** que esté **en curso** o empiece en los **próximos 20 minutos**, de las reservas del sitio **y** de Google Calendar (las de Encuadrado solo existen ahí; se usa el mismo cruce por título `pacienteDeTitulo` que ya usa el Inicio, y se deduplica por horario).
2. Si hay **una**: se muestra seleccionada con **"Cambiar"**.
3. Si hay **dos que se cruzan** o el título del calendario no calza con ninguna ficha: se muestran las opciones como botones grandes (*"¿Qué sesión vas a grabar?"*).
4. Si no hay ninguna: buscador **"Busca al paciente"** con los 5 pacientes atendidos más recientemente arriba. Tipo de sesión se toma de la ficha; si falta, se pregunta: **Individual / Pareja** (define el modelo, regla fija del sitio).
5. Pareja: se muestra *"Pareja · consentimiento de grabación firmado por ambos ✓"*. Si falta alguna firma: **el botón Grabar queda desactivado** con el texto *"Falta el consentimiento de grabación de [nombre]. Sin él no se puede grabar."* (no se graba sin consentimiento; coherente con 00-decisiones).

---

## 3. Flujo online (bot en Meet, Mac Chrome)

1. **Nada que hacer antes.** Toda sesión online con consentimiento de grabación firmado queda con el bot programado. En el Inicio, la tarjeta de la próxima sesión online dice **"Asistente de notas: entrará a las 16:00"**.
2. Vale entra por **Sala online** como siempre. A la hora, en Meet aparece *"Notas Ps. Valentina Orellana quiere unirse"* → ella toca **Admitir** (único paso).
3. Estado en el panel (Inicio y Sala online, se actualiza solo cada 15 s):
   - **"Esperando que lo admitas en Meet"** (ámbar)
   - **"● Grabando · 00:12:05"** (verde)
   - **"Terminó. Transcribiendo…"** → **"Resumen listo ✓ Ver ficha"**
4. El bot se va solo cuando Vale sale de la reunión o cuando quedan solo él y nadie más 2 minutos.
5. Controles por sesión (en el Inicio, menú "…" de la tarjeta): **"No grabar esta sesión"** y **"Enviar el asistente ahora"** (si la sesión partió antes o cambió el link).
6. Si nadie lo admite en 10 minutos: el bot se retira y aparece la franja **"El asistente de notas no fue admitido en la sesión de Camila Rojas (16:00). Esta sesión no se grabó."** con **"Enviarlo de nuevo"**.

---

## 4. Ver el resumen en la ficha

En **Notas clínicas**, cada sesión con grabación muestra una tarjeta encima de la nota manual de esa fecha:

```
[ Resumen automático (IA) ]            15 oct 2026 · 16:00 · Ind. presencial
Puntos clave
• …
Tareas dadas
• …
Revisar la próxima sesión
• …
Generado automáticamente por IA a partir de la grabación. Puede tener errores: no reemplaza tu nota clínica.
[Ver transcripción completa]  [Copiar a mi nota]
```

- La etiqueta **"Resumen automático (IA)"** siempre visible (badge dorado oscuro + borde izquierdo dorado), para que nunca se confunda con lo que escribió Vale.
- **"Ver transcripción completa"** abre un panel con el texto por hablante (pareja: "Persona 1 / Persona 2"; online: nombres de Meet) y marcas de minuto. Se descifra al abrir; texto *"Cargando transcripción cifrada…"*.
- **"Copiar a mi nota"** pega el resumen en el formulario "+ Nueva nota" para que ella lo edite si quiere (no obligatorio: el resumen ya está guardado sin aprobación).
- En la pestaña **Sesiones**, cada sesión grabada lleva un pequeño badge **"Grabada · resumen IA"** que lleva a la tarjeta.
- Mientras se procesa: tarjeta gris **"Resumen automático (IA): en proceso. Aparecerá aquí solo."**

## 5. Preguntar a la IA

Caja en la ficha (columna derecha en Mac, debajo en celular):
- Título: **"Preguntar a la IA"** · subtítulo *"Sobre las sesiones grabadas de Camila Rojas"*.
- Selector: **"Todas las sesiones (6)"** / **"Solo la última"** / fecha.
- Campo: placeholder *"Ej.: ¿Qué dijo sobre su mamá en las últimas sesiones?"* · botón **"Preguntar"**.
- Ideas rápidas (chips): **"¿Qué tareas quedaron pendientes?"**, **"¿Cómo ha cambiado el sueño?"**, **"Temas que se repiten"**.
- Respuesta: texto + citas clicables *"(sesión 8 oct, min 23)"* que abren la transcripción en ese punto. Pie: *"Respuesta de IA basada solo en las transcripciones. Revisa las citas."*
- Estados: *"Buscando en 6 sesiones…"* · sin datos: *"Aún no hay sesiones grabadas de este paciente."* · error: *"No se pudo responder ahora. Intenta de nuevo en un minuto."* · límite de gasto alcanzado: *"Se alcanzó el límite mensual de la IA. Las preguntas vuelven el 1 de noviembre."*
- Las preguntas y respuestas **no** se guardan en la ficha (salvo que toque **"Guardar en mi nota"**).

---

## 6. Estados del grabador y textos exactos

| Estado | Fondo | Título grande | Texto de apoyo | Botones |
|---|---|---|---|---|
| **Cargando** | claro | "Preparando el grabador…" | — | — |
| **Elegir sesión** | claro | "¿Qué sesión vas a grabar?" | — | una fila por sesión · "Buscar otro paciente" |
| **Listo** | claro | "Sesión de las 16:00" | "Camila Rojas · Individual presencial" + checklist | **Grabar** · "Lugar con ruido" (interruptor) · "Cambiar" |
| **Hoja: aún con conexión** | hoja inferior | "Todavía tienes conexión" | "Si entra una llamada, el iPhone corta el micrófono aunque no contestes. Activa Modo avión y deja el Wi-Fi apagado." | **Primero activo modo avión** · "Grabar igual" |
| **Grabando** | oscuro `#1A1A18` | "● Grabando" + **00:23:41** | medidor de nivel · "Pantalla encendida · Guardando en este teléfono" · si ruido: "Lugar con ruido activado" | "Pausar" (pequeño) · **Mantén para terminar** |
| **Silencio sospechoso** (nivel 0 por 60 s) | oscuro + franja ámbar | igual | **"No se escucha nada hace 1 minuto. Revisa que nada tape el micrófono."** | — (se quita solo al volver el sonido) |
| **En pausa (por ella)** | ámbar `#92400e` sobre `#fffbeb` | "En pausa" | "Pausaste la grabación a los 23:41. Lo que se diga ahora no se graba." | **Tocar para seguir grabando** · "Mantén para terminar" |
| **Pausada por interrupción** | **rojo `#b91c1c` pantalla completa** | **"La grabación se pausó"** | causa en una línea (abajo) + "Se grabó hasta las 16:23. Toca para seguir: el resto se agrega a la misma sesión." | **Tocar para seguir grabando** (toda la mitad inferior es el botón) · "Terminar aquí" |
| **Terminando** | oscuro | "Guardando…" | "No cierres esta página." | — |
| **Guardada sin conexión** | claro | "Sesión guardada en este teléfono ✓" | "50 min 12 s · Desactiva el modo avión para subirla." | — |
| **Subiendo** | claro | "Subiendo… 7 de 12 partes" | barra + "Deja esta página abierta un momento." | — |
| **Procesando** | claro | "Subida ✓ Transcribiendo…" → "Escribiendo el resumen…" | "Ya puedes cerrar esta página. El resumen aparecerá solo en la ficha." | "Grabar otra sesión" |
| **Listo** | claro | "Listo ✓" | "El resumen está en la ficha de Camila Rojas." | **Ver ficha** · "Grabar otra sesión" |
| **Error** | claro + caja roja | ver tabla §7 | — | según el error |

Causas mostradas en "La grabación se pausó":
- llamada / otra app tomó el micrófono (`mute`): **"Otra app o una llamada tomó el micrófono."**
- página oculta / pantalla bloqueada (`visibilitychange` → hidden): **"Saliste de esta página o se bloqueó la pantalla."**
- pista terminada (`ended`) o error del grabador: **"El iPhone detuvo el micrófono."**
- Wake Lock soltado estando visible: no pausa; se reintenta y si falla muestra franja ámbar **"La pantalla podría apagarse. Tócala de vez en cuando o enchufa el cargador."**

El cronómetro muestra el **tiempo grabado real**; el hueco se registra (16:23–16:25) y se marca en la transcripción como *"[grabación pausada 2 min]"*.

## 7. Qué ve si algo falla (textos exactos)

| Situación | Dónde | Texto | Acción |
|---|---|---|---|
| Micrófono bloqueado | grabador | **"Safari no tiene permiso para usar el micrófono."** "Toca aA en la barra de direcciones → Ajustes del sitio web → Micrófono → Permitir. Después vuelve a tocar Grabar." | **Reintentar** |
| Micrófono mudo (medidor quieto en la prueba) | grabador | **"El micrófono no capta sonido."** "Cierra WhatsApp u otras apps que lo usen, y si sigue igual, reinicia Safari." | **Probar de nuevo** |
| Navegador no compatible | grabador | **"Este navegador no puede grabar."** "Usa Safari en el iPhone (iOS 16.4 o más nuevo) o Chrome en el Mac." | — |
| Poco espacio en el teléfono | grabador (antes de grabar) | **"Hay poco espacio en el iPhone."** "Una sesión ocupa unos 25 MB. Libera espacio antes de grabar." | **Grabar igual** |
| Falta consentimiento | grabador | **"Falta el consentimiento de grabación de [nombre]."** "Sin él no se puede grabar esta sesión." | **Enviar consentimiento** (lleva a la ficha) |
| Subida falla | grabador + franja panel | **"No se pudo subir la grabación."** "Está segura en este teléfono. Se reintentará sola cuando haya internet." | **Reintentar ahora** |
| Trozos sin subir > 24 h | franja roja en todo el panel | **"Hay una grabación guardada solo en tu iPhone desde ayer (Camila Rojas). Ábrela en el iPhone con internet para subirla: si pasan 7 días, Safari podría borrarla."** | **Subir ahora** |
| Transcripción falla | ficha + franja | **"No se pudo transcribir la sesión del 15 oct (Camila Rojas)."** "Se reintentará sola. Si vuelve a fallar, te avisamos." | — |
| Audio sin voz / muy corto | ficha | **"La grabación del 15 oct casi no tiene voz (2 min de habla en 50 min). No se generó resumen."** | **Ver transcripción** |
| Resumen falla | ficha | **"La transcripción está lista, pero el resumen no se pudo generar. Se reintentará en la noche."** | **Ver transcripción** |
| Bot no admitido | franja | (ver §3.6) | **Enviarlo de nuevo** |
| Bot no pudo entrar (link inválido) | franja | **"El asistente de notas no pudo entrar al Meet de Camila Rojas: el link no funciona."** | **Enviar el asistente ahora** |
| Límite de gasto | franja | **"Se alcanzó el límite mensual de la IA. Las grabaciones se guardan y se procesarán el 1 de noviembre."** | — |

Regla: **ningún error dice "error 500" ni términos técnicos**; siempre dice qué pasó con *su* grabación (¿está a salvo?) y qué hacer. El detalle técnico va a `/admin/logs`.

---

## 8. Accesibilidad

- **Tamaños táctiles**: todo botón del grabador ≥ **48 × 48 px** (WCAG 2.5.5 pide 44; usamos 48 como Material). "Grabar" y "Tocar para seguir grabando": ≥ 96 px de alto, ancho completo. Separación ≥ 16 px entre "Pausar" y "Mantén para terminar".
- **Contraste medido** (WCAG AA ≥ 4,5:1 texto normal):
  - blanco sobre verde `#576352`: **6,34:1** ✓
  - blanco sobre rojo `#b91c1c`: **6,47:1** ✓
  - blanco sobre `#1A1A18` (modo grabación): **17,4:1** ✓ · gris claro `#B5B0A6` sobre `#1A1A18`: **8,07:1** ✓
  - `#6B6860` (stone) sobre `#FAF7F4` (sand): **5,21:1** ✓
  - etiqueta IA `#7A6544` sobre blanco: **5,57:1** ✓ (el `gold #A8906C` da 3,06:1 ✗ → solo decorativo)
  - rojo de punto de grabación `#f87171` sobre `#1A1A18`: **6,3:1** ✓
- **No depender solo del color**: cada estado tiene palabra ("Grabando", "En pausa", "La grabación se pausó") e ícono.
- Cronómetro en cifras tabulares (`font-variant-numeric: tabular-nums`), 56 px, legible a 1 m.
- Anuncios con `aria-live="assertive"` para pausa/error y `polite` para progreso. El botón "Mantén para terminar" también funciona con teclado (Enter mantenido) y VoiceOver (doble toque + mantener).
- Respeta `prefers-reduced-motion`: el punto rojo deja de latir y queda fijo.
- Textos a 16 px mínimo en el grabador (evita el zoom automático de iOS en campos de texto).

---

## 9. Criterios de prueba de usabilidad (antes de usarlo con pacientes)

Pruebas con Vale en su box, su iPhone real, con un familiar como "paciente" (5 sesiones simuladas de 10 min).

| # | Tarea | Éxito |
|---|---|---|
| U1 | Desde el teléfono bloqueado, empezar a grabar la sesión correcta | ≤ 20 s, **1 toque** en el grabador, sesión correcta autoseleccionada, sin ayuda |
| U2 | Saber si está grabando mirando de reojo a 1 m | Responde "sí/no" en < 2 s en 5/5 intentos |
| U3 | Terminar la sesión | 1 gesto, 0 terminaciones accidentales en 5 sesiones |
| U4 | Interrupción: el ayudante bloquea la pantalla / abre otra app a mitad | Vale ve el aviso rojo y retoma en < 10 s; el audio final tiene ambas partes y la marca del hueco |
| U5 | Llamada entrante con modo avión **desactivado** (prueba controlada) | Aparece "La grabación se pausó" o el aviso de silencio en ≤ 60 s |
| U6 | Subir después de la sesión | Sube sola al quitar modo avión; Vale no toca nada más |
| U7 | Encontrar el resumen en la ficha | ≤ 15 s desde el aviso "Listo"; identifica que es de IA sin preguntar |
| U8 | Hacer una pregunta a la IA y abrir la cita | Respuesta con cita que abre el minuto correcto |
| U9 | Sesión online: admitir al bot y verlo "Grabando" en el panel | Solo 1 acción (Admitir) |
| U10 | Comprensión de errores: mostrarle 4 errores de §7 | Explica con sus palabras qué pasó y qué hacer en 4/4 |

Métricas técnicas a revisar en las mismas pruebas: 50 min reales sin cortes con pantalla encendida; peso del archivo (meta ≤ 30 MB); batería gastada (meta ≤ 15 % por sesión de 50 min); tiempo hasta resumen.
Escala SEQ (1–7, "¿qué tan fácil fue?") después de U1, U3, U4 y U7: meta ≥ 6.

**Pendientes a verificar en su iPhone** (no se pueden confirmar en documentación): versión de iOS (≥ 16.4 para Wake Lock), permiso de micrófono persistente por sitio, comportamiento real del Wake Lock con modo de bajo consumo.
