-- Tasa de apertura de los correos masivos (Comunicaciones), 14 oct 2026.
-- Un registro por destinatario de cada envío; la imagen invisible del correo
-- (/api/abierto/<id>.gif) marca la apertura con marcar_apertura().

create table if not exists public.bulk_email_recipients (
  id          uuid primary key default gen_random_uuid(),
  bulk_id     uuid not null references public.bulk_emails(id) on delete cascade,
  name        text,
  email       text not null,
  sent        boolean not null default false,
  opened_at   timestamptz,
  open_count  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists bulk_email_recipients_bulk_id_idx on public.bulk_email_recipients (bulk_id);
alter table public.bulk_email_recipients enable row level security;
-- En este proyecto las tablas nuevas no traen permisos para el servidor: se dan
-- solo a service_role (la llave que usa la página), nunca a anon/authenticated.
grant select, insert, update, delete on public.bulk_email_recipients to service_role;

-- Suma una apertura en un solo paso (sin carreras). Solo la usa el servidor.
create or replace function public.marcar_apertura(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.bulk_email_recipients
     set opened_at = coalesce(opened_at, now()),
         open_count = open_count + 1
   where id = p_id;
$$;
revoke all on function public.marcar_apertura(uuid) from public, anon, authenticated;
grant execute on function public.marcar_apertura(uuid) to service_role;
