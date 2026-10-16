// Tipos mínimos de Playwright que usa el bot + carga perezosa del paquete.
// Se declaran aquí (en vez de `import type { Page } from 'playwright'`) para que el
// chequeo de tipos del sitio (tsc en la raíz del repo, que también ve bot/) no dependa de
// tener instaladas las dependencias del bot. En la imagen Docker se usa playwright real.

export interface Manejador {
  click(): Promise<void>;
  dispose(): Promise<void>;
}

export interface Localizador {
  first(): Localizador;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  elementHandle(o?: { timeout?: number }): Promise<Manejador | null>;
  evaluateAll<R>(fn: (els: Element[]) => R): Promise<R>;
}

export interface Pagina {
  goto(url: string, o?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>;
  bringToFront(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): Localizador;
  fill(selector: string, valor: string): Promise<void>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  exposeFunction(nombre: string, fn: (...args: any[]) => unknown): Promise<unknown>;
  isClosed(): boolean;
  url(): string;
  close(): Promise<void>;
}

export interface Contexto {
  newPage(): Promise<Pagina>;
  /** storageState de Playwright (cookies + localStorage). Modo 'cuenta': se devuelve al sitio. */
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

export interface Navegador {
  /** `storageState` (objeto) restaura la sesión de Google del robot (modo 'cuenta'). */
  newContext(o: Record<string, unknown>): Promise<Contexto>;
  close(): Promise<void>;
}

interface ModuloPlaywright {
  chromium: { launch(o: Record<string, unknown>): Promise<Navegador> };
}

/** Importa playwright en tiempo de ejecución (nombre en variable: tsc no lo resuelve). */
export async function cargarPlaywright(): Promise<ModuloPlaywright> {
  const nombre = 'playwright';
  return (await import(nombre)) as ModuloPlaywright;
}
