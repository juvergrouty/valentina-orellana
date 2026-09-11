-- Ejecutar UNA VEZ en el SQL Editor de Supabase (Project → SQL Editor → New query).
-- Es aditivo y seguro: no borra ni modifica datos existentes.

-- 1) Marca las reservas creadas desde el panel admin, para que el cron de
--    expiración nunca las elimine automáticamente por falta de pago.
alter table bookings add column if not exists created_by_admin boolean not null default false;

-- 2) Nuevo estado 'expired': en vez de borrar una reserva pública vencida, se
--    conserva con este estado (y sus datos) para poder recuperarla desde el
--    correo de "horario liberado" dentro de las 4 horas previas a la sesión.
alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('pending_payment', 'confirmed', 'cancelled', 'expired'));

-- 3) Token de recuperación (único) usado por el link del correo.
alter table bookings add column if not exists recovery_token text;
create unique index if not exists idx_bookings_recovery_token
  on bookings(recovery_token) where recovery_token is not null;

-- 4) El horario de una reserva 'expired' debe quedar libre para otras personas
--    (antes el índice único solo excluía 'cancelled').
drop index if exists idx_bookings_slot;
create unique index idx_bookings_slot
  on bookings(session_date, session_time)
  where status not in ('cancelled', 'expired');

-- 5) Estado real de pago, separado del estado de la reserva. Antes "confirmada"
--    y "pagada" eran lo mismo en el código (bug: una reserva "Pago en consulta"
--    quedaba marcada como pagada de inmediato, sin haber recibido el pago).
--    paid_at = null  → no se ha registrado el pago.
--    paid_at = fecha → se marcó "Marcar como pagado" con ese medio.
--    debt_voided     → la deuda se anuló (no se va a cobrar), sin marcarla como pagada.
alter table bookings add column if not exists paid_at timestamptz;
alter table bookings add column if not exists payment_note text;
alter table bookings add column if not exists debt_voided boolean not null default false;

-- 6) Inasistencia: el paciente no llegó a la sesión. Es independiente del pago
--    (puede haber cobrado igual, o no) y del estado de la reserva.
alter table bookings add column if not exists no_show boolean not null default false;

-- 7) Comunicaciones opcionales por reserva (panel "Agendar hora" → sección
--    Comunicaciones al paciente). El correo de confirmación y el recordatorio
--    por correo ya existían (send_confirmation al crear, reminder_email_enabled);
--    esto agrega los dos que faltaban:
--    - whatsapp_reminder_enabled: recordatorio por WhatsApp 4h antes de la sesión.
--      Requiere WhatsApp Business conectado en Configuración (hoy no lo está).
--    - evaluation_email_enabled: correo de seguimiento/evaluación después de la sesión.
alter table bookings add column if not exists whatsapp_reminder_enabled boolean not null default false;
alter table bookings add column if not exists evaluation_email_enabled boolean not null default false;
