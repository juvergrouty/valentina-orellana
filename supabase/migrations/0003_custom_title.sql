-- Ejecutar UNA VEZ en el SQL Editor de Supabase (Project → SQL Editor → New query).
-- Es aditivo y seguro: no borra ni modifica datos existentes.

-- Nombre personalizado de una sesión (botón "Cambiar nombre de la sesión" en el
-- panel del calendario, igual que Encuadrado). Si está vacío, se sigue
-- mostrando el nombre del servicio como hasta ahora.
alter table bookings add column if not exists custom_title text;
