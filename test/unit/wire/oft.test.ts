import { describe, expect, it } from 'vitest';
import { OscarDecodeError, fromHex, toHex } from '../../../src/wire/bytes.js';
import {
  OFT_ACK, OFT_CHECKSUM_START, OFT_DONE, OFT_HEADER_MIN, OFT_PROMPT, OFT_RESUME, OFT_RESUME_ACK, OFT_RESUME_ANSWER,
  decodeOftHeader, encodeOftHeader, oftChecksum, oftHeaderLength, sameOftChecksum,
} from '../../../src/wire/oft.js';
import type { OftHeader } from '../../../src/wire/oft.js';
import { loadVectors } from '../../support/vectors.js';
import type { Vector } from '../../support/vectors.js';

// A file of captured frames joins this list when it has the same fields.
const FILES = ['hand-oft.json'];
const CHUNK_SIZES = [1, 7, 4096];
const FIXED_BYTES = 192;

const all: Vector[] = FILES.flatMap((file) => loadVectors(file).vectors);
const ofKind = (kind: string): [string, Vector][] => all.filter((v) => v.inputs?.kind === kind).map((v) => [v.name, v]);
const headers = ofKind('header');
const files = ofKind('file');

function input(v: Vector, key: string): string {
  const value = v.inputs?.[key];
  if (value === undefined) throw new Error(`vector "${v.name}" has no ${key}`);
  return value;
}

function recorded(v: Vector): OftHeader {
  const n = (key: string): number => Number(input(v, key));
  return {
    type: n('type'),
    cookie: BigInt(`0x${input(v, 'cookie')}`),
    totalFiles: n('totalFiles'),
    filesLeft: n('filesLeft'),
    totalParts: n('totalParts'),
    partsLeft: n('partsLeft'),
    totalBytes: n('totalBytes'),
    bytes: n('bytes'),
    modifiedAt: n('modifiedAt'),
    checksum: n('checksum'),
    received: n('received'),
    receivedChecksum: n('receivedChecksum'),
    nameEncoding: n('nameEncoding'),
    name: input(v, 'name'),
  };
}

function inChunks(data: Uint8Array, size: number): number {
  let check = OFT_CHECKSUM_START;
  for (let at = 0; at < data.length; at += size) check = oftChecksum(data.subarray(at, at + size), check, at);
  return check;
}

// The second routine: the published steps on unsigned 32-bit values, with no part of the codec.
function secondChecksum(data: Uint8Array): number {
  const wrap = (x: bigint): bigint => BigInt.asUintN(32, x);
  let check = 0xffffn;
  data.forEach((byte, i) => {
    const before = check;
    check = wrap(check - (i % 2 === 0 ? BigInt(byte) * 256n : BigInt(byte)));
    if (check > before) check = wrap(check - 1n);
  });
  for (let fold = 0; fold < 2; fold++) check = (check % 65536n) + check / 65536n;
  return Number(wrap(check * 65536n));
}

// The sum of the 16-bit words of the data. A last odd byte is the high byte of a word.
function wordSum(data: Uint8Array): number {
  let sum = 0;
  data.forEach((byte, i) => {
    sum += i % 2 === 0 ? byte * 256 : byte;
  });
  return sum;
}

