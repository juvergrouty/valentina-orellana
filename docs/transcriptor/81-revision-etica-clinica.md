# 81 — Revisión ética y clínica de la rama `transcriptor`

Fecha: 16 oct 2026. Revisión hecha sin modificar código, sobre `git diff origin/main...transcriptor` (HEAD 8fa59c6).
Referencias: `01-decisiones-16oct.md` (manda), `10-etica-legal.md` §4, `20-clinico.md`, `12-consentimiento-nuevo.md`.
Roles: especialista en ética profesional (Chile) y psicóloga clínica senior.

Nota previa: la rama `transcriptor` **no incluye** `origin/main` (que ya trae la v3 y el retiro de grabación por correo/WhatsApp). La regla de versión (`numeroVersion >= 2`) acepta la v3 sin cambios, pero hay que integrar main antes de lanzar y volver a revisar los textos del consentimiento.

---

## 1. Lo que está bien (verificado en el código)

| Requisito | Dónde | Estado |
|---|---|---|
| Chequeo de consentimiento **en el servidor** al preparar, al pedir URL de subida y al finalizar | `grabacion-iniciar.ts:75`, `subida-url.ts:51`, `grabacion-finalizar.ts:92` | OK |
| Bot de Meet: no se despacha sin consentimiento (queda `sin_consentimiento` + bitácora) | `pipeline.ts:363-382` | OK |
| v2 con `accept_recording=true` o v3+ habilitan; v1 no; revocación o `accept_recording=false` bloquean; última firma por persona; pareja = 2 personas distintas (RUT validado) | `consentimiento.ts:93-131` | OK |
| Conservador: cualquier persona de la ficha con firma revocada/negada/antigua bloquea | `consentimiento.ts:122-127` | OK |
| Menores de 18: bloqueo si la fecha de nacimiento lo indica; sin fecha se permite (decisión 10) | `consentimiento.ts:98-99` | OK |
| Falla cerrado si la base no responde o el transcriptor está apagado | `consentimiento.ts:171-202` | OK |
| Pausar presencial: cierra el segmento, sin buffer; marca "Grabación pausada a pedido" | `grabar.astro:925-933`, `panel.ts:349` | OK |
| "Mantén para terminar", indicador "Grabando" permanente | `grabar.astro:296-308` | OK |
| Bot: nombre "Notas de Ps. Valentina Orellana", solo entra si Vale lo admite, sale si hay más humanos de los esperados | `tipos.ts:11`, `vigia.ts:64-67` | OK |
| Rótulo "Resumen automático (IA) — no revisado" en badge y en la base; edición = versión nueva "editado por la terapeuta"; la de la IA nunca se pisa (trigger) | `tipos.ts:14`, `panel.ts:17`, `0014:132,161-180` | OK |
| El resumen va en tarjeta propia, nunca en `session_notes`; "Copiar a mi nota" antepone "Basado en el resumen automático (IA) — revisar y editar" | `[id].astro:661-690,1357` | OK |
| Sin alertas de riesgo clínico (no hay banner, correo ni tamizaje); `atencion_prioridad` siempre null; "Atención" se dibuja igual que las demás secciones | `alertas.ts:5`, `panel.ts:152`, `[id].astro:955` | OK |
| Avisos técnicos en el panel; correo de respaldo sin contenido clínico ni nombres | `alertas.ts:126-145`, `pipeline.ts:137-143` | OK (ver H17) |
| Q&A rotulado "Respuesta generada por IA", con aviso; pregunta y respuesta cifradas; bitácora obligatoria antes de descifrar | `preguntar.ts:116-124,161-185`, `[id].astro:782` | OK |
| Ver transcripción: `auditarObligatorio` antes de descifrar; texto "el acceso quedó registrado" es verdadero | `[gid].astro:78`, línea ~101 del cuerpo | OK |
| Bitácora solo inserción y sin contenido clínico (`LLAVES_PROHIBIDAS`) | `auditoria.ts:21-40` | OK |
| Ningún texto visible promete que la terapeuta revisa el resumen | grabador, ficha, transcripción, `/admin/transcriptor` | OK |

