-- Ejecutar UNA VEZ en el SQL Editor de Supabase (Project → SQL Editor → New query).
-- Es aditivo y seguro: no borra ni modifica datos existentes.

-- Consentimiento informado de tratamiento de datos (Ley 21.719). Cada envío
-- crea una fila con un token único; el paciente la firma desde
-- /consentimiento/<token>. La fila firmada es la prueba del consentimiento:
-- guarda el texto exacto que aceptó (y su hash), qué autorizaciones marcó,
-- cuándo, desde qué IP y navegador. Nunca se borra al borrar la ficha
-- (patient_id queda en null pero el registro y el nombre/RUT firmados siguen).
create table if not exists consents (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid references patients(id) on delete set null,
  token              text not null unique,
  version            text not null,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz,
  sent_via           text,              -- 'whatsapp' | 'email' | 'link'
  signed_at          timestamptz,
  signer_name        text,
  signer_rut         text,
  signer_email       text,
  accept_treatment   boolean not null default false, -- obligatoria
  accept_recording   boolean not null default false, -- grabación para transcribir notas
  accept_case_review boolean not null default false, -- análisis anónimo con psicólogos
  text_snapshot      text,
  text_sha256        text,
  ip                 text,
  user_agent         text,
  revoked_at         timestamptz,
  revoked_note       text
);

create index if not exists consents_patient_idx on consents (patient_id);

-- Nadie fuera del servidor puede leerla (el sitio usa service_role, que no
-- pasa por RLS). Los permisos explícitos evitan el error "permission denied"
-- que ya pasó con admin_logs/blocked_slots/bulk_emails.
alter table consents enable row level security;
grant select, insert, update, delete on public.consents to service_role;
