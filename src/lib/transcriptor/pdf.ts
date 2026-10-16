// Generador de PDF mínimo, sin dependencias (exportación legal de la ficha, 02-decisiones-16oct-noche B).
//
// Por qué así (y no Chromium/HTML→PDF ni una librería nueva):
//   • En Vercel una función tiene 250 MB sin comprimir y 2 GB de memoria (Hobby); un Chromium sin
//     cabeza (@sparticuz/chromium) pesa ~60 MB comprimido, arranca lento y suma una dependencia
//     binaria crítica para un documento legal. Una librería JS (pdf-lib/pdfkit) agrega dependencias.
//   • Un PDF de texto es simple: fuentes estándar Helvetica/Helvetica-Bold (las 14 base de PDF 1.4, no
//     hay que incrustar nada) con WinAnsiEncoding, que cubre el español (á é í ó ú ñ ü ¿ ¡ « » — …).
//   • Todo ocurre en memoria (Uint8Array): no se escribe nada en disco ni queda copia en el servidor.
//   • Los flujos de página van comprimidos (FlateDecode, zlib de Node) para no pasar del límite de
//     4,5 MB de respuesta de Vercel.
// Caracteres fuera de WinAnsi se transliteran (sin tilde) o se reemplazan por "?".
import { deflateSync } from 'node:zlib';

export type TipoBloque = 'titulo' | 'h2' | 'h3' | 'parrafo' | 'meta' | 'mono' | 'separador' | 'salto';
export interface BloquePdf { tipo: TipoBloque; texto?: string; sangria?: number }

const A4 = { ancho: 595.28, alto: 841.89 };
const MARGEN = { izq: 56, der: 56, sup: 60, inf: 64 };

const ESTILO: Record<Exclude<TipoBloque, 'separador' | 'salto'>, { fuente: 'F1' | 'F2'; tam: number; antes: number; gris: number }> = {
  titulo:  { fuente: 'F2', tam: 18, antes: 0,  gris: 0.1 },
  h2:      { fuente: 'F2', tam: 13, antes: 14, gris: 0.1 },
  h3:      { fuente: 'F2', tam: 10.5, antes: 9, gris: 0.15 },
  parrafo: { fuente: 'F1', tam: 9.5, antes: 3, gris: 0.12 },
  meta:    { fuente: 'F1', tam: 8, antes: 2, gris: 0.4 },
  mono:    { fuente: 'F1', tam: 8.5, antes: 1, gris: 0.15 },
};

// Anchos de Helvetica (AFM estándar, 1/1000 em) para ASCII 32–126.
const ANCHOS_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const ANCHOS_ESPECIALES: Record<string, number> = {
  '—': 1000, '…': 1000, '–': 556, '«': 556, '»': 556, '“': 333, '”': 333, '‘': 222, '’': 222,
  '•': 350, '·': 278, '¿': 611, '¡': 333, '°': 400, '€': 556, 'º': 365, 'ª': 370, ' ': 278,
};
// WinAnsi (CP1252) fuera de Latin-1.
const WINANSI_EXTRA: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
};
const TRANSLITERAR: Record<string, string> = { '✦': '*', '✓': 'v', '✕': 'x', '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '\t': '    ' };

/** Texto → caracteres representables en WinAnsi. */
export function normalizarTexto(t: string): string {
  let out = '';
  for (const ch of (t ?? '').replace(/\r\n?/g, '\n')) {
    const cp = ch.codePointAt(0)!;
    if (TRANSLITERAR[ch] !== undefined) { out += TRANSLITERAR[ch]; continue; }
    if ((cp >= 32 && cp <= 126) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRA[ch] !== undefined || ch === '\n') { out += ch; continue; }
    if (cp < 32) continue;
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += base && [...base].every((c) => c.codePointAt(0)! < 127) ? base : '?';
  }
  return out;
}

function anchoCaracter(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp >= 32 && cp <= 126) return ANCHOS_ASCII[cp - 32];
  if (ANCHOS_ESPECIALES[ch] !== undefined) return ANCHOS_ESPECIALES[ch];
  const base = ch.normalize('NFD')[0];
  const b = base?.codePointAt(0) ?? 0;
  return b >= 32 && b <= 126 ? ANCHOS_ASCII[b - 32] : 556;
}

/** Ancho del texto en puntos (negrita ~6 % más ancha: margen de seguridad). */
export function anchoTexto(t: string, tam: number, negrita = false): number {
  let w = 0;
  for (const ch of t) w += anchoCaracter(ch);
  return (w / 1000) * tam * (negrita ? 1.06 : 1);
}

/** Corta un párrafo en renglones que caben en `ancho` (palabras largas se parten). */
export function cortarLineas(texto: string, ancho: number, tam: number, negrita = false): string[] {
  const lineas: string[] = [];
  for (const parrafo of normalizarTexto(texto).split('\n')) {
    const palabras = parrafo.split(/ +/);
    let actual = '';
    const empujar = () => { lineas.push(actual); actual = ''; };
    for (let p of palabras) {
      while (anchoTexto(p, tam, negrita) > ancho) {
        // Palabra más ancha que la línea (p. ej. un hash): se parte.
        if (actual) empujar();
        let i = 1;
        while (i < p.length && anchoTexto(p.slice(0, i + 1), tam, negrita) <= ancho) i++;
        lineas.push(p.slice(0, i));
        p = p.slice(i);
      }
      const prueba = actual ? `${actual} ${p}` : p;
      if (anchoTexto(prueba, tam, negrita) <= ancho) actual = prueba;
      else { empujar(); actual = p; }
    }
    lineas.push(actual);
  }
  return lineas;
}

