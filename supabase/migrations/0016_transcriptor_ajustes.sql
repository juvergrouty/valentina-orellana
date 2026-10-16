-- 0016_transcriptor_ajustes.sql — Ajustes del orquestador del transcriptor (P6, 16 oct 2026).
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 0014_transcriptor.sql y cuando Vale lo
-- apruebe (NO está aplicada). Aditiva e idempotente: solo agrega columnas con default y un ajuste.
-- Las alertas del panel (tabla propia) las crea P8 en su migración; aquí no.
--
-- Transición 'subiendo → cancelada': el check de grabaciones.estado ya acepta 'cancelada' (0014) y
-- las transiciones se validan en el código (src/lib/transcriptor/estados.ts), así que en SQL no hace
-- falta nada para eso.

-- ── 1. Backoff del cron: cuándo puede volver a intentarse el paso actual de la grabación ──
-- (envío a AssemblyAI 1/5/15/60 min, guardado de la transcripción, resumen, relanzar el bot).
alter table public.grabaciones
  add column if not exists proximo_intento_at timestamptz;

-- ── 2. Errores de AssemblyAI por segmento (regla 4 de 50-arquitectura §4: 1 reintento con el
--       mismo modelo, luego Universal-3.5 Pro, luego 'error' + alerta en el panel). ──
alter table public.grabacion_segmentos
  add column if not exists aai_errores integer not null default 0 check (aai_errores >= 0);

-- ── 3. Nombres visibles de Vale en Meet (separados por "|"), los usa el bot para "salir
--       cuando Vale sale" y el cron para rotularla "Ps. Valentina" en la transcripción. ──
insert into public.settings (key, value) values
  ('transcriptor_bot_nombres_vale', 'Valentina Orellana|Vínculos que sostienen')
on conflict (key) do nothing;
