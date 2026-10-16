# Decisiones de Vale — 16 oct 2026 (mandan sobre los documentos 10–50 si chocan)

1. **Resúmenes con protección máxima**: Messages API normal (NO Batch) con `claude-sonnet-5-5`; la cuenta de Anthropic se pondrá en modo HIPAA (lo activa Vale en Console; es permanente → con HIPAA, Batch responde 400). `transcriptor_resumen_modo = 'directo'`. No usar Batch en ningún lado (tampoco Q&A). Sin datos del paciente en esquemas JSON, custom_id ni metadatos.
2. **Riesgo**: SIN tamizaje ni alertas (ni banner ni correo). El resumen solo consigna de forma literal y neutra que un tema de riesgo apareció, con minuto, en la sección "Atención" al inicio. Sin clasificar gravedad ni recomendar. `transcriptor_alerta_riesgo = 'false'` y el código de alerta no se construye.
3. **Passkey (WebAuthn) obligatoria para el panel** antes de lanzar el transcriptor (Face ID / huella en iPhone y Mac).
4. **Grabador**: "Mantén para terminar" (1 s), botón pequeño "Pausar", y Grabar bloqueado (en el servidor) si falta la firma v3 de cualquiera de los presentes (pareja: ambos).
5. **Grabación OPCIONAL** hasta que el abogado valide por escrito (`transcriptor_grabacion_requisito = 'opcional'`).
6. Resumen IA = anexo separado, rotulado "Resumen automático (IA) — no revisado"; nunca reemplaza la nota de evolución de Vale.
7. No se graba a menores de 18.
