import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { logInfo, logError } from '../../../lib/logger';

export const prerender = false;

// Documentos de la ficha (14 nov 2026): informes para seguros, certificados
// firmados y otros PDF que Valentina guarda en la ficha de cada paciente.
// Bucket privado "documentos-pacientes", una carpeta por paciente
// (<patient_id>/<fecha>-<nombre>.pdf). No necesita tabla: la lista sale del
// propio bucket. La subida va directo del navegador al bucket con un link
// firmado (Vercel no acepta cuerpos de más de ~4,5 MB).
// Ruta protegida por el middleware de /api/admin.
export const BUCKET_DOCUMENTOS = 'documentos-pacientes';

const json = (b: unknown, status = 200) => Response.json(b, { status });
const idValido = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
// Solo el nombre del archivo dentro de la carpeta del paciente: nada de "../".
const nombreValido = (n: unknown): n is string => typeof n === 'string' && /^[\w.\-]{1,140}$/.test(n) && !n.includes('..');

let bucketListo = false;
async function asegurarBucket() {
  if (bucketListo) return;
  const { error } = await supabase.storage.getBucket(BUCKET_DOCUMENTOS);
  if (error) {
    const { error: e2 } = await supabase.storage.createBucket(BUCKET_DOCUMENTOS, { public: false, fileSizeLimit: '20MB', allowedMimeTypes: ['application/pdf'] });
    if (e2 && !/exists/i.test(e2.message)) throw new Error(e2.message);
  }
  bucketListo = true;
}

async function pacienteExiste(id: string) {
  const { data } = await supabase.from('patients').select('id').eq('id', id).maybeSingle();
  return !!data;
}

// GET ?paciente=<id> → lista de documentos de ese paciente.
export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('paciente');
  if (!idValido(id) || !(await pacienteExiste(id))) return json({ error: 'Paciente no válido.' }, 400);
  try { await asegurarBucket(); } catch (e) { return json({ error: `No se pudo preparar el archivo de documentos: ${(e as Error).message}` }, 500); }
  const { data, error } = await supabase.storage.from(BUCKET_DOCUMENTOS).list(id, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) return json({ error: `No se pudo leer la lista: ${error.message}` }, 500);
  // El nombre guardado va sin tildes (las rutas del bucket no las aceptan); el
  // título original, con tildes, queda en el registro de la subida.
  const titulos = new Map<string, string>();
  const { data: subidas } = await supabase.from('admin_logs').select('data')
    .eq('context', 'ficha/documentos').eq('data->>paciente', id).not('data->>titulo', 'is', null)
    .order('created_at', { ascending: false }).limit(500);
  for (const r of subidas ?? []) {
    const d = r.data as { nombre?: string; titulo?: string } | null;
    if (d?.nombre && d.titulo && !titulos.has(d.nombre)) titulos.set(d.nombre, d.titulo); // el más reciente manda
  }
  const docs = (data ?? [])
    .filter((f) => f.id && f.name && !f.name.startsWith('.'))
    .map((f) => ({ nombre: f.name, titulo: titulos.get(f.name) ?? null, subido: f.created_at, bytes: (f.metadata as { size?: number } | null)?.size ?? null }));
  return json({ ok: true, docs });
};

// POST { action: 'subir', paciente, nombre } → link firmado para subir el PDF.
// POST { action: 'abrir', paciente, nombre } → link firmado (5 min) para verlo.
// POST { action: 'borrar', paciente, nombre } → lo quita de la lista (queda archivado).
export const POST: APIRoute = async ({ request }) => {
  // Igual que los demás endpoints clínicos: solo desde el panel.
  if (request.headers.get('X-Panel') !== '1') return json({ error: 'No autorizado.' }, 403);
  const body = await request.json().catch(() => ({}));
  const { action, paciente } = body ?? {};
  if (!idValido(paciente) || !(await pacienteExiste(paciente))) return json({ error: 'Paciente no válido.' }, 400);
  try { await asegurarBucket(); } catch (e) { return json({ error: `No se pudo preparar el archivo de documentos: ${(e as Error).message}` }, 500); }
  const bucket = supabase.storage.from(BUCKET_DOCUMENTOS);

  if (action === 'subir') {
    const base = String(body?.nombre ?? 'documento')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\.pdf$/i, '')
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110) || 'documento';
    const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
    const nombre = `${hoy}_${base}.pdf`;
    const { data, error } = await bucket.createSignedUploadUrl(`${paciente}/${nombre}`);
    if (error || !data) {
      const yaExiste = /exist|duplicate/i.test(error?.message ?? '');
      return json({ error: yaExiste ? 'Ya hay un documento con ese nombre hoy. Cámbiale el nombre al archivo o borra el anterior.' : `No se pudo preparar la subida: ${error?.message ?? ''}` }, yaExiste ? 409 : 500);
    }
    return json({ ok: true, nombre, signedUrl: data.signedUrl });
  }

  const { nombre } = body ?? {};
  if (!nombreValido(nombre)) return json({ error: 'Documento no válido.' }, 400);
  const ruta = `${paciente}/${nombre}`;

  if (action === 'subido') {
    const titulo = String(body?.titulo ?? '').replace(/\.pdf$/i, '').replace(/[<>]/g, '').trim().slice(0, 140) || null;
    await logInfo('ficha/documentos', `Documento subido a la ficha: ${titulo ?? nombre}`, { paciente, nombre, titulo });
    return json({ ok: true });
  }
  if (action === 'abrir') {
    const { data, error } = await bucket.createSignedUrl(ruta, 300);
    if (error || !data) return json({ error: 'No se pudo abrir el documento.' }, 500);
    await logInfo('ficha/documentos', `Documento abierto: ${nombre}`, { paciente, nombre });
    return json({ ok: true, url: data.signedUrl });
  }
  if (action === 'borrar') {
    // No se elimina: se mueve a <paciente>/_archivados/ (la ficha se conserva
    // 15 años). La lista solo muestra el primer nivel de la carpeta.
    const destino = `${paciente}/_archivados/${Date.now()}_${nombre}`;
    const { error } = await bucket.move(ruta, destino);
    if (error) {
      await logError('ficha/documentos', 'No se pudo archivar un documento de la ficha', { paciente, nombre, error: error.message });
      return json({ error: 'No se pudo quitar el documento.' }, 500);
    }
    await logInfo('ficha/documentos', `Documento quitado de la ficha (archivado): ${nombre}`, { paciente, nombre, destino });
    return json({ ok: true });
  }
  return json({ error: 'Acción no válida.' }, 400);
};
