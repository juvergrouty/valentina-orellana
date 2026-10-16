// POST /api/admin/transcriptor/resumenes-archivados — "Ver más" (y el buscador) de la ficha para los
// resúmenes de sesiones antiguas, que ya no están en Supabase sino archivados en R2 (+B2) (02-decisiones-
// 16oct-noche, B; archivo.ts). Body: { patient_id: uuid, resumen_ids: uuid[] (1–60) }.
// Devuelve [{ id, html, texto }] renderizados en el servidor (resumenAHtml escapa todo). Reglas:
//   • guardiaPanel + sesión con passkey (acceso.ts);
//   • solo resúmenes de ESA ficha (se valida por la grabación);
//   • bitácora obligatoria ('ver_resumen', vista 'archivo') antes de traer nada; sin caché; nada se guarda.
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { exigirAccesoClinico } from '../../../../lib/transcriptor/acceso';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import { auditarObligatorio } from '../../../../lib/transcriptor/auditoria';
import { COLUMNAS_ARCHIVO, conTextoResumen, estaArchivado, type FilaArchivo } from '../../../../lib/transcriptor/archivo';
import { resumenAHtml, resumenATexto } from '../../../../lib/transcriptor/panel';

export const prerender = false;
const MAX = 60;

export const POST: APIRoute = async (ctx) => {
  const rechazo = (await guardiaPanel(ctx, 'ver_resumen')) ?? (await exigirAccesoClinico(ctx, 'ver_resumen'));
  if (rechazo) return rechazo;
  const body = await leerJson(ctx.request);
  const ids = Array.isArray(body?.resumen_ids) ? [...new Set(body!.resumen_ids as unknown[])] : [];
  if (!body || !esUuid(body.patient_id) || !ids.length || ids.length > MAX || !ids.every(esUuid)) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const patientId = body.patient_id;

  const { data: rs, error } = await supabase.from('resumenes_ia')
    .select(`id, grabacion_id, estado, contenido, contenido_cifrado, ${COLUMNAS_ARCHIVO}`).in('id', ids as string[]);
  if (error) return json({ ok: false, error: 'No se pudieron leer los resúmenes.' }, 500);
  const gids = [...new Set((rs ?? []).map((r) => r.grabacion_id as string))];
  const { data: gs } = gids.length ? await supabase.from('grabaciones').select('id, patient_id').in('id', gids) : { data: [] };
  const deEsta = new Set((gs ?? []).filter((g) => g.patient_id === patientId).map((g) => g.id as string));
  const filas = ((rs ?? []) as FilaArchivo[]).filter((r) => deEsta.has(String(r.grabacion_id)) && r.estado === 'listo' && estaArchivado(r));
  if (filas.length !== ids.length) return json({ ok: false, error: 'Algún resumen no pertenece a esta ficha.' }, 400);

  try {
    await auditarObligatorio('vale', 'ver_resumen', {
      patientId, request: ctx.request, clientAddress: safeAddr(ctx), detalle: { vista: 'archivo', resumenes: filas.length },
    });
  } catch {
    return json({ ok: false, error: 'No se pudo registrar el acceso en la bitácora. Por seguridad no se muestra.' }, 503);
  }
  const { filas: claras, fallidas } = await conTextoResumen(filas);
  return json({
    ok: true,
    fallidas,
    resumenes: claras.filter((f) => f.contenido).map((f) => ({
      id: f.id,
      html: resumenAHtml(f.contenido, (s) => `/admin/pacientes/${patientId}/sesion/${f.grabacion_id}?t=${s}`),
      texto: resumenATexto(f.contenido),
    })),
  });
};
