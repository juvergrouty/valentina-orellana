-- 0024_transcriptor_texto_utf8.sql - repara textos con tildes que quedaron corruptos en la base (17 oct 2026).
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, cuando Vale lo apruebe (NO esta aplicada).
-- Idempotente: se puede correr dos veces sin efecto extra.
--
-- Sintoma: la ficha mostraba "Resumen autom(raiz)(grado)tico (IA) ... no revisado". Es UTF-8 correcto leido
-- como Mac Roman. Los archivos del repo son UTF-8 valido; el rotulo sale del DEFAULT de resumenes_ia.rotulo
-- (0014), asi que el texto se corrompio al pegar la migracion en el SQL Editor. Lo mismo puede haber
-- pasado con la semilla de instrucciones_ia (0014) y el ajuste transcriptor_bot_nombres_vale (0016).
--
-- ESTE ARCHIVO ES SOLO ASCII A PROPOSITO (las tildes van como U&'\00E1'), para que no se vuelva a
-- corromper al copiarlo. Recomendacion para las proximas: abrir el .sql en un editor (VS Code / TextEdit)
-- y copiar desde ahi, no con pbcopy/pbpaste ni desde una terminal sin LANG=es_CL.UTF-8.
--
-- Que hace:
--  1. DEFAULT correcto de resumenes_ia.rotulo.
--  2. Repara el rotulo de los resumenes que NO estan 'listo' (los 'listo' son inmutables por el trigger
--     resumenes_ia_protegido; esos los repara el sitio al mostrarlos: src/lib/transcriptor/texto.ts).
--  3. Repara el texto de instrucciones_ia y los ajustes transcriptor_* de settings.
--  4. Si la instruccion activa del resumen sigue siendo la semilla de 0014 (que Vale nunca eligio y que
--     pide otra estructura), la desactiva: el resumen usa el texto por defecto del codigo (mas corto).

create or replace function pg_temp.vo_reparar_macroman(t text) returns text
language plpgsql immutable as $$
declare
  -- Bytes 0x80..0xFF de Mac Roman como puntos de codigo Unicode, en orden.
  tabla int[] := array[196,197,199,201,209,214,220,225,224,226,228,227,229,231,233,232,234,235,237,236,238,
    239,241,243,242,244,246,245,250,249,251,252,8224,176,162,163,167,8226,182,223,174,169,8482,180,168,8800,
    198,216,8734,177,8804,8805,165,181,8706,8721,8719,960,8747,170,186,937,230,248,191,161,172,8730,402,8776,
    8710,171,187,8230,160,192,195,213,338,339,8211,8212,8220,8221,8216,8217,247,9674,255,376,8260,8364,8249,
    8250,64257,64258,8225,183,8218,8222,8240,194,202,193,203,200,205,206,207,204,211,212,63743,210,218,219,
    217,305,710,732,175,728,729,730,184,733,731,711];
  b bytea := ''::bytea;
  c int;
  pos int;
begin
  if t is null or t !~ U&'[\221A\00AC]|\201A\00C4' then return t; end if;
  for i in 1..char_length(t) loop
    c := ascii(substr(t, i, 1));
    if c < 128 then
      b := b || set_byte('\x00'::bytea, 0, c);
    else
      pos := array_position(tabla, c);
      if pos is null then return t; end if;       -- no es Mac Roman puro: no se toca
      b := b || set_byte('\x00'::bytea, 0, 127 + pos);
    end if;
  end loop;
  return convert_from(b, 'UTF8');
exception when others then
  return t;                                        -- no era UTF-8 valido: no se toca
end $$;

-- 1. Default del rotulo.
alter table public.resumenes_ia
  alter column rotulo set default U&'Resumen autom\00E1tico (IA) \2014 no revisado';

-- 2. Rotulos de resumenes no 'listo'.
update public.resumenes_ia
   set rotulo = pg_temp.vo_reparar_macroman(rotulo)
 where estado <> 'listo'
   and rotulo is distinct from pg_temp.vo_reparar_macroman(rotulo);

-- 3. Instrucciones y ajustes.
update public.instrucciones_ia
   set texto = pg_temp.vo_reparar_macroman(texto)
 where texto is distinct from pg_temp.vo_reparar_macroman(texto);

update public.settings
   set value = pg_temp.vo_reparar_macroman(value)
 where key like 'transcriptor\_%'
   and value is distinct from pg_temp.vo_reparar_macroman(value);

-- 4. Semilla de 0014 activa -> se desactiva (queda en el historial; "Restaurar original" sigue funcionando).
update public.instrucciones_ia
   set activa = false
 where uso = 'resumen' and activa
   and texto = U&'Resume la sesi\00F3n en espa\00F1ol de Chile con: 1) Puntos clave. 2) Tareas que la psic\00F3loga dio. 3) Qu\00E9 revisar la pr\00F3xima sesi\00F3n. No inventes nada que no est\00E9 en la transcripci\00F3n.';

-- Verificacion (debe devolver 0 filas):
-- select key, value from public.settings where value ~ U&'[\221A\00AC]|\201A\00C4';
-- select id, uso from public.instrucciones_ia where texto ~ U&'[\221A\00AC]|\201A\00C4';
