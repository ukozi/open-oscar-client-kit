import { ByteReader, ByteWriter, OscarDecodeError } from './bytes.js';
import { ICBM_CHARSET_ASCII, ICBM_CHARSET_LATIN1, ICBM_CHARSET_UNICODE } from './constants.js';
import { decodeWireText } from './text.js';

export const OFT_PROMPT = 0x0101;
export const OFT_ACK = 0x0202;
export const OFT_DONE = 0x0204;
export const OFT_RESUME = 0x0205;
export const OFT_RESUME_ANSWER = 0x0106;
export const OFT_RESUME_ACK = 0x0207;
export const OFT_LISTING = 0x1108;
export const OFT_LISTING_ACK = 0x1209;
export const OFT_LISTING_DONE = 0x120b;
export const OFT_FILE_REQUEST = 0x120c;
/** A requester can send this type after a listing that it did not show. It needs no answer. */
export const OFT_LISTING_UNREAD = 0x120e;
export const OFT_HEADER_MIN = 256;
export const OFT_CHECKSUM_START = 0xffff0000;
/** The column of the name in a line of a listing, for a header that encodeOftHeader makes. */
export const OFT_NAME_OFFSET = 0x1c;
/** The column of the size in a line of a listing, for a header that encodeOftHeader makes. */
export const OFT_SIZE_OFFSET = 0x11;
/** The bit of the flags that an answer sets when it gives the count of the bytes that came. */
export const OFT_FLAG_RECEIVED = 0x01;
/** The bit of the flags that marks a listing of the Lst1 form. An answer does not have it. */
export const OFT_FLAG_LST1 = 0x10;
/** The flags of a header that encodeOftHeader makes when the caller gives no flags. */
export const OFT_FLAGS = 0x20;

export type OftHeader = {
  type: number;
  cookie: bigint;
  totalFiles: number;
  filesLeft: number;
  totalParts: number;
  partsLeft: number;
  totalBytes: number;
  bytes: number;
  /** Seconds. */
  modifiedAt: number;
  checksum: number;
  received: number;
  receivedChecksum: number;
  nameEncoding: number;
  /** Byte 0x01 inside a name separates folders. */
  name: string;
};

/** A header as it came, with the fields that an answer sends back. */
export type OftFrame = {
  header: OftHeader;
  idText: string;
  flags: number;
  /** The column of the name in a line of a listing. */
  nameOffset: number;
  /** The column of the size in a line of a listing. */
  sizeOffset: number;
  /** The whole header. An answer keeps each byte that it does not change. */
  bytes: Uint8Array;
};

/** 'latin-1': a name of the encoding 0 has one byte for each character. This is the form that AIM 5.1 writes. */
export type OftNameForm = 'utf-8' | 'latin-1';

/** `received` sets OFT_FLAG_RECEIVED. `name` makes a request: the two sizes are zero and OFT_FLAG_RECEIVED is set. */
export type OftAnswer = { type: number; received?: { bytes: number; checksum: number }; name?: string };

const MAGIC = Uint8Array.of(0x4f, 0x46, 0x54, 0x32);
const HEAD_BYTES = 6;
const FIXED_BYTES = 192;
const NAME_FIELD_MIN = OFT_HEADER_MIN - FIXED_BYTES;
const ID_BYTES = 32;
const ID = 'Cool FileXfer';
const UNUSED_BYTES = 69 + 16;
const TYPE_AT = 6;
const TOTAL_BYTES_AT = 28;
const RECEIVED_AT = 60;
const ID_AT = 68;
const FLAGS_AT = 100;
const ENCODING_AT = 188;

function u16(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`${field} is out of range`);
  return value;
}

function u32(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError(`${field} is out of range`);
  return value;
}

function wide(encoding: number): boolean {
  return encoding === ICBM_CHARSET_UNICODE;
}

function nameBytes(name: string, encoding: number): Uint8Array {
  if (name.includes('\u0000')) throw new RangeError('the name has a zero character');
  if (wide(encoding)) {
    const out = new Uint8Array(name.length * 2);
    for (let i = 0; i < name.length; i++) {
      const unit = name.charCodeAt(i);
      out[i * 2] = unit >>> 8;
      out[i * 2 + 1] = unit & 0xff;
    }
    return out;
  }
  if (encoding !== ICBM_CHARSET_LATIN1) return new Uint8Array(Buffer.from(name, 'utf8'));
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0xff) throw new RangeError('the name does not fit Latin-1');
  }
  return new Uint8Array(Buffer.from(name, 'latin1'));
}

