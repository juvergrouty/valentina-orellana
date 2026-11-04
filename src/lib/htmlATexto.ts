// Versión de texto plano de un correo HTML (4 nov 2026): los correos que van solo
// en HTML son una señal de spam para Gmail (los de Pedro cayeron ahí). Cada envío
// por Resend lleva ahora también esta versión, armada desde el mismo HTML.

const ENTIDADES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·', mdash: '—', ndash: '–',
  hellip: '…', laquo: '«', raquo: '»', iquest: '¿', iexcl: '¡', bull: '•', copy: '©', deg: '°',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
};

function decodificar(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTIDADES[e] ?? m;
  });
}

const limpio = (s: string) => decodificar(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function htmlATexto(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '');
  // Enlaces: "texto (url)"; si el texto ya es la url, solo la url. Los mailto/tel quedan como su texto.
  s = s.replace(/<a\b[^>]*?href\s*=\s*(["'])([^"'>]*)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href: string, inner: string) => {
    const url = decodificar(href.trim());
    const texto = limpio(inner);
    if (!/^https?:/i.test(url)) return texto;
    if (!texto || texto === url || texto.replace(/^https?:\/\//, '') === url.replace(/^https?:\/\//, '')) return ` ${url} `;
    return `${texto} (${url})`;
  });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|tr|table|h[1-6]|ul|ol|blockquote|section)>/gi, '\n')
    .replace(/<(p|h[1-6]|table|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  s = decodificar(s);
  return s
    .split('\n')
    .map(l => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
