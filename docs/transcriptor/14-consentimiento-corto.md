# Consentimiento v4 (`2026-10-v4`): versión corta por capas

Preparado el 17 oct 2026. Base: `src/lib/consent.ts` (v3, `2026-10-v3`), `src/pages/condiciones.astro#privacidad` (versión 4), `12-consentimiento-nuevo.md` y `10-etica-legal.md`.
No es asesoría legal: es un borrador para que la abogada lo valide.

**Qué pidió Vale.** La v3 es larguísima, sobre todo "Quién más puede verlos" y "Qué datos y para qué". La v4 tiene que ser mucho más corta y cálida, sin perder lo que exige la ley.

**Técnica de capas.**
- **Capa 1 (este consentimiento):** lo que la persona necesita para decidir. Quién es la responsable, para qué se usan los datos, que son sensibles, que se usa IA sin decisiones automatizadas, que hay encargados fuera de Chile, el plazo de la ficha, los derechos, cómo se revoca y las 3 autorizaciones.
- **Capa 2 (`/condiciones#privacidad`):** el detalle. Lista de proveedores con nombre y país, plazos de las copias temporales, derechos uno por uno y detalle de la grabación.

La v3 se queda como está para quienes ya la firmaron, porque su `text_snapshot` no cambia. La v4 es para los consentimientos nuevos. La regla para grabar tiene que aceptar v2, v3 o v4 con `accept_recording = true`.

---

## (a) Texto completo propuesto, versión `2026-10-v4`

**Consentimiento informado para la atención psicológica y el tratamiento de datos personales y de salud (versión 2026-10-v4)**

### Quién trata tus datos
Valentina Orellana, psicóloga (RUT 16.768.831-4, registro N° 360070 de la Superintendencia de Salud), es la responsable de tus datos. Contacto: consulta@valentinaorellana.cl o WhatsApp +56 9 7273 5696.

### Sobre la atención psicológica
La terapia es un proceso colaborativo: no garantiza resultados, puede traer emociones difíciles y puedes dejarla cuando quieras. Las sesiones duran 50 minutos; reagendar es gratis avisando con 24 horas; con menos aviso, la sesión se considera realizada. Si otro profesional te ayudaría o la terapia no te sirve, te propondré una derivación.

Este espacio no atiende urgencias. En crisis, llama al *4141 (gratis, 24/7), a Salud Responde 600 360 7777 o al SAMU 131, o ve a urgencias.

### Tus datos y para qué
Trato tus datos de contacto y de salud (y, si lo autorizas, el audio de las sesiones y su transcripción) solo para atenderte: ficha clínica, agenda, cobros y boletas. Por ser datos sensibles, te pido este consentimiento expreso. Uso herramientas tecnológicas, incluida inteligencia artificial (IA), para transcribir y ordenar la información, pero ninguna decide nada sobre ti: las decisiones clínicas las tomo yo. Nunca se venden ni se usan para publicidad, investigación, docencia o entrenar IA.

### Quién más puede verlos
Solo yo. Los servicios que hacen funcionar la consulta (ficha, transcripción, correo, videollamada, pagos, boletas) actúan por encargo mío, con contrato de confidencialidad; algunos operan fuera de Chile, principalmente en Estados Unidos.

El secreto profesional solo se levanta ante riesgo grave para tu vida o la de otros, vulneración de derechos de niños, niñas o adolescentes, u orden judicial u otro caso legal, y solo en lo necesario, avisándote si es posible.

### Cuánto tiempo se guardan
La ley obliga a guardar la ficha clínica al menos 15 años desde la última anotación (Ley 20.584), aunque termines la terapia; luego se elimina o anonimiza.

### Tus derechos
Puedes acceder a tus datos, corregirlos, eliminarlos (salvo la ficha en su plazo legal), oponerte, bloquearlos o llevártelos, y reclamar ante la Agencia de Protección de Datos Personales. Puedes retirar este consentimiento o cualquier autorización cuando quieras, gratis y sin dar razones, por correo o WhatsApp; no afecta lo ya hecho, y retirar la 2 o la 3 no cambia tu atención.

Proveedores, países, plazos y el detalle de tus derechos: valentinaorellana.cl/condiciones#privacidad.

### Autorizaciones

**1. Tratamiento de mis datos (necesaria para atenderte)**
Leí este documento y autorizo el tratamiento de mis datos personales y de salud para mi atención psicológica, en estos términos.

**2. Grabación de sesiones (opcional)**
Autorizo grabar el audio de mis sesiones para transcribirlo y procesarlo con herramientas tecnológicas, incluida IA, solo para elaborar las notas de mi ficha y preparar mi atención, mediante proveedores por encargo, algunos fuera de Chile (principalmente Estados Unidos). El audio se borra al transcribirse, la transcripción queda en mi ficha y ninguna herramienta decide sobre mi tratamiento. Es voluntario: sin esto me atienden igual, y puedo pedir no grabar una sesión o un momento o retirarlo cuando quiera. En pareja, cada persona firma y solo se graba si todas lo autorizan.

