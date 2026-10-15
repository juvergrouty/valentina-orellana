# Transcriptor IA — decisiones ya tomadas por Vale (no re-discutir)

Fecha: 15 oct 2026. Sitio: valentinaorellana.cl (Astro SSR en Vercel Hobby + Supabase + Flow + Resend + Google Calendar).
Usuaria: Ps. Valentina Orellana (Vale), psicóloga clínica en Chile, atiende individual y parejas, presencial (box) y online (Google Meet con la cuenta vinculosquesostienen@gmail.com). Máx. 35–36 sesiones/semana. Todo en español de Chile.

## Qué quiere
- Todo ocurre dentro de su web (panel /admin). Nada de app nativa. Chrome en Mac o Safari en iPhone.
- Presencial: un botón "Grabar" en el panel (desde el iPhone). Al lado, ANTES de empezar, un botón "Lugar con ruido" que fuerza el modelo robusto.
- Online: un bot llamado "Notas de Ps. Valentina Orellana" entra SOLO a su Meet (ella lo admite), graba y se va al terminar.
- Transcripción automática. Resumen automático en la ficha del paciente, etiquetado "Resumen automático (IA)", siguiendo SUS instrucciones (puntos clave, tareas dadas, qué revisar la próxima sesión). Ella NO quiere aprobar nada: todo automático.
- Preguntas a la IA sobre sesiones completas (Q&A).
- La sesión completa se guarda FUERA de su sitio (almacenamiento externo cifrado), pero solo se procesa/ve a través de su sitio.
- Costo total ≤ 35.000 CLP/mes. Cumplir ley chilena (Ley 19.628 / 21.719 datos personales, Ley 20.584 derechos del paciente, Decreto 41 fichas clínicas — retención 15 años).
- Autochequeos diarios (alerta solo si falla) + revisión mensual por Claude.

## Proveedores (cuentas ya creadas por Vale)
- AssemblyAI (pago, autopay; entrenamiento con datos DESACTIVADO, TTL 1 día; BAA firmado 15/10).
  - Regla FIJA del sitio (no la decide una IA): pareja → Universal-3.5 Pro + diarización; individual → Universal-2; sin tipo → Universal-2. "Lugar con ruido" → modelo robusto. Online: sin diarización pagada (el bot sabe quién habla).
  - Webhooks para saber cuándo termina.
- Anthropic (Claude Console, org individual de Vale): resúmenes con Sonnet 5.5 vía Batch API (`claude-sonnet-5-5`); Q&A con Haiku 5.5 (`claude-haiku-5-5`). Límite de gasto mensual US$20.
- Fly.io: máquinas efímeras (región iad) para el bot de Meet, derivado del código Apache-2.0 de Vexa.
- Cloudflare R2: transcripciones cifradas (AES-GCM) — bucket aún no creado. NO agregar el dominio de Vale a Cloudflare.
- Backblaze B2: copia de las transcripciones + respaldo semanal de Supabase (el plan Free de Supabase no tiene backups).
- El audio se BORRA después de transcribir.
- Las llaves las pega Vale directo en variables de entorno de Vercel. Nunca en chat ni en el repo.

## iPhone (presencial)
- Modo avión con Wi-Fi APAGADO durante la sesión (una llamada entrante corta el micrófono aunque no se conteste; la web no puede evitarlo).
- Pantalla encendida (Wake Lock). Trozos de audio guardados en IndexedDB y subidos después.
- Si se interrumpe: aviso rojo grande "La grabación se pausó" + tocar para continuar (una web no puede reanudar sola).
- vercel.json bloquea el micrófono en todo el sitio (Permissions-Policy microphone=()) → override solo para la ruta del grabador.

## Pacientes y consentimiento
- Pareja = UNA ficha (quien reserva/paga) pero AMBOS firman el consentimiento de grabación.
- Vale no atiende a quien no acepte grabar: se avisa ANTES de reservar (confirmar con abogado).
- Consentimiento v3 debe cubrir: grabación, procesamiento con IA, procesamiento en EE.UU., ambos miembros de la pareja, retención, borrado del audio, derechos ARCO+.
- Preguntar a un abogado si las transcripciones completas forman parte de la ficha clínica.

## Costos verificados (CLP, USD 950, +IVA)
Por sesión: indiv. presencial $211, indiv. online $236, pareja presencial $273, pareja online $298; cada pregunta $4. ≈$9.000/mes hoy, ≈$31.600/mes a 36 sesiones/semana.

## Reglas del proyecto
- Supabase: toda tabla nueva necesita `grant select, insert, update, delete on public.<t> to service_role;` en la migración. RLS activado, sin políticas anon.
- Revisión independiente + revisión visual (escritorio y 375px) antes de cada push. Preguntar antes de push a main.
- No cambiar el autor de git. Todo texto visible en español.