---

## 2. Hallazgos

Gravedad: **Alta** = bloquea el lanzamiento; **Media** = corregir antes del primer paciente real; **Baja** = mejora.

### H1 — Alta · No existe "retirar solo la grabación"; el retiro del panel revoca el consentimiento completo y, en pareja, la fila de la persona equivocada
- **Dónde:** `src/pages/api/admin/consent.ts:29-36` (acción `revoke`: toma la última fila firmada de la ficha, sin importar quién la firmó, y le pone `revoked_at`).
- **Por qué importa:** el consentimiento (v3 en main, sección 6, y `[token].astro:47`) promete que el paciente puede retirar **solo** la autorización de grabación por correo o WhatsApp sin que cambie su atención. Hoy, para cumplir ese pedido, Vale solo puede revocar todo el consentimiento, lo que también deja sin base la autorización 1 (tratamiento) en el registro. En pareja, si pide retirar Persona A y la última firma es de Persona B, queda registrado que B retiró. El bloqueo de grabación funciona (es conservador), pero el registro queda falso, y eso es un problema de veracidad de la ficha (D41) y del art. 12 de la Ley 21.719.
- **Corrección:** agregar la acción `revoke_recording` con `consent_id` explícito (Vale elige a la persona en la ficha) que guarde `recording_revoked_at` + nota, y que `evaluarConsentimientos` la trate igual que `revoked_at` (motivo `revocado`). Botón en la ficha, al lado de cada firma: **"Retirar solo la grabación"**, con confirmación: *"Desde ahora no se graban las sesiones de {nombre}. Lo ya transcrito queda en la ficha con la misma confidencialidad. Su consentimiento para la atención sigue vigente."* La acción `revoke` existente también debe pedir `consent_id`.

### H2 — Alta · El tipo de sesión lo puede elegir el cliente y una pareja puede grabarse como "individual" con una sola firma
- **Dónde:** `grabacion-iniciar.ts:34,48-49,73` (si la reserva no tiene tipo, o es un evento de Calendar/Encuadrado, o se busca al paciente a mano, vale el `tipo` del cuerpo); `consentimiento.ts:94` (`requeridas = 1` salvo `pareja`); online: `bot.ts:384` (eventos sin reserva → `sin_tipo` → 1 firma y `MAX_HUMANOS = 2`).
- **Por qué importa:** la protección "conservadora" de `consentimiento.ts:122-127` solo actúa si la segunda persona tiene **alguna** fila de consentimiento. Si nunca firmó, elegir "Individual" (por error o apuro) graba a una persona sin consentimiento. En online, una pareja conectada desde un solo dispositivo se ve como 2 humanos y el vigía no la detiene. Es exactamente lo que la decisión 4 y la 9 prohíben ("pareja: ambos").
- **Corrección:** en `evaluarEnBase`, exigir 2 firmas si la ficha es de pareja por cualquier señal en el servidor: (a) la ficha tiene alguna reserva `pareja-*` histórica, (b) hay ≥ 2 identidades firmantes en `consents`, o (c) un campo `patients.es_pareja` (si existe o se agrega). Para eventos `sin_tipo` online, no despachar el bot si la ficha cumple (a)–(c) y no hay 2 firmas. Texto en el grabador al elegir Individual en una ficha de pareja: *"Esta ficha es de pareja. Para grabar se necesita el consentimiento de las dos personas."*