**3. Revisión anónima de casos (opcional)**
Autorizo que mi caso, sin ningún dato que permita reconocerme, se analice con otros psicólogos sujetos a secreto profesional, para mejorar mi atención.

**Notas para quien lo implemente en `consent.ts` (no son para el paciente)**
- `CONSENT_VERSION = '2026-10-v4'`. Los títulos de las secciones 1, 2, 5 y 6 no cambian. La sección "Qué datos y para qué" pasa a llamarse "Tus datos y para qué". Los títulos de las autorizaciones 1 y 2 no cambian. El de la 3 se acorta a "3. Revisión anónima de casos (opcional)".
- El WhatsApp de la sección 1 va fijo en el texto, porque `consentSections` hoy solo recibe el correo.
- **Condición previa a publicar la v4:** los cambios del punto (d) tienen que estar ya publicados en `/condiciones`. Si no, la capa 1 remite a una capa 2 que no tiene el detalle, y el consentimiento deja de ser "informado".

---

## (b) Conteo de palabras

Se contó sobre el texto plano que guarda `consentPlainText`, con el título y los encabezados incluidos.

| Bloque | v3 | v4 |
|---|---|---|
| Quién trata tus datos | 33 | 31 |
| Sobre la atención psicológica | 140 | 83 |
| Qué datos y para qué | 157 | 81 |
| Quién más puede verlos | 184 | 76 |
| Cuánto tiempo se guardan | 127 | 31 |
| Tus derechos | 124 | 74 |
| Autorización 1 | 36 | 29 |
| Autorización 2 | 152 | 97 |
| Autorización 3 | 52 | 29 |
| **Total (con título)** | **1.024** | **549** (−46 %) |

En caracteres, el texto baja de 6.444 a 3.561 (−45 %). Queda algo sobre la mitad. Bajar más obligaría a sacar las urgencias, el reagendamiento o la lista de usos excluidos, y no lo recomiendo (ver la tabla siguiente).

---

## (c) Qué se movió a la política, qué se quitó y por qué es seguro

| Contenido de la v3 | Destino en la v4 | Por qué es seguro |
|---|---|---|
| Lista de categorías largas ("almacenamiento de la ficha clínica y del sitio web…") y "solo pueden usar tus datos para eso" | Resumida entre paréntesis. El detalle está en la capa 2, con nombre y país | El art. 14 ter pide informar destinatarios y transferencias en la **política**. La capa 1 conserva lo esencial: que son encargados, que hay contrato y que están fuera de Chile, principalmente en EE.UU. |
| "La lista actualizada… y puedes pedírmela" | Remisión explícita al link. Lo de "pedírmela" pasa a la política (d.5) | La remisión por capas queda escrita en la capa 1. |
| "Bajo contratos que los obligan a mantenerla segura" | Queda "con contrato de confidencialidad". El párrafo de la transferencia internacional ya está en la política | Las garantías de transferencia (arts. 27 y 28) ya están en la política. |
| IA: "no diagnostican ni evalúan tu riesgo, y no deciden derivaciones ni altas" | En la capa 1 queda "ninguna decide nada sobre ti: las decisiones clínicas las tomo yo". La lista va a la política (d.3) | Lo que exige el art. 14 ter l) es informar que hay o no decisiones automatizadas, y eso se mantiene. |
| "Tus datos nunca se usan para entrenar…, investigación, docencia o publicidad" | Se mantiene, en una frase. También queda en la política (d.3) | Es la limitación de finalidad (art. 12, consentimiento específico). Se conserva en la capa 1. |
| Copias temporales de los proveedores ("por el tiempo limitado que fijan sus contratos") | Solo en la política: 1 día (AssemblyAI) y 30 días o hasta 2 años (Anthropic), y una línea nueva en plazos (d.6) | La política ya los detalla por proveedor. La capa 1 dice "plazos" en la remisión. **Ver la pregunta 1.** |
| Pagos y boletas: plazo tributario | Solo en la política (ya estaba) | No son datos sensibles, y la política ya tiene ese plazo. |
| Audio borrado y transcripción cifrada, en la sección de plazos | Se quitó de la sección de plazos porque se repetía. Queda en la autorización 2 y en la política (d.2 y d.6) | Solo aplica a quien autoriza la 2, y se informa justo donde se decide. |
| ARCO+P explicado uno por uno | Una frase con todos los derechos. El detalle ya está en la política | Los 6 derechos y el límite de la ficha siguen nombrados. |
| Efecto de retirar la grabación ("dejo de grabar, lo transcrito queda en la ficha") | A la política (d.2). En la capa 1 queda que se puede retirar, por correo o WhatsApp, y que no afecta lo ya hecho | El art. 12 exige revocabilidad y que no sea retroactiva, y las dos cosas siguen en la capa 1. |
| Autorización 2: "a pedido de la psicóloga", "con la misma confidencialidad", "cada persona firma su propio consentimiento… todas las personas presentes" | Redactado más corto, con el mismo contenido. El detalle de pareja también va a la política (d.2) | Siguen todos los elementos que pidió Vale: audio, transcripción, IA, notas, encargados fuera de Chile, borrado, ficha, sin decisiones, voluntaria, pausar, retirar y pareja. La regla de pareja respalda el art. 161-A del Código Penal. |
| Autorización 3: "nombre, RUT", "espacio de trabajo comunitario de casos complejos" | "Sin ningún dato que permita reconocerme". El espacio se describe en la política (ya estaba) | "Ningún dato" incluye el nombre y el RUT. La finalidad ("mejorar mi atención") y el secreto profesional se mantienen. |
| Atención psicológica: frases explicativas | Comprimidas, con todo el contenido | Siguen el proceso, que no hay garantía, el término libre, el reagendamiento, la derivación y las urgencias (Ley 20.584, derecho a información). |
| "Los datos de salud son datos sensibles: por eso…" | Se mantiene ("Por ser datos sensibles…") | Es el art. 16: consentimiento expreso. No se toca. |

