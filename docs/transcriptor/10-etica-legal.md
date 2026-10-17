# Transcriptor IA: ética profesional y cumplimiento legal (Chile)

Fecha: 15 oct 2026 (revisado 16 oct 2026: verificación en LeyChile, Senado y documentación de Anthropic; ver §1 y `11-para-el-abogado.md`). Autor: especialista ética/legal del equipo (Claude). Este documento NO es asesoría legal. Todo lo marcado **NO VERIFICADO — consultar abogado** debe confirmarse antes del lanzamiento.

Parte de: `00-decisiones.md` (decisiones de Vale; aquí no se re-discuten, solo se señalan riesgos).
Base existente revisada: `src/lib/consent.ts` (consentimiento v2, `2026-10-v2`) y `src/pages/condiciones.astro` (política de privacidad v3, 11 oct 2026).

---

## 0. Lo esencial en 6 puntos

1. **RIESGO BLOQUEANTE (legal): “sin grabación no hay atención”.** La Ley 21.719, art. 12, presume que el consentimiento **no es libre** cuando se pide durante la prestación de un servicio en la que esa recolección **no es necesaria**. La psicoterapia puede hacerse sin grabar, así que la presunción probablemente aplica. Si un abogado no la descarta por escrito, la grabación debe ofrecerse como **opcional**, con una alternativa real. Más abajo va un “Plan B” de texto listo para usar.
2. **El resumen IA automático, sin revisión, choca con dos cosas.** El Decreto 41 (arts. 2 y 7) exige que el contenido de la ficha lo registre el profesional, con su identificación y firma. La guía APA 2025 pide supervisión humana. Mitigación sin pedirle a Vale que apruebe nada: el resumen IA es un **anexo auxiliar**, rotulado “no revisado”, y **no reemplaza** la evolución clínica firmada.
3. **La transferencia a EE.UU. es habitual.** Por eso no basta el consentimiento: el art. 27 de la Ley 21.719 exige **cláusulas contractuales con garantías adecuadas**. Los DPA de AssemblyAI y Anthropic traen cláusulas tipo de la UE, y está **NO VERIFICADO** si sirven para Chile mientras la Agencia no publique sus cláusulas modelo.
4. **Hallazgo técnico con impacto legal (resuelto por la decisión del 16 oct).** La **Batch API de Anthropic NO está cubierta por su BAA** y guarda los datos 29 días. Vale decidió usar la Messages API normal con la organización en modo HIPAA (ver `01-decisiones-16oct.md`); con HIPAA, la Batch API queda bloqueada (error 400). Una pareja online pasa por Fly.io → AssemblyAI → Anthropic → R2/B2, y cada eslabón necesita su contrato de encargado (art. 15 bis).
5. **Clave de cifrado.** Si se pierde la clave AES de R2/B2, se pierde la ficha, y eso incumple los 15 años de conservación (Decreto 41, arts. 8 y 11). Se necesita una copia de la clave fuera del sistema.
6. **La “revisión mensual por Claude” y los autochequeos** nunca deben leer contenido clínico real, solo métricas y registros sin contenido.

---

## 1. Marco legal verificado

Las fuentes primarias se leyeron el 15 oct 2026. La Ley 21.719 se leyó desde el PDF oficial del Diario Oficial. El 16 oct 2026 se verificaron en el **texto oficial de LeyChile** (servicio JSON de la BCN, que sí responde aunque la página web devuelva 401): Ley 19.628 vigente y su versión diferida desde el 1 dic 2026, Código Penal art. 161-A y Ley 20.584 vigente. El estado del proyecto de postergación se verificó en el servicio público de tramitación del Senado.

**Fuentes primarias**
- **[L21719]** Ley 21.719, Diario Oficial 13-12-2024, CVE 2583630: https://www.diariooficial.interior.gob.cl/publicaciones/2024/12/13/44023/01/2583630.pdf
- **[L19628]** Ley 19.628, texto oficial LeyChile (última versión vigente hasta el 30-11-2026 y versión diferida desde el 01-12-2026): https://www.bcn.cl/leychile/navegar?idNorma=141599 — leído vía https://nuevo.leychile.cl/servicios/Navegar/get_norma_json?idNorma=141599 y `...&idVersion=2026-12-01` [verificado 16 oct]. Copia DIPRES: https://www.dipres.gob.cl/598/articles-51683_Otrasleyes_ley19628.pdf
- **[L20584]** Ley 20.584, texto original de 2012 publicado por la Superintendencia de Salud: https://superdesalud.gob.cl/664/articles-7564_recurso_1.pdf
  - Texto vigente (última versión desde 16-02-2026) en LeyChile: https://www.bcn.cl/leychile/navegar?idNorma=1039348, leído vía https://nuevo.leychile.cl/servicios/Navegar/get_norma_json?idNorma=1039348 [verificado 16 oct]. Arts. 12 y 13 fueron modificados por la Ley 21.541 (D.O. 17-03-2023, telemedicina) y la Ley 21.668 (D.O. 28-05-2024); art. 14 por las Leyes 21.331, 21.509 y 21.541; art. 5 solo en su letra b) (Ley 21.371), la letra c) sigue igual.
- **[D41]** Decreto 41/2012 Minsal, Reglamento sobre fichas clínicas: https://www.superdesalud.gob.cl/app/uploads/2012/12/articles-12707_recurso_1.pdf
- **[L21331]** Ley 21.331 de salud mental, Diario Oficial 11-05-2021: https://www.diariooficial.interior.gob.cl/publicaciones/2021/05/11/42951/01/1942112.pdf
- **[CEP]** Código de Ética Profesional del Colegio de Psicólogos de Chile, copia publicada por FACSO U. de Chile: https://facso.uchile.cl/dam/jcr:469ed1d2-b7d3-463d-b358-af357dd7f6b6/codigo_de_etica%20Psicologos%20Chile%201996.pdf
  - Que esta sea la **versión vigente** está **NO VERIFICADO**. El sitio del Colegio no respondió; hay que confirmarlo con el Colegio.
- **[APA]** APA, *Ethical Guidance for AI in the Professional Practice of Health Service Psychology* (junio 2025, actualizada julio 2025): https://www.apa.org/topics/artificial-intelligence-machine-learning/ethical-guidance-professional-practice.pdf

**Proveedores**
- **[ANT-RET]** Anthropic, retención de datos API: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data y https://docs.anthropic.com/en/docs/build-with-claude/zero-data-retention
- **[ANT-BAA]** Anthropic, BAA para clientes comerciales: https://privacy.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers
- **[ANT-DPA]** Anthropic, Data Processing Addendum: https://www.anthropic.com/legal/data-processing-addendum
- **[AAI-DPA]** AssemblyAI, DPA: https://www.assemblyai.com/legal/data-processing-addendum
- **[AAI-RET]** AssemblyAI, retención: https://www.assemblyai.com/docs/faq/how-long-are-outputs-retained