function mixedBytes(count: number, seed: number): Uint8Array {
  const out = new Uint8Array(count);
  let x = seed;
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

const SAMPLE: OftHeader = {
  type: OFT_PROMPT,
  cookie: 0x0102030405060708n,
  totalFiles: 1,
  filesLeft: 1,
  totalParts: 1,
  partsLeft: 1,
  totalBytes: 12,
  bytes: 12,
  modifiedAt: 1036108800,
  checksum: 0x12340000,
  received: 0,
  receivedChecksum: OFT_CHECKSUM_START,
  nameEncoding: 0,
  name: 'notes.txt',
};

describe('the vectors of the OFT format', () => {
  it('the file has headers and files', () => {
    expect(headers.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);
  });

  it('each hand vector says in its note that it is hand-assembled', () => {
    for (const v of loadVectors('hand-oft.json').vectors) expect(v.note, v.name).toMatch(/^Hand-assembled\./);
  });
});

describe('the OFT header', () => {
  it('the type constants have the values of the format', () => {
    expect([OFT_PROMPT, OFT_ACK, OFT_DONE, OFT_RESUME, OFT_RESUME_ANSWER, OFT_RESUME_ACK]).toEqual([0x0101, 0x0202, 0x0204, 0x0205, 0x0106, 0x0207]);
    expect(OFT_HEADER_MIN).toBe(256);
    expect(OFT_CHECKSUM_START).toBe(0xffff0000);
  });

  it.each(headers)('%s decodes to the fields recorded for it', (_name, v) => {
    expect(decodeOftHeader(fromHex(v.hex))).toEqual(recorded(v));
  });

  it.each(headers)('%s re-encodes byte for byte', (_name, v) => {
    expect(toHex(encodeOftHeader(decodeOftHeader(fromHex(v.hex))))).toBe(v.hex);
  });

  it.each(headers)('%s is built from its recorded fields byte for byte', (_name, v) => {
    expect(toHex(encodeOftHeader(recorded(v)))).toBe(v.hex);
  });

  it.each(headers)('%s has a length field that equals its size', (_name, v) => {
    const bytes = fromHex(v.hex);
    expect(oftHeaderLength(bytes.subarray(0, 6))).toBe(bytes.length);
    expect(bytes.length).toBe(Number(input(v, 'length')));
  });

  it('a short name gives a header of 256 bytes', () => {
    const bytes = encodeOftHeader(SAMPLE);
    expect(bytes.length).toBe(OFT_HEADER_MIN);
    expect(oftHeaderLength(bytes.subarray(0, 6))).toBe(OFT_HEADER_MIN);
  });

  it('a 100-character name gives a header longer than 256 whose length field matches', () => {
    const name = `${'a'.repeat(96)}.txt`;
    const bytes = encodeOftHeader({ ...SAMPLE, name });
    expect(bytes.length).toBeGreaterThan(OFT_HEADER_MIN);
    expect(bytes.length).toBe(FIXED_BYTES + name.length + 1);
    expect(oftHeaderLength(bytes.subarray(0, 6))).toBe(bytes.length);
    expect(decodeOftHeader(bytes).name).toBe(name);
  });

  it('a name with letters outside ASCII comes back in each encoding', () => {
    for (const [nameEncoding, name] of [[0, 'résumé 日本.txt'], [2, 'résumé 日本.txt'], [3, 'café.txt']] as const) {
      expect(decodeOftHeader(encodeOftHeader({ ...SAMPLE, nameEncoding, name }))).toEqual({ ...SAMPLE, nameEncoding, name });
    }
  });

  it('the Latin-1 form writes a name of the encoding 0 with one byte for each character', () => {
    const bytes = encodeOftHeader({ ...SAMPLE, nameEncoding: 0, name: 'caf\u00e9.txt' }, 'latin-1');
    expect(toHex(bytes.subarray(188, 201))).toBe('00000000636166e92e74787400');
    expect(decodeOftHeader(bytes)).toEqual({ ...SAMPLE, nameEncoding: 0, name: 'caf\u00e9.txt' });
    expect(toHex(encodeOftHeader({ ...SAMPLE, nameEncoding: 0, name: 'caf\u00e9.txt' }).subarray(192, 202))).toBe('636166c3a92e74787400');
  });

  it('the Latin-1 form refuses a name of the encoding 0 that Latin-1 does not hold, and leaves the other encodings as they are', () => {
    expect(() => encodeOftHeader({ ...SAMPLE, nameEncoding: 0, name: '\u65e5.txt' }, 'latin-1')).toThrow(RangeError);
    const wide = { ...SAMPLE, nameEncoding: 2, name: '\u65e5.txt' };
    expect(toHex(encodeOftHeader(wide, 'latin-1'))).toBe(toHex(encodeOftHeader(wide)));
  });

  it('byte 0x01 inside a name stays in the name', () => {
    const name = 'photos\u0001beach.jpg';
    expect(decodeOftHeader(encodeOftHeader({ ...SAMPLE, name })).name).toBe(name);
  });

  it('bytes after the length of the header are not read', () => {
    const header = encodeOftHeader(SAMPLE);
    const withData = Uint8Array.from([...header, 0x41, 0x42, 0x43]);
    expect(decodeOftHeader(withData)).toEqual(SAMPLE);
  });

  it('a name with no zero byte at its end fills the name field', () => {
    const bytes = encodeOftHeader({ ...SAMPLE, name: 'x'.repeat(63) });
    bytes[bytes.length - 1] = 0x79;
    expect(decodeOftHeader(bytes).name).toBe(`${'x'.repeat(63)}y`);
  });

  it('decodeOftHeader throws on "OFT3"', () => {
    const bytes = encodeOftHeader(SAMPLE);
    bytes[3] = 0x33;
    expect(() => decodeOftHeader(bytes)).toThrow(OscarDecodeError);
    expect(() => oftHeaderLength(bytes.subarray(0, 6))).toThrow(OscarDecodeError);
  });

  it('decodeOftHeader throws on a buffer shorter than its length field', () => {
    const bytes = encodeOftHeader(SAMPLE);
    expect(() => decodeOftHeader(bytes.subarray(0, bytes.length - 1))).toThrow(OscarDecodeError);
    expect(() => decodeOftHeader(bytes.subarray(0, 5))).toThrow(OscarDecodeError);
    expect(() => decodeOftHeader(new Uint8Array(0))).toThrow(OscarDecodeError);
  });

  it('a length field below the fixed part is refused', () => {
    const bytes = encodeOftHeader(SAMPLE);
    bytes[4] = 0;
    bytes[5] = FIXED_BYTES - 1;
    expect(() => oftHeaderLength(bytes.subarray(0, 6))).toThrow(OscarDecodeError);
    expect(() => decodeOftHeader(bytes)).toThrow(OscarDecodeError);
  });

  it('oftHeaderLength throws on fewer than 6 bytes', () => {
    expect(() => oftHeaderLength(encodeOftHeader(SAMPLE).subarray(0, 5))).toThrow(OscarDecodeError);
  });

  it('a field outside its range is refused', () => {
    const wrong: Partial<OftHeader>[] = [
      { type: 0x10000 },
      { totalFiles: -1 },
      { filesLeft: 1.5 },
      { totalBytes: 0x1_0000_0000 },
      { bytes: 0x1_0000_0000 },
      { checksum: -1 },
      { nameEncoding: 0x10000 },
      { name: 'a\u0000b' },
      { nameEncoding: 3, name: '日本.txt' },
      { name: 'n'.repeat(0x10000) },
    ];
    for (const part of wrong) expect(() => encodeOftHeader({ ...SAMPLE, ...part }), JSON.stringify(part).slice(0, 40)).toThrow(RangeError);
  });

  it('the largest sizes fit', () => {
    const h = { ...SAMPLE, totalBytes: 0xffff_ffff, bytes: 0xffff_ffff, received: 0xffff_ffff, cookie: 0xffff_ffff_ffff_ffffn };
    expect(decodeOftHeader(encodeOftHeader(h))).toEqual(h);
  });
});

describe('the OFT checksum', () => {
  it('the checksum of zero bytes is 0xFFFF0000', () => {
    expect(oftChecksum(new Uint8Array(0))).toBe(0xffff0000);
    expect(oftChecksum(new Uint8Array(0), OFT_CHECKSUM_START, 5)).toBe(0xffff0000);
  });

  it('zero bytes leave an earlier checksum as it is', () => {
    expect(oftChecksum(new Uint8Array(0), 0x12340000, 3)).toBe(0x12340000);
  });

  it.each(files)('%s has the checksum recorded for it in one chunk', (_name, v) => {
    expect(oftChecksum(fromHex(v.hex))).toBe(Number(input(v, 'checksum')));
  });

  it.each(files)('%s has the same checksum in chunks of 1, 7 and 4096 bytes', (_name, v) => {
    const data = fromHex(v.hex);
    expect(data.length).toBe(Number(input(v, 'bytes')));
    for (const size of CHUNK_SIZES) expect(inChunks(data, size), `chunks of ${size}`).toBe(Number(input(v, 'checksum')));
  });

  it.each(files)('%s agrees with the second routine', (_name, v) => {
    expect(secondChecksum(fromHex(v.hex))).toBe(Number(input(v, 'checksum')));
  });

  it('generated data of many sizes agrees with the second routine, whole and in chunks', () => {
    for (const count of [1, 2, 3, 6, 7, 8, 255, 256, 4095, 4096, 4097, 8193, 20000]) {
      const data = mixedBytes(count, count);
      const expected = secondChecksum(data);
      expect(oftChecksum(data), `${count} bytes`).toBe(expected);
      for (const size of CHUNK_SIZES) expect(sameOftChecksum(inChunks(data, size), expected), `${count} bytes by ${size}`).toBe(true);
    }
  });

  it('the checksum and the sum of the words add to a multiple of 0xFFFF', () => {
    const samples = [...files.map(([, v]) => fromHex(v.hex)), mixedBytes(5000, 7), mixedBytes(333, 9)];
    for (const data of samples) expect(((oftChecksum(data) >>> 16) + wordSum(data)) % 0xffff).toBe(0);
  });

  it('the low 16 bits of a checksum are zero', () => {
    for (const [, v] of files) expect(oftChecksum(fromHex(v.hex)) & 0xffff).toBe(0);
  });

  it('a chunk that starts at an odd offset puts its first byte in the low half', () => {
    const data = Uint8Array.of(0x12, 0x34, 0x56);
    const split = oftChecksum(data.subarray(1), oftChecksum(data.subarray(0, 1)), 1);
    expect(split).toBe(oftChecksum(data));
    expect(oftChecksum(data.subarray(1), oftChecksum(data.subarray(0, 1)), 0)).not.toBe(oftChecksum(data));
  });

  it('a different byte gives a different checksum', () => {
    const data = mixedBytes(1000, 3);
    const changed = Uint8Array.from(data);
    changed[500] = (changed[500] ?? 0) ^ 0x01;
    expect(sameOftChecksum(oftChecksum(changed), oftChecksum(data))).toBe(false);
  });

  it('words that sum to a multiple of 0xFFFF give 0x0000 or 0xFFFF, and the two compare as equal', () => {
    const data = new Uint8Array(64).fill(0xff);
    const whole = oftChecksum(data);
    const byOne = inChunks(data, 1);
    expect([0x00000000, 0xffff0000]).toContain(whole);
    expect([0x00000000, 0xffff0000]).toContain(byOne);
    expect(whole).not.toBe(byOne);
    expect(sameOftChecksum(whole, byOne)).toBe(true);
  });

  it('sameOftChecksum is equality for every other pair', () => {
    expect(sameOftChecksum(0x12340000, 0x12340000)).toBe(true);
    expect(sameOftChecksum(0x12340000, 0x12350000)).toBe(false);
    expect(sameOftChecksum(0x00000000, 0x00010000)).toBe(false);
    expect(sameOftChecksum(0xffff0000, 0xfffe0000)).toBe(false);
    expect(sameOftChecksum(0xffff0000, 0x00000000)).toBe(true);
  });
});

describe('the headers of the two clients', () => {
  it.each(loadVectors('aim-oft.json').vectors.map((v): [string, Vector] => [v.name, v]))('%s decodes to its type, sizes and name', (_name, v) => {
    const h = decodeOftHeader(fromHex(v.hex));
    expect(h.type).toBe(Number(input(v, 'type')));
    expect(h.bytes).toBe(Number(input(v, 'bytes')));
    expect(h.received).toBe(Number(input(v, 'received')));
    expect(h.name).toBe(input(v, 'name'));
    expect(h.totalFiles).toBe(1);
  });
});
