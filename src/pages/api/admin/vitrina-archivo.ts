import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { BUCKET_CONTENIDO } from '../../../lib/vitrina';

export const prerender = false;

// POST /api/admin/vitrina-archivo { nombre } → link firmado para SUBIR un
// archivo al bucket privado vitrina-contenido directo desde el navegador
// (Vercel no acepta cuerpos de más de ~4,5 MB; un PDF o video puede pesar más).
// Devuelve la ruta que se guarda en el item (digital_file_path).
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const nombre = String(body?.nombre ?? 'archivo')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-100) || 'archivo';
  const ruta = `${crypto.randomUUID()}/${nombre}`;
  const { data, error } = await supabase.storage.from(BUCKET_CONTENIDO).createSignedUploadUrl(ruta);
  if (error || !data) {
    return Response.json({ error: `No se pudo preparar la subida: ${error?.message ?? ''}. ¿Se ejecutó la migración 0012 (bucket ${BUCKET_CONTENIDO})?` }, { status: 500 });
  }
  return Response.json({ ok: true, ruta, signedUrl: data.signedUrl });
};