**Otras fuentes**
- **[CP161A]** Código Penal, art. 161-A (texto de la Ley 19.423, D.O. 20-11-1995), texto oficial LeyChile: https://www.bcn.cl/leychile/navegar?idNorma=1984, leído vía https://nuevo.leychile.cl/servicios/Navegar/get_norma_json?idNorma=1984 (última versión desde 20-08-2026) [verificado 16 oct].
- **[POST]** Proyecto de postergación de la Ley 21.719, Boletín 18.623-07. Ficha oficial del Senado: https://tramitacion.senado.cl/appsenado/templates/tramitacion/index.php?boletin_ini=18623-07 (datos leídos de https://tramitacion.senado.cl/wspublico/tramitacion.php?boletin=18623) y mensaje presidencial: https://www.senado.cl/appsenado/index.php?mo=tramitacion&ac=getDocto&iddocto=19307&tipodoc=mensaje_mocion [verificado 16 oct]. Fuente secundaria previa: alerta Cariola https://www.cariola.cl/app/uploads/2026/09/Alerta-legal_-2septiembre.pdf

### Tabla

| Norma | Qué exige (verificado) | Cómo lo cumple el diseño | Fuente |
|---|---|---|---|
| L21719, disp. transitoria art. 1° | Las modificaciones a la Ley 19.628 rigen desde el “primero del mes vigésimo cuarto” tras la publicación (13-12-2024), es decir, el **1 dic 2026** (LeyChile marca la versión diferida “Entra en vigencia el 01-DIC-2026”). El Boletín 18.623-07 (mensaje, ingresado al Senado el 01-09-2026) propone reemplazar esa fecha por el **1 dic 2027**. **Estado al 16 oct 2026: primer trámite constitucional en el Senado, primer informe de la Comisión de Constitución, urgencia “suma” renovada el 06-10-2026; sin votaciones. NO es ley**: hoy la fecha vigente sigue siendo el 1 dic 2026. | Se diseña para cumplir la Ley 21.719 desde el día 1, aunque se posponga. | [L21719] p. transitorias; [POST] |
| L19628 (vigente hasta el 30 nov 2026), art. 10 | Los datos sensibles (incluye “estados de salud físicos o psíquicos”, art. 2 g) no pueden tratarse salvo “cuando la ley lo autorice, exista consentimiento del titular o sean datos necesarios para la determinación u otorgamiento de beneficios de salud que correspondan a sus titulares”. Texto de arts. 2 g y 10 cotejado con LeyChile [verificado 16 oct]. | Consentimiento expreso v3 firmado antes de la primera grabación. | [L19628] |
| L21719, art. 3 (principios) | Finalidad específica; **proporcionalidad**: conservar solo el tiempo necesario y luego suprimir o anonimizar; seguridad. | El audio se borra tras transcribir. La conservación de la transcripción completa por 15 años depende de que sea parte de la ficha (pregunta al abogado n.º 2). | [L21719] art. 3 b, c, f |
| L21719, art. 12 | Consentimiento **libre, informado, específico, previo e inequívoco**. Revocable en cualquier momento, sin expresión de causa, por medios similares a los usados para darlo, **gratuitos y permanentemente disponibles**. Sin efecto retroactivo. Se **presume no libre** cuando se recaba en un servicio “en que no es necesario efectuar esa recolección”. La carga de la prueba es del responsable. (Presunción y revocación cotejadas con la versión diferida de LeyChile, art. 12 [verificado 16 oct].) | Firma con hash y `text_snapshot` (ya existe). Botón o link de revocación permanente (falta). **Condicionar la atención a la grabación: RIESGO BLOQUEANTE**, ver §3 y Plan B. | [L21719] art. 12 |
| L21719, art. 16 | Datos sensibles: solo con consentimiento **expreso**, escrito, verbal o por medio tecnológico equivalente, salvo excepciones. | Consentimiento v3 electrónico expreso, un checkbox por autorización. | [L21719] art. 16 |
| L21719, art. 16 bis | Datos de salud: solo “para los fines previstos por las leyes especiales en materia sanitaria”. Sin consentimiento solo en casos tasados; uno de ellos es la letra e): “prestación de asistencia o tratamiento de tipo sanitario”. | La grabación y la IA se usan solo para la ficha y la atención. Nunca para otros fines, entrenamiento ni marketing. | [L21719] art. 16 bis |
| L21719, art. 16 ter | Datos biométricos: incluye “la voz” cuando permite la **identificación única**. | La diarización separa hablantes, pero no está claro que identifique de forma única. **NO VERIFICADO** si cuenta como dato biométrico (pregunta n.º 7). No usar identificación por huella de voz. | [L21719] art. 16 ter |
| L21719, art. 16 quáter | Menores de 14: consienten los padres. Datos sensibles de menores de 16: consienten los padres. De 16 a 17: reglas de adultos. Siempre prima el interés superior del menor. | El sitio atiende “Adultos y Parejas” (agenda.astro). **Regla: no se graba a ningún menor** (§4). | [L21719] art. 16 quáter |
| L21719, art. 8 bis | Derecho a no ser objeto de **decisiones automatizadas** con efectos jurídicos o significativos. | La IA no decide nada: ni diagnósticos, ni altas, ni derivaciones, ni riesgo. Debe decirse explícitamente. | [L21719] art. 8 bis |
| L21719, art. 14 ter | La política pública debe tener, entre otros: datos tratados, destinatarios, finalidades, base de licitud, seguridad, derechos ARCO+P, reclamo ante la Agencia, **transferencia internacional y si el país es adecuado o qué garantías existen**, plazo de conservación, derecho a retirar el consentimiento y **existencia de decisiones automatizadas** (l). | Cambios concretos a `/condiciones#privacidad` en §3.2. | [L21719] art. 14 ter |
| L21719, art. 14 quáter y 14 quinquies | Privacidad desde el diseño y por defecto; seguridad adecuada al riesgo, con **cifrado**, resiliencia, restauración y verificación periódica. | AES-GCM en R2 y B2, borrado del audio, TTL de 1 día en AssemblyAI y autochequeos diarios. Falta la custodia de la clave (§4). | [L21719] arts. 14 quáter y 14 quinquies |
| L21719, art. 14 sexies | Reportar a la Agencia las brechas con riesgo. Con **datos sensibles** también se avisa a cada titular, en lenguaje claro. | Agregar un protocolo de brecha (§4.12). | [L21719] art. 14 sexies |
| L21719, art. 15 bis | El encargado trata los datos solo según el encargo. Se requiere **contrato** con objeto, duración, finalidad, tipo de datos, categorías de titulares y derechos y obligaciones. El encargado no puede subdelegar sin autorización escrita. Al terminar, suprime o devuelve los datos. | Revisar y guardar el DPA de AssemblyAI (más el BAA ya firmado), Anthropic, Fly.io, Cloudflare R2, Backblaze B2, Vercel y Supabase. Lista de subencargados. | [L21719] art. 15 bis; [AAI-DPA]; [ANT-DPA] |
| L21719, art. 15 ter | **Evaluación de impacto (EIPD)** previa cuando sea probable un alto riesgo (por la tecnología usada o los fines). Siempre en los casos de la lista (a–d). | Recomendado: una EIPD breve antes del lanzamiento (salud mental, IA nueva, transferencia a EE.UU.). Pregunta n.º 9. | [L21719] art. 15 ter |
| L21719, arts. 27 y 28 | Transferencia internacional lícita si (a) el país es adecuado, (b) hay **cláusulas contractuales u otros instrumentos con garantías adecuadas**, o (c) hay certificación. Sin esto, solo se permite una transferencia **específica y no habitual** con consentimiento expreso. La Agencia publicará la lista de países adecuados y cláusulas modelo. | Las transferencias del transcriptor son **habituales**, así que el consentimiento no basta y hacen falta cláusulas. Los DPA de AssemblyAI y Anthropic incluyen las SCC de la UE; su suficiencia para Chile está **NO VERIFICADA** (pregunta n.º 4). | [L21719] arts. 27 y 28; [ANT-DPA]; [AAI-DPA] |
| L21719, art. 11 | Derechos ARCO+P: acuse de recibo y respuesta en **30 días corridos**, prorrogables una vez por 30. Respuesta escrita, guardando la prueba del envío. | El procedimiento se describe en el consentimiento y la política (§2, §3.2). | [L21719] art. 11 |
| L21719, arts. 7 y 8 ter | La supresión no procede cuando el tratamiento es necesario para cumplir una obligación legal (como la ficha). Bloqueo temporal mientras se resuelve una solicitud. | Se explica que la ficha (y la transcripción, si el abogado confirma que es parte de ella) no se borra antes de 15 años. | [L21719] arts. 7 y 8 ter |
| L20584, art. 5 c) | Respetar la vida privada y la honra del paciente, “en especial” en grabaciones, “cualquiera que sea su fin o uso”. Exige autorización **escrita** solo para fines periodísticos o publicitarios. | Grabación solo con consentimiento escrito de todos los presentes, aunque la ley no lo exija literalmente para fines clínicos. | [L20584] art. 5 |
| L20584, arts. 12 y 13 (texto vigente, modificado por Leyes 21.541 y 21.668) | La ficha es el instrumento obligatorio que registra “el conjunto de antecedentes” y puede ser electrónica si se asegura acceso, conservación, confidencialidad y autenticidad del contenido y de sus cambios. Todo es dato sensible. Se conserva **al menos 15 años**; el prestador responde del cumplimiento de la Ley 19.628. Los terceros no relacionados directamente con la atención no tienen acceso, “independiente de la modalidad de atención”. Pueden acceder o recibir copia: el titular, su representante o sus herederos; un tercero con poder simple ante notario **o firmado con firma electrónica** (Ley 19.799); los tribunales; fiscales y abogados con autorización judicial; ISP, Minsal, Superintendencias y profesionales que participan directamente en la atención (continuidad). El titular puede pedir **copia íntegra gratuita, sin dilación, en formato estructurado y portable** [verificado 16 oct en LeyChile]. | Retención de 15 años y acceso solo de Vale. Los proveedores, como encargados, no “acceden” con fines propios. **NO VERIFICADO** si un encargado técnico con acceso al texto en claro (Anthropic, AssemblyAI) es un “tercero” en el sentido del art. 13 (pregunta n.º 3). | [L20584] arts. 12 y 13 |
| L20584, art. 14 | Consentimiento informado para procedimientos y tratamientos, libre, voluntario, expreso e informado. Desde la Ley 21.541 (2023), para **prestaciones de salud digital** el consentimiento puede ser verbal, pero el prestador debe registrar la aceptación o rechazo por escrito o con firma electrónica y dejar constancia en la ficha [verificado 16 oct]. | El consentimiento v3 queda en la ficha (D41 art. 6 d). | [L20584] art. 14 |
| D41, art. 2 | La ficha se registra “por el profesional que efectúa la prestación, en el acto de otorgarla o inmediatamente después”. | **RIESGO**: el resumen IA no lo registra la profesional. Se trata como anexo auxiliar, no como evolución (§4.6). | [D41] art. 2 |
| D41, art. 4 | “Deberá existir una ficha clínica de cada paciente”. | **RIESGO**: “pareja = UNA ficha” (decisión de Vale). **NO VERIFICADO** si cumple cuando ambos son pacientes (pregunta n.º 5). | [D41] art. 4 |
| D41, art. 6 c) y d) | Registro cronológico de las atenciones “y cualquier otra información clínica”. Los documentos que se agreguen llevan el n.º de ficha. Incluye los consentimientos informados. | Cada transcripción y cada resumen guardan el `patient_id` / n.º de ficha, la fecha y la sesión. | [D41] art. 6 |
| D41, art. 7 | Cada registro nuevo lleva la identificación y **firma** del profesional. | La evolución firmada sigue siendo de Vale. El resumen IA se rotula y no se firma. | [D41] art. 7 |
| D41, art. 8 | Ficha electrónica: respaldo en cada incorporación, **copia de seguridad en un segundo centro** con control de acceso, barreras contra accesos no autorizados y restauración rápida. | R2 más B2 (copia), respaldo semanal de Supabase. Falta: respaldo de la clave y prueba de restauración (§4.11). | [D41] art. 8 |
| D41, art. 9 | Acceso controlado y **registro de fechas y personas que han accedido** a las fichas. | **Obligatorio**: registro de accesos a transcripciones, resúmenes y Q&A (§4.10). | [D41] art. 9 |
| D41, arts. 11 y 12 | Conservación mínima de 15 años **desde el último ingreso**. La eliminación posterior requiere un acta protocolizada ante notario (prestador privado). | Borrado a los 15 años desde la última anotación, con acta notarial. Nunca automático sin acta. | [D41] arts. 11 y 12 |
| L21331, arts. 4 y 9 n.º 3 | Salud mental: consentimiento libre e informado con información “suficiente, continua y en lenguaje comprensible”; se vela “especialmente” por la vida privada. | Texto cálido y claro, y recordatorio verbal en cada sesión (§4.3). | [L21331] |
| CEP art. 11, n.º 5 y 6 | El secreto profesional dura indefinidamente y alcanza “incluso el nombre del paciente”. Confidencialidad: manejar los antecedentes con procedimientos que los resguarden de personas no autorizadas. | Cifrado, acceso solo de Vale, proveedores que no entrenan con los datos. | [CEP] |
| CEP art. 11, n.º 7 | “El psicólogo/a puede aceptar o rechazar a los clientes con entera libertad”. | Respaldo **ético** de que Vale puede fijar sus condiciones de atención. No resuelve el riesgo **legal** del art. 12 de la Ley 21.719. | [CEP] |
| CEP art. 11, n.º 10 | Si se interrumpe el servicio, hacer esfuerzos razonables para planificar la continuación, pensando en el bienestar del cliente. | Revocar implica cierre cuidado más derivación (§2). | [CEP] |
| CEP art. 14, n.º 1 | Solo el psicólogo aplica, corrige e **interpreta** procedimientos de diagnóstico, y no delega su uso en personas ajenas a la profesión. | La IA nunca interpreta ni diagnostica (§4.6). | [CEP] |
| CEP art. 15, n.º 3 | En investigación: consentimiento expreso y escrito cuando haya “registros, filmaciones y/o grabaciones”. | Por analogía, el mismo estándar se aplica a la clínica. **Nunca usar las grabaciones para investigación o docencia** sin un consentimiento aparte. | [CEP] |
| CP art. 161-A | Reclusión menor (cualquier grado) y multa de 50 a 500 UTM a quien, “en recintos particulares o lugares que no sean de libre acceso al público, sin autorización del afectado y por cualquier medio, capte, intercepte, grabe o reproduzca conversaciones o comunicaciones de carácter privado”. Igual pena a quien las **difunda**; si es la misma persona que obtuvo y divulgó, pena agravada (grado máximo, 100 a 500 UTM). No aplica a quien esté autorizado por ley o por un juez [texto oficial verificado 16 oct]. | Nunca se graba a nadie que no haya firmado, incluidas terceras personas presentes (§4.1). Nunca se difunde una grabación o transcripción. | [CP161A] |
| APA 2025 (orientación, no norma chilena) | Informar en el consentimiento cuándo, cómo y qué IA se usa. Derecho a **optar por no usar** IA, con alternativas: atención sin IA, lista de espera o derivación. **Supervisión humana** (“human in the loop”). Evaluar críticamente el contenido de la IA. El psicólogo sigue siendo responsable. | El consentimiento nombra las herramientas y sus límites. Vale no quiere aprobar nada, así que **hay brecha con la APA**: mitigar con un rótulo de no revisado y no usar el resumen como evolución (§4.6). | [APA] secc. 1, 4 y 5 |
| Anthropic (contrato) | Messages API: entradas y salidas se borran del backend dentro de 30 días por política estándar; **no hay endpoint para borrarlas antes**; si un sistema de seguridad marca el contenido, hasta 2 años (también con HIPAA o ZDR). **Batch API: guarda hasta 29 días; sí se puede borrar con `DELETE /v1/messages/batches/{id}` una vez terminado** (corrección: el texto anterior decía “sin borrado a pedido” también para Batch). **El BAA NO cubre la Batch API** y con HIPAA readiness queda bloqueada (400). No entrena con los datos. El DPA reconoce a Anthropic como encargado, con SCC de UE/Reino Unido/Suiza. | **Decisión 16 oct: Messages API + organización en HIPAA readiness (BAA estándar de Anthropic), sin Batch** (§4.13). Pregunta n.º 6. | [ANT-RET]; [ANT-BAA]; [ANT-DPA]; https://platform.claude.com/docs/en/manage-claude/api-and-data-retention |
| AssemblyAI (contrato) | El DPA dice: AssemblyAI es encargado, procesa principalmente en EE.UU. y no entrena con los datos si hay BAA u opt-out. TTL configurable; DELETE borra el texto pero deja metadatos. Existe residencia en la UE (`api.eu.assemblyai.com`). | BAA firmado, TTL de 1 día y entrenamiento desactivado (según `00-decisiones`). Guardar el PDF del DPA y del BAA firmados. | [AAI-DPA]; [AAI-RET] |

