# Para la reunión con el abogado: transcriptor de sesiones con IA

Ps. Valentina Orellana · consulta privada (adultos y parejas, presencial y online) · preparado el 16 oct 2026.
Este documento resume el sistema y lo que necesito validar. No es asesoría legal: el detalle con citas está en `10-etica-legal.md`.

---

## 1. Qué es el sistema (en simple)

**Qué hace.** Graba solo el **audio** de la sesión (nunca video), lo pasa a texto, y una IA prepara un resumen breve (temas, tareas acordadas, qué retomar). Yo puedo hacerle preguntas a la IA sobre sesiones anteriores. Todo se ve solo dentro del panel privado de mi sitio web, con mi clave y una llave de acceso biométrica (Face ID o huella).

**Cómo funciona una sesión.**
1. **Presencial**: grabo con mi iPhone desde el sitio web. **Online (Google Meet)**: entra un asistente llamado “Notas Ps. Valentina Orellana”, que yo admito y que se va al terminar.
2. El audio va a **AssemblyAI** (EE.UU.), que lo transcribe. El audio **se borra** apenas está la transcripción, en mi sistema y en AssemblyAI (que además lo borra solo en 1 día como máximo).
3. La transcripción va a **Anthropic** (EE.UU., la IA Claude), que hace el resumen. Anthropic guarda lo procesado hasta 30 días y no permite borrarlo antes. Si su sistema de seguridad marca algo como posible infracción, puede guardarlo hasta 2 años.
4. La transcripción y el resumen se guardan **cifrados** en dos almacenamientos en el extranjero (Cloudflare y Backblaze). Los proveedores no tienen la clave.
5. Cada vez que alguien ve, consulta o exporta una transcripción, queda registrado (fecha, hora, quién).

**Proveedores que tratan datos por encargo mío.** AssemblyAI (transcripción), Anthropic (resumen y preguntas), Fly.io (asistente de Meet), Cloudflare R2 y Backblaze B2 (almacenamiento cifrado), Vercel y Supabase (sitio web y base de datos), Resend (correos, nunca con contenido clínico). Ninguno puede usar los datos para entrenar IA.

**Límites que ya fijé.**
- No se graba a nadie que no haya firmado el consentimiento. En pareja firman ambos, cada uno por separado; si falta una firma, el sistema no deja grabar.
- No se graba a menores de 18 años.
- La IA no diagnostica, no evalúa el riesgo, no envía alertas y no decide nada clínico.
- El resumen de la IA es un anexo rotulado “Resumen automático (IA) — no revisado”. Nunca reemplaza mi nota de evolución firmada.
- Las transcripciones se conservan como parte de la ficha (15 años), **si usted confirma que corresponde** (pregunta 2).

## 2. Decisiones que tomé el 16 oct 2026

1. **Protección máxima en Anthropic.** Uso la API normal, no la de lotes (Batch). Activaré su modo HIPAA firmando su contrato de “Business Associate” (BAA), que es permanente. No pongo datos del paciente fuera del contenido protegido.
2. **Sin detección de riesgo ni alertas.** El resumen solo deja constancia neutra de que se habló un tema de riesgo, con el minuto, para que yo lo revise.
3. **Acceso al panel con llave biométrica obligatoria** antes de lanzar.
4. **Grabador**: se mantiene presionado 1 segundo para terminar, tiene botón “Pausar” y no graba si falta la firma de alguno de los presentes.
5. **La grabación es OPCIONAL** hasta que usted valide por escrito si puedo exigirla. Quien no acepte se atiende igual, con notas a mano.
6. El resumen IA es un anexo separado y no reemplaza mi evolución clínica.
7. No grabo a menores de 18 años.

Datos ya verificados en fuente oficial (16 oct): la Ley 21.719 entra en vigencia el **1 dic 2026**. El proyecto que la posterga al 1 dic 2027 (Boletín 18.623-07) sigue en primer trámite en el Senado, así que no es ley. Ley 20.584 arts. 12 a 14: el texto vigente incluye los cambios de las Leyes 21.541 y 21.668. Código Penal art. 161-A: texto oficial revisado.

## 3. Preguntas, por prioridad

“Bloquea” significa que no lanzo el transcriptor sin su respuesta.

