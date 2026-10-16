-- 0022_transcriptor_bot_cuenta.sql — Robot de Meet con cuenta de Google propia (decisión G, 16 oct noche).
-- Diseño y pasos: docs/transcriptor/85-robot-meet.md. Código: src/lib/transcriptor/botCuenta.ts.
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO está aplicada), después
-- de 0014–0019. Aditiva e idempotente. Sin esta tabla el robot sigue en modo invitado (el código lo
-- trata como "no hay cuenta"): no rompe nada si se aplica tarde.
--
-- Una sola fila (id = 1): la sesión de Google del robot, CIFRADA (AES-256-GCM, formato "VOS1.",
-- llave derivada de BOT_TOKEN_SECRET con HKDF). Nunca contraseñas. Solo service_role.

create table if not exists public.transcriptor_bot_sesion (
  id              smallint primary key default 1 check (id = 1),
  cuenta_email    text check (cuenta_email is null or length(cuenta_email) between 6 and 120),
  sesion_cifrada  text check (sesion_cifrada is null or sesion_cifrada like 'VOS1.%'),
  estado          text not null default 'vencida' check (estado in ('vigente', 'vencida')),
  vencida_motivo  text check (vencida_motivo is null or length(vencida_motivo) <= 200),
  actualizada_at  timestamptz,
  verificada_at   timestamptz,
  -- Candado: un solo bot usa la sesión a la vez (Google ve la misma sesión en dos IP como riesgo).
  en_uso_por      uuid references public.grabaciones(id) on delete set null,
  en_uso_hasta    timestamptz,
  version         integer not null default 0,
  created_at      timestamptz not null default now()
);

comment on table public.transcriptor_bot_sesion is
  'Sesión de Google (cookies) del robot de Meet "Notas Ps. Valentina Orellana", cifrada. Sin datos de pacientes. Ver docs/transcriptor/85-robot-meet.md';

-- Regla del proyecto: RLS sin políticas + sin privilegios para anon/authenticated + grants a service_role.
alter table public.transcriptor_bot_sesion enable row level security;
revoke all on public.transcriptor_bot_sesion from anon, authenticated;
grant select, insert, update on public.transcriptor_bot_sesion to service_role;

-- Modo del robot: 'invitado' por defecto hasta que exista la cuenta (Vale lo cambia a 'cuenta').
insert into public.settings (key, value)
values ('transcriptor_bot_modo', 'invitado')
on conflict (key) do nothing;
