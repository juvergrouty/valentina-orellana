// Corre DENTRO de la página de Meet, antes de que cargue (context.addInitScript).
// Meet no siempre cuelga el audio remoto de <audio>/<video> con srcObject: la forma robusta es
// escuchar las pistas que llegan por WebRTC. Guarda cada pista de AUDIO remota en
// window.__voPistasRTC para que el grabador (audio-pagina.ts) las mezcle. No graba nada por sí solo.
export function capturarPistasRTC(): void {
  type V = Window & { __voPistasRTC?: MediaStreamTrack[]; __voRtcHook?: boolean; RTCPeerConnection: typeof RTCPeerConnection };
  const w = window as unknown as V;
  if (w.__voRtcHook || typeof w.RTCPeerConnection !== 'function') return;
  w.__voRtcHook = true;
  w.__voPistasRTC = [];
  const Original = w.RTCPeerConnection;
  const guardar = (t: MediaStreamTrack | null | undefined) => {
    if (t && t.kind === 'audio' && !w.__voPistasRTC!.includes(t)) w.__voPistasRTC!.push(t);
  };
  function Envuelto(this: RTCPeerConnection, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Original(...args);
    pc.addEventListener('track', (e: Event) => guardar((e as RTCTrackEvent).track));
    return pc;
  }
  Envuelto.prototype = Original.prototype;
  Object.setPrototypeOf(Envuelto, Original);
  w.RTCPeerConnection = Envuelto as unknown as typeof RTCPeerConnection;
}
