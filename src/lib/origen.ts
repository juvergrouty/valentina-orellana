// Origen de cada reserva: de qué sitio/anuncio llegó la persona.
// El navegador guarda los "toques" en localStorage ('vo_origen', ver
// BaseLayout.astro) y /agenda los manda con la reserva. Aquí se limpian
// estrictamente y se calcula el canal legible que ve el panel.

export type OrigenTouch = {
  gclid?: string; gbraid?: string; wbraid?: string;
  utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; utm_content?: string;
  referrer_host?: string; landing_path?: string; ts?: number;
};
export type Origen = { canal: string; first: OrigenTouch | null; last: OrigenTouch | null };

const CLAVES = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer_host', 'landing_path'] as const;

function limpiarTouch(raw: unknown): OrigenTouch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const t: OrigenTouch = {};
  for (const k of CLAVES) {
    const v = r[k];
    if (typeof v !== 'string') continue;
    const s = v.replace(/[<>]/g, '').trim().slice(0, 200);
    if (s) t[k] = s;
  }
  if (typeof r.ts === 'number' && Number.isFinite(r.ts) && r.ts > 0) t.ts = Math.floor(r.ts);
  return Object.keys(t).some((k) => k !== 'ts') ? t : null;
}

export function calcularCanal(first: OrigenTouch | null, last: OrigenTouch | null): string {
  const t = last ?? first;
  if (!t) return 'Directo / desconocido';
  const src = (t.utm_source ?? '').toLowerCase();
  const med = (t.utm_medium ?? '').toLowerCase();
  const ref = (t.referrer_host ?? '').toLowerCase();
  const hay = (re: RegExp) => re.test(src) || re.test(ref);
  if (t.gclid || t.gbraid || t.wbraid || (src === 'google' && ['cpc', 'ppc', 'paid'].includes(med))) return 'Google Ads';
  if (hay(/instagram|^ig$/)) return 'Instagram';
  if (hay(/facebook|^fb$/)) return 'Facebook';
  if (hay(/doctoralia/)) return 'Doctoralia';
  if (hay(/psychologytoday|psicologiahoy/)) return 'Psychology Today';
  if (hay(/linkedin/)) return 'LinkedIn';
  if (/^(www\.)?google\.[a-z.]+$|googlequicksearchbox/.test(ref) || src === 'google') return 'Google orgánico';
  if (hay(/bing|duckduckgo|yahoo/)) return 'Buscador (otro)';
  if (hay(/chatgpt|openai|perplexity|claude/)) return 'IA (ChatGPT u otra)';
  return t.referrer_host || t.utm_source || 'Directo / desconocido';
}

/** Limpia lo que manda el navegador. Siempre devuelve un objeto (canal incluido). */
export function limpiarOrigen(raw: unknown): Origen {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const first = limpiarTouch(r.first);
  const last = limpiarTouch(r.last);
  return { canal: calcularCanal(first, last), first, last };
}

/** Texto corto para el panel: "Google Ads · campaña · 'término'". */
export function origenTexto(origen: unknown): string | null {
  if (!origen || typeof origen !== 'object') return null;
  const o = origen as Partial<Origen>;
  if (!o.canal) return null;
  const t = o.last ?? o.first;
  const partes = [o.canal];
  if (t?.utm_campaign) partes.push(t.utm_campaign);
  if (t?.utm_term) partes.push(`'${t.utm_term}'`);
  return partes.join(' · ');
}

// ── Origen marcado a mano (22 nov 2026, plan aprobado Línea 1) ────────────────────────────────
// Las reservas que agenda Vale desde el panel y las horas con link (también las del asistente de
// WhatsApp) no pasan por /agenda, así que no traen el origen del navegador. Vale elige de dónde llegó
// la persona en un selector, y si el link trae UTM (ej. el anuncio de WhatsApp) se guardan también.
// La revisión diaria de anuncios lee bookings.origen (canal + UTM) igual que en las reservas web.
export const CANALES_PANEL = [
  'Anuncio de Instagram o Facebook',
  'Instagram (sin anuncio)',
  'Facebook (sin anuncio)',
  'TikTok',
  'Anuncio de Google',
  'Google orgánico',
  'WhatsApp',
  'Recomendación',
  'Doctoralia',
  'Paciente que vuelve',
  'Otro',
] as const;

export type OrigenManual = Origen & { manual: true; via: string; registrado: string };

/** Origen para guardar en bookings.origen. null si no hay nada que registrar. */
export function origenManual(o: { canal?: string | null; utm?: unknown; via: string }): OrigenManual | null {
  const canalElegido = (CANALES_PANEL as readonly string[]).includes(String(o.canal ?? '')) ? String(o.canal) : '';
  const toque = limpiarTouch(o.utm);
  if (!canalElegido && !toque) return null;
  return {
    canal: canalElegido || calcularCanal(null, toque),
    first: null, last: toque,
    manual: true, via: o.via.replace(/[^\w-]/g, '').slice(0, 20) || 'panel', registrado: new Date().toISOString(),
  };
}

/** Une el origen marcado a mano con el del navegador de quien paga (sin perder el canal elegido). */
export function unirOrigen(guardado: unknown, navegador: Origen): Origen | null {
  const g = guardado && typeof guardado === 'object' ? guardado as Partial<OrigenManual> : null;
  if (!g) return navegador.first || navegador.last ? navegador : null;
  if (g.manual && !g.first && (navegador.first || navegador.last)) {
    return { ...(g as Origen), first: navegador.first, last: g.last ?? navegador.last };
  }
  return null; // ya tenía origen: no se toca
}

/** Parámetros UTM / clic de anuncio para agregar a un link (los mismos que guarda BaseLayout). */
export function utmEnUrl(url: string, utm: unknown): string {
  const t = limpiarTouch(utm);
  if (!t) return url;
  const p = new URLSearchParams();
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid'] as const) if (t[k]) p.set(k, t[k]!);
  const q = p.toString();
  return q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url;
}
