# Decisiones de Vale — 16 oct 2026 (mandan sobre los documentos 10–50 si chocan)

1. **Resúmenes con protección máxima**: Messages API normal (NO Batch) con `claude-sonnet-5-5`; la cuenta de Anthropic se pondrá en modo HIPAA (lo activa Vale en Console; es permanente → con HIPAA, Batch responde 400). `transcriptor_resumen_modo = 'directo'`. No usar Batch en ningún lado (tampoco Q&A). Sin datos del paciente en esquemas JSON, custom_id ni metadatos.
2. **Riesgo**: SIN tamizaje ni alertas (ni banner ni correo). El resumen solo consigna de forma literal y neutra que un tema de riesgo apareció, con minuto, en la sección "Atención" al inicio. Sin clasificar gravedad ni recomendar. `transcriptor_alerta_riesgo = 'false'` y el código de alerta no se construye.
3. **Passkey (WebAuthn) obligatoria para el panel** antes de lanzar el transcriptor (Face ID / huella en iPhone y Mac).
4. **Grabador**: "Mantén para terminar" (1 s), botón pequeño "Pausar", y Grabar bloqueado (en el servidor) si falta la firma v3 de cualquiera de los presentes (pareja: ambos).
5. **Grabación OPCIONAL** hasta que el abogado valide por escrito (`transcriptor_grabacion_requisito = 'opcional'`).
6. Resumen IA = anexo separado, rotulado "Resumen automático (IA) — no revisado"; nunca reemplaza la nota de evolución de Vale.
7. No se graba a menores de 18.

## Agregado 16 oct (tarde)
8. **Errores técnicos → PANEL primero**: cada error (subida, transcripción, resumen, bot, respaldo, chequeo diario) aparece como aviso destacado en el panel apenas Vale entra (todas las páginas de /admin), con qué falló, de qué sesión y un botón para resolver/reintentar ahí mismo; queda hasta resolverse. Correo solo como respaldo. Esto NO es alerta de riesgo clínico (eso sigue prohibido).
9. **Consentimiento**: la firma v2 con la autorización `accept_recording = true` SÍ habilita grabar (Vale quiere que sirva para quienes ya firmaron; la abogada lo confirmará). La v3 (nueva, amplia, para pacientes nuevos) también. En pareja, cada persona presente debe tener su firma vigente con grabación autorizada. Revocación o `accept_recording=false` bloquea.
10. Ficha sin fecha de nacimiento: se permite grabar (Vale atiende solo adultos).
11. Vale decide en cada sesión si graba (no hay grabación obligatoria).
12. **Todo completo para todos** (v2 con grabación autorizada o v3): grabar, transcribir, resumen IA y preguntas. Vale no atenderá a nadie sin transcripción (ya está en las preguntas a la abogada).
13. **Aviso a pacientes con v2**: se muestra UNA sola vez, escrito abajo en el mensaje/correo de confirmación de su siguiente hora (texto en 12-consentimiento-nuevo.md §c, adaptado a "cambié de herramienta"); se registra que se mostró y no se repite. Activo solo cuando el transcriptor esté en uso.
14. Consentimiento v3 amplio se publica YA para pacientes nuevos (rama consentimiento-v3 desde main) junto con la lista de proveedores en /condiciones.
15. Correos a la abogada: juntar TODAS las dudas en un solo correo.
