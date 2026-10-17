// MODO=iniciar_sesion (docs/transcriptor/85-robot-meet.md §6.2–§6.3 y §7.2.4).
// Máquina efímera de Fly, misma imagen y región que el bot. entrypoint.sh levanta Xvfb + x11vnc +
// noVNC ([::]:6080, solo por `fly proxy`) y ejecuta este archivo:
//  1. Abre Chromium como proceso NORMAL (sin Playwright ni depuración remota) con un perfil
//     temporal en accounts.google.com. Vale lo ve por noVNC e inicia sesión con sus manos en la
//     cuenta del robot. Este programa NUNCA ve, pide ni registra la contraseña.
//  2. Espera (plazo 15 min) a que el archivo de cookies del perfil tenga las de sesión de Google
//     o a que Vale cierre el navegador. Luego cierra Chromium limpio (así guarda las cookies).
//  3. Abre el MISMO perfil con Playwright solo para exportar el estado (sin abrir páginas de
//     Google), filtra a google.com, exige SID/__Secure-1PSID/__Secure-3PSID y comprueba, con la
//     lista de cuentas de Google, que la sesión es de BOT_CUENTA_EMAIL.
//  4. Lo sube al sitio (X-VO-Aprovisionar: 1 + Bearer BOT_APROVISIONAR → procesarSesionInicial,
//     que lo guarda cifrado), imprime "LISTO", borra el perfil y sale con 0.
// Nunca se imprimen cookies ni el secreto. El perfil vive en /tmp de la máquina (se destruye).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archivoTieneCookiesDeSesion, armarCuerpoSesionInicial, argumentosChromeNormal, cabecerasAprovisionar,
  cookiesFaltantesEnCrudo, correoEnListaCuentas, explicarRespuesta, leerConfigInicio, mensajeSeguro,
  prepararSesion, URL_LISTA_CUENTAS, URL_MI_CUENTA, type ConfigInicio,
} from './aprovisionar.js';
import type { EstadoSesion } from './sesion.js';

const log = (m: string) => console.log(`[iniciar_sesion ${new Date().toISOString()}] ${m}`);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SONDEO_MS = 3_000;
/** Tras ver las cookies, margen para que Vale cierre avisos de Google antes de cerrar el navegador. */
const GRACIA_MS = 20_000;

// Tipos mínimos de Playwright (mismo criterio que navegador.ts: el tsc del sitio no depende del paquete).
interface ContextoPersistente {
  storageState(): Promise<unknown>;
  request: { get(url: string, o?: { timeout?: number }): Promise<{ ok(): boolean; status(): number; text(): Promise<string> }> };
  close(): Promise<void>;
}
interface ChromiumPw {
  executablePath(): string;
  launchPersistentContext(dir: string, o: Record<string, unknown>): Promise<ContextoPersistente>;
}
async function chromiumPw(): Promise<ChromiumPw> {
  const nombre = 'playwright';
  return ((await import(nombre)) as { chromium: ChromiumPw }).chromium;
}

class ErrorClaro extends Error {}

/** Lanza el Chromium normal. Si el sandbox no arranca (sale en < 5 s), reintenta sin sandbox. */
async function abrirChromeNormal(exe: string, dir: string, env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; salio: () => boolean }> {
  for (const sandbox of process.env.CHROMIUM_SANDBOX === '0' ? [false] : [true, false]) {
    const proc = spawn(exe, argumentosChromeNormal(dir, { sandbox }), { env, stdio: 'ignore' });
    let termino = false;
    proc.on('exit', () => { termino = true; });
    proc.on('error', () => { termino = true; });
    await dormir(5_000);
    if (!termino) {
      log(`Chromium abierto ${sandbox ? 'con' : 'sin'} sandbox (sin automatización)`);
      return { proc, salio: () => termino };
    }
    log(`Chromium ${sandbox ? 'con' : 'sin'} sandbox no arrancó`);
  }
  throw new ErrorClaro('No se pudo abrir Chromium');
}

async function cerrarLimpio(proc: ChildProcess, salio: () => boolean): Promise<void> {
  if (salio()) return;
  proc.kill('SIGTERM'); // cierre ordenado: Chromium escribe las cookies pendientes en disco
  for (let i = 0; i < 30 && !salio(); i++) await dormir(500);
  if (!salio()) { proc.kill('SIGKILL'); await dormir(1_000); }
}

async function hayCookiesEnPerfil(dir: string): Promise<boolean> {
  // Con -wal / -journal: SQLite puede tener las filas nuevas ahí hasta el siguiente checkpoint.
  const bases = ['Default/Network/Cookies', 'Default/Cookies'];
  for (const rel of bases.flatMap((b) => [b, `${b}-wal`, `${b}-journal`])) {
    try { if (archivoTieneCookiesDeSesion(await readFile(join(dir, rel)))) return true; } catch { /* aún no existe */ }
  }
  return false;
}

/** Espera las cookies o el cierre del navegador. true = hay señal de sesión. */
async function esperarInicio(cfg: ConfigInicio, dir: string, salio: () => boolean): Promise<boolean> {
  const limite = Date.now() + cfg.plazoMs;
  let ultimoAviso = 0;
  while (Date.now() < limite) {
    if (await hayCookiesEnPerfil(dir)) {
      log(`sesión de Google detectada. Se guardará en ${GRACIA_MS / 1000} s; si Google muestra un aviso, ciérralo y no hagas nada más.`);
      for (let t = 0; t < GRACIA_MS && !salio(); t += 1_000) await dormir(1_000);
      return true;
    }
    if (salio()) { log('el navegador se cerró'); return hayCookiesEnPerfil(dir); }
    if (Date.now() - ultimoAviso > 60_000) {
      ultimoAviso = Date.now();
      log(`esperando el inicio de sesión de ${cfg.correo} (quedan ${Math.ceil((limite - Date.now()) / 60_000)} min)`);
    }
    await dormir(SONDEO_MS);
  }
  return false;
}