### H3 — Media-alta · Reasignar una grabación a otra ficha no verifica el consentimiento de la ficha nueva
- **Dónde:** `src/pages/api/admin/transcriptor/asignar.ts:31` (actualiza `patient_id` sin chequeo; `consent_ids` sigue apuntando a la ficha anterior).
- **Por qué importa:** la transcripción y el resumen pasan a la ficha de una persona que puede no haber autorizado la grabación; quedan en su ficha y entran a su Q&A. También rompe la trazabilidad grabación ↔ consentimiento.
- **Corrección:** antes de actualizar, `verificarGrabacion(patientId, g.tipo)`; si no puede, responder 403 con *"La ficha elegida no tiene consentimiento de grabación vigente. No se puede asignar esta grabación."* y guardar los `consent_ids` nuevos al asignar.

### H4 — Media · El aviso a pacientes con v2 (decisión 13) no está construido
- **Dónde:** no hay código ni tabla (búsqueda de "aviso", "cambié de herramienta", "ya no uso Encuadrado" en `src/` y `supabase/`: sin resultados).
- **Por qué importa:** la decisión 9 (v2 habilita) se sostiene, según `12-consentimiento-nuevo.md` §(c), en que el aviso "cierra la brecha" (la v2 nombra Encuadrado y dice "único fin de transcribirlo"). Sin aviso, grabar con v2 queda en su lectura más débil.
- **Corrección (pendiente):** tabla `consent_avisos (consent_id, mostrado_at, canal, texto_version)`; al enviar la confirmación de la próxima hora de un paciente cuya última firma vigente es v2 con grabación, agregar al final el texto de §(c) adaptado, registrar y no repetir; activo solo con `transcriptor_activo = true`. Texto propuesto (adaptado):
  > Un cambio en cómo llevo las notas de nuestras sesiones: cuando firmaste el consentimiento autorizaste que grabara el audio para transcribirlo como notas de tu ficha. Eso sigue igual. Lo que cambió es la herramienta: ya no uso Encuadrado, sino un sistema propio de mi sitio que transcribe el audio con apoyo de herramientas tecnológicas, incluida inteligencia artificial, algunas de ellas fuera de Chile (principalmente en Estados Unidos), por encargo mío y con contratos de confidencialidad. El audio se borra apenas se transcribe, la transcripción queda cifrada en tu ficha y ninguna herramienta toma decisiones sobre tu tratamiento. No tienes que firmar nada. Si prefieres que no grabe, respóndeme por aquí o por WhatsApp y desde ese momento tomo notas a mano; nada cambia en tu atención. La lista de servicios está en valentinaorellana.cl/condiciones#privacidad.
- Mientras no exista, en el grabador mostrar la versión: *"Consentimiento de grabación firmado ✓ (versión 2: falta el aviso de cambio de herramienta)"* (`grabar.astro:629`).

### H5 — Media · El Q&A no permite excluir transcripciones a pedido del paciente
- **Dónde:** `preguntar.ts:90-111` (toma todas las grabaciones de la ficha).
- **Por qué importa:** `10-etica-legal.md` §4.1: al revocar, "si el paciente lo pide, se excluyen sus transcripciones del Q&A con IA". No hay campo ni filtro.
- **Corrección (pendiente):** columna `grabaciones.excluir_ia_at` (o en el consentimiento) que `preguntar.ts` y `contextoSesionAnterior` (`resumen.ts:699-722`) respeten; botón en la ficha *"Excluir de las preguntas a la IA"*.

### H6 — Media · Ver un resumen en la ficha no queda en el registro de accesos
- **Dónde:** `src/pages/admin/pacientes/[id].astro:87` lee `resumenes_ia.contenido` y lo muestra; la acción `ver_resumen` existe en `tipos.ts:268` pero no se usa en ningún lado.
- **Por qué importa:** §4.6 y §4.10 (D41 art. 9): "si Vale abre el resumen, el registro de accesos lo deja anotado". Hoy solo se registran transcripción y Q&A.
- **Corrección:** al renderizar la pestaña Notas/Sesiones con tarjetas IA, `auditar('vale', 'ver_resumen', { patientId, request, detalle: { resumenes: n } })` (una fila por vista de ficha basta).

