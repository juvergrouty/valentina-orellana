// Textos del indicador de consentimiento (pedido de Vale, 19 oct 2026). Sin dependencias: lo importan el
// servidor (estadoConsentimiento.ts, IndicadorConsentimiento.astro, agenda) y el navegador (Grabador.astro).
// El estado se calcula SOLO en el servidor (estadoConsentimiento.ts).

export type EstadoConsentimiento = 'firmado' | 'sin_firma' | 'falta_pareja' | 'sin_grabacion';

export const ETIQUETA_CONSENTIMIENTO: Record<Exclude<EstadoConsentimiento, 'firmado'>, string> = {
  sin_firma: 'Sin consentimiento firmado',
  falta_pareja: 'Falta el consentimiento de la pareja',
  sin_grabacion: 'Consentimiento sin autorización de grabación',
};

/** Texto del indicador (null = firmado o desconocido: no se muestra nada). */
export function etiquetaConsentimiento(e: string | null | undefined): string | null {
  return e && e !== 'firmado' && e in ETIQUETA_CONSENTIMIENTO ? ETIQUETA_CONSENTIMIENTO[e as keyof typeof ETIQUETA_CONSENTIMIENTO] : null;
}

/** "sin_grabacion" es un aviso (ámbar); "sin_firma" y "falta_pareja" son graves (naranjo). */
export function claseConsentimiento(e: string | null | undefined): string {
  return e === 'sin_grabacion' ? 'ic ic-aviso' : 'ic ic-grave';
}

/** Enlace "Enviar consentimiento" (bloque Consentimientos de la ficha, donde ya está el envío). */
export function hrefEnviarConsentimiento(patientId: string): string {
  return `/admin/pacientes/${encodeURIComponent(patientId)}#consentimiento`;
}

/** Texto del enlace: si ya firmó (sin autorizar grabación) se va a ver su consentimiento. */
export function textoEnlaceConsentimiento(e: string | null | undefined): string {
  return e === 'sin_grabacion' ? 'Ver consentimiento' : 'Enviar consentimiento';
}
