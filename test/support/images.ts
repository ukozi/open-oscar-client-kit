// Image bytes for tests, with no import and no Node or DOM type.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));
const zeros = (count: number): number[] => new Array<number>(count).fill(0);
const u16be = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];
const u16le = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const u32be = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
/** Also an i32: it writes a negative value in two's complement. */
const u32le = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

/** A PNG up to the end of its IHDR chunk (33 bytes); the CRC is zero, which no header reader looks at. */
export function pngHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...PNG_SIGNATURE,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    0x08,
    0x02,
    0x00,
    0x00,
    0x00,
    ...zeros(4),
  ]);
}

/** A GIF89a screen descriptor with no colour table, and with `frame` the descriptor of a first frame. */
export function gifHeader(width: number, height: number, frame?: { width: number; height: number }): Uint8Array {
  return Uint8Array.from([
    ...ascii('GIF89a'),
    ...u16le(width),
    ...u16le(height),
    ...zeros(3),
    ...(frame === undefined ? [] : [0x2c, ...zeros(4), ...u16le(frame.width), ...u16le(frame.height), 0x00]),
  ]);
}

/** A real animated GIF of one pixel that loops: `first` for `firstFor` hundredths of a second, then `then` for ten minutes. */
export function animatedGif(first: [number, number, number], then: [number, number, number], firstFor: number): Uint8Array {
  const frame = (delay: number, data: number): number[] => [
    ...[0x21, 0xf9, 0x04, 0x00, ...u16le(delay), 0x00, 0x00],
    ...[0x2c, ...zeros(4), ...u16le(1), ...u16le(1), 0x00],
    ...[0x02, 0x02, data, 0x01, 0x00],
  ];
  return Uint8Array.from([
    ...ascii('GIF89a'),
    ...u16le(1),
    ...u16le(1),
    0x80,
    0x00,
    0x00,
    ...first,
    ...then,
    ...[0x21, 0xff, 0x0b, ...ascii('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00],
    ...frame(firstFor, 0x44),
    ...frame(60_000, 0x4c),
    0x3b,
  ]);
}

/** `gif`, which ends in its trailer, grown to exactly `length` bytes by a comment extension before the trailer. */
export function paddedGif(gif: Uint8Array, length: number): Uint8Array {
  const body = gif.subarray(0, gif.length - 1);
  // What the sub-blocks can take: all but the trailer, the introducer and label, and the closing block of size 0.
  let room = length - body.length - 4;
  if (room < 0 || room === 1) throw new Error(`paddedGif: cannot make ${length} bytes`);
  const comment: number[] = [0x21, 0xfe];
  // The comment's text, in sub-blocks of 1 to 255 bytes, each after its count. A single byte cannot be left over.
  while (room > 0) {
    let size = Math.min(255, room - 1);
    if (room - (size + 1) === 1) size -= 1;
    comment.push(size, ...new Array<number>(size).fill(0x41));
    room -= size + 1;
  }
  comment.push(0x00);
  const out = Uint8Array.from([...body, ...comment, 0x3b]);
  if (out.length !== length) throw new Error(`paddedGif: ${out.length} bytes, not ${length}`);
  return out;
}

/** A GIF of one frame and no pixels, `width` × `height`: for header and frame-count tests only. */
export function stillGif(width: number, height: number): Uint8Array {
  // The LZW data: at the 2-bit code size, a clear code and the end code.
  return Uint8Array.from([
    ...ascii('GIF89a'),
    ...u16le(width),
    ...u16le(height),
    0x80,
    0x00,
    0x00,
    ...[0, 0, 0],
    ...[255, 255, 255],
    ...[0x2c, ...zeros(4), ...u16le(width), ...u16le(height), 0x00],
    ...[0x02, 0x01, 0x2c, 0x00],
    0x3b,
  ]);
}

/** A copy of `gif` whose logical screen (bytes 6 to 9) is `width` × `height`; its frames are unchanged. */
export function screenGif(gif: Uint8Array, width: number, height: number): Uint8Array {
  const out = Uint8Array.from(gif);
  out.set([...u16le(width), ...u16le(height)], 6);
  return out;
}

/** A BMP file header and a 40-byte info header, or with `core` the 12-byte header as far as its size. */
export function bmpHeader(width: number, height: number, opts?: { core?: boolean }): Uint8Array {
  if (opts?.core === true) {
    return Uint8Array.from([...ascii('BM'), ...zeros(12), ...u32le(12), ...u16le(width), ...u16le(height)]);
  }
  return Uint8Array.from([...ascii('BM'), ...zeros(12), ...u32le(40), ...u32le(width), ...u32le(height), ...zeros(28)]);
}

/** A JPEG of an APP0 segment, one frame header and the end marker. `sof` is the frame marker's second byte. */
export function jpegHeader(width: number, height: number, sof = 0xc0): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...zeros(14),
    0xff,
    sof,
    0x00,
    0x11,
    0x08,
    ...u16be(height),
    ...u16be(width),
    ...zeros(10),
    0xff,
    0xd9,
  ]);
}

const OWN_ICON_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAMAAwAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQAA//aAAwDAQACEQMRAD8A+f6KKK/rY0CiiigAooooA//Q+f6KKK/rY0CiiigAooooA//R+f6KKK/rY0CiiigAooooA//Z';

/** A real 48 × 48 JPEG, 819 bytes, MD5 0b40f19917484bab1ef5a45cc0c6c381. */
export const OWN_ICON_JPEG: Uint8Array = Uint8Array.from(atob(OWN_ICON_JPEG_B64), (c) => c.charCodeAt(0));

/** The same picture with other bytes, and so another MD5: a comment segment holding `text` (ASCII) right after the start marker. */
export function withJpegComment(jpeg: Uint8Array, text: string): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xfe, ...u16be(2 + text.length), ...ascii(text), ...jpeg.subarray(2)]);
}
