-- Registro de envíos "una sola vez" (8 oct 2026, aplicada en producción ese día).
-- Cada fila es un envío pendiente o hecho de una reserva: lo que sigue a un pago
-- (confirmación, aviso a Valentina, calendario, boleta, pasos a seguir) y los
-- recordatorios. La regla unique(booking_id, tarea) y la toma atómica de cada
-- fila (estado) garantizan que nada se envíe dos veces; lo que falla se
-- reintenta cada 5 min (ver src/lib/tareasEnvio.ts).
create table if not exists public.tareas_envio (
  id bigserial primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  tarea text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','en_curso','hecha','error','descartada')),
  intentos int not null default 0,
  ultimo_error text,
  tomada_en timestamptz,
  hecha_en timestamptz,
  creada_en timestamptz not null default now(),
  unique (booking_id, tarea)
);
create index if not exists tareas_envio_pendientes on public.tareas_envio (estado) where estado in ('pendiente','en_curso','error');
alter table public.tareas_envio enable row level security;
-- Este proyecto no da permisos por defecto a las tablas nuevas: sin esto el
-- servidor (service_role) recibía "permission denied for table tareas_envio".
grant select, insert, update, delete on public.tareas_envio to service_role;
grant usage, select on sequence public.tareas_envio_id_seq to service_role;
