// Derivado de Vexa (Apache-2.0): core/meetings/modules/join/src/googlemeet/join.ts (commit f1a62fb).
// Solo el flujo de INVITADO anónimo: abre el enlace, escribe el nombre, apaga micrófono y
// cámara, y pulsa "Ask to join". Vale lo admite a mano desde su Meet (ese es el control).
// Sin capturas de pantalla: nunca se guarda imagen de una sesión clínica.
import type { Manejador, Pagina } from '../navegador.js';
import { conIdiomaFijo } from './argumentos.js';
import type { InteraccionHumana } from './humano.js';
import { botonesCamara, botonesMicrofono, botonesUnirse, camposNombre } from './selectores.js';

const SONDEO_MS = 300;

/** Primer selector VISIBLE en orden de la lista (el orden manda). */
export async function primeroVisible(p: Pagina, selectores: string[]): Promise<{ h: Manejador; selector: string } | null> {
  for (const sel of selectores) {
    try {
      const loc = p.locator(sel).first();
      if (!(await loc.isVisible())) continue;
      const h = await loc.elementHandle({ timeout: 2000 });
      if (h) return { h, selector: sel };
    } catch { /* selector inválido o nodo desprendido: sigue con el siguiente */ }
  }
  return null;
}

export async function esperarAlguno(p: Pagina, selectores: string[], timeoutMs: number, etiqueta: string): Promise<{ h: Manejador; selector: string }> {
  const inicio = Date.now();
  do {
    const hit = await primeroVisible(p, selectores);
    if (hit) return hit;
    await p.waitForTimeout(SONDEO_MS);
  } while (Date.now() - inicio < timeoutMs);
  throw new Error(`No apareció ${etiqueta} en ${Math.round(timeoutMs / 1000)} s (¿cambió el DOM de Meet o Google bloqueó al invitado?)`);
}

export interface OpcionesEntrar {
  humano: InteraccionHumana | null;
  log: (m: string) => void;
}

export async function entrarComoInvitado(p: Pagina, meetUrl: string, nombre: string, o: OpcionesEntrar): Promise<void> {
  await p.goto(conIdiomaFijo(meetUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await p.bringToFront();
  await p.waitForTimeout(1500);

  const clic = async (h: Manejador, etiqueta: string) => {
    if (o.humano) {
      try { await o.humano.clic(p, h); return; } catch (e) { o.log(`clic humano falló en ${etiqueta} (${e instanceof Error ? e.message : e}); se usa clic sintético`); }
    }
    await h.click();
  };

  const { h: campo, selector } = await esperarAlguno(p, camposNombre, 120_000, 'el campo de nombre');
  if (o.humano) {
    try { await o.humano.escribirEn(p, campo, nombre); }
    catch (e) { o.log(`escritura humana falló (${e instanceof Error ? e.message : e}); se usa fill`); await p.fill(selector, nombre); }
  } else {
    await p.fill(selector, nombre);
  }

  // Micrófono y cámara apagados (el bot nunca habla ni muestra video).
  for (const [lista, etiqueta] of [[botonesMicrofono, 'micrófono'], [botonesCamara, 'cámara']] as const) {
    const hit = await primeroVisible(p, lista);
    if (hit) await clic(hit.h, etiqueta);
  }

  const { h: unirse } = await esperarAlguno(p, botonesUnirse, 60_000, 'el botón "Ask to join"');
  await clic(unirse, 'pedir unirse');
  o.log('pidió unirse a la reunión');
}
