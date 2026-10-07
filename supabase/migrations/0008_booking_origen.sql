-- Ejecutar UNA VEZ en el SQL Editor de Supabase. Aditivo y seguro.

-- Origen de cada reserva hecha en el sitio (7 oct 2026): de qué sitio o
-- anuncio llegó la persona (Google Ads, Instagram, Doctoralia…), para ver en
-- el panel qué canales traen pacientes. Formato: { canal, first, last }, donde
-- first/last son los toques guardados en el navegador (gclid, utm_*,
-- referrer_host, landing_path, ts). Ver src/lib/origen.ts.
-- La API reserva igual si esta columna aún no existe (solo no guarda el origen).
alter table public.bookings add column if not exists origen jsonb;
comment on column public.bookings.origen is 'Origen de la reserva web: { canal, first, last } (gclid/utm/referrer). Ver src/lib/origen.ts';
