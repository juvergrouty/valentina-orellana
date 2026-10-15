-- Documenta en el repositorio dos protecciones que YA existen en producción
-- (verificado en Supabase el 15 oct 2026) y que no estaban versionadas:
--   1. bookings_sin_cruces: dos sesiones no activas no pueden cruzarse en horario.
--   2. RLS activado en todas las tablas: anon/authenticated no leen datos de
--      pacientes; todo pasa por las API del sitio con la service role key.
-- Es idempotente: si ya existen, no cambia nada. Sirve para recrear la base.

create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_sin_cruces') then
    -- Definición idéntica a la de producción (pg_get_constraintdef, 15 oct 2026).
    alter table bookings add constraint bookings_sin_cruces exclude using gist (
      tsrange((session_date + session_time),
              ((session_date + session_time) + ((coalesce(duration_min, 50))::double precision * '00:01:00'::interval))) with &&
    ) where ((status <> all (array['cancelled'::text, 'expired'::text]))
             and (session_date <> '2099-12-31'::date)
             and (session_date >= '2026-10-08'::date));
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['patients', 'session_notes', 'consents', 'admin_logs', 'bookings',
                           'blocked_slots', 'bulk_emails', 'bulk_email_recipients', 'settings'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('revoke all on %I from anon, authenticated', t);
    end if;
  end loop;
end $$;