// The name ends at the first zero character, or at the end of the field.
function readName(field: Uint8Array, encoding: number): string {
  const step = wide(encoding) ? 2 : 1;
  let end = 0;
  while (end + step <= field.length && (field[end] !== 0 || field[end + step - 1] !== 0)) end += step;
  return decodeWireText(field.subarray(0, end), encoding);
}

// The name field has 64 bytes or more, and a zero character ends the name.
export function encodeOftHeader(h: OftHeader, form: OftNameForm = 'utf-8', flags: number = OFT_FLAGS): Uint8Array {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) throw new RangeError('flags is out of range');
  const encoding = u16(h.nameEncoding, 'nameEncoding');
  const name = nameBytes(h.name, form === 'latin-1' && encoding === ICBM_CHARSET_ASCII ? ICBM_CHARSET_LATIN1 : encoding);
  const field = new Uint8Array(Math.max(NAME_FIELD_MIN, name.length + (wide(encoding) ? 2 : 1)));
  field.set(name);
  const id = new Uint8Array(ID_BYTES);
  id.set(Buffer.from(ID, 'ascii'));
  return new ByteWriter()
    .bytes(MAGIC)
    .u16(u16(FIXED_BYTES + field.length, 'the header length'))
    .u16(u16(h.type, 'type'))
    .u64(h.cookie)
    .u16(0)
    .u16(0)
    .u16(u16(h.totalFiles, 'totalFiles'))
    .u16(u16(h.filesLeft, 'filesLeft'))
    .u16(u16(h.totalParts, 'totalParts'))
    .u16(u16(h.partsLeft, 'partsLeft'))
    .u32(u32(h.totalBytes, 'totalBytes'))
    .u32(u32(h.bytes, 'bytes'))
    .u32(u32(h.modifiedAt, 'modifiedAt'))
    .u32(u32(h.checksum, 'checksum'))
    .u32(OFT_CHECKSUM_START)
    .u32(0)
    .u32(0)
    .u32(OFT_CHECKSUM_START)
    .u32(u32(h.received, 'received'))
    .u32(u32(h.receivedChecksum, 'receivedChecksum'))
    .bytes(id)
    .u8(flags)
    .u8(OFT_NAME_OFFSET)
    .u8(OFT_SIZE_OFFSET)
    .bytes(new Uint8Array(UNUSED_BYTES))
    .u16(encoding)
    .u16(0)
    .bytes(field)
    .toBytes();
}

// The input is the first 6 bytes of a header. The result counts those 6 bytes too.
export function oftHeaderLength(first6: Uint8Array): number {
  if (first6.length < HEAD_BYTES) throw new OscarDecodeError(`need ${HEAD_BYTES} bytes, have ${first6.length}`);
  if (!MAGIC.every((byte, i) => first6[i] === byte)) throw new OscarDecodeError('not an OFT2 header');
  const length = ((first6[4] ?? 0) << 8) | (first6[5] ?? 0);
  if (length < FIXED_BYTES) throw new OscarDecodeError(`header length ${length} is too small`);
  return length;
}

// Bytes after the length of the header are not read.
export function decodeOftHeader(bytes: Uint8Array): OftHeader {
  const length = oftHeaderLength(bytes);
  if (bytes.length < length) throw new OscarDecodeError(`need ${length} bytes, have ${bytes.length}`);
  const r = new ByteReader(bytes.subarray(0, length), HEAD_BYTES);
  const type = r.u16();
  const cookie = r.u64();
  r.bytes(4);
  const totalFiles = r.u16();
  const filesLeft = r.u16();
  const totalParts = r.u16();
  const partsLeft = r.u16();
  const totalBytes = r.u32();
  const size = r.u32();
  const modifiedAt = r.u32();
  const checksum = r.u32();
  r.bytes(16);
  const received = r.u32();
  const receivedChecksum = r.u32();
  r.bytes(ID_BYTES + 3 + UNUSED_BYTES);
  const nameEncoding = r.u16();
  r.bytes(2);
  const name = readName(r.rest(), nameEncoding);
  return {
    type, cookie, totalFiles, filesLeft, totalParts, partsLeft, totalBytes, bytes: size, modifiedAt, checksum, received,
    receivedChecksum, nameEncoding, name,
  };
}