---

## 2. Consentimiento v3: grabación y procesamiento con IA (texto completo propuesto)

Notas de implementación (para el equipo, no se muestran al paciente):
- Va **dentro** del consentimiento informado existente (`consent.ts`). Se sube `CONSENT_VERSION` a `2026-1x-v3`.
- Las secciones “Quién trata tus datos”, “Sobre la atención psicológica”, “Tus derechos”, etc. se mantienen. Lo nuevo reemplaza la opción 2 actual (que dice “opcional” y menciona Encuadrado).
- **Pareja: cada persona firma por separado**, con su propio link o token, nombre y RUT. El sistema solo habilita la grabación cuando **ambas** firmas están vigentes.
- `[correo]` = consulta@valentinaorellana.cl y `[WhatsApp]` = +56 9 7273 5696, igual que en `/condiciones`.
- Si el abogado **no** valida “grabación como condición”, se usa el **Plan B** que va al final de esta sección.

---

### Grabación de sesiones y uso de inteligencia artificial

**Por qué te pido esto**
En mi consulta grabo el audio de las sesiones para que nada importante de lo que conversamos se pierda. Así puedo estar presente contigo en la sesión, en vez de estar tomando notas, y retomar con precisión lo que acordamos. Te lo explico con calma para que decidas informadamente.