/** Abre el perfil con Playwright solo para exportar las cookies y confirmar la cuenta. */
async function exportarSesion(cfg: ConfigInicio, dir: string): Promise<EstadoSesion> {
  const chromium = await chromiumPw();
  const abrir = (sandbox: boolean) => chromium.launchPersistentContext(dir, {
    headless: false, chromiumSandbox: sandbox, args: ['--password-store=basic', '--disable-gpu'],
  });
  let ctx: ContextoPersistente;
  try { ctx = await abrir(process.env.CHROMIUM_SANDBOX !== '0'); } catch { ctx = await abrir(false); }
  try {
    const crudo = await ctx.storageState();
    const sesion = prepararSesion(crudo);
    if (!sesion) {
      const faltan = cookiesFaltantesEnCrudo(crudo);
      throw new ErrorClaro(`El perfil no tiene una sesión de Google completa (faltan: ${faltan.join(', ') || 'formato'}). Repite el inicio de sesión.`);
    }
    // Lista de cuentas: petición desde Node con las cookies del contexto (no abre páginas).
    // Respaldo: la página de Mi cuenta (HTML) también trae el correo de la cuenta activa.
    let confirmada = false;
    for (const url of [URL_LISTA_CUENTAS, URL_MI_CUENTA]) {
      const r = await ctx.request.get(url, { timeout: 20_000 }).catch(() => null);
      if (r?.ok() && correoEnListaCuentas(await r.text().catch(() => ''), cfg.correo)) { confirmada = true; break; }
    }
    if (!confirmada) {
      throw new ErrorClaro(`No se pudo confirmar que la sesión sea de ${cfg.correo} (se entró con otra cuenta o Google no respondió). No se subió nada. Repite y entra con la cuenta del robot.`);
    }
    // Después de la petición Google pudo rotar cookies: se toma el estado final.
    return prepararSesion(await ctx.storageState()) ?? sesion;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function subir(cfg: ConfigInicio, sesion: EstadoSesion): Promise<void> {
  const cuerpo = armarCuerpoSesionInicial(cfg.correo, sesion);
  let ultimo = '';
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(cfg.eventoUrl, { method: 'POST', headers: cabecerasAprovisionar(cfg.secreto), body: cuerpo, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return;
      const j = (await res.json().catch(() => ({}))) as { error?: unknown };
      ultimo = explicarRespuesta(res.status, j.error);
      if (res.status < 500 && res.status !== 429) throw new ErrorClaro(ultimo);
    } catch (e) {
      if (e instanceof ErrorClaro) throw e;
      ultimo = `error de red (${mensajeSeguro(e instanceof Error ? e.message : e, cfg.secreto, sesion, 120)})`;
    }
    log(`subida: intento ${i + 1} falló: ${ultimo}`);
    await dormir(2_000 * 2 ** i);
  }
  throw new ErrorClaro(`No se pudo subir la sesión: ${ultimo}`);
}

async function main(): Promise<number> {
  let cfg: ConfigInicio;
  try { cfg = leerConfigInicio(process.env); } catch (e) { log(`configuración inválida: ${e instanceof Error ? e.message : e}`); return 2; }
  // El secreto no pasa a ningún proceso hijo (Chromium, Playwright).
  delete process.env.BOT_APROVISIONAR;
  const envHijos: NodeJS.ProcessEnv = { ...process.env };

  const dir = await mkdtemp(join(tmpdir(), 'vo-perfil-'));
  let proc: ChildProcess | null = null;
  let salio = () => true;
  try {
    const chromium = await chromiumPw();
    const abierto = await abrirChromeNormal(chromium.executablePath(), dir, envHijos);
    proc = abierto.proc; salio = abierto.salio;
    log(`abre http://localhost:6080/vnc.html e inicia sesión en ${cfg.correo}. Plazo: ${Math.round(cfg.plazoMs / 60_000)} min.`);

    let hay = await esperarInicio(cfg, dir, salio);
    await cerrarLimpio(proc, salio);
    // Al cerrarse, Chromium escribe en disco las cookies pendientes: se revisa una última vez.
    if (!hay) hay = await hayCookiesEnPerfil(dir);
    if (!hay) throw new ErrorClaro('No se detectó un inicio de sesión de Google dentro del plazo (o se cerró el navegador antes). No se subió nada.');

    const sesion = await exportarSesion(cfg, dir);
    log(`sesión de ${cfg.correo} confirmada (${sesion.cookies.length} cookies de google.com); subiendo al sitio cifrada…`);
    await subir(cfg, sesion);
    log('LISTO: la sesión del robot quedó guardada en el sitio. Ya puedes cerrar noVNC y borrar BOT_APROVISIONAR_SECRET de Vercel.');
    return 0;
  } catch (e) {
    const msg = e instanceof ErrorClaro ? e.message : `error inesperado: ${mensajeSeguro(e instanceof Error ? e.message : e, cfg.secreto)}`;
    log(`ERROR: ${msg}`);
    return 1;
  } finally {
    if (proc) await cerrarLimpio(proc, salio).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => log('no se pudo borrar el perfil temporal (la máquina se destruye igual)'));
  }
}

main().then((c) => process.exit(c), () => process.exit(1));
