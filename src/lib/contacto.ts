// Teléfono y correo: validación y sugerencias compartidas entre el servidor
// y los formularios (panel y agenda pública).

/**
 * Teléfono en formato internacional "+<código><número>" o null si no es válido.
 * - Sin "+" (o sin "00") se asume Chile: 9 dígitos (celular 9XXXXXXXX o fijo 2XXXXXXXX).
 * - "56" + 9 dígitos también se acepta (dato antiguo sin "+").
 * - Con "+" o "00": Chile exige 9 dígitos después del 56; otros países, 8 a 15 dígitos en total.
 */
export function normalizarTelefono(crudo: string | null | undefined): string | null {
  const s = (crudo ?? '').trim();
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  const internacional = s.startsWith('+') || d.startsWith('00');
  if (d.startsWith('00')) d = d.slice(2);
  if (internacional) {
    if (d.startsWith('56')) return d.length === 11 ? `+${d}` : null;
    return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  }
  if (d.length === 9) return `+56${d}`;
  if (d.length === 11 && d.startsWith('56')) return `+${d}`;
  return null;
}

/** "+56912345678" → "+56 9 1234 5678" (solo Chile; el resto queda igual). */
export function telefonoLegible(t: string): string {
  const m = /^\+56(\d)(\d{4})(\d{4})$/.exec(t);
  return m ? `+56 ${m[1]} ${m[2]} ${m[3]}` : t;
}

export const DOMINIOS_CORREO = [
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com',
  'live.cl', 'hotmail.cl', 'outlook.es', 'yahoo.es', 'live.com',
];

// Dominios reales que se parecen a los de arriba: nunca se "corrigen".
const DOMINIOS_VALIDOS_PARECIDOS = new Set([
  'hotmail.es', 'outlook.cl', 'mail.com', 'me.com', 'msn.com', 'gmx.com', 'aol.com',
  'live.com.ar', 'live.com.mx', 'hotmail.com.ar', 'yahoo.com.ar', 'yahoo.com.mx', 'yahoo.cl',
  'hotmail.co.uk', 'yahoo.co.uk', 'live.co.uk', 'icloud.cl',
]);

/** Mientras se escribe "nombre@gm" → ["nombre@gmail.com"]. Vacío si no aplica. */
export function sugerenciasCorreo(valor: string, max = 4): string[] {
  const v = valor.trim().toLowerCase();
  const at = v.indexOf('@');
  if (at < 1 || v.indexOf('@', at + 1) !== -1) return [];
  const local = v.slice(0, at);
  const dom = v.slice(at + 1);
  if (DOMINIOS_CORREO.includes(dom)) return [];
  return DOMINIOS_CORREO.filter(d => d.startsWith(dom)).slice(0, max).map(d => `${local}@${d}`);
}

function distancia(a: string, b: string): number {
  const f = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = f[0]; f[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = f[j];
      f[j] = Math.min(f[j] + 1, f[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return f[b.length];
}

/** "nombre@gmial.com" → "nombre@gmail.com"; null si el dominio parece correcto. */
export function correccionCorreo(valor: string): string | null {
  const v = valor.trim().toLowerCase();
  const m = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(v);
  if (!m) return null;
  const [, local, dom] = m;
  if (DOMINIOS_CORREO.includes(dom) || DOMINIOS_VALIDOS_PARECIDOS.has(dom)) return null;
  let mejor: string | null = null, dMin = 3;
  for (const d of DOMINIOS_CORREO) {
    const dist = distancia(dom, d);
    if (dist < dMin) { dMin = dist; mejor = d; }
  }
  // Un error de 1 letra, o de 2 en dominios largos (gmail.cl, hotmial.co…).
  if (!mejor || (dMin === 2 && dom.length < 8)) return null;
  return `${local}@${mejor}`;
}
