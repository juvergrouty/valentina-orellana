// Armado del correo masivo a pacientes (Comunicaciones → "Enviar correo").
// Módulo sin dependencias de servidor (ni base de datos, ni Resend, ni variables de entorno) para que
// lo usen LOS TRES caminos con el mismo HTML exacto (pedido de Vale, 19 oct 2026: "quiero ver cómo va a
// quedar antes de mandarlo"):
//   • el envío real (sendBulkEmail en email.ts),
//   • el correo "Enviarme una prueba" (sendBulkTestEmail en email.ts),
//   • la vista previa del panel (script de src/pages/admin/comunicaciones.astro, en el navegador).
// Lo revisan las pruebas (src/lib/transcriptor/correoMasivo.test.ts).
import { cierreFirmaHtml, LOGO_HEADER_HTML } from './firmaCorreo';

function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Texto que escribe Vale → HTML del cuerpo: se escapa (un "<" no rompe el correo) y los saltos pasan a <br>. */
export function textoMasivoAHtml(texto: string): string {
  return String(texto ?? '').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}

/** HTML completo de UN correo masivo: logo, "Hola <nombre>,", el texto, "Un saludo," + firma (+ píxel de apertura). */
export function htmlCorreoMasivo(opts: { nombre: string; cuerpoHtml: string; pixelId?: string }): string {
  const pixel = opts.pixelId && /^[\w-]{1,64}$/.test(opts.pixelId)
    ? `<img src="https://www.valentinaorellana.cl/api/abierto/${opts.pixelId}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`
    : '';
  return `
      <div style="font-family:'Inter',sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        ${LOGO_HEADER_HTML}
        <p style="font-size:0.9rem;color:#6B6860;margin-bottom:1.5rem;">Hola ${escapeHtml(opts.nombre)},</p>
        <div style="font-size:0.92rem;line-height:1.7;color:#1A1A18;">${opts.cuerpoHtml}</div>
        ${cierreFirmaHtml({ registro: true })}
        ${pixel}
      </div>`;
}

/** Asunto del correo de prueba que va solo a Vale. */
export function asuntoPrueba(asunto: string): string {
  return `[Prueba] ${String(asunto ?? '').trim()}`;
}

export const AVISO_CIERRE_DUPLICADO = "Tu firma ya agrega 'Un saludo,' y tu nombre al final; puedes borrar el cierre de tu texto.";

const quitarTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// Despedidas típicas al final del texto: "Un saludo", "Saludos cordiales", "Un abrazo grande", "Cariños",
// "Muchos cariños", "Abrazos", y la firma a mano ("Valentina", "Ps. Valentina Orellana", "Vale").
// La línea entera tiene que ser la despedida (anclada al final): "Saludos a quienes se suman" no cuenta.
const NOMBRE = String.raw`(?:ps\s*|psicologa\s+)?(?:valentina|vale)(?:\s+o|\s+orellana(?:\s+\w)?)?`;
const DESPEDIDA_RE = new RegExp(String.raw`^(?:(?:les|te|os)\s+(?:mando|envio|dejo)\s+)?`
  + String.raw`(?:(?:un|una|muchos|muchas|mucho|mucha|mil|gran|grande|fuerte|afectuoso|afectuosos|cordial|cordiales|con|todo|todos|mi|mis)\s+)*`
  + String.raw`(?:saludos?|abrazos?|carinos?|besos?|atte|atentamente|cordialmente)`
  + String.raw`(?:\s+(?:grande|grandes|enorme|enormes|cordial|cordiales|fuerte|fuertes|afectuoso|afectuosos|apretado|para\s+todas?|para\s+todos|a\s+todas?|a\s+todos))*`
  + String.raw`(?:\s+${NOMBRE})?$`);
const FIRMA_A_MANO_RE = new RegExp(String.raw`^${NOMBRE}$`);

/**
 * ¿El texto ya termina con un saludo/despedida o con su nombre? (la firma automática ya los agrega).
 * Solo mira la última línea con texto, y solo si es corta (una despedida, no un párrafo).
 * NO borra nada: el panel solo muestra AVISO_CIERRE_DUPLICADO.
 */
export function terminaConCierre(texto: string): boolean {
  const lineas = String(texto ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ultima = lineas[lineas.length - 1];
  if (!ultima || ultima.length > 60) return false;
  const l = quitarTildes(ultima.toLowerCase())
    .replace(/[\p{Extended_Pictographic}\p{S}‍️]/gu, ' ') // emojis y símbolos ("Vale 💛")
    .replace(/[.,;:!¡?¿…\-–—"'()*]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!l) return false;
  return DESPEDIDA_RE.test(l) || FIRMA_A_MANO_RE.test(l);
}
