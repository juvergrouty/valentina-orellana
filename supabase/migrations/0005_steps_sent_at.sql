-- Ejecutar UNA VEZ en el SQL Editor de Supabase. Aditivo y seguro.

-- "Pasos a seguir" sale solo una vez por paciente, automático al pagar su
-- primera sesión (pedido de Valentina, 3 oct 2026). Esta columna marca que ya
-- se le envió. Los pacientes que ya existen se marcan como enviados para que
-- ninguno lo reciba de nuevo; solo los pacientes nuevos desde hoy lo reciben.
alter table patients add column if not exists steps_sent_at timestamptz;
update patients set steps_sent_at = now() where steps_sent_at is null;