/** The header with the fields that an answer sends back. Bytes after the length of the header are not read. */
export function decodeOftFrame(bytes: Uint8Array): OftFrame {
  const header = decodeOftHeader(bytes);
  const own = bytes.slice(0, oftHeaderLength(bytes));
  const id = own.subarray(ID_AT, ID_AT + ID_BYTES);
  const end = id.indexOf(0);
  return {
    header,
    idText: Buffer.from(id.subarray(0, end === -1 ? ID_BYTES : end)).toString('latin1'),
    flags: own[FLAGS_AT] ?? 0,
    nameOffset: own[FLAGS_AT + 1] ?? 0,
    sizeOffset: own[FLAGS_AT + 2] ?? 0,
    bytes: own,
  };
}

// A name that Latin-1 holds has one byte for each character and the encoding 0. This is the form that AIM 5.1 writes.
function answerName(name: string): { bytes: Uint8Array; encoding: number; end: number } {
  const encoding = latin1NameEncoding(name);
  if (encoding === ICBM_CHARSET_UNICODE) return { bytes: nameBytes(name, encoding), encoding, end: 2 };
  return { bytes: nameBytes(name, ICBM_CHARSET_LATIN1), encoding, end: 1 };
}

/** The encoding of a name in the Latin-1 form: 0 for a name that Latin-1 holds. */
export function latin1NameEncoding(name: string): number {
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0xff) return ICBM_CHARSET_UNICODE;
  }
  return ICBM_CHARSET_ASCII;
}

/**
 * The answer to a header that came: that header with a different type and without OFT_FLAG_LST1.
 * The id text, the two offsets and each byte that the answer does not name stay as they came.
 */
export function answerOftFrame(frame: OftFrame, answer: OftAnswer): OftFrame {
  const type = u16(answer.type, 'type');
  const name = answer.name === undefined ? null : answerName(answer.name);
  const length = Math.max(frame.bytes.length, name ? FIXED_BYTES + name.bytes.length + name.end : 0);
  const out = new Uint8Array(length);
  out.set(frame.bytes);
  const view = new DataView(out.buffer);
  view.setUint16(MAGIC.length, u16(length, 'the header length'));
  view.setUint16(TYPE_AT, type);
  if (answer.received) {
    view.setUint32(RECEIVED_AT, u32(answer.received.bytes, 'received'));
    view.setUint32(RECEIVED_AT + 4, u32(answer.received.checksum, 'receivedChecksum'));
  }
  // A requester that sends OFT_FLAG_LST1 back gets no answer to its requests from AIM 5.9.
  out[FLAGS_AT] = (out[FLAGS_AT] ?? 0) & ~OFT_FLAG_LST1;
  if (answer.received || name) out[FLAGS_AT] = (out[FLAGS_AT] ?? 0) | OFT_FLAG_RECEIVED;
  if (name) {
    view.setUint32(TOTAL_BYTES_AT, 0);
    view.setUint32(TOTAL_BYTES_AT + 4, 0);
    view.setUint16(ENCODING_AT, name.encoding);
    // The name ends at its zero character. The bytes after it stay, as in a request of AIM 5.1.
    out.set(name.bytes, FIXED_BYTES);
    out.fill(0, FIXED_BYTES + name.bytes.length, FIXED_BYTES + name.bytes.length + name.end);
  }
  return decodeOftFrame(out);
}

// `prior` is the checksum of the bytes before the chunk and `offset` is their count.
export function oftChecksum(chunk: Uint8Array, prior = OFT_CHECKSUM_START, offset = 0): number {
  let check = (prior >>> 16) & 0xffff;
  for (let i = 0; i < chunk.length; i++) {
    const old = check;
    const byte = chunk[i] ?? 0;
    check = (check - ((i + offset) & 1 ? byte : byte << 8)) >>> 0;
    if (check > old) check = (check - 1) >>> 0;
  }
  check = (check & 0xffff) + (check >>> 16);
  check = (check & 0xffff) + (check >>> 16);
  return (check << 16) >>> 0;
}

// The chunk sizes decide between 0x0000 and 0xFFFF when the words sum to a multiple of 0xFFFF.
export function sameOftChecksum(a: number, b: number): boolean {
  const zero = (x: number): boolean => x === 0 || x === OFT_CHECKSUM_START;
  return a === b || (zero(a) && zero(b));
}
