// Derivado de Vexa (Apache-2.0): core/meetings/modules/join/src/googlemeet/admission.ts (commit f1a62fb).
// Espera en la sala hasta que Vale admite al bot, lo rechaza, o vence el plazo (20 min).
// Si aparece un reCAPTCHA, el bot NO lo resuelve: sale con error (Google sospecha de él).
import type { Pagina } from '../navegador.js';
import {
  indicadoresAdmision, indicadoresRechazo, indicadoresSalaEspera, selectorRecaptcha, selectorRecaptchaDesafio,
  MIN_LADO_DESAFIO, textosRechazoExplicito,
} from './selectores.js';

export type ResultadoAdmision =
  | { tipo: 'admitido' }
  | { tipo: 'rechazado' }                     // el anfitrión dijo que no
  | { tipo: 'vencido' }                       // nadie lo admitió a tiempo
  | { tipo: 'bloqueado'; detalle: string };   // página de error / reCAPTCHA / enlace inválido

const PANEL_EFECTOS = /visual_effects|backgrounds and effects/i;

async function visible(p: Pagina, sel: string): Promise<boolean> {
  try { return await p.locator(sel).first().isVisible(); } catch { return false; }
}

export function esRechazoExplicito(selector: string): boolean {
  const s = selector.toLowerCase();
  return textosRechazoExplicito.some((t) => s.includes(t));
}

/** Tiles reales (sin el panel "Backgrounds and effects", que también trae data-participant-id). */
export async function contarTilesReales(p: Pagina): Promise<number> {
  try {
    const etiquetas = await p.locator('[data-participant-id]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('aria-label') || (e.textContent || '').trim()),
    );
    return etiquetas.filter((l) => l && !PANEL_EFECTOS.test(l)).length;
  } catch { return 0; }
}

export async function revisarRechazo(p: Pagina): Promise<ResultadoAdmision | null> {
  for (const sel of indicadoresRechazo) {
    if (esRechazoExplicito(sel) && await visible(p, sel)) return { tipo: 'rechazado' };
  }
  for (const sel of indicadoresRechazo) {
    if (!esRechazoExplicito(sel) && await visible(p, sel)) return { tipo: 'bloqueado', detalle: 'Meet mostró una página de error' };
  }
  if (await hayDesafioRecaptcha(p)) {
    return { tipo: 'bloqueado', detalle: 'Google pidió un reCAPTCHA (bloqueo de invitado automatizado)' };
  }
  return null;
}

/** true solo si el desafío de reCAPTCHA (bframe) está visible y con tamaño real. */
export async function hayDesafioRecaptcha(p: Pagina): Promise<boolean> {
  try {
    const cajas = await p.locator(selectorRecaptchaDesafio).evaluateAll((els) => els.map((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(e as HTMLElement);
      const oculto = st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0;
      return { w: r.width, h: r.height, oculto };
    }));
    return cajas.some((c) => !c.oculto && c.w >= MIN_LADO_DESAFIO && c.h >= MIN_LADO_DESAFIO);
  } catch { return false; }
}

/** Diagnóstico sin datos personales: ruta (sin query) y tamaño de cada iframe de reCAPTCHA. */
export async function diagnosticoRecaptcha(p: Pagina): Promise<string> {
  try {
    const info = await p.locator(selectorRecaptcha).evaluateAll((els) => els.map((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      let ruta = '';
      try { ruta = new URL((e as HTMLIFrameElement).src).pathname; } catch { /* */ }
      return `${ruta} ${Math.round(r.width)}x${Math.round(r.height)}`;
    }));
    return info.length ? info.join(' | ') : 'sin iframes de reCAPTCHA';
  } catch { return 'diagnóstico no disponible'; }
}

export async function estaAdmitido(p: Pagina): Promise<boolean> {
  // Guarda negativa: en la sala de espera los botones de la barra son falsos positivos.
  for (const sel of indicadoresSalaEspera) if (await visible(p, sel)) return false;
  if ((await contarTilesReales(p)) > 0) return true;
  try { if ((await p.locator('[data-self-name]').count()) > 0) return true; } catch { /* */ }
  for (const sel of indicadoresAdmision.slice(2)) if (await visible(p, sel)) return true;
  return false;
}

export async function esperarAdmision(p: Pagina, plazoMs: number, log: (m: string) => void, ahora: () => number = Date.now): Promise<ResultadoAdmision> {
  const limite = ahora() + plazoMs;
  let vueltas = 0;
  while (ahora() < limite) {
    // Primero "admitido": dentro de la llamada no hay rechazo posible y se evitan falsos positivos.
    if (await estaAdmitido(p)) return { tipo: 'admitido' };
    const rechazo = await revisarRechazo(p);
    if (rechazo) {
      if (rechazo.tipo === 'bloqueado') log(`bloqueo detectado: ${rechazo.detalle} · reCAPTCHA: ${await diagnosticoRecaptcha(p)}`);
      return rechazo;
    }
    if (++vueltas % 30 === 0) log(`sigue en la sala de espera (${Math.round((limite - ahora()) / 60_000)} min restantes)`);
    await p.waitForTimeout(2000);
  }
  return { tipo: 'vencido' };
}
