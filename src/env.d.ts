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
  // Transcriptor IA (docs/transcriptor/30-seguridad.md §6). Las pega Vale en Vercel
  // (Production, Sensitive); opcionales porque el transcriptor parte apagado.
  readonly ASSEMBLYAI_API_KEY?: string;
  readonly ASSEMBLYAI_WEBHOOK_SECRET?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly R2_ACCOUNT_ID?: string;
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
  readonly R2_BUCKET_AUDIO?: string;           // audio temporal (ciclo de vida 1 día)
  readonly R2_BUCKET_TRANSCRIPCIONES?: string; // objetos cifrados VOT1
  readonly R2_JURISDICCION?: 'us';
  readonly B2_ENDPOINT?: string;
  readonly B2_REGION?: string;
  readonly B2_KEY_ID?: string;
  readonly B2_APPLICATION_KEY?: string;
  readonly B2_BUCKET?: string;
  readonly TRANSCRIPTOR_KEK_V1?: string;       // 32 bytes base64 (KEK que envuelve las DEK)
  readonly TRANSCRIPTOR_KEK_V2?: string;       // solo durante una rotación
  readonly TRANSCRIPTOR_KEK_ACTIVA?: string;   // 'v1' | 'v2' …
  readonly BACKUP_KEK_V1?: string;             // respaldo semanal de Supabase en B2
  readonly BOT_TOKEN_SECRET?: string;          // HMAC de los tokens del bot
  readonly FLY_API_TOKEN?: string;             // deploy token SOLO de la app del bot
  readonly FLY_APP_BOT?: string;
  readonly FLY_IMAGEN?: string;                // registry.fly.io/<app>:<tag fijo>
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}