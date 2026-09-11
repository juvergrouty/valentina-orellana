-- Ejecutar UNA VEZ en el SQL Editor de Supabase (Project → SQL Editor → New query).
-- Es aditivo y seguro: no borra ni modifica datos existentes.

-- Solicitud de reseña de Google, opt-in por reserva (panel "Agendar hora" →
-- sección Comunicaciones al paciente), igual que whatsapp_reminder_enabled y
-- evaluation_email_enabled. Default false: cuando el paciente reserva solo por
-- el sitio (sin pasar por el panel admin), NO se le pide reseña automáticamente
-- — a diferencia del correo de recordatorio y la boleta, que sí van por defecto.
-- Cuando Valentina agenda desde el panel, puede marcar el checkbox caso a caso.
alter table bookings add column if not exists review_email_enabled boolean not null default false;
