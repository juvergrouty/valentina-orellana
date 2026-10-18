// Bot "Notas Ps. Valentina Orellana": entra al Meet como invitado (o, en modo 'cuenta', con la
// cuenta de Google del robot: invitado del calendario, entra sin pedir permiso; ver
// docs/transcriptor/85-robot-meet.md), espera que Vale lo admita (hasta 20 min), y EMPIEZA A GRABAR
// recién cuando VALE está en la llamada (18 oct: el robot lo manda Vale al abrir la sesión y nunca graba
// al paciente solo; si la llamada queda sin nadie 30 min sale sin subir nada). Graba el audio mezclado de la reunión en segmentos de 15 min que sube directo a R2
// (URL prefirmada que pide al sitio), registra quién habla por el tile iluminado y sale según
// vigia.ts (Vale salió, quedó solo, alguien de más, expulsado, sin consentimiento, HORA_FIN + 30 min).
// Al terminar, el proceso sale y la máquina de Fly se autodestruye (config.auto_destroy = true,
// restart.policy = "no"). Si se cae antes de la hora, el sitio manda un robot de reemplazo con
// SEQ_INICIAL / ORIGEN_MS para seguir la misma grabación (src/lib/transcriptor/botReconexion.ts).
//
// Privacidad: nada se escribe en disco, no se toman capturas de pantalla, no se registran en
// los logs el enlace, el token ni nombres de participantes.
import { leerConfig, type ConfigBot } from './config.js';
import { desfaseOrigen, LineaHablantes, lineaConDesfase, type LineaHablante } from './linea.js';
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
import { instalarHablantesEnPagina, lecturaParticipantes } from './captura/hablantes-pagina.js';
import { Segmentos } from './segmentos.js';
import { horaFinDeRespuesta, SinConsentimientoError, Sitio, TokenRechazadoError } from './sitio.js';
import { sanearError } from './saneo.js';
import { estadoSesionValido, soloGoogle, type EstadoSesion } from './sesion.js';
import { decidirInicio, listaIlegible, Vigia, type LecturaParticipantes, type MotivoFin } from './vigia.js';

const log = (m: string) => console.log(`[bot ${new Date().toISOString()}] ${m}`);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TROZO_MS = 10_000;
const SONDEO_VIGIA_MS = 2_000;
/** Pico de la mezcla remota que cuenta como voz (0–1; el silencio de Meet queda en ~0). */
const UMBRAL_VOZ = 0.02;
/** Tope duro tras HORA_FIN + MAX_EXTRA_MS: pase lo que pase, el proceso termina. */
const MARGEN_TOPE_DURO_MS = 10 * 60_000;

interface GrabPagina {
  iniciar(seq: number): void;
  detener(seq: number): boolean;
  activas(): number[];
  pistas(): number;
  nivel(): { pico: number; estado: string };
  apagar(): void;
}

interface ResultadoGrabar { motivo: MotivoFin; linea: LineaHablante[]; fallidos: number[] }

/**
 * `alCambiarHora` lo llama main cuando el sitio informa otra HORA_FIN (Vale movió el evento).
 * `admitidoPorPersona`: en modo invitado alguien tuvo que admitirlo, así que "nadie visible" en
 * 30 min es más bien el DOM de Meet que cambió (se avisa); en modo cuenta entra solo.
 */