**Qué se graba**
- Solo el **audio** de la sesión: nunca video ni imagen.
- En sesiones presenciales grabo desde mi teléfono, que dejo en modo avión. En sesiones online entra a la videollamada un asistente llamado **“Notas Ps. Valentina Orellana”**. Lo verás en la lista de participantes, yo lo admito y se retira al terminar.
- Al comenzar te recordaré que estamos grabando. Nunca grabo a escondidas ni fuera del horario de la sesión.

**Para qué se usa (y para qué no)**
- Para **transcribir** la sesión (pasar el audio a texto) y guardar esa transcripción en tu ficha clínica.
- Para que una herramienta de **inteligencia artificial (IA)** prepare un **resumen automático** de la sesión: los temas principales, las tareas o acuerdos y lo que conviene retomar la próxima vez.
- Para que yo pueda **hacerle preguntas** a la IA sobre tus sesiones anteriores (por ejemplo, “¿qué dijimos sobre el trabajo en marzo?”) y así preparar mejor nuestros encuentros.
- **Nunca** se usa para investigación, docencia, publicidad ni para entrenar sistemas de IA. Nunca se vende ni se comparte con nadie más.

**La IA es una ayuda, no tu terapeuta**
- **Ninguna IA toma decisiones sobre ti ni sobre tu tratamiento.** No diagnostica, no evalúa tu riesgo, no decide derivaciones ni altas. Todas las decisiones clínicas las tomo yo, como psicóloga responsable.
- El resumen automático queda **marcado claramente como “Resumen automático (IA)”**. Puede tener errores u omisiones, por eso **no reemplaza mis propias notas clínicas**. Puedes pedirme verlo y, si algo no te representa, pedir que se corrija o que se deje constancia de tu versión.
- La IA **no vigila tu seguridad entre sesiones** ni da aviso de emergencias. Si estás en crisis, sigue valiendo lo de siempre: llama al *4141, a Salud Responde 600 360 7777 o al SAMU 131, o acude a urgencias.

**Quién procesa tu información y dónde**
Para esto uso estos servicios, que trabajan por encargo mío, solo para este fin, con contratos que los obligan a mantener la confidencialidad y que les prohíben usar tus datos para entrenar sus sistemas:
- **AssemblyAI** (Estados Unidos): convierte el audio en texto.
- **Anthropic** (Estados Unidos), creador de la IA Claude: prepara el resumen y responde mis preguntas.
- **Fly.io** (Estados Unidos): hace funcionar el asistente que entra a las videollamadas.
- **Cloudflare** y **Backblaze** (servidores en el extranjero): guardan las transcripciones **cifradas**, una copia principal y un respaldo.
- Este sitio web (Vercel y Supabase): es el único lugar desde donde se puede ver la información, solo con mi clave.

Estados Unidos aún no ha sido declarado por la autoridad chilena como país con nivel adecuado de protección de datos. Por eso solo trabajo con proveedores que se obligan por contrato a proteger tu información con garantías equivalentes.

**Cuánto tiempo se guarda cada cosa**
- **Audio**: se **borra** apenas termina la transcripción. No guardo grabaciones de audio.
- **Copias temporales en los proveedores**: AssemblyAI borra su copia en un máximo de [1 día]. Anthropic borra lo que procesa en un máximo de 30 días y no permite borrarlo antes; solo si sus sistemas de seguridad marcan un contenido como posible infracción de sus políticas puede conservarlo hasta 2 años.
- **Transcripción y resumen**: se guardan **cifrados** como parte de tu ficha clínica durante el plazo que exige la ley para las fichas: **al menos 15 años desde la última anotación** (Ley 20.584 y Decreto 41 de 2012). Después se eliminan de forma segura, dejando constancia ante notario como exige el reglamento.

