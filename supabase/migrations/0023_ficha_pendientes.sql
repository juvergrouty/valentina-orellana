-- 0023_ficha_pendientes.sql — franja "Pendientes" de la ficha del paciente (pedido de Vale, 17 oct 2026).
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO está aplicada).
-- Aditiva e idempotente: solo crea una tabla nueva. Sin esta migración la ficha funciona igual:
-- los pendientes se muestran y el botón "Ya está hecho" avisa que falta actualizar la base (0023).
--
-- Una fila por cada vez que Vale aprieta "Ya está hecho" en un pendiente de la ficha (por ejemplo,
-- "Falta el consentimiento de la pareja" cuando ya lo gestionó por otro lado). Marcarlo NO cambia
-- ninguna regla: si la firma sigue faltando, la grabación sigue bloqueada. Solo deja de mostrarse
-- en la franja y queda en el historial de pendientes (plegado). Es registro: solo select + insert.
-- No guarda datos clínicos: la clave del pendiente ("consentimiento_pareja", …) y el texto que se vio.
-- Regla del proyecto: RLS sin políticas para anon/authenticated + grants explícitos a service_role.

create table if not exists public.ficha_pendientes_gestionados (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references public.patients(id) on delete restrict,
  clave          text not null check (char_length(clave) between 1 and 120),
  texto          text not null check (char_length(texto) between 1 and 300),
  gestionado_at  timestamptz not null default now()
);
create index if not exists ficha_pendientes_gestionados_patient_idx
  on public.ficha_pendientes_gestionados (patient_id, gestionado_at desc);

alter table public.ficha_pendientes_gestionados enable row level security;
revoke all on public.ficha_pendientes_gestionados from public, anon, authenticated;
grant select, insert on public.ficha_pendientes_gestionados to service_role; -- registro: no se edita ni se borra
