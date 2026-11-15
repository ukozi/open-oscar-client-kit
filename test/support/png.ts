// Node only: a PNG a browser decodes, the pixels of one Chromium wrote, and the MD5 an icon is named by.
import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG of one colour: 8-bit truecolour, one IDAT chunk. */
export function pngImage(width: number, height: number, rgb: [number, number, number] = [67, 32, 225]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from(rgb))]);
  const pixels = Buffer.alloc(row.length * height, row);
  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return new Uint8Array(png);
}

/** A real PNG of one-pixel-wide upright stripes, `a` in the even columns and `b` in the odd ones: shrunk well, it is their average everywhere. */
export function stripedPng(width: number, height: number, a: [number, number, number], b: [number, number, number]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(x % 2 === 0 ? a : b, 1 + x * 3);
  const pixels = Buffer.alloc(row.length * height, row);
  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return new Uint8Array(png);
}

/** The pixels of an 8-bit RGBA PNG as rows from the top, each row unfiltered by its filter type 0 to 4. */
export function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const png = Buffer.from(bytes);
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error(`only 8-bit RGBA PNGs without interlace are read, not depth ${body[8]} colour type ${body[9]} interlace ${body[12]}`);
    }
    if (type === 'IDAT') data.push(body);
    if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? (rgba[y * stride + i - 4] ?? 0) : 0; // left
      const b = y > 0 ? (rgba[(y - 1) * stride + i] ?? 0) : 0; // up
      const c = i >= 4 && y > 0 ? (rgba[(y - 1) * stride + i - 4] ?? 0) : 0; // up left
      const x = line[i] ?? 0;
      let value: number;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`row ${y} has filter ${filter}, not 0 to 4`);
      rgba[y * stride + i] = value & 0xff;
    }
  }
  return { width, height, rgba };
}

export function md5Hex(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}
