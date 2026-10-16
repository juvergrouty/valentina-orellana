// Derivado de Vexa (Apache-2.0):
//   core/meetings/modules/join/src/googlemeet/humanized/x11Input.ts
//   core/meetings/modules/join/src/googlemeet/humanized/humanizedInteraction.ts  (commit f1a62fb)
// Cambios: la trayectoria del mouse se sintetiza (curva de Bézier con ruido y aceleración)
// en vez de reproducir la biblioteca de capturas de movimiento de Vexa; ver bot/NOTICE.
//
// Por qué: Google Meet descarta los clics sintéticos de Playwright/CDP (isTrusted=false, sin
// movimiento real del puntero). xdotool genera eventos XTEST que entrega el propio servidor X
// (Xvfb), así que Chromium los ve como entrada real.
import { execFile } from 'node:child_process';
import type { Manejador, Pagina } from '../navegador.js';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class EntradaX11 {
  constructor(private readonly display = process.env.DISPLAY ?? ':99', private readonly timeoutMs = 5000) {}

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(args[0], args.slice(1), { env: { ...process.env, DISPLAY: this.display }, timeout: this.timeoutMs },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
  }

  async disponible(): Promise<boolean> {
    try { await this.run(['xdotool', 'getdisplaygeometry']); return true; } catch { return false; }
  }

  async puntero(): Promise<{ x: number; y: number }> {
    const out = await this.run(['xdotool', 'getmouselocation', '--shell']);
    return { x: Number(/X=(-?\d+)/.exec(out)?.[1] ?? 0), y: Number(/Y=(-?\d+)/.exec(out)?.[1] ?? 0) };
  }

  async mover(x: number, y: number): Promise<void> {
    await this.run(['xdotool', 'mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]);
  }

  async presionar(): Promise<void> { await this.run(['xdotool', 'mousedown', '1']); }
  async soltar(): Promise<void> { await this.run(['xdotool', 'mouseup', '1']); }
  async tecla(nombre: string): Promise<void> { await this.run(['xdotool', 'key', '--clearmodifiers', nombre]); }

  /** Escribe texto con pulsaciones XTEST (retardo por carácter). */
  async escribir(texto: string, retardoMs = 70): Promise<void> {
    await this.run(['xdotool', 'type', '--clearmodifiers', '--delay', String(retardoMs), '--', texto]);
  }
}

/** Puntos de una trayectoria "humana" de (x0,y0) a (x1,y1): Bézier cúbica + ruido + easing. */
export function trayectoria(x0: number, y0: number, x1: number, y1: number, pasos = 28, azar: () => number = Math.random): { x: number; y: number }[] {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist; // normal
  const curva = (azar() - 0.5) * Math.min(120, dist * 0.3);
  const c1 = { x: x0 + dx * 0.3 + nx * curva, y: y0 + dy * 0.3 + ny * curva };
  const c2 = { x: x0 + dx * 0.7 + nx * curva * 0.5, y: y0 + dy * 0.7 + ny * curva * 0.5 };
  const out: { x: number; y: number }[] = [];
  for (let i = 1; i <= pasos; i++) {
    const s = i / pasos;
    const t = s < 0.5 ? 2 * s * s : 1 - (-2 * s + 2) ** 2 / 2; // ease-in-out
    const u = 1 - t;
    let x = u ** 3 * x0 + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * x1;
    let y = u ** 3 * y0 + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * y1;
    if (i < pasos) { x += (azar() - 0.5) * 2; y += (azar() - 0.5) * 2; }
    out.push({ x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

interface Rect { left: number; top: number; width: number; height: number }

/** Clics y escritura con entrada real del servidor X sobre una página de Playwright. */
export class InteraccionHumana {
  private dx = 0;
  private dy = 0;
  private dpr = 1;
  private calibrada = false;

  constructor(private readonly x11: EntradaX11, private readonly log: (m: string) => void = () => {}) {}

  /** Relación pantalla X (px dispositivo) ↔ página (px CSS): mueve el puntero real y lee el evento. */
  private async calibrar(p: Pagina): Promise<void> {
    if (this.calibrada) return;
    this.dpr = await p.evaluate(() => window.devicePixelRatio || 1);
    await p.evaluate(() => {
      const w = window as unknown as { __voUltimoMouse: { x: number; y: number } | null };
      w.__voUltimoMouse = null;
      window.addEventListener('mousemove', (e) => { w.__voUltimoMouse = { x: e.clientX, y: e.clientY }; }, { capture: true });
    });
    const geo = await p.evaluate(() => ({ sx: window.screenX, sy: window.screenY, iw: window.innerWidth, ih: window.innerHeight }));
    const px = Math.round((geo.sx + geo.iw * 0.4) * this.dpr), py = Math.round((geo.sy + geo.ih * 0.45) * this.dpr);
    await this.x11.mover(px, py);
    await dormir(150);
    const ev = await p.evaluate(() => (window as unknown as { __voUltimoMouse: { x: number; y: number } | null }).__voUltimoMouse);
    if (ev) { this.dx = px - ev.x * this.dpr; this.dy = py - ev.y * this.dpr; }
    else { this.dx = geo.sx * this.dpr; this.dy = geo.sy * this.dpr; this.log('calibración: se usó screenX/screenY'); }
    this.calibrada = true;
  }

  private async rect(p: Pagina, h: Manejador): Promise<Rect> {
    return p.evaluate((el: unknown) => {
      const r = (el as Element).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }, h as unknown);
  }

  /** Mueve el puntero real al centro (con azar) del elemento, verifica que cae encima y hace clic. */
  async clic(p: Pagina, h: Manejador): Promise<void> {
    await this.calibrar(p);
    for (let intento = 0; intento < 3; intento++) {
      const r = await this.rect(p, h);
      if (r.width <= 0 || r.height <= 0) throw new Error('elemento sin tamaño');
      const cx = r.left + r.width * (0.35 + Math.random() * 0.3);
      const cy = r.top + r.height * (0.35 + Math.random() * 0.3);
      const destino = { x: this.dx + cx * this.dpr, y: this.dy + cy * this.dpr };
      const desde = await this.x11.puntero();
      for (const pt of trayectoria(desde.x, desde.y, destino.x, destino.y)) {
        await this.x11.mover(pt.x, pt.y);
        await dormir(8 + Math.random() * 14);
      }
      // Verificación del punto final con el puntero REAL (no el previsto).
      const real = await this.x11.puntero();
      const enPagina = { x: (real.x - this.dx) / this.dpr, y: (real.y - this.dy) / this.dpr };
      const encima = await p.evaluate((a: { x: number; y: number; el: unknown }) => {
        const hit = document.elementFromPoint(a.x, a.y);
        const el = a.el as Element;
        return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
      }, { x: enPagina.x, y: enPagina.y, el: h as unknown });
      if (!encima) { this.log(`clic humano fuera del objetivo (intento ${intento + 1})`); this.calibrada = false; await this.calibrar(p); continue; }
      await dormir(60 + Math.random() * 120);
      await this.x11.presionar();
      await dormir(50 + Math.random() * 70);
      await this.x11.soltar();
      return;
    }
    throw new Error('no se pudo apuntar al elemento con el puntero real');
  }

  async escribirEn(p: Pagina, h: Manejador, texto: string): Promise<void> {
    await this.clic(p, h);
    await dormir(200);
    await this.x11.tecla('ctrl+a');
    await this.x11.escribir(texto);
  }
}
