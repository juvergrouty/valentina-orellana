-- 0018_transcriptor_permisos.sql — Permisos del transcriptor (revisión de seguridad 16 oct 2026, B3).
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 0014–0017 y cuando Vale lo apruebe
-- (NO está aplicada). Idempotente: solo revoca y vuelve a dar los mismos grants; no toca datos.
--
-- Por qué: 0014 activó RLS y dio grants a service_role, pero no revocó los grants por defecto que
-- Supabase da a anon/authenticated en tablas nuevas del esquema public. Hoy esas tablas solo las
-- protege RLS sin políticas; con esto, además, anon/authenticated no tienen NINGÚN privilegio
-- (si alguien agregara por error una política, igual no podrían leer ni escribir).
-- 0015 y 0017 ya revocaban; se repite aquí para dejar todo en un solo lugar.
--
-- Se mantiene la excepción de la bitácora inmutable: transcriptor_auditoria solo select + insert
-- para service_role (sin update/delete/truncate; los triggers de 0014 lo refuerzan).

-- ── 1. Sin privilegios para anon / authenticated ────────────────────────────
revoke all on public.grabaciones            from anon, authenticated;
revoke all on public.grabacion_segmentos    from anon, authenticated;
revoke all on public.transcripciones        from anon, authenticated;
revoke all on public.instrucciones_ia       from anon, authenticated;
revoke all on public.resumenes_ia           from anon, authenticated;
revoke all on public.preguntas_ia           from anon, authenticated;
revoke all on public.transcriptor_webhooks  from anon, authenticated;
revoke all on public.transcriptor_auditoria from anon, authenticated;
revoke all on public.transcriptor_salud     from anon, authenticated;
revoke all on public.transcriptor_reportes  from anon, authenticated;
revoke all on public.transcriptor_costos_mes from anon, authenticated;   -- vista
revoke all on public.transcriptor_alertas   from anon, authenticated;    -- 0017
revoke all on public.admin_passkeys          from anon, authenticated;   -- 0015
revoke all on public.admin_codigos_respaldo  from anon, authenticated;   -- 0015
revoke all on public.admin_webauthn_desafios from anon, authenticated;   -- 0015

-- Secuencias de los id bigserial.
revoke all on sequence public.transcriptor_webhooks_id_seq  from anon, authenticated;
revoke all on sequence public.transcriptor_auditoria_id_seq from anon, authenticated;

-- ── 2. service_role: los mismos grants de 0014/0015/0017 (por si faltaran) ──
grant select, insert, update, delete on public.grabaciones            to service_role;
grant select, insert, update, delete on public.grabacion_segmentos    to service_role;
grant select, insert, update, delete on public.transcripciones        to service_role;
grant select, insert, update, delete on public.instrucciones_ia       to service_role;
grant select, insert, update, delete on public.resumenes_ia           to service_role; -- el trigger impide borrar/pisar
grant select, insert, update, delete on public.preguntas_ia           to service_role;
grant select, insert, update, delete on public.transcriptor_webhooks  to service_role;
grant select, insert, update, delete on public.transcriptor_salud     to service_role;
grant select, insert, update, delete on public.transcriptor_reportes  to service_role;
grant select, insert, update, delete on public.transcriptor_alertas   to service_role;
grant select on public.transcriptor_costos_mes to service_role;
grant select, insert, update, delete on public.admin_passkeys          to service_role;
grant select, insert, update         on public.admin_codigos_respaldo  to service_role; -- se anulan, no se borran
grant select, insert, update, delete on public.admin_webauthn_desafios to service_role;
grant usage, select on sequence public.transcriptor_webhooks_id_seq  to service_role;
grant usage, select on sequence public.transcriptor_auditoria_id_seq to service_role;

-- Bitácora inmutable (excepción deliberada): solo agregar y leer.
grant  select, insert                 on public.transcriptor_auditoria to service_role;
revoke update, delete, truncate       on public.transcriptor_auditoria from service_role;

-- ── 3. Comprobación (opcional, solo lectura): debe devolver 0 filas ─────────
-- select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon', 'authenticated')
--    and table_name in ('grabaciones','grabacion_segmentos','transcripciones','instrucciones_ia','resumenes_ia',
--                       'preguntas_ia','transcriptor_webhooks','transcriptor_auditoria','transcriptor_salud',
--                       'transcriptor_reportes','transcriptor_costos_mes','transcriptor_alertas',
--                       'admin_passkeys','admin_codigos_respaldo','admin_webauthn_desafios');
