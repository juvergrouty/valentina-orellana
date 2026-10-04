-- Ficha de paciente con datos mínimos obligatorios (Valentina, 4 oct 2026).
-- Ya existían: name, email, phone, rut, address, emergency_name, emergency_phone.
-- Nuevos:
--   comuna      → se usa también como "Comuna del receptor" en la boleta.
--   sin_rut     → paciente extranjera/o sin RUT chileno. La boleta se emite con
--                 el RUT genérico del SII para extranjeros sin RUT (44.444.446-0)
--                 y su nombre; su documento queda registrado en la ficha.
--   doc_tipo / doc_numero / doc_pais → documento de identidad de su país.
alter table patients add column if not exists comuna     text;
alter table patients add column if not exists sin_rut    boolean not null default false;
alter table patients add column if not exists doc_tipo   text;
alter table patients add column if not exists doc_numero text;
alter table patients add column if not exists doc_pais   text;
