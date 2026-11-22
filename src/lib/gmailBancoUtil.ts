// Comparar un correo del banco con una transferencia (22 nov 2026). Puro, sin red ni base de
// datos, para poder probarlo (gmailBancoUtil.test.ts). Ver gmailBanco.ts.

// Marcas en bookings.notes de una transferencia (además de las de comprobantes.ts):
export const MARCA_ESPERA_BANCO = 'BoletaEsperaBanco';       // BoletaEsperaBanco <iso>: la boleta espera el correo del banco
export const MARCA_BANCO_OK = 'BancoConfirmado';             // BancoConfirmado <iso> <id del correo|panel>
export const MARCA_BANCO_DUDOSO = 'BancoDudoso';             // BancoDudoso <iso> <id>: monto y fecha calzan, el nombre no
export const MARCA_BANCO_NO = 'BancoNoEncontrado';           // BancoNoEncontrado <iso>: pasó el plazo sin correo
export const MARCA_TITULAR = 'TransferenciaTitular';         // TransferenciaTitular <nombre de la cuenta de origen>

/** Plazo para encontrar el correo del banco desde que se subió el comprobante. */
export const PLAZO_BANCO_MS = 48 * 3600_000;

const sinTildes = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** ¿El texto trae el monto exacto? Acepta "$65.000", "65.000", "$ 65000", "65,000" y "65.000,00". */
export function traeMonto(texto: string, monto: number): boolean {
  if (!(monto > 0)) return false;
  const digitos = String(Math.round(monto));
  // Miles con punto, coma, espacio o nada: 65000 → 65[.,\s]?000
  const grupos: string[] = [];
  for (let i = digitos.length; i > 0; i -= 3) grupos.unshift(digitos.slice(Math.max(0, i - 3), i));
  const patron = grupos.join('[.,\\s]?');
  const re = new RegExp(`(?<![\\d.,])${patron}(?![\\d]|[.,]\\d{3})`);
  return re.test(texto.replace(/ /g, ' '));
}

/** Palabras útiles de un nombre (sin tildes, de 3 letras o más, sin "del", "las"...). */
export function palabrasNombre(nombre: string): string[] {
  const vacias = new Set(['del', 'las', 'los', 'van', 'von', 'san']);
  return sinTildes(nombre).replace(/[^a-zñ ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !vacias.has(w));
}

/** ¿El texto trae el nombre? Con dos o más palabras, al menos dos deben aparecer (nombre y apellido). */
export function traeNombre(texto: string, nombres: string[]): boolean {
  const t = ` ${sinTildes(texto).replace(/[^a-zñ ]/g, ' ').replace(/\s+/g, ' ')} `;
  return nombres.some((n) => {
    const p = palabrasNombre(n);
    if (!p.length) return false;
    const hay = p.filter((w) => t.includes(` ${w} `)).length;
    return p.length === 1 ? hay === 1 : hay >= 2;
  });
}

/** ¿Parece un aviso de transferencia recibida (y no publicidad o un estado de cuenta)? */
export function pareceAvisoTransferencia(texto: string): boolean {
  return /transferencia|transferido|abono|te transfiri|recibiste|has recibido|deposito/.test(sinTildes(texto));
}

export type Coincidencia = 'ok' | 'dudoso' | 'no';

/** Resultado de comparar UN correo: ok = monto + nombre; dudoso = monto sin nombre; no = no calza. */
export function compararCorreo(texto: string, monto: number, nombres: string[]): Coincidencia {
  if (!traeMonto(texto, monto) || !pareceAvisoTransferencia(texto)) return 'no';
  return traeNombre(texto, nombres) ? 'ok' : 'dudoso';
}

/** Búsqueda de Gmail: correos con el monto entre 2 días antes y 3 días después del comprobante. */
export function consultaGmail(monto: number, subidoMs: number, remitente?: string | null): string {
  const d = String(Math.round(monto));
  const conPunto = d.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const despues = Math.floor((subidoMs - 2 * 86400_000) / 1000);
  const antes = Math.floor((subidoMs + 3 * 86400_000) / 1000);
  const de = (remitente ?? '').trim().replace(/[^\w.@+-]/g, '');
  return `("${conPunto}" OR "${d}") after:${despues} before:${antes}${de ? ` from:${de}` : ''}`;
}

/** Texto de un mensaje de Gmail (format=full): partes text/plain, o text/html sin etiquetas. */
export function textoDeMensaje(msg: { snippet?: string; payload?: ParteGmail }): string {
  const planos: string[] = [];
  const html: string[] = [];
  const recorrer = (p?: ParteGmail) => {
    if (!p) return;
    const datos = p.body?.data ? Buffer.from(p.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '';
    if (datos && p.mimeType === 'text/plain') planos.push(datos);
    else if (datos && p.mimeType === 'text/html') html.push(datos);
    for (const h of p.parts ?? []) recorrer(h);
  };
  recorrer(msg.payload);
  const asunto = (msg.payload?.headers ?? []).find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
  const cuerpo = planos.length ? planos.join('\n') : html.join('\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$');
  return `${asunto}\n${msg.snippet ?? ''}\n${cuerpo}`.replace(/[ \t]+/g, ' ');
}
export type ParteGmail = { mimeType?: string; body?: { data?: string }; parts?: ParteGmail[]; headers?: { name: string; value: string }[] };
