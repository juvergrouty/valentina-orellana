// Derivado de Vexa (Apache-2.0): core/meetings/modules/gmeet-capture/src/gmeet-speakers.ts (commit f1a62fb).
// Meet ilumina el tile de quien habla. Se leen las clases "hablando" conocidas, el nombre
// visible (span.notranslate) y se excluye el propio tile del bot (data-self-name). Se avisa a
// Node cada cambio: window.__voHablante(nombre, on, tMs) con t relativo al inicio de la
// grabación (window.__voT0, lo fija el grabador). Antes de grabar no se avisa nada.
//
// ESTAS FUNCIONES CORREN DENTRO DE LA PÁGINA: solo DOM y su argumento.

export interface OpcionesHablantesPagina { clases: string[]; sondeoMs: number }

export function instalarHablantesEnPagina(o: OpcionesHablantesPagina): void {
  type Ventana = Window & {
    __voHablantes?: { detener(): void };
    __voT0?: number | null;
    __voHablante?: (nombre: string, on: boolean, tMs: number) => Promise<unknown>;
  };
  const w = window as Ventana;
  if (w.__voHablantes) return;
  const BASURA = /^Google Participant \(|spaces\/|devices\//;
  const FRASES = ['let participants', 'send messages', 'turn on captions'];

  const nombreTile = (el: Element): string | null => {
    const nt = el.querySelector('span.notranslate');
    let t = nt?.textContent?.trim() || '';
    if (!t) t = el.querySelector('[data-self-name]')?.getAttribute('data-self-name')?.trim() || '';
    if (!t || t.length < 2 || t.length > 50 || BASURA.test(t)) return null;
    const l = t.toLowerCase();
    if (FRASES.some((f) => l.includes(f))) return null;
    return t;
  };
  const hablando = (el: Element): boolean =>
    o.clases.some((c) => el.classList.contains(c) || !!el.querySelector('.' + CSS.escape(c)));

  const activos = new Set<string>();
  const timer = setInterval(() => {
    const t0 = w.__voT0;
    if (t0 == null) return;
    const marca = document.querySelector('[data-self-name]');
    const idPropio = marca?.closest('[data-participant-id]')?.getAttribute('data-participant-id') || null;
    const ahora = new Set<string>();
    const vistos = new Set<string>();
    document.querySelectorAll('[data-participant-id]').forEach((el) => {
      const id = el.getAttribute('data-participant-id') || '';
      if (!id || vistos.has(id)) return;
      vistos.add(id);
      const propio = el.hasAttribute('data-self-name') || !!el.querySelector('[data-self-name]') || id === idPropio;
      const nombre = nombreTile(el);
      if (!propio && nombre && hablando(el)) ahora.add(nombre);
    });
    const t = performance.now() - t0;
    for (const n of ahora) if (!activos.has(n)) { activos.add(n); void w.__voHablante?.(n, true, t); }
    for (const n of [...activos]) if (!ahora.has(n)) { activos.delete(n); void w.__voHablante?.(n, false, t); }
  }, o.sondeoMs);

  w.__voHablantes = { detener: () => clearInterval(timer) };
}

/** Nombres visibles de los participantes, sin el propio tile del bot (para la regla de salida). */
export function participantesEnPagina(): string[] {
  const BASURA = /^Google Participant \(|spaces\/|devices\/|visual_effects|backgrounds and effects/i;
  const marca = document.querySelector('[data-self-name]');
  const idPropio = marca?.closest('[data-participant-id]')?.getAttribute('data-participant-id') || null;
  const out = new Set<string>();
  const vistos = new Set<string>();
  document.querySelectorAll('[data-participant-id]').forEach((el) => {
    const id = el.getAttribute('data-participant-id') || '';
    if (!id || vistos.has(id) || id === idPropio) return;
    vistos.add(id);
    if (el.hasAttribute('data-self-name') || el.querySelector('[data-self-name]')) return;
    const t = el.querySelector('span.notranslate')?.textContent?.trim() || '';
    if (t && t.length >= 2 && t.length <= 50 && !BASURA.test(t)) out.add(t);
  });
  return [...out];
}
