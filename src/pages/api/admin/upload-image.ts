import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

const BUCKET   = 'services-images';
const MAX_SIZE = 3 * 1024 * 1024; // 3 MB
const ALLOWED  = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const file = form.get('file') as File | null;

    if (!file || !file.size) {
      return Response.json({ error: 'No se recibió ningún archivo.' }, { status: 400 });
    }
    if (!ALLOWED.includes(file.type)) {
      return Response.json({ error: 'Formato no permitido. Usa JPG, PNG o WebP.' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return Response.json({ error: 'El archivo supera los 3 MB.' }, { status: 400 });
    }

    // Nombre único para evitar colisiones
    const ext      = file.type.split('/')[1].replace('jpeg', 'jpg');
    const fileName = `${crypto.randomUUID()}.${ext}`;

    const buffer = await file.arrayBuffer();

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, buffer, {
        contentType: file.type,
        upsert:      false,
      });

    if (uploadError) {
      console.error('[upload-image]', uploadError.message);
      return Response.json({ error: 'Error al subir la imagen: ' + uploadError.message }, { status: 500 });
    }

    const { data: { publicUrl } } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(fileName);

    return Response.json({ ok: true, url: publicUrl });

  } catch (err: any) {
    console.error('[upload-image]', err);
    return Response.json({ error: err.message ?? 'Error interno.' }, { status: 500 });
  }
};
