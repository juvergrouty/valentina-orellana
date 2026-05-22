-- ═══════════════════════════════════════════════════════════════════════════
-- SCHEMA — Ps. Valentina Orellana
-- Ejecutar en: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Slots de disponibilidad semanal ─────────────────────────────────────
create table if not exists availability_slots (
  id           uuid primary key default gen_random_uuid(),
  day_of_week  integer not null check (day_of_week between 0 and 6),
  -- 0=domingo, 1=lunes, 2=martes, 3=miércoles, 4=jueves, 5=viernes, 6=sábado
  start_time   time not null,
  active       boolean default true,
  created_at   timestamptz default now()
);

create index if not exists idx_availability_day on availability_slots(day_of_week, active);

-- Semilla: lunes a viernes (ajustar según disponibilidad real de Valentina)
insert into availability_slots (day_of_week, start_time) values
  (1, '09:00'), (1, '10:00'), (1, '11:00'), (1, '15:00'), (1, '16:00'), (1, '17:00'),
  (2, '09:00'), (2, '10:00'), (2, '11:00'), (2, '15:00'), (2, '16:00'), (2, '17:00'),
  (3, '09:00'), (3, '10:00'), (3, '11:00'), (3, '15:00'), (3, '16:00'), (3, '17:00'),
  (4, '09:00'), (4, '10:00'), (4, '11:00'), (4, '15:00'), (4, '16:00'), (4, '17:00'),
  (5, '09:00'), (5, '10:00'), (5, '11:00'), (5, '14:00'), (5, '15:00');


-- ─── 2. Fechas bloqueadas (feriados, vacaciones, días sin atención) ──────────
create table if not exists blocked_dates (
  id         uuid primary key default gen_random_uuid(),
  date       date not null unique,
  reason     text,           -- opcional: "Feriado", "Vacaciones", etc.
  created_at timestamptz default now()
);

create index if not exists idx_blocked_dates_date on blocked_dates(date);


-- ─── 3. Reservas ─────────────────────────────────────────────────────────────
create table if not exists bookings (
  id               uuid primary key default gen_random_uuid(),
  session_type     text not null check (session_type in (
                     'online', 'presencial', 'pareja-online', 'pareja-presencial'
                   )),
  session_date     date not null,
  session_time     time not null,
  patient_name     text not null,
  patient_email    text not null,
  patient_phone    text not null,
  notes            text,
  status           text not null default 'pending_payment'
                   check (status in ('pending_payment', 'confirmed', 'cancelled')),
  amount           integer not null,   -- en CLP
  payment_method   text default 'flow' check (payment_method in ('flow', 'manual')),
  mp_preference_id text,
  mp_payment_id    text,
  created_at       timestamptz default now()
);

-- Evitar doble reserva en el mismo horario
create unique index if not exists idx_bookings_slot
  on bookings(session_date, session_time)
  where status != 'cancelled';

create index if not exists idx_bookings_date   on bookings(session_date);
create index if not exists idx_bookings_status on bookings(status);
create index if not exists idx_bookings_email  on bookings(patient_email);


-- ─── 4. Row Level Security ───────────────────────────────────────────────────
alter table availability_slots enable row level security;
alter table blocked_dates       enable row level security;
alter table bookings            enable row level security;
-- Toda la escritura/lectura pasa por las API routes con service_role key (bypassa RLS).