**Si es una sesión de pareja**
- Las dos personas firman este consentimiento, cada una por separado. Si una de las dos no firma o retira su autorización, **esa sesión no se graba**.
- Lo que se dice en la sesión conjunta queda en la ficha de la pareja. Si uno de ustedes pide una copia de una transcripción, cuidaré la privacidad del otro según lo que la ley permita.

**En la sesión siempre puedes**
- Pedirme que **pausemos la grabación** en un momento puntual, sin dar explicaciones. Dejaré constancia de la pausa, no de lo que se dijo en ella.
- Preguntarme cualquier duda sobre cómo funciona esto.
- Avisarme si hay otra persona contigo (presente o conectada). No se graba a nadie que no haya firmado este consentimiento.

**Qué pasa si no aceptas o si después retiras tu autorización**
Hoy trabajo con este sistema en todas mis sesiones, porque es parte de cómo aseguro la calidad de mi atención. Por eso, si no aceptas la grabación, no podré comenzar un proceso contigo. Y si más adelante la retiras, no podré seguir atendiéndote de la misma forma.

Quiero que sepas que **retirar tu autorización es un derecho que puedes ejercer en cualquier momento, sin dar razones, y lo voy a respetar sin juicio**. Si lo haces:
- **Dejo de grabar de inmediato**, desde ese momento.
- Lo ya grabado y transcrito no se “des-hace”: queda en tu ficha, con la misma confidencialidad, durante el plazo legal. Si me lo pides, **dejaré de usar la IA** sobre esas transcripciones.
- Te ofrezco **una sesión de cierre sin grabación**, para cuidar lo que hemos avanzado.
- Te recomendaré **colegas de confianza** que trabajen sin grabación y, si lo autorizas, les enviaré la información necesaria para que tu proceso continúe sin empezar de cero.

**Tus derechos sobre esta información**
Puedes pedir en cualquier momento y gratis, escribiendo a [correo] o por [WhatsApp]:
- **Acceso**: saber qué hay sobre ti y recibir una copia de tus transcripciones y resúmenes.
- **Rectificación**: corregir algo inexacto, o dejar constancia de tu versión.
- **Supresión**: borrar datos que no deban conservarse. La ficha clínica, incluidas sus transcripciones, debe guardarse el plazo legal.
- **Oposición y bloqueo**: oponerte a un uso específico (por ejemplo, que se le hagan preguntas a la IA sobre tus sesiones) o pedir que se suspenda mientras resolvemos tu solicitud.
- **Portabilidad**: recibir tus datos en un formato que puedas llevar a otro profesional.
- **Retirar este consentimiento**, por el mismo medio por el que lo diste (este link, correo o WhatsApp).

Te responderé por escrito en un máximo de 30 días corridos. Si no quedas conforme, puedes reclamar ante la **Agencia de Protección de Datos Personales**.

**Autorización (marca para aceptar)**
☐ **Grabación y procesamiento con IA (necesaria para atenderte en esta consulta).** Declaro que leí y entendí esta información. Autorizo que se grabe el audio de mis sesiones, que se transcriba y que se procese con inteligencia artificial por los proveedores nombrados, incluido su procesamiento en Estados Unidos, para los fines descritos. Sé que puedo pedir pausas, retirar esta autorización en cualquier momento y ejercer mis derechos como se indica arriba.

*Nombre completo · RUT o documento · Fecha y hora (se registran automáticamente)*
*(Sesión de pareja: cada integrante firma su propio formulario.)*

---

### Plan B (si el abogado no valida la grabación como condición de atención)

Se reemplazan el bloque “Qué pasa si no aceptas…” y el título del checkbox:

> **Esta autorización es voluntaria.** Si no la das, o si la retiras después, te atiendo igual: tomo mis notas a mano, como se ha hecho siempre, y nada cambia en la calidad ni en el precio de tu atención. Si la retiras, dejo de grabar desde ese momento; lo ya transcrito queda en tu ficha con la misma confidencialidad y, si me lo pides, dejo de usar la IA sobre ello.
>
> ☐ **Grabación y procesamiento con IA (opcional).** …(mismo texto de la declaración)…

Nota para Vale: el Plan B también es lo que recomienda la APA (opción de no usar IA, con una alternativa real).

---

## 3. Aviso antes de reservar y cambios a la política de privacidad

### 3.1 Aviso breve antes de reservar

Ubicación: en `/agenda`, antes del pago. Un checkbox obligatorio que, al marcarse, guarde la marca de tiempo y la versión del aviso junto a la reserva.