### H7 — Media · El resumen se guarda en claro en Supabase
- **Dónde:** `supabase/migrations/0014_transcriptor.sql:142` (`contenido text`), leído directo en `[id].astro:87` y `preguntar.ts:103`.
- **Por qué importa:** §4.8: "si el resumen se guarda en Supabase, cifrarlo igual". El resumen contiene datos sensibles (incluida la sección Atención). La transcripción sí está cifrada; el resumen, que es su destilado, no.
- **Corrección:** derivar a la revisión de seguridad (30-seguridad); mínimo, cifrar `contenido` con el mismo VOT1 o dejar constancia escrita de la decisión y su motivo.

### H8 — Media · El prompt obliga a NO omitir lo que el paciente pidió que no quedara registrado
- **Dónde:** `src/lib/transcriptor/resumen.ts:104` (principio 8: *"Si alguien pide en sesión que algo 'no quede registrado', NO lo omitas por tu cuenta"*).
- **Por qué importa:** la autorización 2 de la v3 dice "Puedo pedir que una sesión o un momento de la sesión no se grabe". Si el pedido llegó tarde (Vale no pausó a tiempo), el resumen igual resumiría ese contenido en Puntos clave, Temas, etc. Clínicamente rompe la alianza; éticamente contradice lo prometido. La transcripción queda (es la ficha), pero el anexo automático no debería amplificarlo.
- **Corrección (texto exacto para reemplazar la segunda oración del principio 8):**
  > Si alguien pide en sesión que algo no quede registrado o no se grabe, no incluyas en ninguna sección del resumen lo dicho en ese tramo (desde el pedido hasta que la conversación cambia de tema). En "Calidad de la transcripción" escribe solo: "En [mm:ss] se pidió que algo no quedara registrado; ese tramo no se resume." Si en ese tramo apareció un tema de los de Atención, en Atención escribe solo: "En [mm:ss], en un tramo que se pidió no registrar, apareció un tema de esta lista; ver transcripción." sin cita.
- Agregar al protocolo de Vale (`20-clinico.md` §6.2): si lo piden, tocar **Pausar** de inmediato.

### H9 — Media-baja · Formato de "Atención": falta prohibir calificativos clínicos y marcar hablante inferido
- **Dónde:** `resumen.ts:125-126`.
- **Por qué importa:** "{tema, en palabras neutras}" deja abierto que el modelo escriba "ideación suicida **pasiva**", "**niega** plan", "consumo **problemático**": son clasificaciones de gravedad, prohibidas por la decisión 2. Además, en sesiones sin etiquetas (Ej. 3), "Dicho por: Tomás" se presenta como hecho cuando es inferido.
- **Corrección (texto exacto, reemplaza las líneas 125-126):**
  > - Se habló de {tema, con palabras cercanas a lo dicho; sin términos clínicos ni calificativos de gravedad como "pasiva", "activa", "leve", "grave", "problemático", "niega"} — Dicho por: {nombre o rol}{agrega " (inferido)" si la asignación de hablante fue inferida} — [mm:ss]
  >   «cita textual breve»
  >   {opcional, solo si existe: "Lo que se dijo enseguida: «cita» [mm:ss]", sin interpretar}

### H10 — Baja · El rótulo completo de §4.6 no aparece
- **Dónde:** `panel.ts:18` (`AVISO_RESUMEN`) y `resumen.ts:248` (línea de datos).
- **Por qué importa:** §4.6 exige modelo, fecha/hora, transcripción y "No constituye la evolución clínica firmada" en la interfaz y en exportaciones. Hoy dice "No reemplaza el juicio clínico", que no es lo mismo que decir que no es la evolución.
- **Corrección:** `AVISO_RESUMEN` = *"Resumen automático (IA) — no revisado por la psicóloga. Generado por {modelo} el {fecha y hora} a partir de la transcripción. Puede contener errores. No constituye la evolución clínica firmada."* (los datos están en `resumenes_ia.modelo`, `listo_at`, `transcripcion_id`). En `lineaEncabezado`: *"Generado automáticamente a partir de la transcripción. No revisado. No constituye la evolución clínica."*

