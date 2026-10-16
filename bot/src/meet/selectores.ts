// Derivado de Vexa (Apache-2.0): core/meetings/modules/join/src/googlemeet/selectors.ts
// (commit f1a62fb). Cambios: ver bot/NOTICE. Solo constantes, sin lógica.
//
// Semántica Playwright: `text="foo"` = coincidencia EXACTA; `text=foo` = subcadena sin
// distinguir mayúsculas. `:has-text()` solo existe del lado de Playwright (page.locator),
// NO dentro de page.evaluate (ahí solo CSS simple).
//
// El idioma de la interfaz se fija en en-US (argumentos.ts + ?hl=en), por eso los textos
// en inglés son correctos "por construcción". Si Google cambia el DOM de Meet, este es el
// único archivo que hay que ajustar (riesgo documentado en bot/README.md).

/** Indicadores de que el bot YA está dentro (no aparecen en la sala de espera). */
export const indicadoresAdmision: string[] = [
  '[data-participant-id]',
  '[data-self-name]',
  'button[aria-label*="Share screen"]',
  'button[aria-label*="Present now"]',
];

/** Sala de espera ("Pidiendo unirse…"). */
export const indicadoresSalaEspera: string[] = [
  'text="Asking to be let in..."',
  'text=Asking to be let in',
  'text="You\'ll join the call when someone lets you in"',
  'text=You\'ll join the call when someone lets you',
  'text=You’ll join the call when someone lets you', // apóstrofo tipográfico de Meet
  'text="Please wait until a meeting host brings you into the call"',
  'text="Waiting for the host to let you in"',
  'text="You\'re in the waiting room"',
  '[aria-label*="waiting room"]',
  '[aria-label*="Asking to be let in"]',
  '[aria-label*="waiting for admission"]',
  // Vexa#471: "Return to home screen" aparece en la ESPERA, no es rechazo.
  'button:has-text("Return to home screen")',
];

/** Rechazo explícito del anfitrión (gana sobre todo lo demás). */
export const textosRechazoExplicito: string[] = [
  'denied your request',
  'request to join was denied',
  'you were denied',
  'weren\'t allowed to join',
  'weren’t allowed to join',
  'not allowed to join',
  'not admitted',
  'ask to join again',
];

export const indicadoresRechazo: string[] = [
  'text=denied your request',
  'text=Your request to join was denied',
  'text=You were denied',
  'text=weren\'t allowed to join',
  'text=weren’t allowed to join',
  'text=not allowed to join',
  'text=not admitted',
  'text=Ask to join again',
  'button:has-text("Ask to join again")',
  // Página de error / bloqueo (no es la respuesta del anfitrión).
  'text=can\'t join this call',
  'text=can’t join this call',
  'text=cannot join this call',
  'text="You can\'t join this video call"',
  'text="Meeting not found"',
  'text="Can\'t join the meeting"',
  'text="Unable to join"',
  'text="Meeting has ended"',
  'text="This meeting has ended"',
  'text="Invalid meeting"',
  'text="Meeting link expired"',
  '[role="dialog"]:has-text("Meeting not found")',
  '[role="alertdialog"]:has-text("Meeting not found")',
  'button:has-text("Try again")',
  'button:has-text("Go back")',
];

/** Desafío reCAPTCHA (Google sospecha de automatización). El bot NO lo resuelve. */
export const selectorRecaptcha = 'iframe[src*="recaptcha"]';

/** Expulsión o fin de la llamada estando dentro. (Sin [role="alert"]: falsos positivos.) */
export const indicadoresExpulsion: string[] = [
  'text="You\'ve been removed from the meeting"',
  'text=been removed from the meeting',
  'text=removed you from the meeting',
  'text="Meeting ended"',
  'text="Call ended"',
  'text="You left the meeting"',
  'text="The call ended"',
];

/** Botón "Ask to join" (invitado). Textos exactos primero; el estructural al final. */
export const botonesUnirse: string[] = [
  '//button[.//span[text()="Ask to join"]]',
  'button:has-text("Ask to join")',
  'button:has-text("Join now")',
  'button[jsname]:not([aria-label]):has(span)',
];

export const botonesCamara: string[] = [
  'button[aria-label*="Turn off camera"]',
  '[aria-label*="Turn off camera"]',
];

export const botonesMicrofono: string[] = [
  'button[aria-label*="Turn off microphone"]',
  '[aria-label*="Turn off microphone"]',
];

/** Campo "Your name" del invitado: estructural primero, inglés de respaldo. */
export const camposNombre: string[] = [
  'input[jsname][type="text"]',
  'input[type="text"]:not([aria-hidden="true"])',
  'div[jscontroller] input[type="text"]',
  'input[type="text"][aria-label="Your name"]',
  'input[placeholder*="name"]',
];

/** Coincidencias para el clic de salida (CONTEXTO DE NAVEGADOR: solo CSS + texto). */
export type MatcherBoton = { css?: string; text?: string };
export const matchersSalir: MatcherBoton[] = [
  { css: 'button[aria-label="Leave call"]' },
  { css: 'button[aria-label*="Leave"]' },
  { css: '[role="toolbar"] button[aria-label*="Leave"]' },
  { css: 'button[aria-label*="Hang up"]' },
  { text: 'Leave meeting' },
  { text: 'Just leave the meeting' },
  { css: '[role="dialog"] button', text: 'Leave' },
];

/** Clases "hablando" conocidas del tile (ofuscadas: pueden rotar con Meet). */
export const clasesHablando: string[] = [
  'Oaajhc', 'HX2H7', 'wEsLMd', 'OgVli',
  'speaking', 'active-speaker', 'speaker-active', 'speaking-indicator',
];
