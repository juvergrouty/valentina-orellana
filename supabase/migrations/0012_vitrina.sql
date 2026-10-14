-- Ejecutar UNA VEZ en el SQL Editor de Supabase. Aditivo y seguro: no toca
-- ninguna tabla existente (bookings, pagos, etc.).

-- Vitrina (14 oct 2026): talleres y charlas grupales (online por Meet o
-- presenciales en Estoril 50) y contenido digital (PDF, charla grabada).
-- Se publica desde /admin/vitrina; mientras el ajuste vitrina_publica no sea
-- 'true', /talleres responde 404 para el público. Ver src/lib/vitrina.ts.

create table if not exists public.vitrina_items (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique,
  type              text not null check (type in ('taller', 'charla', 'contenido')),
  title             text not null,
  short_description text,
  description       text,                       -- texto plano; párrafos separados por línea en blanco
  price             integer not null default 0 check (price >= 0), -- CLP; 0 = gratis
  modality          text not null default 'online' check (modality in ('online', 'presencial')),
  starts_at         timestamptz,                -- null en contenido digital
  duration_min      integer check (duration_min is null or duration_min > 0),
  capacity          integer check (capacity is null or capacity > 0), -- null = sin límite
  image_url         text,
  digital_file_path text,                       -- ruta en el bucket privado vitrina-contenido, o un enlace https externo
  meet_url          text,                       -- link de Google Meet (online): automático o pegado a mano
  google_event_id   text,                       -- evento de Google Calendar creado para el Meet
  visible           boolean not null default false,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists vitrina_items_visible_idx on public.vitrina_items (visible, sort_order);

create table if not exists public.vitrina_inscripciones (
  id                   uuid primary key default gen_random_uuid(),
  item_id              uuid not null references public.vitrina_items(id) on delete restrict,
  name                 text not null,
  email                text not null,
  phone                text,
  status               text not null default 'pending_payment'
                         check (status in ('pending_payment', 'paid', 'free', 'cancelled', 'expired')),
  amount               integer not null default 0,
  flow_token           text unique,
  flow_order           text,
  paid_at              timestamptz,
  payment_note         text,                    -- 'Flow', o el medio si Valentina la marcó pagada a mano
  confirmation_sent_at timestamptz,             -- correo de confirmación enviado (evita duplicados)
  origen               jsonb,                   -- { canal, first, last } igual que bookings.origen (src/lib/origen.ts)
  created_at           timestamptz not null default now()
);

create index if not exists vitrina_inscripciones_item_idx   on public.vitrina_inscripciones (item_id, status);
create index if not exists vitrina_inscripciones_email_idx  on public.vitrina_inscripciones (lower(email));
create index if not exists vitrina_inscripciones_pending_idx on public.vitrina_inscripciones (created_at) where status = 'pending_payment';

-- Solo el servidor (service_role) lee y escribe: sin políticas para anon.
alter table public.vitrina_items         enable row level security;
alter table public.vitrina_inscripciones enable row level security;
-- Este proyecto no da permisos por defecto a las tablas nuevas (ver 0009).
grant select, insert, update, delete on public.vitrina_items         to service_role;
grant select, insert, update, delete on public.vitrina_inscripciones to service_role;

-- Bucket PRIVADO para el contenido digital (PDF, video). El archivo se entrega
-- con un link firmado que vence en 7 días, solo a quien pagó o se inscribió.
insert into storage.buckets (id, name, public)
values ('vitrina-contenido', 'vitrina-contenido', false)
on conflict (id) do nothing;

-- Interruptor general: la vitrina parte APAGADA.
insert into public.settings (key, value)
values ('vitrina_publica', 'false')
on conflict (key) do nothing;