### H11 — Baja · Online no hay Pausar
- **Dónde:** `bot/src/` sin comando de pausa (§4.4 lo exige para online).
- **Por qué importa:** en online, la única forma de dejar de grabar es sacar al asistente, que ya no vuelve. El paciente pierde la opción "pausa sin terminar".
- **Corrección (pendiente):** documentarlo en el protocolo ("en online, para no grabar un momento, saca al asistente; el resto de la sesión no se graba") y, si se quiere paridad, botón "Pausar asistente" en el panel que mande `pausa/continuar` por `bot-evento`.

### H12 — Baja · El vigía graba 15 s a un tercero antes de salir
- **Dónde:** `bot/src/vigia.ts:64-67` (`graciaExtraMs = 15 000`).
- **Corrección:** al salir por `participantes_extra`, recortar el audio desde `extraDesde` o marcar el tramo en la transcripción "[Ingresó una persona no prevista; tramo no resumido]" y excluirlo del resumen.

### H13 — Baja · Las interrupciones (llamada, pantalla bloqueada) no quedan como hueco marcado
- **Dónde:** `grabar.astro:897-914` (solo la pausa voluntaria se agrega a `pausas`).
- **Por qué importa:** el resumen no sabe que faltó un tramo; puede presentar como continuo algo que no lo fue.
- **Corrección:** registrar también las interrupciones en `pausas` con `motivo: 'interrupcion'`, y que la transcripción diga "[Grabación interrumpida mm:ss–mm:ss]".

### H14 — Baja · En pareja el modelo no recibe los nombres de las dos personas
- **Dónde:** `pipeline.ts:629` (pareja → solo "Terapeuta: Valentina").
- **Por qué importa:** la plantilla pide "Perspectiva de {nombre}"; sin nombres el modelo los infiere del texto (Ej. 2: "Javi") o escribe "Hablante B". La atribución errada en pareja es el error clínico más dañino (neutralidad).
- **Corrección:** pasar como `Miembro` el nombre de pila de los dos firmantes válidos (`v.firmantes`), indicando "orden no determinado; asigna por el contenido y decláralo en Calidad".

### H15 — Baja · Ejemplos y documentos que contradicen las reglas
- `resumen.fixtures.ts` (EJ3_RESUMEN, Temas): *"Ánimo desde la separación de 'la Fran'"* → "se fue" no dice separación (inferencia). Cambiar a: *"Ánimo desde que, en sus palabras, «se fue la Fran»."*
- `[id].astro:73` y `[gid].astro:51` (datos demo): Atención sin el formato fijo y con *"No consta que se haya profundizado en ese momento"*, que evalúa a la terapeuta. Usar el formato de `resumen.ts:125`.
- `20-clinico.md` §3.2 y §5 Ej. 3 todavía piden "Prioridad: ALTA", tamizaje Haiku, banner y correo. Agregar al inicio de ambas secciones: *"SUPERADO por 01-decisiones-16oct.md (decisión 2): sin tamizaje, sin prioridad, sin alertas. Ver resumen.fixtures.ts EJ3."*
- `10-etica-legal.md` §4.1 exige v3; agregar la misma nota apuntando a la decisión 9.

### H16 — Baja · Reglas del prompt que conviene explicitar
- `resumen.ts:92` (principio 2): agregar *"No recomiendes medicación, derivaciones, altas ni cambios de frecuencia o de tratamiento."* (§4.6 n.º 5 lo exige literal; "recomendaciones de tratamiento" no cubre derivaciones con claridad).
- `resumen.ts:170` ("Puntos clave: lo más importante que se contó, se entendió o se decidió"): "se entendió" invita a atribuir insights. Cambiar a *"lo que se contó, lo que alguien dijo haber entendido y lo que se decidió"*.
- `resumen.ts:98` (pareja): agregar *"Si de un miembro no consta algo que sí consta del otro (p. ej., su tarea), escríbelo: 'No consta en la transcripción'."*

