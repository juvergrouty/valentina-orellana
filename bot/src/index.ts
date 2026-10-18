// Bot "Notas Ps. Valentina Orellana": entra al Meet como invitado (o, en modo 'cuenta', con la
// cuenta de Google del robot: invitado del calendario, entra sin pedir permiso; ver
// docs/transcriptor/85-robot-meet.md), espera que Vale lo admita (hasta 20 min), graba el
// audio mezclado de la reunión en segmentos de 15 min que sube directo a R2 (URL prefirmada que pide al sitio), registra quién habla por el tile
// iluminado y sale cuando Vale sale, cuando quedan solo bots, si entra alguien de más, si lo
// expulsan o al llegar a HORA_FIN + 30 min. Al terminar, el proceso sale y la máquina de Fly
// se autodestruye (config.auto_destroy = true, restart.policy = "no").
//
// Privacidad: nada se escribe en disco, no se toman capturas de pantalla, no se registran en
// los logs el enlace, el token ni nombres de participantes.
import { leerConfig, type ConfigBot } from './config.js';
import { LineaHablantes } from './linea.js';
import { cargarPlaywright, type Navegador, type Pagina } from './navegador.js';
import { esperarAdmision } from './meet/admision.js';
import { argumentosChromium, IDIOMA_UI } from './meet/argumentos.js';
import { entrarComoInvitado, entrarConCuenta } from './meet/entrar.js';
import { revisarExpulsion } from './meet/expulsion.js';
import { EntradaX11, InteraccionHumana } from './meet/humano.js';
import { salirDeMeet } from './meet/salir.js';
import { clasesHablando } from './meet/selectores.js';
import { instalarGrabadorEnPagina } from './captura/audio-pagina.js';
import { capturarPistasRTC } from './captura/rtc-pagina.js';
import { instalarHablantesEnPagina, participantesEnPagina } from './captura/hablantes-pagina.js';
import { Segmentos } from './segmentos.js';
import { Sitio, TokenRechazadoError } from './sitio.js';
import { sanearError } from './saneo.js';
import { estadoSesionValido, soloGoogle, type EstadoSesion } from './sesion.js';
import { Vigia, type MotivoFin } from './vigia.js';

const log = (m: string) => console.log(`[bot ${new Date().toISOString()}] ${m}`);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TROZO_MS = 10_000;
const SONDEO_VIGIA_MS = 2_000;

interface GrabPagina {
  iniciar(seq: number): void;
  detener(seq: number): boolean;
  activas(): number[];
  pistas(): number;
  nivel(): { pico: number; estado: string };
  apagar(): void;
}

