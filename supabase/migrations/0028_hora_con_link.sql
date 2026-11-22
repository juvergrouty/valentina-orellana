-- 0028_hora_con_link.sql - link de pago a UNA hora (/hora/<token>), pedido por Vale el 22 nov 2026.
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO esta aplicada).
-- Aditiva e idempotente: solo agrega tres columnas opcionales a bookings y un indice.
-- ESTE ARCHIVO ES SOLO ASCII A PROPOSITO (ver 0024).
--
-- Sin esta migracion el resto del sitio funciona igual: solo la opcion nueva
-- "Link a esta hora" del panel (y crearHoraConLink del asistente de WhatsApp)
-- responde "falta aplicar la actualizacion 0028" y no crea nada.
--
-- link_token     : codigo no adivinable de la pagina publica /hora/<token> (24 caracteres al azar).
-- link_vence_at  : hasta cuando se retiene la hora sin pagar. Pasado ese momento el cron de
--                  cada 5 min la libera (status 'expired') y le avisa a Vale. Las reservas web
--                  (30 min, expireBooking.ts) y las demas del panel NO usan esta columna.
-- link_canal     : por donde se mandan los Pasos a seguir al pagar: 'whatsapp' (se agendo con
--                  telefono) o 'correo' (se agendo solo con correo).

alter table public.bookings add column if not exists link_token    text;
alter table public.bookings add column if not exists link_vence_at timestamptz;
alter table public.bookings add column if not exists link_canal    text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_link_canal_check') then
    alter table public.bookings add constraint bookings_link_canal_check
      check (link_canal is null or link_canal in ('whatsapp', 'correo'));
  end if;
end $$;

create unique index if not exists idx_bookings_link_token
  on public.bookings(link_token) where link_token is not null;

-- Para el cron que libera las horas vencidas (solo filas con plazo).
create index if not exists idx_bookings_link_vence
  on public.bookings(link_vence_at) where link_vence_at is not null;

comment on column public.bookings.link_token    is 'Codigo de /hora/<token> (link a una sola hora). Ver src/lib/horaLink.ts';
comment on column public.bookings.link_vence_at is 'Hasta cuando se retiene la hora sin pagar (Configuracion: hora_link_retencion_horas, 24 h por defecto)';
comment on column public.bookings.link_canal    is 'Pasos a seguir al pagar: whatsapp o correo';
