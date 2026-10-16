-- 0021_consentimiento_pareja_y_anexos.sql — decisiones de Vale del 16 oct noche
-- (docs/transcriptor/02-decisiones-16oct-noche.md, D y E). Requiere 0004 y 0019.
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO está aplicada).
-- Aditiva e idempotente: no borra ni cambia datos existentes. Las firmas ya hechas (v1, v2, v3)
-- quedan exactamente igual: la columna nueva vale 1 para todas.
-- Sin esta migración el sitio sigue funcionando como hoy: el link de la pareja y los anexos
-- muestran "falta actualizar la base de datos (0021)" y nada más cambia.
-- Regla del proyecto: RLS sin políticas para anon/authenticated + grants explícitos a service_role.

-- ── D: consentimiento de la segunda persona de una pareja ──────────────────
-- persona = 1: la persona agendada (la de la ficha). Todas las firmas existentes.
-- persona = 2: la segunda persona de la pareja (no agendada). Firma su propio consentimiento,
--              por su link, ligado a la MISMA ficha (patient_id). No se copia su RUT ni su correo
--              a la ficha.
alter table public.consents add column if not exists persona smallint not null default 1;
do $$ begin
  alter table public.consents add constraint consents_persona_chk check (persona in (1, 2));
exception when duplicate_object then null; end $$;
create index if not exists consents_patient_persona_idx on public.consents (patient_id, persona);

-- consents solo la usa el servidor (service_role). Se refuerza: nada para anon/authenticated.
revoke all on public.consents from anon, authenticated;
grant select, insert, update, delete on public.consents to service_role;

-- ── E: anexo del consentimiento = copia fiel del correo con el aviso v2 ──────
-- Una fila por firma y tipo de anexo. Guarda el HTML COMPLETO tal como se entregó a Resend, el
-- asunto, el destinatario, la fecha y hora de envío, el id de Resend y la huella SHA-256 del HTML
-- (para probar que no se alteró). Es constancia: solo select + insert (no se edita ni se borra).
-- El HTML va en la base y no en R2: pesa ~10 KB, existe a lo más una vez por firma v2 (decenas en
-- total) y contiene lo mismo que ya está en claro en bookings (nombre, fecha, valor), sin datos
-- clínicos. Así se guarda en el mismo paso del envío, sin depender de R2.
create table if not exists public.consent_anexos (
  id            uuid primary key default gen_random_uuid(),
  consent_id    uuid not null references public.consents(id) on delete restrict,
  aviso_id      uuid references public.consent_avisos(id) on delete restrict,
  patient_id    uuid references public.patients(id) on delete set null,
  booking_id    uuid references public.bookings(id) on delete set null,
  tipo          text not null check (tipo in ('aviso_v2')),
  asunto        text not null,
  destinatario  text not null,
  enviado_at    timestamptz not null,
  resend_id     text,
  html          text not null,
  html_sha256   text not null check (html_sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  unique (consent_id, tipo)
);
create index if not exists consent_anexos_patient_idx on public.consent_anexos (patient_id);
alter table public.consent_anexos enable row level security;
revoke all on public.consent_anexos from anon, authenticated;
grant select, insert on public.consent_anexos to service_role; -- constancia: no se edita ni se borra
