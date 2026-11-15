import { ByteReader, ByteWriter, OscarDecodeError } from './bytes.js';
import {
  ODC_FLAG_HELLO, ODC_FLAG_TYPED, ODC_FLAG_TYPING, ODC_FLAG_TYPING_NOTICE, ODC_HEADER_BYTES, ODC_HEADER_MAX_BYTES,
} from './constants.js';
import { attributeValue, decodeEntities, decodeWireText, tagEnd, toAsciiEntities } from './text.js';

export type OdcHeader = { cookie: bigint; payloadBytes: number; encoding: number; flags: number; screenName: string };
export type OdcKind = 'hello' | 'typing' | 'typed' | 'idle' | 'message';
/** `text` is HTML. `image.name` is a label only, and nothing opens it. */
export type OdcSegment = { text: string } | { image: { id: number | null; name: string } };
/** Each `bytes` is a view of the payload. `damaged` tells that the read of the binary section stopped early, or that the text has more IMG tags than the limit. */
export type OdcMessage = { segments: OdcSegment[]; binaries: { id: number; bytes: Uint8Array }[]; damaged: boolean };

const MAGIC = Uint8Array.of(0x4f, 0x44, 0x43, 0x32);
const HEAD_BYTES = 6;
const TYPE = 0x0001;
const SUBTYPE = 0x0006;
const NAME_BYTES = 32;
const ID_MAX = 0xffff;
const LABEL_MAX = 64;
const DATA_TAG_MAX_BYTES = 64;
const DATA_TAG = /^<DATA\s+ID="?([0-9]{1,5})"?\s+SIZE="?([0-9]{1,10})"?\s*>$/i;
const BINARY_OPEN = '<BINARY>';
const BINARY_CLOSE = '</BINARY>';
const DATA_CLOSE = '</DATA>';

function ranged(value: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`${field} is out of range`);
  return value;
}

// The input is the first 6 bytes of a header. The result counts those 6 bytes too.
export function odcHeaderLength(first6: Uint8Array): number {
  if (first6.length < HEAD_BYTES) throw new OscarDecodeError(`need ${HEAD_BYTES} bytes, have ${first6.length}`);
  if (!MAGIC.every((byte, i) => first6[i] === byte)) throw new OscarDecodeError('not an ODC2 header');
  const length = ((first6[4] ?? 0) << 8) | (first6[5] ?? 0);
  if (length < ODC_HEADER_BYTES) throw new OscarDecodeError(`header length ${length} is too small`);
  if (length > ODC_HEADER_MAX_BYTES) throw new OscarDecodeError(`header length ${length} is too large`);
  return length;
}

// Bytes after the first 76 are not read.
export function decodeOdcHeader(bytes: Uint8Array): OdcHeader {
  const length = odcHeaderLength(bytes);
  if (bytes.length < length) throw new OscarDecodeError(`need ${length} bytes, have ${bytes.length}`);
  const r = new ByteReader(bytes.subarray(0, ODC_HEADER_BYTES), HEAD_BYTES);
  r.bytes(6);
  const cookie = r.u64();
  r.bytes(8);
  const payloadBytes = r.u32();
  const encoding = r.u16();
  r.bytes(4);
  const flags = r.u16();
  r.bytes(4);
  let screenName = '';
  for (const byte of r.bytes(NAME_BYTES)) {
    if (byte === 0) break;
    screenName += String.fromCharCode(byte);
  }
  return { cookie, payloadBytes, encoding, flags, screenName };
}

export function encodeOdcHeader(h: OdcHeader): Uint8Array {
  const name = new Uint8Array(NAME_BYTES);
  if (h.screenName.length > NAME_BYTES) throw new RangeError('the screen name is longer than 32 bytes');
  for (let i = 0; i < h.screenName.length; i++) {
    const unit = h.screenName.charCodeAt(i);
    if (unit === 0 || unit > 0x7f) throw new RangeError('the screen name is not ASCII');
    name[i] = unit;
  }
  return new ByteWriter()
    .bytes(MAGIC)
    .u16(ODC_HEADER_BYTES)
    .u16(TYPE)
    .u16(SUBTYPE)
    .u16(0)
    .u64(h.cookie)
    .bytes(new Uint8Array(8))
    .u32(ranged(h.payloadBytes, 0xffff_ffff, 'payloadBytes'))
    .u16(ranged(h.encoding, 0xffff, 'encoding'))
    .bytes(new Uint8Array(4))
    .u16(ranged(h.flags, 0xffff, 'flags'))
    .bytes(new Uint8Array(4))
    .bytes(name)
    .toBytes();
}

// A frame that has a payload and no typing bit is a message, with the hello bits or not.
export function odcKind(h: OdcHeader): OdcKind {
  if ((h.flags & ODC_FLAG_TYPING_NOTICE) !== 0) {
    if ((h.flags & ODC_FLAG_TYPING) !== 0) return 'typing';
    return (h.flags & ODC_FLAG_TYPED) !== 0 ? 'typed' : 'idle';
  }
  if (h.payloadBytes > 0) return 'message';
  return (h.flags & ODC_FLAG_HELLO) === ODC_FLAG_HELLO ? 'hello' : 'message';
}

// ASCII letters match in the two cases.
function startsWith(bytes: Uint8Array, at: number, word: string): boolean {
  if (at + word.length > bytes.length) return false;
  for (let i = 0; i < word.length; i++) {
    const byte = bytes[at + i] ?? 0;
    const upper = byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
    if (upper !== word.charCodeAt(i)) return false;
  }
  return true;
}

