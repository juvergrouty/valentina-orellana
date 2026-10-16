-- 0020_transcriptor_archivo_resumenes.sql — sitio liviano (docs/transcriptor/02-decisiones-16oct-noche.md, B y C).
-- Requiere 0014–0019. Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO está
-- aplicada), y antes de encender el transcriptor: el paso 'archivo' del orquestador lee estas columnas
-- (si faltan, ese paso falla con "Falta aplicar la migración 0020" y no mueve nada).
-- Aditiva: no borra columnas ni datos. Regla del proyecto: RLS sin políticas para anon/authenticated
-- + grants explícitos a service_role.
--
-- B. En Supabase solo queda el CONTENIDO (cifrado) de los resúmenes de las ÚLTIMAS 4 sesiones de cada
--    paciente. Los de sesiones anteriores se mueven, cifrados (formato VOT1, tipo 'resumen'), al bucket
--    de transcripciones de R2 con copia verificada en B2 (llave opaca t/<uuid>.bin). En la fila queda la
--    referencia: archivo_r2_key / archivo_b2_key / archivo_sha256 / archivado_at; contenido y
--    contenido_cifrado pasan a null. Al consultarlo (Ver más, preguntas a la IA, exportación) el sitio
--    lo trae desde R2 (o B2 si R2 falla) y lo descifra en memoria.
-- C. Ya no existe la supresión de transcripciones (la ficha se conserva 15 años). La columna
--    transcripciones.borrado_canal de 0019 queda SIN USO (no se borra; ver comentario abajo).

-- ── B: referencia del resumen archivado ──────────────────────────────────────
alter table public.resumenes_ia add column if not exists archivo_r2_key text;
alter table public.resumenes_ia add column if not exists archivo_b2_key text;
alter table public.resumenes_ia add column if not exists archivo_sha256 text;
alter table public.resumenes_ia add column if not exists archivo_kek_v  smallint;
alter table public.resumenes_ia add column if not exists archivado_at   timestamptz;

do $$ begin
  alter table public.resumenes_ia add constraint resumenes_ia_archivo_llave_chk
    check (archivo_r2_key is null or archivo_r2_key ~ '^t/[A-Za-z0-9_-]{1,64}\.bin$');
exception when duplicate_object then null; end $$;
-- Archivado = hay copia en R2 Y en B2, y en la base ya no queda el texto.
do $$ begin
  alter table public.resumenes_ia add constraint resumenes_ia_archivado_chk
    check (archivado_at is null or (archivo_r2_key is not null and archivo_b2_key is not null
                                    and contenido is null and contenido_cifrado is null));
exception when duplicate_object then null; end $$;

-- Para el paso 'archivo' (resúmenes listos aún en la base).
create index if not exists resumenes_ia_en_sitio_idx on public.resumenes_ia (patient_id)
  where estado = 'listo' and archivado_at is null;

-- Un resumen listo sigue sin poder modificarse (0014/0019), con UNA excepción: el paso de archivo
-- puede vaciar contenido/contenido_cifrado en la MISMA actualización que marca archivado_at con sus
-- dos copias. Una vez archivado, la referencia no cambia y el texto no vuelve a la base.
create or replace function public.resumenes_ia_protegido() returns trigger
language plpgsql as $$
declare
  archivando boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'resumenes_ia no se borra (usar oculto_at)';
  end if;
  if old.archivado_at is not null and (
       new.archivado_at   is distinct from old.archivado_at
    or new.archivo_r2_key is distinct from old.archivo_r2_key
    or new.archivo_b2_key is distinct from old.archivo_b2_key
    or new.archivo_sha256 is distinct from old.archivo_sha256) then
    raise exception 'un resumen archivado no cambia su archivo';
  end if;
  archivando := old.archivado_at is null and new.archivado_at is not null
    and new.archivo_r2_key is not null and new.archivo_b2_key is not null
    and new.contenido is null and new.contenido_cifrado is null;
  if old.estado = 'listo' and (
       (not archivando and (
            new.contenido is distinct from old.contenido
         or new.contenido_cifrado is distinct from old.contenido_cifrado))
    or new.estado is distinct from old.estado
    or new.grabacion_id is distinct from old.grabacion_id
    or new.version is distinct from old.version
    or new.autor is distinct from old.autor
    or new.modelo is distinct from old.modelo
    or new.rotulo is distinct from old.rotulo) then
    raise exception 'un resumen listo no se modifica: crear una nueva versión';
  end if;
  return new;
end $$;

-- ── C: columnas que quedan sin uso (no se borran) ────────────────────────────
comment on column public.transcripciones.borrado_canal is
  'SIN USO desde 0020 (02-decisiones-16oct-noche, C): se eliminó la supresión de transcripciones; la ficha se conserva 15 años.';
comment on column public.transcripciones.motivo_borrado is
  'Solo para el borrado al vencer el plazo legal de la ficha (15 años). No hay supresión a pedido (02-decisiones-16oct-noche, C).';

-- ── Permisos (sin cambios de fondo; se repiten por la regla del proyecto) ────
revoke all on public.resumenes_ia from anon, authenticated;
grant select, insert, update, delete on public.resumenes_ia to service_role; -- el trigger impide borrar/pisar
