import type { APIRoute } from 'astro';

export const prerender = true;

// Solo páginas públicas indexables (sin /admin, /api ni páginas transaccionales)
const PAGES: { path: string; changefreq: string; priority: string }[] = [
  { path: '',            changefreq: 'weekly',  priority: '1.0' },
  { path: 'sobre-mi',    changefreq: 'monthly', priority: '0.8' },
  { path: 'servicios',   changefreq: 'weekly',  priority: '0.9' },
  { path: 'precios',     changefreq: 'monthly', priority: '0.7' },
  { path: 'opiniones',   changefreq: 'weekly',  priority: '0.7' },
  { path: 'contacto',    changefreq: 'monthly', priority: '0.6' },
  { path: 'condiciones', changefreq: 'yearly',  priority: '0.3' },
  { path: 'agenda',      changefreq: 'monthly', priority: '0.9' },
];

export const GET: APIRoute = ({ site }) => {
  const base = (site?.toString() ?? 'https://valentinaorellana.cl/').replace(/\/$/, '');
  const urls = PAGES.map(p => {
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
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
