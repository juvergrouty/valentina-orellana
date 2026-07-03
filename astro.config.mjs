import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'static',
  adapter: vercel(),
  integrations: [tailwind()],
  site: 'https://valentinaorellana.cl',
  security: {
    checkOrigin: false, // Flow envía POST cross-site en urlReturn y urlConfirmation
  },
});