| # | Pregunta | ¿Bloquea el lanzamiento? |
|---|---|---|
| 1 | **¿La transcripción completa y el resumen IA son parte de la ficha clínica** (Ley 20.584 art. 12; D41 art. 6 c)? Si **sí**: ¿se conservan 15 años y no se suprimen aunque el paciente revoque? Si **no**: ¿cuánto puedo guardarlos (proporcionalidad, art. 3 Ley 21.719) y debo borrarlos al revocar? ¿Y qué pasa con lo ya grabado si un paciente retira el consentimiento a mitad del proceso? | **Sí** (define la retención y el texto del consentimiento) |
| 2 | **Transferencia habitual a EE.UU.** ¿Las cláusulas tipo de la UE incluidas en los DPA de AssemblyAI y Anthropic sirven como “garantías adecuadas” (arts. 27 y 28 Ley 21.719) mientras la Agencia no publique sus cláusulas modelo? ¿Debo firmar algún anexo? ¿Qué redacción uso en la política de privacidad? | **Sí** |
| 3 | **Proveedores con acceso al texto.** ¿AssemblyAI y Anthropic, como encargados que procesan el contenido, son “terceros no relacionados con la atención” (Ley 20.584 art. 13), o basta el contrato de encargo (art. 15 bis Ley 21.719)? ¿Los DPA cumplen el contenido mínimo del art. 15 bis? | **Sí** |
| 4 | **Retención en Anthropic.** ¿Es aceptable que guarde hasta 30 días (hasta 2 años si lo marca su sistema de seguridad), sin borrado a pedido, si tengo DPA y BAA? ¿El BAA (figura de la ley de EE.UU.) suma como garantía en Chile? **Revisar el BAA antes de que lo acepte, porque es permanente.** | **Sí** |
| 5 | **Revisión del consentimiento v3 y del aviso previo a reservar**, en su versión de grabación opcional: ¿cumple los arts. 12, 14 ter y 16 Ley 21.719, la Ley 20.584 art. 14 y la Ley 21.331? ¿Las sesiones online cuentan como “salud digital” con el registro del art. 14? | **Sí** |
| 6 | **Resumen IA no revisado.** ¿Puedo guardar en la ficha un contenido que no registré ni firmé yo (D41 arts. 2 y 7) si va rotulado como anexo automático? ¿Qué responsabilidad tengo si contiene un error que no leí? | **Sí** |
| 7 | **Evaluación de impacto (art. 15 ter).** ¿Es obligatoria aquí (salud mental, IA, transferencia)? ¿Hay un formato mínimo para una persona natural? | **Condicional**: bloquea si es obligatoria |
| 8 | **Ficha de pareja.** El D41 art. 4 exige “una ficha clínica de cada paciente”. ¿Cumple llevar una ficha por pareja? ¿Cómo respondo si uno pide acceso a una transcripción con dichos del otro, sobre todo relatos de violencia? | **Sí** para parejas; no para individuales |
| 9 | **Grabación como condición de atención.** Con la presunción del art. 12 Ley 21.719 (el consentimiento no es libre si la recolección no es necesaria para el servicio), ¿puedo exigir la grabación para atender? ¿Me respalda el art. 11 n.º 7 del Código de Ética o el art. 16 bis e)? | **No** (hoy es opcional); bloquea solo si quiero hacerla obligatoria |
| 10 | **Terceros en sesiones online (CP art. 161-A).** ¿Qué riesgo hay si se escucha de fondo a alguien que no firmó? ¿Basta con detener la grabación? | No (el sistema ya detiene; confirmar) |
| 11 | **Voz y diarización.** ¿Separar quién habla convierte la voz en dato biométrico (art. 16 ter) y exige la información específica de ese artículo? | No (no usamos huella de voz; confirmar) |
| 12 | **Grabaciones antiguas con consentimiento v2 (Encuadrado).** ¿Puedo procesarlas con el nuevo sistema o necesito la v3 firmada antes? | No (no se procesan hasta su respuesta) |
| 13 | **Deber de denuncia.** Ante relatos de maltrato o abuso a niños, niñas o adolescentes, ¿qué obligación tengo como psicóloga de consulta privada frente al secreto profesional? ¿Cambia algo que exista una transcripción? | No (pero es urgente en lo clínico) |
| 14 | **Continuidad por 15 años.** ¿Qué debo prever si dejo de ejercer, me incapacito o fallezco (custodio de fichas, acceso de herederos, claves de cifrado)? | No |
| 15 | **Reglamento vigente y vigencia.** ¿Sigue vigente el Decreto 41/2012 o se modificó tras la Ley 21.668? Si se aprueba la postergación al 1 dic 2027, ¿cambia algo de lo exigible hoy bajo la Ley 19.628 original? | No |
| 16 | **Pago y devolución.** Si en el futuro la grabación fuera obligatoria y alguien paga pero luego no firma, ¿debo devolver el 100% (Ley 19.496)? ¿Basta un aviso con checkbox antes del pago? | No |
| 17 | **Código de Ética.** ¿La versión citada (copia publicada por FACSO U. de Chile, archivo de 1996) es la vigente? ¿Hay algún criterio del Colegio sobre grabación de sesiones o IA? | No |

## 4. Documentos para llevar

- **AssemblyAI**: DPA y **BAA ya firmado (15 oct 2026)**, en PDF fechado. Captura de la configuración: retención de 1 día y entrenamiento desactivado.
- **Anthropic**: Data Processing Addendum (https://www.anthropic.com/legal/data-processing-addendum), Commercial Terms y el **BAA estándar**. El BAA se descarga en Console (Settings → Data retention → HIPAA compliance) **antes** de aceptarlo: llevarlo sin aceptar, porque la activación es permanente.
- **Consentimiento v3 (borrador)**: `10-etica-legal.md` §2, versión **Plan B (grabación opcional)**, más el aviso previo a reservar (§3.1).
- **Política de privacidad vigente** (`/condiciones#privacidad`, versión 3 del 11 oct 2026) y los cambios propuestos (§3.2).
- **Lista de proveedores y subencargados** con sus DPA: Fly.io, Cloudflare, Backblaze, Vercel, Supabase y Resend.
- Este documento y `01-decisiones-16oct.md`.

Pídale que deje sus respuestas **por escrito**, sobre todo las preguntas 1 a 6 y la 9.
