import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'static',       // 'hybrid' fue removido en Astro 5 → usar 'static' + prerender=false por ruta
  adapter: vercel(),
  integrations: [tailwind()],
  site: 'https://psicologavalentinaorellana.com',
});
