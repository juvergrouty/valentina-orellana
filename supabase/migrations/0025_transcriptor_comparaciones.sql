-- 0025_transcriptor_comparaciones.sql - prueba ciega Sonnet 5.5 vs Haiku 5.5 del resumen (17 oct 2026).
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO esta aplicada).
-- Aditiva e idempotente: solo crea una tabla nueva. Sin esta migracion la pagina
-- /admin/transcriptor/comparar avisa que falta aplicarla y no genera nada.
--
-- ESTE ARCHIVO ES SOLO ASCII A PROPOSITO (ver 0024): no lleva tildes ni en los comentarios.
--
-- Una fila por caso de una corrida de comparacion. Cada caso tiene DOS resumenes generados con el
-- mismo prompt: "Resumen 1" y "Resumen 2". Que modelo es cada uno (modelo_1 / modelo_2) se sortea
-- en el servidor y la pagina no lo muestra hasta que Vale voto todos los casos.
--  * tipo 'real': transcripciones de la ficha de prueba. Los resumenes y el comentario van CIFRADOS
--    (formato VOT1, igual que resumenes_ia.contenido_cifrado); las columnas en claro quedan null
--    (lo exige un check). detalle_1/detalle_2 solo llevan conteos (tokens, costo, citas, secciones).
--  * tipo 'sintetico': transcripciones inventadas del repo (sin datos reales): pueden ir en claro.
-- Regla del proyecto: RLS sin politicas para anon/authenticated + grants explicitos a service_role.

create table if not exists public.transcriptor_comparaciones (
  id                 uuid primary key default gen_random_uuid(),
  corrida_id         uuid not null,
  orden              smallint not null check (orden between 1 and 50),
  tipo               text not null check (tipo in ('real', 'sintetico')),
  caso_clave         text not null check (char_length(caso_clave) between 1 and 120),
  etiqueta           text not null check (char_length(etiqueta) between 1 and 200),
  grabacion_id       uuid references public.grabaciones(id) on delete set null,
  patient_id         uuid references public.patients(id) on delete set null,
  modelo_1           text not null check (char_length(modelo_1) between 1 and 80),
  modelo_2           text not null check (char_length(modelo_2) between 1 and 80),
  estado             text not null default 'pendiente' check (estado in ('pendiente', 'generando', 'listo', 'error')),
  error_codigo       text check (error_codigo is null or char_length(error_codigo) <= 80),
  resumen_1          text check (resumen_1 is null or char_length(resumen_1) <= 40000),
  resumen_2          text check (resumen_2 is null or char_length(resumen_2) <= 40000),
  resumen_1_cifrado  bytea,
  resumen_2_cifrado  bytea,
  kek_v              smallint,
  detalle_1          jsonb,
  detalle_2          jsonb,
  costo_usd_1        numeric(10,5),
  costo_usd_2        numeric(10,5),
  preferencia        text check (preferencia is null or preferencia in ('1', '2', 'iguales')),
  comentario         text check (comentario is null or char_length(comentario) <= 4000),
  comentario_cifrado bytea,
  created_at         timestamptz not null default now(),
  generando_at       timestamptz,
  listo_at           timestamptz,
  votado_at          timestamptz,
  constraint transcriptor_comparaciones_modelos_distintos check (modelo_1 <> modelo_2),
  constraint transcriptor_comparaciones_reales_cifrados check (
    tipo = 'sintetico' or (resumen_1 is null and resumen_2 is null and comentario is null)
  ),
  constraint transcriptor_comparaciones_orden_unico unique (corrida_id, orden)
);
create index if not exists transcriptor_comparaciones_corrida_idx
  on public.transcriptor_comparaciones (created_at desc, corrida_id);

alter table public.transcriptor_comparaciones enable row level security;
revoke all on public.transcriptor_comparaciones from public, anon, authenticated;
grant select, insert, update, delete on public.transcriptor_comparaciones to service_role;
