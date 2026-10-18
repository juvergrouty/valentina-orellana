// Derivado de Vexa (Apache-2.0): core/meetings/modules/gmeet-capture/src/gmeet-capture.ts y
// core/meetings/modules/recording/src/audio-pipeline.ts (MediaRecorderCapture), commit f1a62fb.
// Cambio principal: en vez de PCM por participante, se MEZCLAN todas las pistas de audio
// remotas de Meet (Vale y pacientes; el bot no habla) y se graba con MediaRecorder
// audio/webm;codecs=opus. Node controla cuándo abre/cierra cada segmento (15 min, 3 s de
// solapamiento) y recibe los trozos por funciones expuestas (exposeFunction):
//   window.__voTrozo(seq, base64)         trozo de MediaRecorder (cada `trozoMs`)
//   window.__voSegFin(seq, offsetMs, durMs) el segmento terminó (después del último trozo)
//
// ESTA FUNCIÓN CORRE DENTRO DE LA PÁGINA (page.evaluate la serializa): no puede usar nada
// del módulo, solo el DOM y su argumento.

export interface OpcionesGrabadorPagina { bitsPorSegundo: number; trozoMs: number }

export function instalarGrabadorEnPagina(o: OpcionesGrabadorPagina): boolean {
  type Ventana = Window & {
    __voGrab?: unknown;
    __voT0?: number | null;
    __voTrozo?: (seq: number, b64: string) => Promise<unknown>;
    __voSegFin?: (seq: number, offsetMs: number, durMs: number) => Promise<unknown>;
  };
  const w = window as Ventana;
  if (w.__voGrab) return true;
  const mime = 'audio/webm;codecs=opus';
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mime)) return false;

  const ctx = new AudioContext();
  void ctx.resume().catch(() => {});
  const destino = ctx.createMediaStreamDestination();
  // Mantiene el grafo "tirando" aunque nadie hable (sin esto Chrome puede dormir el contexto).
  const silencio = ctx.createConstantSource();
  const cero = ctx.createGain();
  cero.gain.value = 0;
  silencio.connect(cero).connect(destino);
  silencio.start();

  const pistas = new Set<string>();
  const enlazar = (pista: MediaStreamTrack) => {
    if (pistas.has(pista.id) || pista.readyState !== 'live') return;
    try {
      ctx.createMediaStreamSource(new MediaStream([pista])).connect(destino);
      pistas.add(pista.id);
      pista.addEventListener('ended', () => pistas.delete(pista.id));
    } catch { /* pista no utilizable */ }
  };
  const conectar = () => {
    // Pistas remotas de WebRTC (rtc-pagina.ts): la fuente principal y más estable.
    for (const pista of (window as unknown as { __voPistasRTC?: MediaStreamTrack[] }).__voPistasRTC ?? []) enlazar(pista);
    document.querySelectorAll('audio, video').forEach((n) => {
      const el = n as HTMLMediaElement;
      const s = el.srcObject;
      if (!(s instanceof MediaStream)) return;
      for (const pista of s.getAudioTracks()) {
        if (pistas.has(pista.id) || pista.readyState !== 'live') continue;
        try {
          // Una fuente por PISTA (Meet reemplaza pistas dentro del mismo stream).
          ctx.createMediaStreamSource(new MediaStream([pista])).connect(destino);
          pistas.add(pista.id);
          pista.addEventListener('ended', () => pistas.delete(pista.id));
        } catch { /* pista no utilizable */ }
      }
    });
  };
  conectar();
  const intervalo = setInterval(conectar, 1000);

  const aBase64 = (b: Blob) => new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

  const grabadoras = new Map<number, MediaRecorder>();
  w.__voT0 = null;

  w.__voGrab = {
    iniciar(seq: number): void {
      if (grabadoras.has(seq)) return;
      const ahora = performance.now();
      if (w.__voT0 == null) w.__voT0 = ahora;
      const offset = ahora - (w.__voT0 as number);
      const rec = new MediaRecorder(destino.stream, { mimeType: mime, audioBitsPerSecond: o.bitsPorSegundo });
      let cadena: Promise<unknown> = Promise.resolve();
      rec.ondataavailable = (e: BlobEvent) => {
        if (!e.data || e.data.size === 0) return;
        const datos = e.data;
        cadena = cadena.then(() => aBase64(datos)).then((b64) => w.__voTrozo?.(seq, b64)).catch(() => {});
      };
      rec.onstop = () => {
        const dur = performance.now() - ahora;
        cadena = cadena.then(() => w.__voSegFin?.(seq, offset, dur)).catch(() => {});
        grabadoras.delete(seq);
      };
      rec.start(o.trozoMs);
      grabadoras.set(seq, rec);
    },
    detener(seq: number): boolean {
      const rec = grabadoras.get(seq);
      if (!rec || rec.state === 'inactive') return false;
      rec.stop();
      return true;
    },
    activas(): number[] { return [...grabadoras.keys()]; },
    pistas(): number { return pistas.size; },
    apagar(): void {
      clearInterval(intervalo);
      for (const rec of grabadoras.values()) if (rec.state !== 'inactive') rec.stop();
    },
  };
  return true;
}
