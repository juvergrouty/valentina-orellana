-- 0027_seguimientos.sql - seguimientos automaticos (aprobado por Vale el 18 nov 2026).
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO esta aplicada).
-- Aditiva e idempotente: solo crea dos tablas nuevas. ESTE ARCHIVO ES SOLO ASCII A PROPOSITO (ver 0024).
-- Sin esta migracion el sitio funciona igual: el webhook de WhatsApp responde 200 sin guardar nada,
-- la tarea /api/cron/seguimientos no envia nada y /admin/seguimientos avisa que falta la 0027.
--
-- Privacidad: NO se guarda el texto de ningun mensaje. Solo metadatos: telefono, nombre de perfil,
-- correo, fechas, de donde llego (anuncio / codigo del sitio / marcado a mano) y el codigo G-XXXX.
-- Regla del proyecto: RLS sin politicas para anon/authenticated + permisos explicitos a service_role.

-- Personas en seguimiento:
--  * tipo 'consulta': quien escribio por primera vez (desde un anuncio, con el codigo del sitio, o
--    marcada a mano "Consulta nueva" en el panel). Nunca familia ni amigos: un WhatsApp sin anuncio
--    ni codigo NO crea fila.
--  * tipo 'paciente': solo existe si Vale marco "No escribir" a una paciente (la lista de pacientes
--    sale de patients/bookings; esta fila guarda unicamente esa marca).
create table if not exists public.seguimiento_personas (
  id                        uuid primary key default gen_random_uuid(),
  tipo                      text not null default 'consulta' check (tipo in ('consulta', 'paciente')),
  nombre                    text check (nombre is null or char_length(nombre) <= 120),
  telefono                  text check (telefono is null or telefono ~ '^[0-9]{8,15}$'),
  email                     text check (email is null or char_length(email) <= 200),
  patient_id                uuid references public.patients(id) on delete cascade,
  origen                    text not null check (origen in ('anuncio', 'codigo', 'manual', 'paciente')),
  codigo                    text check (codigo is null or codigo ~ '^[A-Z]-[A-Z0-9]{4}$'),
  -- Ultimo mensaje que la persona le escribio a Vale (WhatsApp entrante).
  ultimo_entrante_at        timestamptz,
  -- Ultima respuesta de Vale desde la app WhatsApp Business (smb_message_echoes) o la fecha que
  -- ella indico al marcarla "Consulta nueva". La secuencia 1 parte SOLO despues de esto.
  ultima_respuesta_vale_at  timestamptz,
  no_escribir               boolean not null default false,
  -- Consulta por correo: Vale ya confirmo "No respondio: enviar el segundo" (si no, el 1B espera su aprobacion,
  -- porque las respuestas por correo no se detectan solas).
  segundo_aprobado          boolean not null default false,
  estado                    text not null default 'activa'
                            check (estado in ('activa', 'agendo', 'respondio', 'no_siguio', 'no_escribir')),
  creado_at                 timestamptz not null default now(),
  actualizado_at            timestamptz not null default now()
);
create unique index if not exists seguimiento_personas_telefono on public.seguimiento_personas (telefono) where telefono is not null;
create unique index if not exists seguimiento_personas_email on public.seguimiento_personas (lower(email)) where email is not null;
create unique index if not exists seguimiento_personas_paciente on public.seguimiento_personas (patient_id) where patient_id is not null;

-- Registro de cada envio (y de cada omision con su motivo). unique(clave, paso, referencia) hace que
-- un mismo paso nunca salga dos veces aunque la tarea corra cada 5 minutos; la fila se "toma" antes
-- de enviar (estado en_curso) y se cierra despues (enviado / error).
--  clave:      'consulta:<id>' | 'paciente:<patient_id>' | 'resumen'
--  paso:       '1A' | '1B' | '2A' | '3A' | '4A' | 'resumen'
--  estado por_aprobar/aprobado: 3A (pausa) y 1B de consultas por correo, que esperan a Vale.
--  referencia: '' (1A/1B), fecha de la ultima sesion (2A/3A), id de la reserva (4A), fecha (resumen)
create table if not exists public.seguimiento_envios (
  id           bigserial primary key,
  clave        text not null check (char_length(clave) <= 80),
  paso         text not null check (paso in ('1A', '1B', '2A', '3A', '4A', 'resumen')),
  referencia   text not null default '' check (char_length(referencia) <= 80),
  estado       text not null default 'en_curso'
               check (estado in ('en_curso', 'enviado', 'error', 'omitido', 'por_aprobar', 'aprobado', 'descartado')),
  canal        text check (canal is null or canal in ('correo', 'whatsapp_texto', 'whatsapp_plantilla')),
  -- Para el tope por persona (2 mensajes automaticos) y para el resumen diario.
  telefono     text,
  email        text,
  nombre       text,
  motivo       text check (motivo is null or char_length(motivo) <= 500),
  intentos     int not null default 1,
  tomada_en    timestamptz,
  enviado_at   timestamptz,
  creado_at    timestamptz not null default now(),
  unique (clave, paso, referencia)
);
create index if not exists seguimiento_envios_enviados on public.seguimiento_envios (enviado_at) where estado = 'enviado';
create index if not exists seguimiento_envios_estado on public.seguimiento_envios (estado);

-- Por si una version anterior de esta migracion ya se aplico en otra base (idempotente).
alter table public.seguimiento_personas add column if not exists segundo_aprobado boolean not null default false;

alter table public.seguimiento_personas enable row level security;
alter table public.seguimiento_envios enable row level security;
revoke all on public.seguimiento_personas from public, anon, authenticated;
revoke all on public.seguimiento_envios from public, anon, authenticated;
grant select, insert, update, delete on public.seguimiento_personas to service_role;
grant select, insert, update on public.seguimiento_envios to service_role; -- registro: no se borra
grant usage, select on sequence public.seguimiento_envios_id_seq to service_role;

-- Interruptor general (apagado hasta que Vale lo encienda en /admin/seguimientos).
insert into public.settings (key, value) values ('seguimientos_activos', 'false') on conflict (key) do nothing;

-- DESPUES de aplicar esta migracion: agregar la llamada a /api/cron/seguimientos al job de pg_cron
-- existente 'tareas-cada-5-min' (su comando vive solo en la base; ver docs/transcriptor/70-cron.md),
-- o crear un job propio con la misma forma:
--
-- select cron.schedule(
--   'seguimientos-cada-5-min',
--   '*/5 * * * *',
--   $$
--   select net.http_get(
--     url := 'https://www.valentinaorellana.cl/api/cron/seguimientos',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || (select value from public.settings where key = 'cron_interno_secret')
--     ),
--     timeout_milliseconds := 60000
--   ) as request_id;
--   $$
-- );