> **Antes de reservar: mis sesiones se graban.**
> Para cuidar la calidad de tu atención, grabo el audio de todas las sesiones (no video). Se transcribe y una inteligencia artificial prepara un resumen que solo yo veo. El audio se borra después de transcribir, y el texto se guarda cifrado en tu ficha clínica por el plazo legal (15 años). Algunos proveedores procesan la información en Estados Unidos. Ninguna IA toma decisiones sobre tu tratamiento.
> Antes de tu primera sesión firmarás un consentimiento con todos los detalles. En terapia de pareja firman ambos. **Si prefieres no ser grabado/a, por ahora no puedo atenderte**, pero con gusto te recomiendo colegas.
> [Leer más en la política de privacidad →](/condiciones#privacidad)
>
> ☐ Entiendo que las sesiones se graban y se procesan con IA, y que firmaré un consentimiento antes de la primera sesión.

Notas:
- Este checkbox **no reemplaza** el consentimiento firmado. Solo informa antes de pagar, para evitar que alguien pague y luego no pueda atenderse.
- **Recomendación:** si alguien paga y después no firma, devolverle el 100%. Agregarlo en `/condiciones`, sección 01 · Pagos.
- Con el Plan B, la última frase en negrita cambia a: “Es voluntario: si prefieres no ser grabado/a, te atiendo igual, con notas manuales.”

### 3.2 Cambios concretos a `/condiciones` (sección 05 · Privacidad → versión 4)

1. **Encabezado**: “Versión 4 · vigente desde el [fecha]”.
2. **“Qué datos se tratan”, viñeta Pacientes**: agregar “el **audio** de las sesiones (que se borra después de transcribirlo), su **transcripción** escrita y un **resumen automático** generado con inteligencia artificial”.
3. **“Para qué se usan y con qué base legal”**: agregar la viñeta “Grabación, transcripción y resumen con IA de las sesiones: con tu **consentimiento expreso** firmado aparte, para llevar tu ficha clínica y preparar tus sesiones. Es condición para atenderse en esta consulta [Plan B: es voluntario].”
4. **“Usos que requieren tu autorización aparte”**:
   - **Eliminar** la frase “que puedes negar o retirar sin que cambie tu atención” para la grabación (con Plan A deja de ser cierta). Mantenerla solo para la revisión anónima de casos.
   - Reemplazar la viñeta de grabación por: “Grabación de sesiones y procesamiento con IA: ver consentimiento informado. Si la retiras, dejo de grabar de inmediato y te ofrezco un cierre y una derivación.”
5. **“Quién más puede acceder”**:
   - Agregar “**AssemblyAI** (EE.UU.): transcripción del audio”, “**Anthropic** (EE.UU.): resumen y consultas con IA (Claude)”, “**Fly.io** (EE.UU.): asistente de videollamada que graba las sesiones online” y “**Cloudflare** y **Backblaze**: almacenamiento cifrado de transcripciones y respaldos”.
   - Revisar la viñeta de Encuadrado: si deja de usarse para transcribir, cambiar a “registros anteriores” o eliminarla. Supabase, en su línea actual, agregar “y respaldo semanal cifrado”.
6. **“Transferencia internacional”**: agregar “En particular, el audio y las transcripciones de las sesiones se procesan en Estados Unidos (AssemblyAI y Anthropic). Las garantías son contratos de encargo con cláusulas de protección de datos, la prohibición de usar tu información para entrenar sistemas de IA y el borrado de las copias del proveedor en un máximo de 1 día (AssemblyAI) y 30 días (Anthropic).” La redacción exacta de las “garantías” depende de la pregunta n.º 4 al abogado.
7. **Frase actual “no se toman decisiones automatizadas ni se hacen perfiles sobre ti”**: mantenerla y precisarla (art. 14 ter l): “Se usa inteligencia artificial para transcribir y resumir sesiones y para ayudar a la psicóloga a buscar información en ellas, pero **ninguna decisión sobre ti o tu tratamiento se toma de forma automatizada**: todas las toma la psicóloga.”
8. **“Cuánto tiempo se guardan”**: agregar “**Audio de sesiones:** se borra al terminar la transcripción. **Transcripciones y resúmenes:** como parte de la ficha clínica, al menos 15 años desde la última anotación.”
9. **“Cómo se protegen”**: agregar “Las transcripciones se guardan **cifradas** (AES-GCM) en dos servicios distintos, y la clave no la tienen los proveedores de almacenamiento. Cada acceso a las transcripciones y resúmenes queda registrado (fecha, hora y quién).”
10. **“Tus derechos”**: agregar “Se responde por escrito en un máximo de 30 días corridos, prorrogable una vez por otros 30 (art. 11, Ley 19.628 modificada por la Ley 21.719).” Y también: “Para retirar el consentimiento de grabación puedes usar el mismo link del consentimiento, el correo o el WhatsApp.”
11. **Sección 04 · Confidencialidad**: agregar una línea: “Las sesiones se graban en audio según el consentimiento informado (ver sección 05).”
12. **Coherencia**: el texto de “Pasos a seguir” (`src/lib/stepsContent.ts`, paso 02) y el correo de consentimiento (`whatsappConsentMessage`) deben mencionar la grabación.

---

## 4. Salvaguardas éticas obligatorias del sistema

Cada salvaguarda indica qué la exige. “Debe” significa que es requisito para lanzar.

### 4.1 Consentimiento como bloqueo técnico
- **No hay grabación sin consentimiento v3 vigente** de cada persona presente. El botón “Grabar” queda deshabilitado y el bot de Meet no se despacha si:
  - el paciente (o **cualquiera de los dos** en pareja) no tiene un consentimiento v3 firmado,
  - el consentimiento fue revocado, o
  - la versión firmada es anterior a la v3.
- El chequeo se hace **en el servidor** al iniciar la grabación, no solo en la interfaz. Exigencias: Ley 21.719 arts. 12 y 16; CP art. 161-A.
- **Consentimientos v2 existentes**: la autorización 2 de la v2 (Encuadrado, opcional) **no** cubre IA ni EE.UU. vía AssemblyAI/Anthropic. Hay que firmar de nuevo la v3.
- **Terceros**: si aparece otra persona (en el box o en la llamada), Vale detiene la grabación. El bot debe **negarse a grabar** si en la llamada hay más participantes que los esperados (ej.: individual, más de 2 humanos; pareja, más de 3). En ese caso, avisar a Vale.
- **Revocación siempre disponible**: un botón “Retirar mi autorización de grabación” en la página del consentimiento firmado (mismo link), más correo y WhatsApp. Exigencia: art. 12, revocación por medios similares, gratuitos y permanentes. Al revocar:
  - se bloquea toda grabación futura;
  - se avisa a Vale;
  - se registra la fecha;
  - si el paciente lo pide, se excluyen sus transcripciones del Q&A con IA.

### 4.2 Menores de edad
- **No se graba a menores de 18 años**, regla fija del sistema. La consulta atiende adultos y parejas. Si en la ficha hay una fecha de nacimiento que indica menos de 18, o la sesión es con un menor, el grabador se bloquea.
- Si en el futuro Vale atiende adolescentes, se necesita un consentimiento distinto: padres o representantes para menores de 16 en datos sensibles, más el asentimiento del adolescente (Ley 21.719 art. 16 quáter). Antes de eso, revisión del abogado.

### 4.3 Transparencia en cada sesión
- Indicador visible y permanente “● Grabando” en la pantalla del grabador.
- El bot de Meet se llama “Notas Ps. Valentina Orellana”, solo entra si Vale lo admite y se va al terminar.
- Protocolo de Vale: decir al comienzo “estamos grabando, como acordamos; si quieres pausar, me dices”. Exigencias: Ley 21.331 art. 4 (información continua) y APA secc. 1.

### 4.4 Pausar la grabación
- **Botón “Pausar”** en el grabador (presencial) y comando de pausa del bot (online). Al pausar no se captura audio, no hay buffer “por si acaso”.
- En la transcripción queda solo la marca “[Grabación pausada a pedido, mm:ss–mm:ss]”.
- La pausa **no** se considera revocación.

### 4.5 Sesiones de crisis o temas de riesgo
- Vale puede **detener** la grabación cuando lo considere clínicamente necesario (crisis aguda, revelación de abuso, etc.). Primero la persona, después la herramienta.
- **El sistema no hace detección automática de riesgo ni envía alertas.** No es una red de seguridad, y presentarlo así crearía una falsa expectativa y una posible responsabilidad. Así se dice en el consentimiento.
- El resumen IA **no evalúa el riesgo**. Si en la sesión se mencionó un tema de riesgo, solo debe consignar, de forma literal y neutra, que el tema apareció (ej.: “Se habló de pensamientos de muerte; ver transcripción, min 23”). Sin clasificaciones (“riesgo alto/bajo”) ni recomendaciones.
- Las obligaciones legales que surjan de una sesión (por ejemplo, vulneración de derechos de un menor) son de Vale, no del sistema.

### 4.6 Qué NO debe hacer el resumen IA (reglas del prompt, fijas en el código)

**El resumen DEBE**
- Seguir las instrucciones de Vale: puntos clave, tareas dadas y qué revisar la próxima sesión.
- Usar las palabras del paciente cuando sea posible, con citas cortas y el minuto.
- Decir “no se mencionó” en vez de inferir.
- En pareja, atribuir lo dicho a “Persona A / Persona B” (o los nombres) de forma equilibrada.

**El resumen NO DEBE**
1. Diagnosticar, ni sugerir o nombrar categorías diagnósticas (DSM/CIE), ni “compatible con…”. Exigencias: CEP art. 14 n.º 1; Ley 21.719 art. 8 bis.
2. Evaluar el riesgo, puntuar o clasificar la gravedad, ni predecir conductas.
3. Emitir juicios sobre la persona: moralidad, personalidad, “resistencia”, credibilidad, “manipulación”, etc.
4. En pareja, tomar partido, decir quién “tiene la razón” ni atribuir culpas.
5. Recomendar medicación, derivaciones, altas o cambios de tratamiento. Eso es decisión clínica de Vale.
6. Inventar contenido que no está en la transcripción, ni completar vacíos con suposiciones.
7. Incluir datos identificatorios de terceros mencionados (nombres completos de familiares, empleadores, direcciones) más allá de lo mínimo necesario para entender el resumen.
8. Copiar de forma íntegra pasajes extensos que ya están en la transcripción.

**Rótulo fijo** en la interfaz y en cualquier exportación o PDF:
> **Resumen automático (IA) — no revisado por la psicóloga.** Generado por [modelo, p. ej. claude-sonnet-5-5] el [fecha/hora] a partir de la transcripción [id]. Puede contener errores. No constituye la evolución clínica firmada.

**Mitigación de la brecha con D41 arts. 2 y 7 y con la APA**, sin pedirle a Vale que apruebe:
- El resumen IA vive en una sección aparte de la ficha (“Anexos automáticos”), **nunca** en el campo de evolución o notas firmadas.
  - **Excepción decidida por Vale (17 oct 2026: “cópialo automáticamente, pero en la evolución deja un botón de editar por si acaso”).** Si la sesión no tiene evolución, el orquestador guarda como evolución el texto plano del resumen, encabezado por “Basado en el resumen automático (IA) — revisar y editar:” y con un aviso visible “sin revisar” hasta que ella la edite (src/lib/transcriptor/evolucionAuto.ts). Nunca pisa una evolución existente; el resumen IA sigue aparte como anexo. Riesgo residual frente a D41 arts. 2 y 7: la evolución queda con texto generado por IA hasta que Vale la revise; si al editarla borra el encabezado, el origen solo queda en el historial de la nota y en la bitácora (`evolucion_autollenada`). Pendiente: consultarlo con el abogado junto con la pregunta 2.
- Si Vale abre el resumen, el registro de accesos lo deja anotado. Si lo edita, se guarda su versión con autor y fecha (nunca se sobrescribe la original de la IA).
- Trazabilidad: guardar el modelo, la versión del prompt y la versión de la transcripción de cada resumen.

**Q&A**: las respuestas llevan el rótulo “Respuesta generada por IA” y citan el fragmento o minuto de la transcripción en que se basan. **No se guardan en la ficha** salvo que Vale las copie explícitamente. Las consultas quedan en el registro de accesos.

### 4.7 Quién accede
- **Solo Vale**, con clave fuerte y **segundo factor (2FA)** en `/admin`. Exigencias: Ley 20.584 art. 13; D41 art. 9.
- Ningún proveedor tiene un acceso “de lectura” con fines propios. Las llaves de API las pega Vale en Vercel (ya decidido).
- **Claude (revisión mensual) y los autochequeos diarios NO acceden a contenido clínico real**: solo a métricas (n.º de sesiones procesadas, errores, tiempos, costos) y a registros **sin texto de sesiones**. Las pruebas usan audio sintético o grabado por Vale con su propia voz. **Nunca usar sesiones reales para desarrollo o pruebas.**
- Correos de aviso (Resend): **nunca** incluir el contenido del resumen o la transcripción en un correo, solo “hay un resumen nuevo de [iniciales]” y un link al panel.

### 4.8 Minimización y borrado
- Audio:
  - borrado **verificable** tras la transcripción (en el teléfono/IndexedDB, en Fly.io, en el almacenamiento intermedio y en AssemblyAI, con DELETE explícito además del TTL);
  - registrar el borrado con fecha;
  - el autochequeo diario verifica que no quede audio con más de 24–48 h.
- Fragmentos en IndexedDB del iPhone: se borran al confirmar la subida. Si el teléfono se pierde, esos fragmentos están expuestos, así que se recomienda cifrarlos en el dispositivo y usar el bloqueo del iPhone.
- Las transcripciones no se copian a Supabase en claro: solo los metadatos y el resumen (si el resumen se guarda en Supabase, cifrarlo igual).

### 4.9 Etiquetado y uso exclusivo
- Todo contenido generado por IA lleva el rótulo “IA” (ver 4.6).
- Prohibido por diseño: usar transcripciones para entrenar, para investigación, para contenido de Instagram o del blog, ni “anonimizadas para ejemplos”. Exigencias: Ley 21.719 art. 3 b (finalidad); CEP art. 15. Cualquier uso de ese tipo requiere un consentimiento nuevo y específico.

### 4.10 Registro de accesos (obligatorio, D41 art. 9)
- Tabla de registro **solo de inserción** (sin update ni delete para `service_role` desde la app). Guarda:
  - fecha y hora;
  - usuario;
  - acción: ver transcripción, ver resumen, pregunta Q&A, exportar, editar, borrar o revocar;
  - `patient_id` y sesión;
  - IP y user-agent.
- El texto de las preguntas Q&A se guarda **cifrado** (puede contener datos de salud).
- Se conserva **al menos lo mismo que la ficha** (15 años). Se puede entregar al paciente si ejerce su derecho de acceso.

### 4.11 Disponibilidad durante 15 años
- **Custodia de la clave de cifrado**: una copia fuera de línea (gestor de contraseñas de Vale y un sobre sellado en un lugar seguro). Sin clave no hay ficha, lo que incumple D41 arts. 8 y 11.
- **Prueba de restauración** trimestral desde B2 (D41 art. 8 I e).
- **Continuidad si Vale no puede seguir** (enfermedad o muerte): designar quién custodia las fichas (Ley 20.584 art. 13: acceso de herederos). Pregunta al abogado n.º 10.
- Si un proveedor cierra o cambia sus condiciones: los datos están en dos proveedores distintos, en un formato abierto y documentado.

### 4.12 Protocolo de brecha (Ley 21.719 art. 14 sexies)
- Si se filtra o pierde información:
  1. contener;
  2. registrar (naturaleza, datos, n.º de titulares, medidas);
  3. reportar a la Agencia sin dilación indebida;
  4. **avisar a cada paciente afectado** en lenguaje claro (datos sensibles: aviso obligatorio).
- Tener una plantilla del aviso lista antes de lanzar.

### 4.13 Proveedores y contratos (Ley 21.719 arts. 15 bis y 27)
- Carpeta con el **PDF fechado** de cada contrato y DPA: AssemblyAI (DPA + BAA), Anthropic (Commercial Terms + DPA), Fly.io, Cloudflare (R2), Backblaze (B2), Vercel, Supabase y Resend. Agregar la lista de subencargados de cada uno.
- **Anthropic (decisión 16 oct)**: Messages API normal en una organización con **HIPAA readiness** y el BAA estándar de Anthropic; nada por Batch. Verificado el 16 oct 2026 en https://platform.claude.com/docs/en/manage-claude/api-and-data-retention:
  - Se activa en Console → **Data retention** (`platform.claude.com/settings/privacy`), tarjeta **HIPAA compliance**, solo para administradores de la organización con permiso HIPAA y solo si la organización es “eligible”. Pasos: descargar el BAA, descargar la HIPAA Implementation Guide y aceptar el BAA “como representante legal autorizado”; la habilitación queda atada a la versión exacta del BAA descargada. Efecto inmediato y **permanente** (ningún administrador puede desactivarlo).
  - Si la tarjeta no aparece o se necesita un BAA negociado: ventas (https://claude.com/contact-sales). El artículo del Privacy Center (https://privacy.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers) todavía dice que, para la API, el Primary Owner firma el BAA y luego contacta a ventas para activarlo: las dos páginas oficiales no coinciden; vale lo que muestre la Console.
  - Requisito de plan o gasto mínimo para ser “eligible”: **NO VERIFICADO** (ninguna página oficial lo dice).
  - Funciones bloqueadas (400): Batch, Files API, Skills, code execution, programmatic tool calling, MCP connector, Managed Agents, advisor, context editing/compaction, tool search, web fetch, cache diagnostics, entre otras. Siguen disponibles: Messages API, prompt caching, structured outputs (sin datos del paciente en el esquema JSON, que se guarda aparte hasta 24 h), citations, thinking, token counting. La Console misma **no** está cubierta: nunca pegar contenido clínico en Workbench.
  - HIPAA se aplica a **toda la organización**: Anthropic recomienda una organización separada para usos que no sean de salud. Si la cuenta actual de Vale se usa para otra cosa (Claude Code con llave de Console, otros proyectos), conviene crear una organización nueva solo para el transcriptor antes de activar.
  - Retención con HIPAA: la documentación dice que los datos “pueden retenerse con salvaguardas” (cifrado, control de acceso, auditoría) en vez de borrarse de inmediato, y remite a la política estándar (30 días) sin fijar un plazo propio; con contenido marcado, hasta 2 años. Plazo exacto con HIPAA: **NO VERIFICADO** (pedirlo a Anthropic por escrito o leerlo en la Implementation Guide).
  - Costo: la Messages API cuesta el doble que Batch; recalcular contra el tope de $35.000.
- Anthropic **no permite borrar a pedido** los datos de la API. Esto debe estar en el consentimiento (ya incluido: “máximo 30 días y no permite borrarlo antes”).

---

## 5. Preguntas puntuales para el abogado

1. **Condición de atención.** Con la presunción del art. 12 de la Ley 21.719 (consentimiento no libre si la recolección no es necesaria para el servicio), ¿puede una psicóloga independiente exigir la grabación y su procesamiento con IA como condición para atender? ¿Sirve como respaldo el CEP art. 11 n.º 7 (libertad para aceptar pacientes), o la base del art. 16 bis e) (tratamiento sanitario)? Si no, ¿basta el Plan B (grabación opcional)?
2. **¿La transcripción completa es parte de la ficha clínica?** (Ley 20.584 art. 12; D41 art. 6 c “cualquier otra información clínica”.)
   - Si **sí**: ¿hay que conservarla 15 años y no se puede suprimir aunque el paciente lo pida o revoque?
   - Si **no**: ¿cuánto tiempo puede conservarse según el principio de proporcionalidad (art. 3 c), y debe borrarse al revocar?
   - ¿Y el resumen IA?
3. **Encargados con acceso al texto.** ¿AssemblyAI y Anthropic, como encargados que procesan el contenido en claro, son “terceros no relacionados con la atención” en el sentido del art. 13 de la Ley 20.584? ¿O el contrato de encargo (art. 15 bis Ley 21.719) es suficiente?
4. **Transferencia internacional habitual a EE.UU.** ¿Las SCC de la UE incluidas en los DPA de AssemblyAI y Anthropic cuentan como “garantías adecuadas” del art. 27 b / art. 28 mientras la Agencia no publique sus cláusulas modelo? ¿Hay que firmar anexos adicionales? ¿Qué redacción usar en la política?
5. **Ficha de pareja.** El D41 art. 4 dice “una ficha clínica de cada paciente”. ¿Cumple llevar UNA ficha por pareja (decisión de Vale) cuando ambos son pacientes? ¿Cómo responder una solicitud de acceso de uno de los dos sobre una transcripción que contiene datos del otro?
6. **Anthropic con BAA (HIPAA readiness) + DPA.** ¿Es aceptable bajo la ley chilena procesar datos de salud mental con un proveedor en EE.UU. que retiene entradas y salidas hasta 30 días (hasta 2 años si su sistema de seguridad marca el contenido) y que no permite borrado a pedido, si existen DPA y BAA? ¿El BAA (figura de la ley de EE.UU.) aporta algo como garantía bajo el art. 27?
7. **Voz y diarización.** ¿La diarización (separar hablantes) convierte la voz en dato biométrico (art. 16 ter) y exige la información específica de ese artículo?
8. **Resumen IA no revisado en la ficha.** ¿Puede incorporarse a la ficha un contenido que no registró ni firmó la profesional (D41 arts. 2 y 7), si va rotulado como anexo automático? ¿Qué riesgo de responsabilidad crea si contiene un error y Vale no lo leyó?
9. **Evaluación de impacto (art. 15 ter).** ¿Es obligatoria para este tratamiento (datos sensibles de salud mental, IA y transferencia)? ¿Hay un formato mínimo aceptable para una persona natural?
10. **Continuidad y custodia por 15 años.** ¿Qué debe prever Vale si deja de ejercer, se incapacita o fallece (custodio de fichas, acceso de herederos, claves de cifrado)?
11. **Aviso antes de reservar y devoluciones.** ¿El checkbox informativo previo al pago es suficiente y bien ubicado? ¿Es obligatorio devolver el pago a quien reserva y luego no firma (Ley 19.496 del consumidor)?
12. **Consentimiento previo v2.** ¿Las grabaciones hechas con la v2 (Encuadrado) pueden migrarse o procesarse con el nuevo sistema, o se requiere la v3 firmada antes de tocar ese material?
13. **Vigencia.** El Boletín 18.623-07 sigue en primer trámite en el Senado (16 oct 2026), así que hoy rige el 1 dic 2026. Si se aprueba la postergación al 1 dic 2027, ¿cambia en algo lo exigible hoy bajo la Ley 19.628 original para este tratamiento?
14. **Código Penal art. 161-A y sesiones online.** ¿Hay algún riesgo cuando el paciente se conecta desde un lugar con otras personas que no firmaron y que se escuchan de fondo?
15. **Ley 20.584 vigente y su reglamento.** El texto vigente (verificado 16 oct) cambió en los arts. 12, 13 y 14 por las Leyes 21.541 (telemedicina) y 21.668 (interoperabilidad). ¿Sigue vigente el Decreto 41/2012 como reglamento de fichas clínicas o fue reemplazado o modificado tras la Ley 21.668? (NO VERIFICADO). ¿Las sesiones online son “prestaciones de salud digital” con el registro de consentimiento del art. 14?
16. **Código de Ética.** Confirmar con el Colegio de Psicólogos que la versión citada (copia FACSO) es la vigente, y si existe alguna resolución o criterio del Colegio sobre grabación de sesiones o IA.
