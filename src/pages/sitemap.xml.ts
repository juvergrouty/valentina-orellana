import type { APIRoute } from 'astro';
import { articulos } from '../data/blog';

// Se genera en cada visita (14 oct 2026; antes era estático): así /talleres y
// sus items entran SOLO cuando la vitrina está publicada (vitrina_publica).
// Si la base no responde, sale la lista fija de siempre (sin talleres).
export const prerender = false;

// Solo páginas públicas indexables (sin /admin, /api ni páginas transaccionales)
const PAGES: { path: string; changefreq: string; priority: string }[] = [
  { path: '',            changefreq: 'weekly',  priority: '1.0' },
  { path: 'sobre-mi',    changefreq: 'monthly', priority: '0.8' },
  { path: 'servicios',   changefreq: 'weekly',  priority: '0.9' },
  { path: 'terapia-de-pareja-las-condes', changefreq: 'monthly', priority: '0.8' },
  { path: 'precios',     changefreq: 'monthly', priority: '0.7' },
  { path: 'opiniones',   changefreq: 'weekly',  priority: '0.7' },
  { path: 'contacto',    changefreq: 'monthly', priority: '0.6' },
  { path: 'condiciones', changefreq: 'yearly',  priority: '0.3' },
  { path: 'agenda',      changefreq: 'monthly', priority: '0.9' },
  { path: 'blog',        changefreq: 'weekly',  priority: '0.7' },
  ...articulos.filter(a => a.publicado).map(a => ({ path: `blog/${a.slug}`, changefreq: 'monthly', priority: '0.6' })),
  ];

/** /talleres y sus items visibles, solo con la vitrina publicada. */
async function paginasVitrina(): Promise<typeof PAGES> {
  try {
    const { supabase } = await import('../lib/supabase');
    const { data: on } = await supabase.from('settings').select('value').eq('key', 'vitrina_publica').maybeSingle();
    if (on?.value !== 'true') return [];
    const { data: items } = await supabase.from('vitrina_items').select('slug').eq('visible', true).order('sort_order');
    return [
      { path: 'talleres', changefreq: 'weekly', priority: '0.7' },
      ...(items ?? []).map((i: { slug: string }) => ({ path: `talleres/${i.slug}`, changefreq: 'weekly', priority: '0.6' })),
    ];
  } catch {
    return [];
  }
}

export const GET: APIRoute = async ({ site }) => {
    const base = (site?.toString() ?? 'https://www.valentinaorellana.cl/').replace(/\/$/, '');
    const urls = [...PAGES, ...(await paginasVitrina())].map(p => {
          const loc = p.path ? `${base}/${p.path}` : `${base}/`;
          return `  <url>\n    <loc>${loc}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    ${urls}
    </urlset>`;

    return new Response(xml, {
          headers: {
                  'Content-Type': 'application/xml; charset=utf-8',
                  'Cache-Control': 'public, max-age=3600, s-maxage=3600',
          },
    });
};
