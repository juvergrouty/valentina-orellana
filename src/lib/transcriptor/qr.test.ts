// Prueba de qr.ts (86-revisión I2): el SVG que se muestra en la ficha DECODIFICA exactamente al link.
// Decodificador mínimo e independiente del generador (ISO/IEC 18004, nivel M, modo byte, versiones
// 1–9, sin errores que corregir): lee la matriz desde el propio SVG, la información de formato (nivel
// y máscara), recorre los módulos de datos en zigzag, quita la máscara, desentrelaza los bloques y lee
// el texto. Sin red. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modulosQr, qrSvg } from './qr';

/** SVG → matriz booleana (sin el margen de 4 módulos). */
function matrizDeSvg(svg: string): boolean[][] {
  const lado = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  assert.ok(lado > 8, 'viewBox cuadrado');
  const n = lado - 8;
  const m = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const d = /<path d="([^"]*)"/.exec(svg)?.[1] ?? '';
  for (const [, x, y, largo] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    for (let k = 0; k < Number(largo); k++) m[Number(y) - 4][Number(x) - 4 + k] = true;
  }
  return m;
}

const ALINEACION: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46] };
// Nivel M: [bloques, total, datos] (uno o dos grupos), tabla 9 de la norma.
const BLOQUES_M: Record<number, number[]> = {
  1: [1, 26, 16], 2: [1, 44, 28], 3: [1, 70, 44], 4: [2, 50, 32], 5: [2, 67, 43], 6: [4, 43, 27], 7: [4, 49, 31],
  8: [2, 60, 38, 2, 61, 39], 9: [3, 58, 36, 2, 59, 37],
};
const MASCARA: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (_i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

function decodificar(mod: boolean[][]): { texto: string; nivel: string; version: number } {
  const n = mod.length;
  const version = (n - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 9, `versión soportada (${version})`);
  // Formato (copia vertical junto al buscador de arriba a la izquierda / abajo a la izquierda, columna 8).
  let fmt = 0;
  for (let i = 0; i < 15; i++) {
    const fila = i < 6 ? i : i < 8 ? i + 1 : n - 15 + i;
    if (mod[fila][8]) fmt |= 1 << i;
  }
  const datosFmt = (fmt ^ 0x5412) >> 10;
  const nivel = ['M', 'L', 'H', 'Q'][datosFmt >> 3];
  const mascara = MASCARA[datosFmt & 7];
  // Zonas reservadas (patrones de función).
  const res = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const marca = (r0: number, c0: number, alto: number, ancho: number) => {
    for (let r = r0; r < r0 + alto; r++) for (let c = c0; c < c0 + ancho; c++) if (r >= 0 && c >= 0 && r < n && c < n) res[r][c] = true;
  };
  marca(0, 0, 9, 9); marca(0, n - 8, 9, 8); marca(n - 8, 0, 8, 9); // buscadores + separadores + formato
  marca(6, 0, 1, n); marca(0, 6, n, 1); // temporización
  const pos = ALINEACION[version];
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === pos.at(-1)) || (r === pos.at(-1) && c === 6)) continue;
    marca(r - 2, c - 2, 5, 5);
  }
  if (version >= 7) { marca(0, n - 11, 6, 3); marca(n - 11, 0, 3, 6); }
  // Lectura en zigzag (de abajo a la derecha, de a dos columnas, saltando la columna 6).
  const bits: number[] = [];
  let fila = n - 1, paso = -1;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (!res[fila][c]) bits.push(Number(mod[fila][c] !== mascara(fila, c)));
      }
      fila += paso;
      if (fila < 0 || fila >= n) { fila -= paso; paso = -paso; break; }
    }
  }
  const palabras: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) palabras.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // Desentrelazar los datos de los bloques.
  const t = BLOQUES_M[version];
  const tam: number[] = [];
  for (let g = 0; g < t.length; g += 3) for (let k = 0; k < t[g]; k++) tam.push(t[g + 2]);
  const bloques: number[][] = tam.map(() => []);
  let idx = 0;
  for (let i = 0; i < Math.max(...tam); i++) for (let b = 0; b < tam.length; b++) if (i < tam[b]) bloques[b].push(palabras[idx++]);
  const datos = bloques.flat();
  // Flujo: modo (4 bits) + largo (8 bits en v1–9) + bytes.
  const flujo = datos.flatMap((w) => Array.from({ length: 8 }, (_, k) => (w >> (7 - k)) & 1));
  const leer = (desde: number, cuantos: number) => flujo.slice(desde, desde + cuantos).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(leer(0, 4), 0b0100, 'modo byte');
  const largo = leer(4, 8);
  const bytes = Uint8Array.from({ length: largo }, (_, k) => leer(12 + k * 8, 8));
  return { texto: new TextDecoder().decode(bytes), nivel, version };
}

test('qr: el SVG decodifica EXACTAMENTE al link del consentimiento de la pareja (nivel M)', () => {
  const link = 'https://www.valentinaorellana.cl/consentimiento/Xx7Qm2LpR4vN9sKe1Tz0aB3cYy8Wd5Fh';
  const svg = qrSvg(link, { titulo: 'Código QR del consentimiento de la pareja' });
  const r = decodificar(matrizDeSvg(svg));
  assert.equal(r.texto, link);
  assert.equal(r.nivel, 'M');
  assert.equal(r.version * 4 + 17, modulosQr(link));
  assert.match(svg, /<title>Código QR del consentimiento de la pareja<\/title>/);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, 'el link no queda como texto ni pasa por servicios externos');
});

test('qr: también decodifica textos cortos y largos (con patrones de alineación e info de versión)', () => {
  for (const texto of ['https://a.cl/x', `https://www.valentinaorellana.cl/consentimiento/${'a'.repeat(100)}`, 'ñandú — «consentimiento»']) {
    assert.equal(decodificar(matrizDeSvg(qrSvg(texto))).texto, texto);
  }
  assert.ok(decodificar(matrizDeSvg(qrSvg(`https://www.valentinaorellana.cl/consentimiento/${'a'.repeat(100)}`))).version >= 7);
});

test('qr: el título no puede inyectar marcado', () => {
  assert.doesNotMatch(qrSvg('x', { titulo: '<script>"&' }), /<script>/);
});
