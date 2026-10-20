-- 0026_cruce_permitido.sql - hora libre al agendar desde el panel (20 oct 2026).
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO esta aplicada).
-- Idempotente. ESTE ARCHIVO ES SOLO ASCII A PROPOSITO (ver 0024).
--
-- Pedido de Vale: al agendar o reagendar desde el panel puede poner la hora que quiera; si se cruza
-- con otra sesion, el panel le avisa y ella decide "agendar igual". Hoy la base lo impide siempre:
--   * bookings_sin_cruces (0013): dos sesiones activas no pueden cruzarse;
--   * idx_bookings_slot (0001): dos sesiones activas no pueden empezar a la misma hora.
-- Esta migracion agrega bookings.cruce_permitido (false por defecto) y deja FUERA de esas dos reglas
-- solo las sesiones que Vale acepto cruzar (cruce_permitido = true, lo pone el panel tras su
-- confirmacion). Todo lo demas sigue igual: la agenda web nunca ofrece una hora ocupada (eso lo
-- revisa el sitio con todas las sesiones, tambien las cruzadas) y las reservas normales siguen
-- protegidas por la base.
--
-- Sin esta migracion el panel avisa el cruce y, si Vale elige "agendar igual", explica que la base
-- todavia no lo permite (no se guarda nada a medias).

alter table bookings add column if not exists cruce_permitido boolean not null default false;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'bookings_sin_cruces') then
    alter table bookings drop constraint bookings_sin_cruces;
  end if;
  alter table bookings add constraint bookings_sin_cruces exclude using gist (
    tsrange((session_date + session_time),
            ((session_date + session_time) + ((coalesce(duration_min, 50))::double precision * '00:01:00'::interval))) with &&
  ) where ((status <> all (array['cancelled'::text, 'expired'::text]))
           and (session_date <> '2099-12-31'::date)
           and (session_date >= '2026-10-08'::date)
           and (not cruce_permitido));
end $$;

drop index if exists idx_bookings_slot;
create unique index idx_bookings_slot
  on bookings(session_date, session_time)
  where status not in ('cancelled', 'expired') and session_date <> '2099-12-31' and not cruce_permitido;

notify pgrst, 'reload schema';
