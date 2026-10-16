// ZIP mínimo en memoria (método deflate, nombres UTF-8), sin dependencias. Para la exportación legal
// de la ficha: un archivo con el PDF legible y el JSON de datos. Nada se escribe en disco.
// Formato: PKWARE APPNOTE 6.3 (cabecera local, directorio central, fin de directorio). Sin ZIP64:
// se rechaza si pasa de 4 GB (la respuesta de Vercel no puede pasar de 4,5 MB de todas formas).
import { deflateRawSync } from 'node:zlib';

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(datos: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < datos.length; i++) c = TABLA_CRC[(c ^ datos[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fechaDos(d: Date): { hora: number; fecha: number } {
  const anio = Math.max(1980, d.getFullYear());
  return {
    hora: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    fecha: ((anio - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ArchivoZip { nombre: string; datos: Uint8Array }

export function crearZip(archivos: ArchivoZip[], cuando: Date = new Date()): Uint8Array {
  const { hora, fecha } = fechaDos(cuando);
  const locales: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const a of archivos) {
    const nombre = Buffer.from(a.nombre, 'utf8');
    const comprimido = deflateRawSync(a.datos);
    const crc = crc32(a.datos);
    if (a.datos.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('ZIP demasiado grande');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // versión necesaria
    local.writeUInt16LE(0x0800, 6);      // bit 11: nombre en UTF-8
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(fecha, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(a.datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);
    locales.push(local, nombre, comprimido);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);              // hecho por
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(hora, 12);
    c.writeUInt16LE(fecha, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comprimido.length, 20);
    c.writeUInt32LE(a.datos.length, 24);
    c.writeUInt16LE(nombre.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nombre);
    offset += 30 + nombre.length + comprimido.length;
  }
  const dir = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(dir.length, 12);
  fin.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locales, dir, fin]));
}
