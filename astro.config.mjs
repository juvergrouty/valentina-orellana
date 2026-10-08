import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'static',
  // 60 s explícitos (8 oct 2026): sin esto, en Vercel sin Fluid compute el límite
  // es 10 s y el aviso de pago de Flow (boleta del SII + correos) podía cortarse.
  // 60 s es válido en todos los planes.
  adapter: vercel({ maxDuration: 60 }),
  integrations: [tailwind()],
  site: 'https://www.valentinaorellana.cl',
  security: {
    checkOrigin: false, // Flow envía POST cross-site en urlReturn y urlConfirmation
  },
});
