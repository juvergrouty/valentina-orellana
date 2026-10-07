import { promises as dns } from 'node:dns';
import { domainToASCII } from 'node:url';

// ¿El dominio del correo (lo que va después de la @) recibe correos?
// No confirma que la casilla exista (nadie puede, salvo enviando un correo),
// pero sí detecta dominios que no existen o no reciben correos (ej.
// "@gmail.con"). Los errores de tipeo que sí existen (ej. "@gmial.com") los
// atrapa la sugerencia "¿Quisiste decir…?" del formulario.
// Ante cualquier duda (DNS lento o caído) responde que sí: nunca debe
// impedir una reserva por un problema de red.
const cache = new Map<string, { ok: boolean; t: number }>();
const UNA_HORA = 60 * 60 * 1000;

const conTiempo = <T>(p: Promise<T>, ms = 2500) =>
  Promise.race([p, new Promise<'tiempo'>((r) => setTimeout(() => r('tiempo'), ms))]);

const codigo = (e: unknown) => (e as { code?: string })?.code ?? '';

async function consultar(dominio: string): Promise<boolean> {
  try {
    const mx = await conTiempo(dns.resolveMx(dominio));
    if (mx === 'tiempo') return true;
    // "Null MX" (RFC 7505): el dominio declara que no recibe correos.
    if (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')) return false;
    if (mx.length > 0) return true;
  } catch (e) {
    if (codigo(e) === 'ENOTFOUND') return false; // el dominio no existe
    if (codigo(e) !== 'ENODATA') return true;    // otro problema de DNS: no bloquear
  }
  // Sin registros MX: por norma se entrega a la dirección del dominio (A/AAAA).
  for (const f of [dns.resolve4, dns.resolve6]) {
    try {
      const r = await conTiempo(f.call(dns, dominio));
      if (r === 'tiempo' || r.length > 0) return true;
    } catch (e) {
      if (!['ENOTFOUND', 'ENODATA'].includes(codigo(e))) return true;
    }
  }
  return false;
}

export async function dominioRecibeCorreo(correo: string): Promise<boolean> {
  // Dominios con ñ, tildes, etc. se consultan en su forma ASCII (xn--…).
  const dominio = domainToASCII((correo.split('@').pop() ?? '').trim().toLowerCase().replace(/\.$/, ''));
  if (!dominio) return true; // no se pudo interpretar: ante la duda, no bloquear
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]{2,}$/.test(dominio)) return false;
  if (cache.size > 1000) cache.clear();
  const c = cache.get(dominio);
  if (c && Date.now() - c.t < UNA_HORA) return c.ok;
  const ok = await consultar(dominio);
  cache.set(dominio, { ok, t: Date.now() });
  return ok;
}