function binaryStart(payload: Uint8Array): number {
  for (let at = payload.indexOf(0x3c); at >= 0; at = payload.indexOf(0x3c, at + 1)) {
    if (startsWith(payload, at, BINARY_OPEN)) return at;
  }
  return -1;
}

// The last path part of the address, without control characters.
function label(src: string): string {
  const path = decodeEntities(src).replace(/\p{Cc}/gu, '').replace(/[?#].*$/, '');
  return Array.from(path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)).slice(0, LABEL_MAX).join('');
}

function imageOf(tag: string): OdcSegment {
  const id = attributeValue(tag, 'id');
  const n = /^[0-9]{1,5}$/.test(id) ? Number(id) : 0;
  return { image: { id: n >= 1 && n <= ID_MAX ? n : null, name: label(attributeValue(tag, 'src')) } };
}

// The walk reads each tag, so an IMG in the value of a different tag stays text. An IMG after `maxImages` images stays text too.
function segmentsOf(html: string, maxImages: number): { segments: OdcSegment[]; over: boolean } {
  const out: OdcSegment[] = [];
  let images = 0;
  let over = false;
  let from = 0;
  let i = 0;
  const text = (to: number): void => {
    if (to > from) out.push({ text: html.slice(from, to) });
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? '')) {
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end < 0) break;
    if (/^<img[\s/>]/i.test(html.slice(lt, lt + 5))) {
      if (images >= maxImages) over = true;
      else {
        images++;
        text(lt);
        out.push(imageOf(html.slice(lt, end + 1)));
        from = end + 1;
      }
    }
    i = end + 1;
  }
  text(html.length);
  return { segments: out, over };
}

// The declared size of a block is only compared with the bytes that are there.
function readBinaries(payload: Uint8Array, start: number, maxBinaries: number): Pick<OdcMessage, 'binaries' | 'damaged'> {
  const binaries: OdcMessage['binaries'] = [];
  const seen = new Set<number>();
  const damaged = { binaries, damaged: true };
  let at = start;
  for (;;) {
    while (at < payload.length && [0x20, 0x09, 0x0d, 0x0a].includes(payload[at] ?? 0)) at++;
    if (at >= payload.length || startsWith(payload, at, BINARY_CLOSE)) return { binaries, damaged: false };
    if (binaries.length >= maxBinaries) return damaged;
    const limit = Math.min(payload.length, at + DATA_TAG_MAX_BYTES);
    let tag = '';
    let close = at;
    for (; close < limit; close++) {
      tag += String.fromCharCode(payload[close] ?? 0);
      if (payload[close] === 0x3e) break;
    }
    const fields = close < limit ? DATA_TAG.exec(tag) : null;
    if (!fields) return damaged;
    const id = Number(fields[1]);
    const size = Number(fields[2]);
    const first = close + 1;
    if (id < 1 || id > ID_MAX || seen.has(id) || size > payload.length - first) return damaged;
    if (!startsWith(payload, first + size, DATA_CLOSE)) return damaged;
    seen.add(id);
    binaries.push({ id, bytes: payload.subarray(first, first + size) });
    at = first + size + DATA_CLOSE.length;
  }
}

// The byte count of the text of a payload: the bytes before the first ASCII BINARY tag, or each byte when there is no tag.
export function odcTextBytes(payload: Uint8Array): number {
  const binary = binaryStart(payload);
  return binary < 0 ? payload.length : binary;
}

// The text ends at the first ASCII BINARY tag. The binary section is read by its sizes, not searched.
// `maxImages` is the limit of IMG tags that become images. The default is `maxBinaries`.
export function decodeOdcMessage(payload: Uint8Array, encoding: number, maxBinaries: number, maxImages: number = maxBinaries): OdcMessage {
  const binary = binaryStart(payload);
  const html = decodeWireText(binary < 0 ? payload : payload.subarray(0, binary), encoding);
  const read = binary < 0 ? { binaries: [], damaged: false } : readBinaries(payload, binary + BINARY_OPEN.length, maxBinaries);
  const { segments, over } = segmentsOf(html, maxImages);
  return { segments, binaries: read.binaries, damaged: read.damaged || over };
}

// The result is ASCII before the binary section. The frame that carries it has encoding 0.
export function encodeOdcMessage(
  html: string,
  pictures: readonly { id: number; name: string; bytes: Uint8Array; width: number; height: number }[],
): Uint8Array {
  const w = new ByteWriter();
  const ascii = (s: string): void => {
    w.bytes(new Uint8Array(Buffer.from(s, 'latin1')));
  };
  const seen = new Set<number>();
  let tags = '';
  for (const p of pictures) {
    if (!Number.isInteger(p.id) || p.id < 1 || p.id > ID_MAX || seen.has(p.id)) throw new RangeError('a picture id is out of range or repeated');
    seen.add(p.id);
    const name = p.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, LABEL_MAX);
    const width = ranged(p.width, 0xffff_ffff, 'width');
    const height = ranged(p.height, 0xffff_ffff, 'height');
    tags += `<IMG SRC="${name}" ID="${p.id}" WIDTH="${width}" HEIGHT="${height}" DATASIZE="${p.bytes.length}">`;
  }
  ascii(toAsciiEntities(html) + tags);
  if (pictures.length === 0) return w.toBytes();
  ascii(BINARY_OPEN);
  for (const p of pictures) {
    ascii(`<DATA ID="${p.id}" SIZE="${p.bytes.length}">`);
    w.bytes(p.bytes);
    ascii(DATA_CLOSE);
  }
  ascii(BINARY_CLOSE);
  return w.toBytes();
}
