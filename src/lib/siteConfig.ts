/**
 * siteConfig.ts
 * Lee precios y duraciones desde Supabase settings.
 * Usar en páginas SSR (prerender=false) para que los valores
 * sean dinámicos sin redeploy.
 */

import { supabase } from './supabase';

export interface SiteConfig {
  // Precios en CLP
  prices: {
    online:           number;
    presencial:       number;
    parejaOnline:     number;
    parejaPresencial: number;
  };
  // Duraciones para mostrar en texto
  durations: {
    individual: string;   // ej: "50 minutos"
    pareja:     string;   // ej: "60 minutos"
  };
}

// Valores por defecto (se usan si Supabase no tiene el setting)
const DEFAULTS: SiteConfig = {
  prices: {
    online:           45000,
    presencial:       55000,
    parejaOnline:     60000,
    parejaPresencial: 70000,
  },
  durations: {
    individual: '50 minutos',
    pareja:     '60 minutos',
  },
};

export async function getSiteConfig(): Promise<SiteConfig> {
  const { data } = await supabase.from('settings').select('key, value');
  const s: Record<string, string> = {};
  (data ?? []).forEach(({ key, value }: { key: string; value: string }) => { s[key] = value; });

  const num = (key: string, fallback: number) => {
    const v = parseInt(s[key] ?? '');
    return isNaN(v) ? fallback : v;
  };

  // Duración en minutos → texto legible
  const indMin  = num('session_duration_min', 55);
  const indText = s['duration_individual'] ?? `${indMin} minutos`;
  const parMin  = num('session_duration_pareja', 60);
  const parText = s['duration_pareja'] ?? `${parMin} minutos`;

  return {
    prices: {
      online:           num('price_online',            DEFAULTS.prices.online),
      presencial:       num('price_presencial',        DEFAULTS.prices.presencial),
      parejaOnline:     num('price_pareja_online',     DEFAULTS.prices.parejaOnline),
      parejaPresencial: num('price_pareja_presencial', DEFAULTS.prices.parejaPresencial),
    },
    durations: {
      individual: indText,
      pareja:     parText,
    },
  };
}

// Helper para formatear CLP
export function formatCLP(n: number): string {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency', currency: 'CLP', maximumFractionDigits: 0,
  }).format(n);
}