async function grabar(p: Pagina, cfg: ConfigBot, sitio: Sitio): Promise<{ motivo: MotivoFin; linea: ReturnType<LineaHablantes['cerrar']>; fallidos: number[] }> {
  const linea = new LineaHablantes(cfg.botNombre);
  const segs = new Segmentos({ sitio, log });
  const finSegmento = new Map<number, () => void>();

  await p.exposeFunction('__voTrozo', (seq: number, b64: string) => { segs.agregarTrozo(seq, Buffer.from(b64, 'base64')); return true; });
  await p.exposeFunction('__voSegFin', (seq: number, offset: number, dur: number) => {
    void segs.cerrar(seq, offset, dur);
    finSegmento.get(seq)?.();
    return true;
  });
  await p.exposeFunction('__voHablante', (nombre: string, on: boolean, t: number) => { linea.registrar(t, nombre, on); return true; });

  const ok = await p.evaluate(instalarGrabadorEnPagina, { bitsPorSegundo: cfg.bitsPorSegundo, trozoMs: TROZO_MS });
  if (!ok) throw new Error('MediaRecorder no soporta audio/webm;codecs=opus en este Chromium');
  await p.evaluate(instalarHablantesEnPagina, { clases: clasesHablando, sondeoMs: 250 });

  const iniciar = (seq: number) => p.evaluate((s: number) => (window as unknown as { __voGrab: GrabPagina }).__voGrab.iniciar(s), seq);
  const detener = async (seq: number) => {
    const termino = new Promise<void>((r) => { finSegmento.set(seq, r); setTimeout(r, 20_000); });
    const ok2 = await p.evaluate((s: number) => (window as unknown as { __voGrab: GrabPagina }).__voGrab.detener(s), seq).catch(() => false);
    if (ok2) await termino;
    finSegmento.delete(seq);
  };

  const inicio = Date.now();
  const limiteMs = cfg.horaFin.getTime() + cfg.maxExtraMs;
  const vigia = new Vigia({ botNombre: cfg.botNombre, valeNombres: cfg.valeNombres, soloMs: cfg.soloMs, maxHumanos: cfg.maxHumanos, limiteMs });
  let seq = 0;
  await iniciar(seq);
  let proximoCorte = inicio + cfg.segmentoMs;
  let siguienteAbierto = false;
  let vioHumanos = false;
  let avisoSinPistas = false;
  let ultimoNivel = Date.now();
  let motivo: MotivoFin | null = null;

  while (!motivo) {
    await dormir(SONDEO_VIGIA_MS);
    const ahora = Date.now();

    const exp = await revisarExpulsion(p);
    if (exp) { motivo = exp === 'expulsado' ? 'expulsado' : 'vale_salio'; break; }

    let nombres: string[] = [];
    try { nombres = await p.evaluate(participantesEnPagina); } catch { /* página ocupada: se reintenta */ }
    if (nombres.length) vioHumanos = true;
    motivo = vigia.observar(ahora, nombres);
    if (motivo) break;

    if (ahora - ultimoNivel >= 60_000) {
      ultimoNivel = ahora;
      const nv = await p.evaluate(() => {
        const g = (window as unknown as { __voGrab: GrabPagina }).__voGrab;
        return { ...g.nivel(), pistas: g.pistas(), rtc: ((window as unknown as { __voPistasRTC?: MediaStreamTrack[] }).__voPistasRTC ?? []).length };
      }).catch(() => null);
      if (nv) log(`audio: contexto=${nv.estado} pistas=${nv.pistas} rtc=${nv.rtc} pico=${nv.pico}`);
    }
    if (!avisoSinPistas && ahora - inicio > 60_000) {
      const n = await p.evaluate(() => (window as unknown as { __voGrab: GrabPagina }).__voGrab.pistas()).catch(() => 0);
      if (n === 0) {
        const diag = await p.evaluate(() => ({
          rtc: ((window as unknown as { __voPistasRTC?: MediaStreamTrack[] }).__voPistasRTC ?? []).length,
          elementos: document.querySelectorAll('audio, video').length,
        })).catch(() => null);
        log(`sin pistas de audio: ${diag ? `rtc=${diag.rtc} elementos=${diag.elementos}` : 'sin diagnóstico'}`);
      }
      if (n === 0) { avisoSinPistas = true; await sitio.enviar({ tipo: 'error', detalle: 'El bot no encuentra pistas de audio en la reunión (¿cambió Meet?)' }).catch(() => {}); }
    }

    // Segmentación: abre el siguiente `solapamientoMs` antes del corte y cierra el actual en el corte.
    if (!siguienteAbierto && ahora >= proximoCorte - cfg.solapamientoMs) { await iniciar(seq + 1); siguienteAbierto = true; }
    if (siguienteAbierto && ahora >= proximoCorte) {
      void detener(seq);
      seq += 1;
      siguienteAbierto = false;
      proximoCorte += cfg.segmentoMs;
    }
  }

  if (!vioHumanos) await sitio.enviar({ tipo: 'error', detalle: 'El bot no pudo leer los participantes de Meet (¿cambió el DOM?)' }).catch(() => {});
  log(`fin de la grabación: ${motivo}`);
  const tFin = Date.now() - inicio;
  const abiertas = await p.evaluate(() => (window as unknown as { __voGrab: GrabPagina }).__voGrab.activas()).catch(() => [seq]);
  await Promise.all(abiertas.map((s) => detener(s)));
  const fallidos = await segs.vaciar();
  return { motivo, linea: linea.cerrar(tFin), fallidos };
}

