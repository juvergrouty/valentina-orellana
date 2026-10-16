// Derivado de Vexa (Apache-2.0): core/meetings/modules/join/src/shared/leave-click.ts y
// googlemeet/leave.ts (commit f1a62fb). Clic de "Leave call" dentro de la página.
import type { Pagina } from '../navegador.js';
import { matchersSalir, type MatcherBoton } from './selectores.js';

/** Corre DENTRO de la página (se serializa): solo DOM y su argumento. */
export async function clicSalirEnPagina(matchers: MatcherBoton[]): Promise<boolean> {
  const g = globalThis as unknown as { __name?: (f: unknown) => unknown };
  g.__name = g.__name || ((f: unknown) => f); // por si un compilador envuelve funciones anidadas
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const esVisible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  for (const m of matchers) {
    let candidatos: Element[];
    try { candidatos = Array.from(document.querySelectorAll(m.css ?? 'button, [role="button"]')); } catch { continue; }
    const aguja = m.text === undefined ? null : norm(m.text);
    const boton = candidatos.find((el) => (aguja === null || norm(el.textContent || '').includes(aguja)) && esVisible(el)) as HTMLElement | undefined;
    if (!boton) continue;
    boton.click();
    await new Promise((r) => setTimeout(r, 800));
    return true;
  }
  return false;
}

export async function salirDeMeet(p: Pagina, log: (m: string) => void): Promise<void> {
  if (p.isClosed()) return;
  try {
    const ok = await p.evaluate(clicSalirEnPagina, matchersSalir);
    log(ok ? 'salió de la reunión' : 'no encontró el botón de salir (se cierra la página)');
  } catch (e) {
    log(`error al salir: ${e instanceof Error ? e.message : e}`);
  }
  try { await p.close(); } catch { /* */ }
}
