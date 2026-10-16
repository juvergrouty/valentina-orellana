-- 0017_transcriptor_alertas.sql — Avisos de errores técnicos del transcriptor en el panel (P8).
-- Decisión 8 de docs/transcriptor/01-decisiones-16oct.md: cada error técnico (subida, transcripción,
-- resumen, bot, respaldo, chequeo diario) aparece en TODAS las páginas de /admin hasta resolverse;
-- el correo es solo respaldo. NO es alerta de riesgo clínico (eso sigue prohibido, decisión 2).
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 0014_transcriptor.sql y cuando Vale lo
-- apruebe (NO está aplicada). Aditiva: no modifica tablas existentes.
-- Regla del proyecto: RLS activado sin políticas para anon/authenticated + grants a service_role.
--
-- Sin contenido clínico: título y detalle son textos técnicos ("AssemblyAI respondió 500"),
-- nunca texto de la sesión, del resumen ni nombres. La sesión se identifica por grabacion_id.

create table if not exists public.transcriptor_alertas (
  id                uuid primary key default gen_random_uuid(),
  creada_at         timestamptz not null default now(),
  tipo              text not null check (tipo in ('subida','transcripcion','resumen','bot','respaldo','salud','costo','config')),
  titulo            text not null check (length(titulo) between 1 and 200),
  detalle           text check (detalle is null or length(detalle) <= 1000),
  grabacion_id      uuid references public.grabaciones(id) on delete set null,
  accion            text not null default 'revisar' check (accion in ('reintentar','reintentar_resumen','revisar','ninguna')),
  -- Deduplicación: mientras una alerta con la misma clave esté abierta, se suma `veces` en vez
  -- de crear otra fila (p. ej. 'transcripcion:<grabacion_id>' o 'salud:respaldo_supabase').
  clave             text not null check (length(clave) between 1 and 200),
  veces             integer not null default 1 check (veces >= 1),
  ultima_vez        timestamptz not null default now(),
  resuelta_at       timestamptz,
  resuelta_por      text check (resuelta_por is null or resuelta_por in ('vale','sistema')),
  correo_enviado_at timestamptz,   -- freno: máx. 1 correo por clave cada 6 h (lo aplica alertas.ts)
  check ((resuelta_at is null) = (resuelta_por is null))
);

-- Una sola alerta ABIERTA por clave (las resueltas quedan como historial).
create unique index if not exists transcriptor_alertas_abierta_unq
  on public.transcriptor_alertas (clave) where resuelta_at is null;
create index if not exists transcriptor_alertas_abiertas_idx
  on public.transcriptor_alertas (ultima_vez desc) where resuelta_at is null;
create index if not exists transcriptor_alertas_grab_idx
  on public.transcriptor_alertas (grabacion_id) where resuelta_at is null;
create index if not exists transcriptor_alertas_clave_correo_idx
  on public.transcriptor_alertas (clave, correo_enviado_at desc);
create index if not exists transcriptor_alertas_creada_idx
  on public.transcriptor_alertas (creada_at desc);

alter table public.transcriptor_alertas enable row level security;
grant select, insert, update, delete on public.transcriptor_alertas to service_role;
revoke all on public.transcriptor_alertas from anon, authenticated;
