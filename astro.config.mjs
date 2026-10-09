import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';
import { IMAGEN_ANCHOS, IMAGEN_DOMINIOS } from './src/lib/imagenOptimizada';

export default defineConfig({
  output: 'static',
  // 60 s explícitos (8 oct 2026): sin esto, en Vercel sin Fluid compute el límite
  // es 10 s y el aviso de pago de Flow (boleta del SII + correos) podía cortarse.
  // 60 s es válido en todos los planes.
  // imagesConfig (8 oct 2026): activa /_vercel/image para las fotos de servicios
  // (Supabase). Anchos y dominios en src/lib/imagenOptimizada.ts.
  adapter: vercel({
    maxDuration: 60,
    imagesConfig: {
      sizes: IMAGEN_ANCHOS,
      domains: IMAGEN_DOMINIOS,
      formats: ['image/avif', 'image/webp'],
    },
  }),
  integrations: [tailwind()],
  site: 'https://www.valentinaorellana.cl',
  security: {
    checkOrigin: false, // Flow envía POST cross-site en urlReturn y urlConfirmation
  },
});