async function main(): Promise<number> {
  let cfg: ConfigBot;
  try { cfg = leerConfig(); } catch (e) { log(`configuración inválida: ${e instanceof Error ? e.message : e}`); return 2; }
  const sitio = new Sitio({ eventoUrl: cfg.eventoUrl, token: cfg.token, log });

  // Tope duro: pase lo que pase, el proceso termina (la máquina se destruye al salir).
  const topeDuro = cfg.horaFin.getTime() + cfg.maxExtraMs + 10 * 60_000 - Date.now();
  const guardia = setTimeout(() => { log('tope duro de duración alcanzado: salida forzada'); process.exit(3); }, Math.max(topeDuro, 60_000));
  guardia.unref();

  let navegador: Navegador | null = null;
  let finEnviado = false;
  let devolverSesion: (() => Promise<void>) | null = null;
  const enviarFin = async (motivo: MotivoFin, linea: ReturnType<LineaHablantes['cerrar']> = []) => {
    if (finEnviado) return;
    finEnviado = true;
    // Antes de `fin` (fin revoca el token): la sesión renovada del robot vuelve al sitio.
    if (devolverSesion) { const d = devolverSesion; devolverSesion = null; await d().catch(() => {}); }
    await sitio.enviar({ tipo: 'fin', motivo, linea_hablantes: linea });
  };

  try {
    const { chromium } = await cargarPlaywright();
    // Primero con sandbox (B6). Si no arranca (kernel sin espacios de nombres para pwuser), se
    // relanza sin sandbox para no perder la sesión, y queda en el log. CHROMIUM_SANDBOX=0 lo salta.
    const lanzar = (sandbox: boolean) => chromium.launch({ headless: false, chromiumSandbox: sandbox, args: argumentosChromium(1280, 720, { sandbox }) });
    if (process.env.CHROMIUM_SANDBOX === '0') {
      navegador = await lanzar(false);
      log('Chromium sin sandbox (CHROMIUM_SANDBOX=0)');
    } else {
      try {
        navegador = await lanzar(true);
        log('Chromium con sandbox');
      } catch (e) {
        log(`Chromium sin sandbox: el sandbox no arrancó (${sanearError(e instanceof Error ? e.message : e, 160)})`);
        navegador = await lanzar(false);
      }
    }
    const nav = navegador;
    const opcionesContexto = { locale: IDIOMA_UI, viewport: { width: 1280, height: 720 }, permissions: [] };
    const x11 = new EntradaX11();
    const humano = (await x11.disponible()) ? new InteraccionHumana(x11, log) : null;
    if (!humano) log('xdotool/Xvfb no disponible: se usarán clics sintéticos (Meet podría rechazarlos)');

    // Modo 'cuenta': la sesión del robot llega del sitio (solo en memoria). Sin ella → invitado.
    let sesion: EstadoSesion | null = null;
    if (cfg.modo === 'cuenta' && cfg.cuentaEmail) {
      sesion = await sitio.pedirSesion(cfg.cuentaEmail).catch((e) => {
        if (e instanceof TokenRechazadoError) throw e;
        log(`no se pudo pedir la sesión del robot (${sanearError(e instanceof Error ? e.message : e, 120)})`);
        return null;
      });
      log(sesion ? 'modo cuenta: sesión del robot recibida' : 'modo cuenta sin sesión disponible: entra como invitado');
    }
    const nuevoContexto = async (o: Record<string, unknown>) => {
      const c = await nav.newContext(o);
      await c.addInitScript(capturarPistasRTC);
      return c;
    };
    let contexto = await nuevoContexto(sesion ? { ...opcionesContexto, storageState: sesion } : opcionesContexto);
    let p = await contexto.newPage();
    if (sesion && cfg.cuentaEmail) {
      const r = await entrarConCuenta(p, cfg.meetUrl, cfg.cuentaEmail, { humano, log });
      if (r === 'sin_sesion') {
        log('Meet no reconoció la sesión del robot: entra como invitado');
        await sitio.enviar({ tipo: 'sesion_invalida', motivo: 'Meet pidió iniciar sesión de nuevo' }).catch(() => {});
        sesion = null;
        await contexto.close().catch(() => {});
        contexto = await nuevoContexto(opcionesContexto);
        p = await contexto.newPage();
        await entrarComoInvitado(p, cfg.meetUrl, cfg.botNombre, { humano, log });
      }
    } else {
      await entrarComoInvitado(p, cfg.meetUrl, cfg.botNombre, { humano, log });
    }
    // Al salir devuelve la sesión renovada (Google rota cookies); nunca toca disco.
    devolverSesion = sesion ? async () => {
      const e = await contexto.storageState().catch(() => null);
      if (estadoSesionValido(e)) await sitio.enviar({ tipo: 'sesion_actualizada', sesion: soloGoogle(e) }).catch(() => log('no se pudo devolver la sesión renovada'));
    } : null;
    await sitio.enviar({ tipo: 'lobby' });

    const adm = await esperarAdmision(p, cfg.esperaAdmisionMs, log);
    if (adm.tipo !== 'admitido') {
      log(`no admitido: ${adm.tipo}`);
      if (adm.tipo === 'bloqueado') {
        await sitio.enviar({ tipo: 'error', detalle: adm.detalle }).catch(() => {});
        await enviarFin('error');
      } else {
        await enviarFin('no_admitido');
      }
      await salirDeMeet(p, log);
      return 0;
    }

    log('admitido');
    await sitio.enviar({ tipo: 'activo' });
    const r = await grabar(p, cfg, sitio);
    if (r.fallidos.length) await sitio.enviar({ tipo: 'error', detalle: `No se pudieron subir los segmentos ${r.fallidos.join(', ')}` }).catch(() => {});
    await salirDeMeet(p, log);
    await enviarFin(r.motivo, r.linea);
    return 0;
  } catch (e) {
    const msg = sanearError(e instanceof Error ? e.message : String(e)); // sin enlace de Meet (B8)
    log(`error: ${msg}`);
    if (e instanceof TokenRechazadoError) return 4; // el sitio ya no acepta a este bot: salir sin más
    await sitio.enviar({ tipo: 'error', detalle: msg.slice(0, 300) }).catch(() => {});
    await enviarFin('error').catch(() => {});
    return 1;
  } finally {
    try { await navegador?.close(); } catch { /* */ }
  }
}

main().then((codigo) => process.exit(codigo), () => process.exit(1));
