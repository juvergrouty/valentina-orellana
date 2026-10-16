// Código QR en SVG, generado EN EL SERVIDOR (consentimiento de la pareja: la segunda persona lo
// escanea en la consulta con su celular). Librería `qrcode-generator` 2.0.4 (Kazuhiko Arase, MIT,
// sin dependencias, no hace llamadas de red): el link nunca sale a un servicio externo.
// Pruebas en qr.test.ts.
import qrcode from 'qrcode-generator';

/**
 * SVG cuadrado y escalable (viewBox en módulos, 4 módulos de margen como pide la norma).
 * Corrección de errores 'M' (15 %): legible en pantallas con brillo o reflejos.
 * Lanza si el texto no cabe en un QR (no pasa con un link de consentimiento).
 */
export function qrSvg(texto: string, opciones: { titulo?: string } = {}): string {
  const q = qrcode(0, 'M');
  q.addData(texto, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const m = 4;
  const lado = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!q.isDark(r, c)) continue;
      // Corre horizontal de módulos oscuros en un solo rectángulo (SVG más liviano).
      let largo = 1;
      while (c + largo < n && q.isDark(r, c + largo)) largo++;
      d += `M${c + m} ${r + m}h${largo}v1h-${largo}z`;
      c += largo - 1;
    }
  }
  const titulo = opciones.titulo ? `<title>${opciones.titulo.replace(/[<>&"]/g, '')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges" role="img" focusable="false">${titulo}<rect width="${lado}" height="${lado}" fill="#fff"/><path d="${d}" fill="#111827"/></svg>`;
}

/** Cantidad de módulos por lado del QR de ese texto (para pruebas y para elegir el tamaño). */
export function modulosQr(texto: string): number {
  const q = qrcode(0, 'M');
  q.addData(texto, 'Byte');
  q.make();
  return q.getModuleCount();
}