async function grabar(p: Pagina, cfg: ConfigBot, sitio: Sitio, op: {
  admitidoPorPersona: boolean;
  registrarCambioHora: (f: (limiteMs: number) => void) => void;
}): Promise<ResultadoGrabar> {
  const linea = new LineaHablantes(cfg.botNombre);
  const segs = new Segmentos({ sitio, log });
  const finSegmento = new Map<number, () => void>();
  let desfase = 0;

  await p.exposeFunction('__voTrozo', (seq: number, b64: string) => { segs.agregarTrozo(seq, Buffer.from(b64, 'base64')); return true; });
  await p.exposeFunction('__voSegFin', (seq: number, offset: number, dur: number) => {
    void segs.cerrar(seq, offset + desfase, dur);
    finSegmento.get(seq)?.();
    return true;
  });
  await p.exposeFunction('__voHablante', (nombre: string, on: boolean, t: number) => { linea.registrar(t, nombre, on); return true; });

  const ok = await p.evaluate(instalarGrabadorEnPagina, { bitsPorSegundo: cfg.bitsPorSegundo, trozoMs: TROZO_MS });
  if (!ok) throw new Error('MediaRecorder no soporta audio/webm;codecs=opus en este Chromium');
  await p.evaluate(instalarHablantesEnPagina, { clases: clasesHablando, sondeoMs: 250 });

  // Inicio de cada segmento según Node: solo para cerrar segmentos huérfanos (la página no avisó su fin).
  const inicioSeg = new Map<number, number>();
  const iniciar = async (seq: number) => {
    await p.evaluate((s: number) => (window as unknown as { __voGrab: GrabPagina }).__voGrab.iniciar(s), seq);
    if (!inicioSeg.has(seq)) inicioSeg.set(seq, Date.now());
  };
  // Cortes en curso (detener sin await): se esperan antes de cerrar huérfanos y vaciar la fila.
  const cortes = new Set<Promise<void>>();
  const detener = async (seq: number) => {
    const termino = new Promise<void>((r) => { finSegmento.set(seq, r); setTimeout(r, 20_000); });
    const ok2 = await p.evaluate((s: number) => (window as unknown as { __voGrab: GrabPagina }).__voGrab.detener(s), seq).catch(() => false);
    if (ok2) await termino;
    finSegmento.delete(seq);
  };

  const vigia = new Vigia({
    botNombre: cfg.botNombre, valeNombres: cfg.valeNombres, soloMs: cfg.soloMs, maxHumanos: cfg.maxHumanos,
    limiteMs: cfg.horaFin.getTime() + cfg.maxExtraMs, esperaLlegadaMs: cfg.esperaLlegadaMs, graciaValeMs: cfg.graciaValeMs,
    valeVistaInicial: cfg.valeVista,
  });
  op.registrarCambioHora((limiteMs) => vigia.fijarLimite(limiteMs));
  let seq = cfg.seqInicial;
  let inicio: number | null = null; // inicio de la grabación (null = todavía no hay nadie: no se graba)
  let proximoCorte = 0;
  let siguienteAbierto = false;
  let vioHumanos = false;
  let avisoSinPistas = false;
  let vozSinTiles = 0;
  let ultimoNivel = Date.now();
  let motivo: MotivoFin | null = null;

  try {
    while (!motivo) {
      await dormir(SONDEO_VIGIA_MS);
      const ahora = Date.now();

      const exp = await revisarExpulsion(p);
      if (exp) { motivo = exp === 'expulsado' ? 'expulsado' : 'vale_salio'; break; }
      if (segs.sinConsentimiento) { motivo = 'sin_consentimiento'; break; }

      let lectura: LecturaParticipantes | null = null;
      try { lectura = await p.evaluate(lecturaParticipantes); } catch { /* página ocupada: se reintenta */ }
      const nombres = lectura?.nombres ?? [];
      const humanos = vigia.humanos(nombres);
      if (humanos.length) vioHumanos = true;
      motivo = vigia.observar(ahora, nombres);
      if (motivo) break;

      // Se empieza a grabar recién cuando VALE está en la llamada (atraso de Vale, 18 oct: si el paciente
      // llega antes y espera solo, no se le graba). `activo` le dice al sitio que empezó (pasa a 'grabando';
      // inicio_at = llegada de Vale); si no hay consentimiento, el sitio responde 403 y se sale.
      if (inicio == null) {
        const ilegible = listaIlegible(lectura);
        if (ilegible && !cfg.valeVista && ahora - ultimoNivel >= 10_000) {
          // Respaldo SOLO si la lista de participantes no se puede leer (Meet cambió el DOM): si llega VOZ por
          // las pistas remotas dos sondeos seguidos, hay gente aunque no se vea → se graba y se avisa.
          ultimoNivel = ahora;
          const pico = await p.evaluate(() => (window as unknown as { __voGrab: GrabPagina }).__voGrab.nivel().pico).catch(() => 0);
          vozSinTiles = pico >= UMBRAL_VOZ ? vozSinTiles + 1 : 0;
        } else if (!ilegible) vozSinTiles = 0;
        const decision = decidirInicio({ hayVale: vigia.hayVale(nombres), ilegible, vozSeguida: vozSinTiles, reemplazo: cfg.valeVista });
        if (decision === 'esperar') continue;
        if (decision === 'grabar_por_voz') {
          log('hay voz pero no se puede leer la lista de participantes: se graba igual');
          await sitio.enviar({ tipo: 'error', detalle: 'El bot no pudo leer los participantes de Meet (¿cambió el DOM?); graba porque hay voz' }).catch(() => {});
          vioHumanos = true;
        }
        try { await sitio.enviar({ tipo: 'activo' }); } catch (e) {
          if (e instanceof SinConsentimientoError) { motivo = 'sin_consentimiento'; break; }
          throw e;
        }
        inicio = Date.now();
        vigia.empezoGrabacion();
        desfase = desfaseOrigen(inicio, cfg.origenMs);
        await iniciar(seq);
        proximoCorte = inicio + cfg.segmentoMs;
        log(`empieza la grabación (seq ${seq}${desfase ? `, desfase ${desfase} ms` : ''})`);
        continue;
      }

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
        const corte = detener(seq);
        cortes.add(corte);
        void corte.finally(() => cortes.delete(corte));
        seq += 1;
        siguienteAbierto = false;
        proximoCorte += cfg.segmentoMs;
      }
    }
  } catch (e) {
    // La página dejó de responder (se cayó o se recargó): se termina como error, pero lo que ya
    // está en memoria se sube igual (antes se perdía el segmento abierto y la fila de subidas).
    if (e instanceof TokenRechazadoError) throw e;
    log(`error durante la grabación: ${sanearError(e instanceof Error ? e.message : e, 160)}`);
    motivo = 'error';
  }

  if (!vioHumanos && op.admitidoPorPersona && motivo === 'nadie_llego') {
    await sitio.enviar({ tipo: 'error', detalle: 'El bot no pudo leer los participantes de Meet (¿cambió el DOM?)' }).catch(() => {});
  }
  log(`fin de la grabación: ${motivo}`);
  if (inicio == null) return { motivo, linea: [], fallidos: [] }; // nunca grabó: nada que subir

  if (motivo === 'sin_consentimiento') {
    // Sin consentimiento no se sube nada más: se cortan las grabadoras y se descarta lo que hay en memoria.
    await p.evaluate(() => (window as unknown as { __voGrab: GrabPagina }).__voGrab.apagar()).catch(() => {});
    segs.descartar();
    return { motivo, linea: [], fallidos: [] };
  }

  const tFin = Date.now() - inicio;
  await Promise.all([...cortes]); // primero los cortes en curso (si no, detener() pisa su aviso de fin)
  const abiertas = await p.evaluate(() => (window as unknown as { __voGrab: GrabPagina }).__voGrab.activas()).catch(() => [seq]);
  await Promise.all(abiertas.map((s) => detener(s)));
  const t0 = inicioSeg.get(cfg.seqInicial) ?? inicio;
  segs.cerrarHuerfanos((s) => {
    const desde = inicioSeg.get(s) ?? t0;
    return { offsetMs: desde - t0 + desfase, duracionMs: Date.now() - desde };
  });
  const fallidos = await segs.vaciar();
  if (segs.sinConsentimiento) return { motivo: 'sin_consentimiento', linea: [], fallidos: [] };
  return { motivo, linea: lineaConDesfase(linea.cerrar(tFin), desfase), fallidos };
}

