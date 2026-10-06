-- Notas clínicas: nunca se borran ni se pisan (re-auditoría 5 oct 2026).
-- La ficha clínica se conserva 15 años: "Eliminar" una nota la archiva
-- (deleted_at) y editarla guarda la versión anterior en historial.
alter table session_notes add column if not exists deleted_at timestamptz;
alter table session_notes add column if not exists historial jsonb not null default '[]'::jsonb;
