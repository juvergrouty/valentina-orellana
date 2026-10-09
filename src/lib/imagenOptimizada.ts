// Imágenes de los servicios por el optimizador de Vercel (8 oct 2026): las fotos
// de Supabase pesaban ~750 KB cada una (1201×1201 JPG). /_vercel/image las
// achica al ancho pedido y las entrega en AVIF/WEBP. Vercel solo acepta anchos
// (w) de esta lista y dominios externos de IMAGEN_DOMINIOS; se configuran en
// astro.config.mjs (imagesConfig), que importa estas mismas constantes.

export const IMAGEN_ANCHOS = [384, 640, 828, 1200];
export const IMAGEN_DOMINIOS = ['oadkwaffbmcocdweeclb.supabase.co'];
const CALIDAD = 70;

/** ¿Vercel puede optimizar esta URL? Rutas del propio sitio o dominios permitidos. */
function optimizable(src: string): boolean {
  if (src.startsWith('/') && !src.startsWith('//')) return true;
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && IMAGEN_DOMINIOS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** URL de /_vercel/image para un ancho de IMAGEN_ANCHOS. En `astro dev` (no
 *  existe /_vercel/image) o con una URL no permitida, devuelve la original. */
export function imagenUrl(src: string, ancho: number): string {
  if (import.meta.env.DEV || !optimizable(src)) return src;
  const w = IMAGEN_ANCHOS.includes(ancho) ? ancho : IMAGEN_ANCHOS[IMAGEN_ANCHOS.length - 1];
  return `/_vercel/image?url=${encodeURIComponent(src)}&w=${w}&q=${CALIDAD}`;
}

/** srcset con los anchos pedidos (vacío si no se optimiza: queda solo src). */
export function imagenSrcset(src: string, anchos: number[] = IMAGEN_ANCHOS): string | undefined {
  if (import.meta.env.DEV || !optimizable(src)) return undefined;
  return anchos.map((w) => `${imagenUrl(src, w)} ${w}w`).join(', ');
}
