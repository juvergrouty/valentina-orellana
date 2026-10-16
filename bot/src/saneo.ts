// Saneo de mensajes de error (revisión de seguridad 16 oct, B8). El mensaje crudo de una excepción
// de Playwright puede incluir el enlace de Meet (p. ej. "page.goto: … at https://meet.google.com/…").
// Antes de mandarlo al sitio o escribirlo en el log de Fly se quitan URLs, códigos de Meet
// (abc-defg-hij) y caracteres de control. Misma regla que sanearErrorBot del sitio
// (src/lib/transcriptor/bot.ts), que vuelve a sanear al recibir.

export function sanearError(m: unknown, max = 300): string {
  const t = String(m ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:https?|wss?):\/\/\S+/gi, '[url]')
    .replace(/\bmeet\.google\.com\/\S*/gi, '[url]')
    .replace(/\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/gi, '[código]')
    .replace(/\s+/g, ' ').trim();
  return t.slice(0, max);
}
