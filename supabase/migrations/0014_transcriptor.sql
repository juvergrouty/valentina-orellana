-- 0014_transcriptor.sql — Transcriptor IA (15 oct 2026). Diseño: docs/transcriptor/50-arquitectura.md §2,
-- con los ajustes de 30-seguridad.md (cifrado por sobre, bitácora solo-agregar), 10-etica-legal.md §4
-- (rótulo IA, nada se borra, preguntas cifradas) y 20-clinico.md §0 (resumen = anexo aparte de la nota).
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO está aplicada).
-- Aditiva: no modifica tablas existentes; solo inserta ajustes nuevos en settings (todo APAGADO).
-- Regla del proyecto: RLS activado sin políticas para anon/authenticated + grants explícitos a service_role.

-- ── 1. Grabaciones: una por sesión grabada (presencial u online) ─────────────
create table if not exists public.grabaciones (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid references public.patients(id) on delete restrict,   -- null = "sin asignar"
  booking_id         uuid references public.bookings(id) on delete set null,
  google_event_id    text,
  consent_ids        uuid[] not null default '{}',   -- consentimiento(s) vigente(s) al iniciar (pareja: ambos)
  origen             text not null check (origen in ('presencial','online')),
  tipo               text not null default 'sin_tipo' check (tipo in ('individual','pareja','sin_tipo')),
  lugar_con_ruido    boolean not null default false,
  modelo             text not null check (modelo in ('universal-2','universal-3-5-pro')),
  diarizacion        boolean not null default false,  -- speaker_labels de AssemblyAI (solo pareja presencial)
  estado             text not null default 'creada' check (estado in (
                       'creada','sin_consentimiento',
                       'bot_lanzando','bot_en_lobby','bot_no_admitido',
                       'grabando','pausada','subiendo','subida',
                       'transcribiendo','transcrita','resumiendo','lista',
                       'sin_audio','cancelada','error')),
  estado_antes_error text check (estado_antes_error is null or estado_antes_error in (
                       'creada','bot_lanzando','bot_en_lobby','grabando','pausada','subiendo','subida',
                       'transcribiendo','transcrita','resumiendo')),
  session_date       date not null,
  inicio_at          timestamptz,
  fin_at             timestamptz,
  hora_fin_prevista  timestamptz,
  duracion_seg       integer check (duracion_seg is null or duracion_seg >= 0),
  pausas             jsonb not null default '[]'::jsonb,  -- [{desde_ms, hasta_ms}] → "[Grabación pausada a pedido]"
  meet_url           text,
  bot_machine_id     text,
  bot_token_sha256   text,                                 -- solo el hash del token de un uso del bot
  bot_token_vence_at timestamptz,
  linea_hablantes    jsonb,                                -- online: [{t_ms, nombre, on}]
  mapa_hablantes     jsonb,                                -- {"A":"Ps. Valentina","B":"Paciente 1"} editable
  intentos           integer not null default 0,
  ultimo_error       text,
  tomada_en          timestamptz,                          -- lease del cron (10 min)
  audio_borrado_at   timestamptz,
  nota_sistema       text,                                 -- p. ej. "Grabación incompleta (el bot se cayó a los 32 min)"
  creada_por         text not null default 'vale' check (creada_por in ('vale','bot','cron')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists grabaciones_evento_unq
  on public.grabaciones (google_event_id) where google_event_id is not null and origen = 'online';
create index if not exists grabaciones_patient_idx on public.grabaciones (patient_id, session_date desc);
create index if not exists grabaciones_pendientes_idx on public.grabaciones (estado, updated_at)
  where estado not in ('lista','sin_audio','cancelada','sin_consentimiento','bot_no_admitido');
create index if not exists grabaciones_booking_idx on public.grabaciones (booking_id);

-- ── 2. Segmentos de audio (cada pausa/reanudación o cada 15 min del bot) ────
create table if not exists public.grabacion_segmentos (
  id                 uuid primary key default gen_random_uuid(),
  grabacion_id       uuid not null references public.grabaciones(id) on delete cascade,
  seq                integer not null check (seq >= 0),
  r2_key             text not null,              -- a/<uuid opaco>.<ext> en el bucket de audio temporal
  mime               text not null,
  bytes              bigint check (bytes is null or bytes >= 0),
  sha256             text,
  offset_ms          integer not null default 0,
  duracion_ms        integer,
  subido_at          timestamptz,
  aai_transcript_id  text unique,
  aai_estado         text check (aai_estado in ('enviado','queued','processing','completed','error')),
  aai_enviado_at     timestamptz,
  aai_completado_at  timestamptz,
  aai_error          text,
  aai_audio_seg      numeric,                    -- audio_duration facturado (costos)
  aai_borrado_at     timestamptz,                -- DELETE /v2/transcript/{id} OK
  audio_borrado_at   timestamptz,                -- DELETE del objeto en R2 OK
  created_at         timestamptz not null default now(),
  unique (grabacion_id, seq)
);
create index if not exists segmentos_aai_pend_idx on public.grabacion_segmentos (aai_estado)
  where aai_estado in ('enviado','queued','processing','completed');

-- ── 3. Transcripciones: solo punteros y metadatos. El texto vive cifrado en R2 + B2 ──
-- Formato del objeto y cifrado por sobre (KEK/DEK): 30-seguridad.md §3.
create table if not exists public.transcripciones (
  id              uuid primary key default gen_random_uuid(),
  grabacion_id    uuid not null unique references public.grabaciones(id) on delete restrict,
  r2_key          text not null,                 -- t/<uuid opaco>.bin (sin nombre, fecha ni id de paciente)
  b2_key          text,
  b2_copiada_at   timestamptz,
  formato_v       smallint not null default 1,   -- versión del formato "VOT1"
  kek_v           smallint not null default 1,   -- TRANSCRIPTOR_KEK_V<n> que envuelve la DEK
  dek_envuelta    bytea,                         -- copia para borrado criptográfico (null = destruida)
  sha256_cifrado  text not null,
  bytes           integer not null check (bytes >= 0),
  palabras        integer not null default 0,
  tokens_aprox    integer,
  duracion_s      integer,
  modelo          text not null,
  idioma          text not null default 'es',
  deleted_at      timestamptz,                   -- borrado real (R2 + B2 + DEK); la fila queda como prueba
  motivo_borrado  text,
  created_at      timestamptz not null default now(),
  check (deleted_at is null or motivo_borrado is not null)
);

-- ── 4. Instrucciones de Vale para la IA (versionadas, nunca se borran) ───────
create table if not exists public.instrucciones_ia (
  id          uuid primary key default gen_random_uuid(),
  uso         text not null check (uso in ('resumen','preguntas')),
  texto       text not null check (length(texto) between 1 and 20000),
  activa      boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists instrucciones_activa_unq on public.instrucciones_ia (uso) where activa;

-- ── 5. Resúmenes automáticos = ANEXO de la ficha, separado de session_notes ──
-- Nunca se mezcla con la nota de evolución de Vale. Rótulo fijo en la interfaz y exportaciones.
-- No se borran ni se pisan: regenerar = nueva versión; si Vale edita, se guarda una fila nueva
-- con autor='vale' y basado_en = la versión de la IA (la original queda intacta).
create table if not exists public.resumenes_ia (
  id                   uuid primary key default gen_random_uuid(),
  grabacion_id         uuid not null references public.grabaciones(id) on delete restrict,
  patient_id           uuid references public.patients(id) on delete restrict,
  booking_id           uuid references public.bookings(id) on delete set null,
  transcripcion_id     uuid references public.transcripciones(id) on delete set null,
  version              integer not null default 1 check (version >= 1),
  autor                text not null default 'ia' check (autor in ('ia','vale')),
  basado_en            uuid references public.resumenes_ia(id) on delete restrict,
  plantilla            text not null default 'individual' check (plantilla in ('individual','pareja')),
  rotulo               text not null default 'Resumen automático (IA) — no revisado',
  instrucciones_id     uuid references public.instrucciones_ia(id) on delete set null,
  prompt_version       text,                    -- versión de la parte fija del prompt (trazabilidad)
  modelo               text not null default 'claude-sonnet-5-5',
  modo                 text not null default 'batch' check (modo in ('batch','directo')),
  estado               text not null default 'pendiente' check (estado in ('pendiente','en_batch','listo','error')),
  batch_id             text,
  custom_id            text unique check (custom_id is null or custom_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  batch_borrado_at     timestamptz,             -- DELETE /v1/messages/batches/{id} OK
  intentos             integer not null default 0,
  ultimo_error         text,
  contenido            text,
  atencion_prioridad   text check (atencion_prioridad in ('ALTA','REVISAR')), -- solo si transcriptor_alerta_riesgo
  atencion_revisada_at timestamptz,
  tokens_entrada       integer,
  tokens_salida        integer,
  costo_usd            numeric(10,5),
  oculto_at            timestamptz,             -- Vale puede archivarlo; nunca se borra
  created_at           timestamptz not null default now(),
  listo_at             timestamptz,
  unique (grabacion_id, version),
  check (autor = 'ia' or basado_en is not null)
);
create index if not exists resumenes_batch_idx on public.resumenes_ia (estado, batch_id) where estado in ('pendiente','en_batch');
create index if not exists resumenes_patient_idx on public.resumenes_ia (patient_id, created_at desc);
create index if not exists resumenes_booking_idx on public.resumenes_ia (booking_id);

-- Un resumen listo no se pisa ni se borra (D41: 15 años). Solo se permiten cambios de
-- metadatos posteriores (oculto_at, atencion_revisada_at, batch_borrado_at).
create or replace function public.resumenes_ia_protegido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'resumenes_ia no se borra (usar oculto_at)';
  end if;
  if old.estado = 'listo' and (
       new.contenido is distinct from old.contenido
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
drop trigger if exists resumenes_ia_protegido on public.resumenes_ia;
create trigger resumenes_ia_protegido before update or delete on public.resumenes_ia
  for each row execute function public.resumenes_ia_protegido();

-- ── 6. Preguntas a la IA (Q&A con Haiku 5.5). Texto CIFRADO (10-etica-legal §4.10) ──
-- Las respuestas no forman parte de la ficha salvo que Vale las copie.
create table if not exists public.preguntas_ia (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid references public.patients(id) on delete restrict,
  grabacion_ids      uuid[] not null,
  pregunta_cifrada   bytea not null,          -- mismo formato VOT1 que las transcripciones
  respuesta_cifrada  bytea,
  pregunta_largo     integer not null check (pregunta_largo between 1 and 4000),
  kek_v              smallint not null default 1,
  modelo             text not null default 'claude-haiku-5-5',
  tokens_entrada     integer,
  tokens_salida      integer,
  tokens_cache       integer,
  costo_usd          numeric(10,5),
  error              text,
  created_at         timestamptz not null default now()
);
create index if not exists preguntas_patient_idx on public.preguntas_ia (patient_id, created_at desc);

-- ── 7. Webhooks / eventos recibidos (idempotencia) ───────────────────────────
create table if not exists public.transcriptor_webhooks (
  id            bigserial primary key,
  proveedor     text not null check (proveedor in ('assemblyai','bot')),
  evento_id     text not null,   -- assemblyai: '<transcript_id>:<status>'; bot: '<grabacion_id>:<tipo>:<seq>'
  payload       jsonb,           -- sin contenido clínico
  recibido_at   timestamptz not null default now(),
  procesado_at  timestamptz,
  unique (proveedor, evento_id)
);

-- ── 8. Bitácora de accesos (D41 art. 9). SOLO AGREGAR ────────────────────────
-- Excepción deliberada a la regla de grants: service_role recibe solo select + insert,
-- y además un trigger rechaza UPDATE/DELETE/TRUNCATE (service_role se salta RLS, no triggers).
create table if not exists public.transcriptor_auditoria (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  actor         text not null check (actor in ('vale','sistema','bot','assemblyai','anthropic','cron')),
  accion        text not null check (length(accion) between 1 and 80),
  resultado     text not null default 'ok' check (resultado in ('ok','denegado','error')),
  grabacion_id  uuid,
  patient_id    uuid,
  ip            text,
  user_agent    text,
  detalle       jsonb            -- NUNCA contenido clínico (ni texto de preguntas)
);
create index if not exists auditoria_grab_idx on public.transcriptor_auditoria (grabacion_id, at);
create index if not exists auditoria_patient_idx on public.transcriptor_auditoria (patient_id, at);
create index if not exists auditoria_at_idx on public.transcriptor_auditoria (at desc);
create or replace function public.transcriptor_auditoria_inmutable() returns trigger
language plpgsql as $$ begin raise exception 'transcriptor_auditoria es solo de inserción'; end $$;
drop trigger if exists auditoria_inmutable on public.transcriptor_auditoria;
create trigger auditoria_inmutable before update or delete on public.transcriptor_auditoria
  for each row execute function public.transcriptor_auditoria_inmutable();
drop trigger if exists auditoria_sin_truncate on public.transcriptor_auditoria;
create trigger auditoria_sin_truncate before truncate on public.transcriptor_auditoria
  for each statement execute function public.transcriptor_auditoria_inmutable();

-- ── 9. Salud (un registro por chequeo) + reportes mensuales ─────────────────
create table if not exists public.transcriptor_salud (
  chequeo         text primary key,
  ok              boolean not null,
  revisado_at     timestamptz not null default now(),
  ultimo_ok_at    timestamptz,
  fallo_desde     timestamptz,
  detalle         jsonb,
  alertado_at     timestamptz           -- freno: 1 correo por chequeo cada 24 h
);
create table if not exists public.transcriptor_reportes (
  mes                    date primary key,
  generado_at            timestamptz not null default now(),
  datos                  jsonb not null,   -- solo métricas, sin contenido clínico
  revisado_por_claude_at timestamptz,
  notas_revision         text
);

-- ── 10. Costos por mes (vista; los montos viven en cada fila) ───────────────
-- security_invoker: la vista respeta los permisos de quien consulta (no los del dueño).
create or replace view public.transcriptor_costos_mes with (security_invoker = true) as
with g as (
  select date_trunc('month', created_at)::date as mes,
         count(*) filter (where estado = 'lista') as sesiones_listas
  from public.grabaciones group by 1
), s as (
  select date_trunc('month', g2.created_at)::date as mes,
         sum(seg.aai_audio_seg) / 3600.0 as horas_audio
  from public.grabacion_segmentos seg join public.grabaciones g2 on g2.id = seg.grabacion_id
  group by 1
), r as (
  select date_trunc('month', created_at)::date as mes, sum(costo_usd) as usd_resumenes
  from public.resumenes_ia group by 1
), p as (
  select date_trunc('month', created_at)::date as mes, sum(costo_usd) as usd_preguntas
  from public.preguntas_ia group by 1
), meses as (
  select mes from g union select mes from s union select mes from r union select mes from p
)
select m.mes,
       coalesce(g.sesiones_listas, 0) as sesiones_listas,
       coalesce(s.horas_audio, 0)     as horas_audio,
       coalesce(r.usd_resumenes, 0)   as usd_resumenes,
       coalesce(p.usd_preguntas, 0)   as usd_preguntas
from meses m
left join g on g.mes = m.mes
left join s on s.mes = m.mes
left join r on r.mes = m.mes
left join p on p.mes = m.mes;

-- ── RLS + permisos (sin políticas anon/authenticated) ───────────────────────
alter table public.grabaciones            enable row level security;
alter table public.grabacion_segmentos    enable row level security;
alter table public.transcripciones        enable row level security;
alter table public.instrucciones_ia       enable row level security;
alter table public.resumenes_ia           enable row level security;
alter table public.preguntas_ia           enable row level security;
alter table public.transcriptor_webhooks  enable row level security;
alter table public.transcriptor_auditoria enable row level security;
alter table public.transcriptor_salud     enable row level security;
alter table public.transcriptor_reportes  enable row level security;

grant select, insert, update, delete on public.grabaciones            to service_role;
grant select, insert, update, delete on public.grabacion_segmentos    to service_role;
grant select, insert, update, delete on public.transcripciones        to service_role;
grant select, insert, update, delete on public.instrucciones_ia       to service_role;
grant select, insert, update, delete on public.resumenes_ia           to service_role; -- el trigger impide borrar/pisar
grant select, insert, update, delete on public.preguntas_ia           to service_role;
grant select, insert, update, delete on public.transcriptor_webhooks  to service_role;
grant select, insert                 on public.transcriptor_auditoria to service_role; -- solo agregar
revoke update, delete, truncate      on public.transcriptor_auditoria from service_role;
grant select, insert, update, delete on public.transcriptor_salud     to service_role;
grant select, insert, update, delete on public.transcriptor_reportes  to service_role;
grant usage, select on sequence public.transcriptor_webhooks_id_seq  to service_role;
grant usage, select on sequence public.transcriptor_auditoria_id_seq to service_role;
revoke all on public.transcriptor_costos_mes from anon, authenticated;
grant select on public.transcriptor_costos_mes to service_role;

-- updated_at automático en grabaciones
create or replace function public.grabaciones_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists grabaciones_touch on public.grabaciones;
create trigger grabaciones_touch before update on public.grabaciones
  for each row execute function public.grabaciones_touch();

-- ── Ajustes (interruptores). Todo parte APAGADO / en el valor prudente ──────
insert into public.settings (key, value) values
  ('transcriptor_activo',                'false'),    -- botón Grabar + pipeline
  ('transcriptor_bot_activo',            'false'),    -- bot de Meet automático
  ('transcriptor_grabacion_requisito',   'opcional'), -- 'obligatoria' | 'opcional' (hasta que el abogado valide)
  ('transcriptor_resumen_modo',          'directo'),  -- 'batch' | 'directo' (Vale eligió protección máxima 16 oct: Messages API con HIPAA)
  ('transcriptor_alerta_riesgo',         'false'),    -- Vale decidió 16 oct: sin alertas; solo sección Atención neutra
  ('transcriptor_presupuesto_clp',       '35000'),
  ('transcriptor_usd_clp',               '950')
on conflict (key) do nothing;

-- Instrucciones iniciales (Vale las edita en /admin/transcriptor)
insert into public.instrucciones_ia (uso, texto, activa)
select 'resumen', 'Resume la sesión en español de Chile con: 1) Puntos clave. 2) Tareas que la psicóloga dio. 3) Qué revisar la próxima sesión. No inventes nada que no esté en la transcripción.', true
where not exists (select 1 from public.instrucciones_ia where uso = 'resumen');
insert into public.instrucciones_ia (uso, texto, activa)
select 'preguntas', 'Responde solo con lo que está en las transcripciones entregadas, citando fecha de sesión. Si no está, dilo.', true
where not exists (select 1 from public.instrucciones_ia where uso = 'preguntas');

-- ── (Opcional, ejecutar aparte y solo al activar) Job pg_cron de 1 minuto ───
-- Copiar EXACTAMENTE la forma del job existente 'tareas-cada-5-min'
-- (select jobname, schedule, command from cron.job;) cambiando la URL a
-- https://www.valentinaorellana.cl/api/cron/transcriptor y el horario a '* * * * *'.