### H17 — Baja · Los correos de respaldo revelan el tipo de terapia
- **Dónde:** `pipeline.ts:138` → títulos como "No se pudo transcribir la sesión **de pareja** presencial del 16/10 a las 15:00", que viajan en el asunto del correo (`alertas.ts:127`).
- **Corrección:** en `armarCorreo`, usar un asunto genérico ("⚠ Transcriptor: hay un aviso en tu panel") y dejar el título completo solo en el panel.

---

## 3. Ejecución mental de los 3 ejemplos de `20-clinico.md` §5 contra los prompts reales

**Ejemplo 1 (individual, sin riesgo, con tarea).** Plantilla individual + instrucciones por defecto. Esperable: Temas (sobrecarga, dificultad para negarse), Puntos clave atribuidos ("cuenta", "dice"), En sus palabras con [09:50] (verificable), Cambios: sueño 4 h, Intervenciones descriptivas, Tarea "Camila: anotar… — durante la semana", Para revisar "la que puede con todo". Principio 2 bloquea "ansiedad", "perfeccionismo", "autoestima"; principio 3 bloquea "buen avance". Ningún tema de la lista de Atención → sin sección Atención. **Pasa.** Riesgo residual: "se entendió" (H16) puede producir "Camila se da cuenta de que puede poner límites".

**Ejemplo 2 (pareja, A/B/C sin nombres).** Etiquetas "diarizadas sin nombre"; participantes: solo terapeuta (H14), así que los nombres salen del texto ("Javi", "Diego"). La plantilla pone primero a quien habló primero (B = Javiera), pide simetría ±1 viñeta, "Momentos" sin etiquetas, Tareas separadas y Calidad con asignación inferida. Principio 7 obliga a reportar [52:40] inaudible sin inventar. **Pasa con reservas:** sin la regla de H16 puede omitir la tarea de Javiera en vez de escribir "no consta", lo que deja asimetría; y sin nombres hay riesgo de invertir B/C si la terapeuta no los nombra.

**Ejemplo 3 (riesgo, sin hablantes).** La lista de Atención incluye "ideas de muerte… medios" → dos viñetas, Atención primero (además `atencionAlInicio` la sube), frase de cierre fija, sin prioridad ni "riesgo bajo". Las dos citas se verifican (la normalización convierte "[inaudible]" en la palabra "inaudible" en ambos lados). El *4141 queda en Tareas como acuerdo, no como recomendación. Sin banner ni correo: cumple la decisión 2. **Pasa con reservas:** sin la regla de H9 el modelo puede escribir "ideación suicida pasiva" o "niega plan", que son calificaciones de gravedad; y "Dicho por: Tomás" sin "(inferido)". El `EJ3_RESUMEN` de fixtures ya usa "(inferido)", pero el prompt no lo pide.

**Prompt de preguntas.** Reglas 1-10 correctas: solo sesiones entregadas, citas verificadas, "No aparece en las sesiones disponibles (fechas)", sin diagnóstico ni evaluación de riesgo (redirige al juicio clínico), neutralidad en pareja, sesiones y pregunta tratadas como dato, mención neutra de temas de riesgo. Falta solo la exclusión a pedido (H5).

---

## 4. Pendientes para lanzar (resumen)

1. H1 retiro solo de grabación por persona. 2. H2 pareja inferida en el servidor. 3. H3 consentimiento al reasignar. 4. H4 aviso v2 (decisión 13). 5. H6 registro `ver_resumen`. 6. H7 decisión sobre cifrado del resumen. 7. H8 y H9 cambios de prompt (subir `PROMPT_VERSION_RESUMEN`). 8. Integrar `origin/main` (v3) en la rama y repetir esta revisión de textos.
