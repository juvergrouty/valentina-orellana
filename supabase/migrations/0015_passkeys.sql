-- 0015_passkeys.sql — Passkey (WebAuthn) como segundo factor del panel /admin (16 oct 2026).
-- Decisión 3 de docs/transcriptor/01-decisiones-16oct.md. Código: src/lib/passkey/*,
-- src/pages/api/admin/passkey/*, src/pages/admin/seguridad.astro.
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO está aplicada).
-- Aditiva: no modifica tablas existentes; solo inserta el ajuste passkey_obligatoria = 'false'.
-- Regla del proyecto: RLS activado sin políticas para anon/authenticated + grants explícitos a service_role.
-- Mientras la migración no esté aplicada, el login sigue funcionando solo con contraseña
-- (el código trata "tabla inexistente" como "sin passkeys registradas").

-- ── 1. Passkeys registradas (iPhone, Mac, …) ─────────────────────────────────
-- Solo datos públicos de la credencial: la llave privada nunca sale del dispositivo.
create table if not exists public.admin_passkeys (
  id             uuid primary key default gen_random_uuid(),
  credential_id  text not null unique,             -- base64url, lo entrega el navegador
  public_key     text not null,                    -- llave pública COSE en base64url
  counter        bigint not null default 0 check (counter >= 0),
  transports     text[] not null default '{}',
  device_type    text check (device_type is null or device_type in ('singleDevice','multiDevice')),
  backed_up      boolean not null default false,   -- true = sincronizada (Llavero de iCloud)
  aaguid         text,
  nombre         text not null check (char_length(nombre) between 1 and 60),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

-- ── 2. Códigos de respaldo (un solo uso; solo el hash) ───────────────────────
-- hash = 'scrypt$<sal base64url>$<hash base64url>'. El código en claro se muestra una vez.
create table if not exists public.admin_codigos_respaldo (
  id          uuid primary key default gen_random_uuid(),
  lote        uuid not null,                       -- un lote por generación; al regenerar se anula el anterior
  hash        text not null unique,
  created_at  timestamptz not null default now(),
  usado_at    timestamptz,                         -- se usó para entrar
  anulado_at  timestamptz                          -- se reemplazó por un lote nuevo
);
create index if not exists idx_admin_codigos_respaldo_vigentes
  on public.admin_codigos_respaldo(created_at) where usado_at is null and anulado_at is null;

-- ── 3. Desafíos (challenges) de WebAuthn: un solo uso, vencen en 5 minutos ───
-- vinculo = firma del token (de paso intermedio o de sesión) que pidió el desafío:
-- un desafío pedido por un navegador no sirve en otro.
create table if not exists public.admin_webauthn_desafios (
  id          uuid primary key default gen_random_uuid(),
  challenge   text not null unique,
  tipo        text not null check (tipo in ('registro','acceso')),
  vinculo     text not null,
  vence       timestamptz not null,
  usado_at    timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_admin_webauthn_desafios_vence on public.admin_webauthn_desafios(vence);

-- ── 4. RLS + permisos ────────────────────────────────────────────────────────
alter table public.admin_passkeys           enable row level security;
alter table public.admin_codigos_respaldo   enable row level security;
alter table public.admin_webauthn_desafios  enable row level security;

revoke all on public.admin_passkeys          from anon, authenticated;
revoke all on public.admin_codigos_respaldo  from anon, authenticated;
revoke all on public.admin_webauthn_desafios from anon, authenticated;

grant select, insert, update, delete on public.admin_passkeys          to service_role;
grant select, insert, update         on public.admin_codigos_respaldo  to service_role; -- se anulan, no se borran
grant select, insert, update, delete on public.admin_webauthn_desafios to service_role; -- los vencidos se limpian

-- ── 5. Ajuste: passkey obligatoria (APAGADO) ─────────────────────────────────
-- 'false': si hay passkey se pide, pero se puede entrar "sin passkey esta vez".
-- 'true' : la contraseña sola no basta (passkey o código de respaldo). Solo se
--          activa desde /admin/seguridad, con al menos una passkey registrada.
insert into public.settings (key, value) values ('passkey_obligatoria', 'false')
on conflict (key) do nothing;
