// Firma de Gmail de Vale para TODOS los correos que el sitio manda a pacientes (pedido de Vale,
// 19 oct 2026: "todos los correos deben terminar con mi firma, con los enlaces clickeables").
// Módulo sin dependencias (ni base de datos ni variables de entorno): lo usan email.ts y
// correoAnulacion.ts, y lo revisan las pruebas (firmaCorreos.test.ts).
// Los avisos internos a Vale (nueva reserva, reagendó, contacto, comprobante, etc.) NO la llevan.

const SITIO = 'https://www.valentinaorellana.cl';
export const URL_WHATSAPP_FIRMA = 'https://wa.me/56972735696';
export const URL_AGENDA_FIRMA = `${SITIO}/agenda`;

// Firma idéntica a la de Gmail de Vale (copiada del HTML de un correo enviado desde consulta@, 9 oct 2026).
export const FIRMA_GMAIL = `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;color:#2e332a;margin-top:0.5rem;"><tbody><tr><td style="padding:0 10px 0 0;vertical-align:middle;width:84px"><img src="${SITIO}/firma/sello.png" width="84" height="84" alt="Valentina Orellana" style="display:block;border:0;width:84px;height:84px"></td><td style="padding:0 0 0 10px;border-left:2px solid #f5a623;vertical-align:middle;font-family:Arial,Helvetica,sans-serif;"><div style="font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:bold;color:#576352;line-height:1.3">Valentina Orellana</div><div style="font-size:11px;color:rgb(139,138,128);line-height:1.5">Psicóloga · Adultos y parejas</div><div style="font-size:12px;line-height:1.6"><a href="${URL_WHATSAPP_FIRMA}" style="color:rgb(87,99,82);font-weight:bold">WhatsApp</a> <span style="color:#f5a623">·</span> <a href="${SITIO}" style="color:rgb(87,99,82);font-weight:bold">valentinaorellana.cl</a></div><div style="font-size:11px;color:rgb(139,138,128);line-height:1.5">Presencial en Las Condes · Online</div><div style="font-size:12px;line-height:1.6"><a href="${URL_AGENDA_FIRMA}" style="color:rgb(87,99,82);font-weight:bold">Agenda tu hora</a></div></td></tr></tbody></table>`;

/** Versión texto plano de la firma (para el `text` de los correos que lo tienen). */
export const FIRMA_TEXTO = `--\nValentina Orellana\nPsicóloga · Adultos y parejas\nWhatsApp ${URL_WHATSAPP_FIRMA} · valentinaorellana.cl\nPresencial en Las Condes · Online\nAgenda tu hora ${URL_AGENDA_FIRMA}`;

/** Cierre en texto plano: "Un saludo," + firma. */
export const CIERRE_TEXTO = `Un saludo,\n\n${FIRMA_TEXTO}`;

/** Dato profesional en letra chica, debajo de la firma (solo en los correos que ya lo tenían). */
export const REGISTRO_SUPERINTENDENCIA_HTML = `<p style="font-family:'Inter',Arial,sans-serif;font-size:11px;color:#9B9485;line-height:1.5;margin:1.25rem 0 0;">Reg. Superintendencia de Salud N° 360070</p>`;

/** Cierre HTML de los correos a pacientes: "Un saludo," + firma de Gmail (+ registro en letra chica). */
export function cierreFirmaHtml(opts: { registro?: boolean } = {}): string {
  return `<p style="font-family:'Inter',Arial,sans-serif;font-size:0.9rem;color:#1A1A18;line-height:1.6;margin:2rem 0 1rem;">Un saludo,</p>
        ${FIRMA_GMAIL}${opts.registro ? `
        ${REGISTRO_SUPERINTENDENCIA_HTML}` : ''}`;
}
