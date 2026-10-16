// Derivado de Vexa (Apache-2.0): core/meetings/modules/join/src/browser-args.ts (commit f1a62fb).
// Sin --ignore-certificate-errors ni --disable-web-security (Google los detecta y muestra
// "You can't join this meeting"). Idioma fijo en-US para que los selectores en inglés sirvan.

export const IDIOMA_UI = 'en-US';

// Sandbox (revisión de seguridad 16 oct, B6): por defecto Chromium corre CON su sandbox de
// espacios de nombres (sin --no-sandbox) como el usuario sin privilegios `pwuser` de la imagen de
// Playwright, y Playwright lo lanza con `chromiumSandbox: true`. El sandbox setuid no se usa
// (--disable-setuid-sandbox), basta el de espacios de nombres. Si el kernel de la máquina no lo
// permite, index.ts relanza sin sandbox y lo deja en el log (ver bot/README.md, "Sandbox").
// Las banderas de aislamiento de sitios (IsolateOrigins, site-per-process) vienen de Vexa y se
// mantienen: no se probó Meet sin ellas.
export function argumentosChromium(anchoPx = 1280, altoPx = 720, o: { sandbox?: boolean } = {}): string[] {
  return [
    ...(o.sandbox === false ? ['--no-sandbox'] : []),
    '--disable-setuid-sandbox',
    '--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor',
    '--disable-infobars',
    '--disable-gpu',
    '--in-process-gpu',
    // Acepta solo el diálogo de permisos (el bot entra con cámara y micrófono apagados).
    '--use-fake-ui-for-media-stream',
    // AudioContext arranca "running": sin esto la mezcla de audio remoto no corre.
    '--autoplay-policy=no-user-gesture-required',
    '--use-file-for-fake-video-capture=/dev/null',
    '--disable-blink-features=AutomationControlled',
    '--disable-site-isolation-trials',
    `--lang=${IDIOMA_UI}`,
    `--accept-lang=${IDIOMA_UI},en`,
    '--window-position=0,0',
    `--window-size=${anchoPx},${altoPx}`,
  ];
}

/** Agrega ?hl=en al enlace (si no lo trae) para fijar el idioma del lobby. */
export function conIdiomaFijo(meetUrl: string): string {
  try {
    const u = new URL(meetUrl);
    if (!u.searchParams.has('hl')) u.searchParams.set('hl', IDIOMA_UI.split('-')[0]);
    return u.toString();
  } catch {
    return meetUrl;
  }
}
