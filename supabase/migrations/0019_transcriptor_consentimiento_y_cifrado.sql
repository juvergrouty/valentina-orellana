-- 0019_transcriptor_consentimiento_y_cifrado.sql — correcciones de la revisión ética-clínica y de código
-- del transcriptor (16 oct 2026: docs/transcriptor/81-revision-etica-clinica.md H1, H4, H5, H7 y
-- 80-revision-seguridad.md M3). Requiere 0014–0017.
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO está aplicada), y SIEMPRE
-- antes de encender el transcriptor: el código nuevo lee y escribe estas columnas (si falta, falla
-- cerrado: no graba ni guarda resúmenes en claro).
-- Aditiva: no borra ni cambia datos existentes. Regla del proyecto: RLS sin políticas para
-- anon/authenticated + grants explícitos a service_role.

-- ── H1: "Retirar solo la grabación" por persona (sin revocar el resto de su consentimiento) ──
-- Se marca en la firma de ESA persona (consents.id). El chequeo de grabación lo trata igual que una
-- revocación (consentimiento.ts). El texto firmado y el resto de las autorizaciones no se tocan.
alter table public.consents add column if not exists recording_revoked_at   timestamptz;
alter table public.consents add column if not exists recording_revoked_via  text;
alter table public.consents add column if not exists recording_revoked_note text;
do $$ begin
  alter table public.consents add constraint consents_recording_revoked_via_chk
    check (recording_revoked_via is null or recording_revoked_via in ('correo','whatsapp','presencial','otro'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.consents add constraint consents_recording_revoked_chk
    check (recording_revoked_at is null or recording_revoked_via is not null);
exception when duplicate_object then null; end $$;

-- ── H5: excluir una sesión de las preguntas a la IA (y del contexto del resumen siguiente) ──
alter table public.grabaciones add column if not exists excluir_ia_at     timestamptz;
alter table public.grabaciones add column if not exists excluir_ia_motivo text;
do $$ begin
  alter table public.grabaciones add constraint grabaciones_excluir_ia_chk
    check (excluir_ia_at is null or excluir_ia_motivo is not null);
exception when duplicate_object then null; end $$;

-- ── H7: contenido del resumen CIFRADO (formato VOT1 de cifrado.ts, tipo 'resumen') ──
-- Lo nuevo se guarda en contenido_cifrado con contenido = null. Las filas antiguas en claro se
-- siguen leyendo (compatibilidad); no se migran aquí.
alter table public.resumenes_ia add column if not exists contenido_cifrado bytea;
alter table public.resumenes_ia add column if not exists contenido_kek_v   smallint;

-- El trigger de 0014 protege también el contenido cifrado de un resumen listo.
create or replace function public.resumenes_ia_protegido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'resumenes_ia no se borra (usar oculto_at)';
  end if;
  if old.estado = 'listo' and (
       new.contenido is distinct from old.contenido
    or new.contenido_cifrado is distinct from old.contenido_cifrado
    or new.estado is distinct from old.estado
    or new.grabacion_id is distinct from old.grabacion_id
    or new.version is distinct from old.version
    or new.autor is distinct from old.autor
    or new.modelo is distinct from old.modelo
    or new.rotulo is distinct from old.rotulo) then
    raise exception 'un resumen listo no se modifica: crear una nueva versión';
  end if;
  return new;
end $$;

-- ── H4: aviso único a pacientes con consentimiento v2 (decisión 13 de 01-decisiones-16oct) ──
-- Una fila por firma (consent_id único): el aviso se muestra UNA vez, abajo del correo de
-- confirmación de su siguiente hora, y queda constancia de cuándo, por qué canal y qué texto.
create table if not exists public.consent_avisos (
  id            uuid primary key default gen_random_uuid(),
  consent_id    uuid not null unique references public.consents(id) on delete restrict,
  patient_id    uuid references public.patients(id) on delete set null,
  booking_id    uuid references public.bookings(id) on delete set null,
  canal         text not null check (canal in ('correo','whatsapp')),
  texto_version text not null,
  mostrado_at   timestamptz not null default now()
);
create index if not exists consent_avisos_patient_idx on public.consent_avisos (patient_id);
alter table public.consent_avisos enable row level security;
revoke all on public.consent_avisos from anon, authenticated;
grant select, insert on public.consent_avisos to service_role; -- constancia: no se edita ni se borra

-- ── Seg. M3: supresión de una transcripción a pedido del paciente ──
-- Usa las columnas que ya trae 0014 (transcripciones.deleted_at, motivo_borrado, dek_envuelta) y
-- deja quién la pidió y por qué canal. La fila queda como prueba; el texto se borra en R2 y B2.
alter table public.transcripciones add column if not exists borrado_canal text;
do $$ begin
  alter table public.transcripciones add constraint transcripciones_borrado_canal_chk
    check (borrado_canal is null or borrado_canal in ('correo','whatsapp','presencial','otro'));
exception when duplicate_object then null; end $$;
