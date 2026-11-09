// Grabación desde PulseAudio (9 nov 2026).
//
// Prueba en vivo (9 nov, sesión de prueba): mientras Vale hablaba, el monitor del sumidero nulo de
// PulseAudio —lo que Chromium/Meet REPRODUCE— llegó a pico 31783/32767, y en el mismo momento la mezcla
// WebAudio de las pistas WebRTC (captura/audio-pagina.ts) medía pico=0. Eso explica las 12 sesiones
// online grabadas en silencio desde el 18 oct. Este grabador toma el audio de `nulo.monitor`, que es
// exactamente lo que se oye en la reunión (todos los participantes, el robot no habla).
//
// Cada segmento es un proceso `parecord` que escribe un OGG en /tmp (tmpfs de la máquina efímera); al
// detenerlo (SIGINT, cierra bien el archivo) se lee entero, se entrega como un trozo y se borra.
// Un segundo proceso `parec` (PCM 8 kHz) alimenta el medidor de nivel de la guardia de silencio.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FUENTE_PULSO = 'nulo.monitor';
export const MIME_PULSO = 'audio/ogg';

export interface FinSegmentoPulso { seq: number; datos: Buffer; offsetMs: number; duracionMs: number }

interface Activo { proc: ChildProcess; archivo: string; inicio: number; salida: Promise<void> }

/** ¿Hay PulseAudio con el sumidero nulo y las herramientas? (si no, se usa el grabador de la página). */
export function pulsoDisponible(): boolean {
  try {
    const a = spawnSync('parecord', ['--version'], { timeout: 5_000 });
    if (a.status !== 0) return false;
    const s = spawnSync('pactl', ['list', 'short', 'sources'], { timeout: 5_000, encoding: 'utf8' });
    return s.status === 0 && String(s.stdout).includes(FUENTE_PULSO);
  } catch {
    return false;
  }
}

export class GrabadorPulso {
  private readonly activos = new Map<number, Activo>();
  private t0: number | null = null;
  private medidor: ChildProcess | null = null;
  private pico = 0;

  constructor(private readonly o: { log: (m: string) => void; alTerminar: (f: FinSegmentoPulso) => void }) {}

  /** Arranca el medidor de nivel (pico desde la última lectura, 0–1). */
  empezarMedidor(): void {
    if (this.medidor) return;
    const p = spawn('parec', ['-d', FUENTE_PULSO, '--format=s16le', '--rate=8000', '--channels=1', '--latency-msec=250'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let resto: Buffer | null = null;
    p.stdout!.on('data', (b: Buffer) => {
      const d = resto ? Buffer.concat([resto, b]) : b;
      const n = d.length - (d.length % 2);
      for (let i = 0; i < n; i += 2) { const v = Math.abs(d.readInt16LE(i)); if (v > this.pico) this.pico = v; }
      resto = n < d.length ? d.subarray(n) : null;
    });
    p.on('exit', () => { if (this.medidor === p) this.medidor = null; });
    this.medidor = p;
  }

  nivel(): number {
    const r = Math.round((this.pico / 32768) * 1000) / 1000;
    this.pico = 0;
    return r;
  }

  iniciar(seq: number): void {
    if (this.activos.has(seq)) return;
    const inicio = Date.now();
    if (this.t0 == null) this.t0 = inicio;
    const archivo = join(tmpdir(), `vo-seg-${process.pid}-${seq}.oga`);
    const proc = spawn('parecord', ['-d', FUENTE_PULSO, '--file-format=oga', '--rate=16000', '--channels=1', archivo], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr!.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-300); });
    const salida = new Promise<void>((r) => proc.on('exit', (code, sig) => {
      if (code && sig !== 'SIGINT') this.o.log(`parecord seq ${seq} terminó con código ${code}: ${err.trim()}`);
      r();
    }));
    this.activos.set(seq, { proc, archivo, inicio, salida });
  }

  /** Detiene el segmento y entrega el archivo completo. false = no estaba activo. */
  async detener(seq: number): Promise<boolean> {
    const a = this.activos.get(seq);
    if (!a) return false;
    this.activos.delete(seq);
    const fin = Date.now();
    a.proc.kill('SIGINT');
    await Promise.race([a.salida, new Promise((r) => setTimeout(r, 10_000))]);
    if (a.proc.exitCode == null) a.proc.kill('SIGKILL');
    try {
      const datos = await readFile(a.archivo);
      this.o.alTerminar({ seq, datos, offsetMs: a.inicio - (this.t0 ?? a.inicio), duracionMs: fin - a.inicio });
    } catch (e) {
      this.o.log(`no se pudo leer el segmento ${seq}: ${e instanceof Error ? e.message : e}`);
    } finally {
      await rm(a.archivo, { force: true }).catch(() => {});
    }
    return true;
  }

  activas(): number[] { return [...this.activos.keys()]; }

  /** Corta todo SIN entregar (sin consentimiento). */
  async apagar(): Promise<void> {
    this.medidor?.kill('SIGKILL');
    for (const [seq, a] of [...this.activos]) {
      this.activos.delete(seq);
      a.proc.kill('SIGKILL');
      await rm(a.archivo, { force: true }).catch(() => {});
    }
  }
}