**Lo que no se quitó:** responsable identificado, finalidad cerrada, sensibilidad, IA sin decisiones, encargados fuera de Chile, secreto profesional y sus excepciones, 15 años, derechos, reclamo ante la Agencia, revocación, urgencias y las 3 autorizaciones.

---

## (d) Cambios necesarios en `/condiciones#privacidad` (texto exacto)

Todos van en `src/pages/condiciones.astro`, dentro de `<div id="privacidad">`. Se mantienen las clases actuales.

**d.1. Versión** (reemplaza la línea "Versión 4 · …"):
> Versión 5 · vigente desde el [fecha en que se publique la v4] de 2026

**d.2. "Usos que requieren tu autorización aparte", reemplaza el `<li>` de Grabación de sesiones:**
> **Grabación de sesiones:** el audio se usa solo para transcribirlo y, con herramientas de apoyo (incluida inteligencia artificial), elaborar las notas clínicas de tu ficha y preparar tu atención. El audio se borra apenas se transcribe; la transcripción y las notas se guardan cifradas como parte de tu ficha. Puedes pedir que una sesión, o un momento de una sesión, no se grabe. Si retiras esta autorización, desde ese momento se deja de grabar y lo ya transcrito queda en tu ficha con la misma confidencialidad. En sesiones de pareja, cada persona firma su propio consentimiento, y solo se graba si todas las personas presentes lo autorizaron.

**d.3. "Para qué se usan", reemplaza el párrafo "Tus datos no se venden, no se ceden para publicidad de terceros y no se toman decisiones automatizadas ni se hacen perfiles sobre ti.":**
> Tus datos no se venden, no se ceden para publicidad de terceros y nunca se usan para entrenar sistemas de inteligencia artificial, ni para investigación o docencia. No se toman decisiones automatizadas ni se hacen perfiles sobre ti. Las herramientas de inteligencia artificial solo ayudan a transcribir y ordenar la información: no diagnostican, no evalúan tu riesgo y no deciden derivaciones ni altas. Todas las decisiones clínicas las toma la psicóloga.

**d.4. "Qué datos se tratan", al final del `<li>` de Pacientes, agrega:**
> Si autorizas la grabación de sesiones, también el audio de tus sesiones y su transcripción escrita.

**d.5. "Quién más puede acceder", después del párrafo "Fuera de esto, tus datos solo se entregan…", agrega:**
> Si quieres, te envío esta lista por correo o WhatsApp. Cuando cambie un proveedor, se actualizará aquí.

**d.6. "Cuánto tiempo se guardan", agrega un `<li>` después del de Ficha clínica:**
> **Audio de las sesiones grabadas:** se borra apenas se transcribe. La transcripción y las notas elaboradas a partir de ella se guardan cifradas en tu ficha, por el mismo plazo. Las copias temporales que pueden guardar los proveedores de transcripción y de inteligencia artificial duran lo que se indica para cada uno en la lista de arriba.

**d.7. "Tus derechos", reemplaza el `<li>` "Retirar tu consentimiento…":**
> **Retirar tu consentimiento** o cualquiera de sus autorizaciones, sin dar razones, por correo o WhatsApp. El retiro no afecta lo que ya se hizo antes, y retirar la autorización de grabación o la de revisión de casos no cambia en nada tu atención.

Nada de esto cambia la sección 04 (secreto profesional) ni la de urgencias, que ya están completas.

---

## (e) Preguntas puntuales para la abogada

1. **Capas y plazos excepcionales.** ¿Cumple con un consentimiento "informado y específico" (Ley 21.719, arts. 12, 14 ter y 16) remitir a `/condiciones#privacidad` la lista nominal de proveedores y los plazos de sus copias temporales, incluido el de Anthropic de **hasta 2 años** cuando su sistema de seguridad marca un posible mal uso? ¿O ese plazo excepcional tiene que estar en la autorización 2? Como la política es una página que cambia, ¿basta con guardar junto a cada firma qué versión de la política estaba vigente (hoy se guarda solo el texto del consentimiento)?
2. **Medio para revocar.** El consentimiento se firma en un link web, y la v4 ofrece retirarlo "por correo o WhatsApp". ¿Eso cumple con el art. 12, que pide revocar por medios "similares" a los usados para dar el consentimiento, gratuitos y siempre disponibles? ¿O hay que agregar un botón para retirar el consentimiento en el mismo link antes de publicar la v4?
