import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';
import { IMAGEN_ANCHOS, IMAGEN_DOMINIOS } from './src/lib/imagenOptimizada';

export default defineConfig({
  output: 'static',
  // maxDuration (16 oct 2026): 300 s. Fluid compute está ACTIVO en el proyecto
  // (verificado en el dashboard de Vercel; región iad1) y con Fluid el máximo en
  // Hobby es 300 s. Lo necesita el cron del transcriptor: un resumen de Sonnet de
  // una sesión larga puede pasar de 60 s (revisión de código 16 oct, A1). Es solo
  // un techo: el resto de las rutas siguen terminando en milisegundos. El adaptador
  // (@astrojs/vercel 11) solo acepta un valor global (una sola función _render).
  // OJO: si se apagara Fluid compute, un valor > 60 hace fallar el deploy en Hobby.
  // Antes (8 oct 2026): 60 s, para que el aviso de pago de Flow no se cortara a 10 s.
  // imagesConfig (8 oct 2026): activa /_vercel/image para las fotos de servicios
  // (Supabase). Anchos y dominios en src/lib/imagenOptimizada.ts.
  adapter: vercel({
    maxDuration: 300,
    imagesConfig: {
      sizes: IMAGEN_ANCHOS,
      domains: IMAGEN_DOMINIOS,
      formats: ['image/avif', 'image/webp'],
    },
  }),
  integrations: [tailwind()],
  // Astro 7 cambió el valor por defecto a 'jsx', que borra los espacios entre
  // elementos en línea separados por saltos de línea (texto pegado). true
  // mantiene el HTML igual que con Astro 6 (12 oct 2026).
  compressHTML: true,
  site: 'https://www.valentinaorellana.cl',
  security: {
    checkOrigin: false, // Flow envía POST cross-site en urlReturn y urlConfirmation
  },
});