function cadenaPdf(t: string): string {
  let out = '(';
  for (const ch of t) {
    const cp = ch.codePointAt(0)!;
    const byte = WINANSI_EXTRA[ch] ?? (cp <= 0xff ? cp : 0x3f);
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

interface Pagina { ops: string[] }

export interface OpcionesPdf {
  titulo: string;
  autor?: string;
  /** Texto del pie de cada página (se le agrega "Página N de M"). */
  pie?: string;
  creado?: Date;
}

/** Arma el PDF completo. Devuelve los bytes (nada se escribe en disco). */
export function generarPdf(bloques: BloquePdf[], op: OpcionesPdf): Uint8Array {
  const anchoUtil = A4.ancho - MARGEN.izq - MARGEN.der;
  const paginas: Pagina[] = [{ ops: [] }];
  let y = A4.alto - MARGEN.sup;
  const nueva = () => { paginas.push({ ops: [] }); y = A4.alto - MARGEN.sup; };
  const pag = () => paginas[paginas.length - 1];

  for (const b of bloques) {
    if (b.tipo === 'salto') { if (pag().ops.length) nueva(); continue; }
    if (b.tipo === 'separador') {
      y -= 6;
      if (y < MARGEN.inf + 10) { nueva(); continue; }
      pag().ops.push(`0.8 G 0.5 w ${MARGEN.izq} ${y.toFixed(2)} m ${(A4.ancho - MARGEN.der).toFixed(2)} ${y.toFixed(2)} l S`);
      y -= 6;
      continue;
    }
    const e = ESTILO[b.tipo];
    const sangria = Math.max(0, Math.min(120, b.sangria ?? 0));
    const alto = e.tam * 1.38;
    const lineas = cortarLineas(b.texto ?? '', anchoUtil - sangria, e.tam, e.fuente === 'F2');
    y -= e.antes;
    // Un título no queda solo al final de la página.
    if ((b.tipo === 'h2' || b.tipo === 'h3' || b.tipo === 'titulo') && y - alto * 3 < MARGEN.inf) nueva();
    for (const l of lineas) {
      if (y - alto < MARGEN.inf) nueva();
      y -= alto;
      if (l) pag().ops.push(`BT /${e.fuente} ${e.tam} Tf ${e.gris} g ${(MARGEN.izq + sangria).toFixed(2)} ${(y + e.tam * 0.3).toFixed(2)} Td ${cadenaPdf(l)} Tj ET`);
    }
  }
  if (!pag().ops.length && paginas.length > 1) paginas.pop();

  // Pies de página (con el total ya conocido).
  const total = paginas.length;
  paginas.forEach((p, i) => {
    const pie = normalizarTexto(`${op.pie ? `${op.pie} · ` : ''}Página ${i + 1} de ${total}`);
    p.ops.push(`BT /F1 7.5 Tf 0.45 g ${MARGEN.izq} ${(MARGEN.inf - 30).toFixed(2)} Td ${cadenaPdf(pie)} Tj ET`);
  });

  // ── Serialización ─────────────────────────────────────────────────────────
  const partes: Buffer[] = [];
  const offsets: number[] = [];
  let largo = 0;
  const escribir = (b: Buffer | string) => { const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; partes.push(buf); largo += buf.length; };
  const objeto = (n: number, cuerpo: Buffer | string) => { offsets[n] = largo; escribir(`${n} 0 obj\n`); escribir(cuerpo); escribir('\nendobj\n'); };

  escribir('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const nPag = (i: number) => 6 + i * 2;
  const kids = paginas.map((_, i) => `${nPag(i)} 0 R`).join(' ');
  objeto(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objeto(2, `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`);
  objeto(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objeto(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const f = op.creado ?? new Date();
  // (Sin la clase de regex "guion-dos puntos-T": Tailwind la confunde con una utilidad y rompe el CSS.)
  const fechaPdf = `D:${f.toISOString().split('-').join('').split(':').join('').replace('T', '').slice(0, 14)}Z`;
  objeto(5, `<< /Title ${cadenaPdf(normalizarTexto(op.titulo))} /Author ${cadenaPdf(normalizarTexto(op.autor ?? ''))} /Producer (valentinaorellana.cl) /CreationDate (${fechaPdf}) >>`);
  paginas.forEach((p, i) => {
    const datos = deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
    objeto(nPag(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.ancho} ${A4.alto}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${nPag(i) + 1} 0 R >>`);
    offsets[nPag(i) + 1] = largo;
    escribir(`${nPag(i) + 1} 0 obj\n<< /Length ${datos.length} /Filter /FlateDecode >>\nstream\n`);
    escribir(datos);
    escribir('\nendstream\nendobj\n');
  });
  const nObjetos = 6 + total * 2;
  const xref = largo;
  escribir(`xref\n0 ${nObjetos}\n0000000000 65535 f \n`);
  for (let n = 1; n < nObjetos; n++) escribir(`${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`);
  escribir(`trailer\n<< /Size ${nObjetos} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(partes));
}
