/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  // Flow.cl
  readonly FLOW_API_KEY: string;
  readonly FLOW_SECRET_KEY: string;
  readonly FLOW_ENV: 'sandbox' | 'production';
  // Sitio
  readonly PUBLIC_SITE_URL: string;
  readonly ADMIN_PASSWORD: string;
  readonly ADMIN_SECRET: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}