async function main(): Promise<number> {
  let cfg: ConfigBot;
  try { cfg = leerConfig(); } catch (e) { log(`configuración inválida: ${e instanceof Error ? e.message : e}`); return 2; }

  // Tope duro: pase lo que pase, el proceso termina (la máquina se destruye al salir). Se reprograma
  // si el sitio informa otra HORA_FIN (Vale movió el evento, r2 punto 7).
  let guardia: ReturnType<typeof setTimeout> | null = null;
  const programarGuardia = () => {
    if (guardia) clearTimeout(guardia);
    const topeDuro = cfg.horaFin.getTime() + cfg.maxExtraMs + MARGEN_TOPE_DURO_MS - Date.now();
    guardia = setTimeout(() => { log('tope duro de duración alcanzado: salida forzada'); process.exit(3); }, Math.max(topeDuro, 60_000));
    guardia.unref();
  };
  programarGuardia();
  let alCambiarLimite: ((limiteMs: number) => void) | null = null;
  const sitio = new Sitio({
    eventoUrl: cfg.eventoUrl, token: cfg.token, log,
    alResponder: (r) => {
      const nueva = horaFinDeRespuesta(r, cfg.horaFin);
      if (!nueva) return;
      log('el sitio informó otra hora de término de la sesión');
      cfg.horaFin = nueva;
      programarGuardia();
      alCambiarLimite?.(nueva.getTime() + cfg.maxExtraMs);
    },
  });

  let navegador: Navegador | null = null;
  let finEnviado = false;
  let devolverSesion: (() => Promise<void>) | null = null;
  const enviarFin = async (motivo: MotivoFin, linea: LineaHablante[] = []) => {
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
        // 'vencido' = nadie lo admitió a tiempo (no es un rechazo): se informa como nadie_llego para que el
        // siguiente clic de Vale lo vuelva a mandar. 'rechazado' (Vale dijo que no) sí es no_admitido.
        await enviarFin(adm.tipo === 'vencido' ? 'nadie_llego' : 'no_admitido');
      }
      await salirDeMeet(p, log);
      return 0;
    }

    // r2: `activo` se manda al EMPEZAR A GRABAR (cuando hay alguien), dentro de grabar().
    log('admitido: espera a que haya alguien para grabar');
    const r = await grabar(p, cfg, sitio, {
      admitidoPorPersona: !sesion,
      registrarCambioHora: (f) => { alCambiarLimite = f; },
    });
    if (r.motivo === 'sin_consentimiento') log('el sitio no autoriza grabar (consentimiento): sale de la reunión');
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
