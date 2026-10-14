import type { APIRoute } from 'astro';
import { csvConversiones } from '../../../lib/conversionesGoogle';

export const prerender = false;

// Descarga manual (desde el panel) del mismo archivo que Google Ads baja solo
// cada día desde /api/google-ads/conversiones.csv. Ver src/lib/conversionesGoogle.ts.
export const GET: APIRoute = async () => new Response(await csvConversiones(), {
  headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="google-ads-pacientes-${new Date().toISOString().slice(0, 10)}.csv"`,
  },
});
