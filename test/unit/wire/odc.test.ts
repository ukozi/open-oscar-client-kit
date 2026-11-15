import { afterEach, describe, expect, it, vi } from 'vitest';
import { OscarDecodeError, concatBytes, fromHex, toHex } from '../../../src/wire/bytes.js';
import {
  DIRECT_IM_MAX_ATTACHMENTS, DIRECT_IM_MAX_MESSAGE_BYTES, ODC_FLAG_AUTO, ODC_FLAG_HELLO, ODC_FLAG_TYPED, ODC_FLAG_TYPING,
  ODC_FLAG_TYPING_NOTICE, ODC_HEADER_BYTES, ODC_HEADER_MAX_BYTES,
} from '../../../src/wire/constants.js';
import { decodeOdcHeader, decodeOdcMessage, encodeOdcHeader, encodeOdcMessage, odcHeaderLength, odcKind, odcTextBytes } from '../../../src/wire/odc.js';
import type { OdcHeader, OdcMessage, OdcSegment } from '../../../src/wire/odc.js';
import { loadVectors, vector } from '../../support/vectors.js';
import type { Vector } from '../../support/vectors.js';

const FILE = loadVectors('hand-odc.json');
const AIM = loadVectors('aim-odc.json');
const MAX = DIRECT_IM_MAX_ATTACHMENTS;

function input(v: Vector, key: string): string {
  const value = v.inputs?.[key];
  if (value === undefined) throw new Error(`vector "${v.name}" has no ${key}`);
  return value;
}

function recordedHeader(v: Vector): OdcHeader {
  return {
    cookie: BigInt(`0x${input(v, 'cookie')}`),
    payloadBytes: Number(input(v, 'payloadBytes')),
    encoding: Number(input(v, 'encoding')),
    flags: Number(input(v, 'flags')),
    screenName: input(v, 'screenName'),
  };
}

function recordedMessage(v: Vector): { segments: OdcSegment[]; binaries: { id: number; hex: string }[] } {
  return {
    segments: JSON.parse(input(v, 'segments')) as OdcSegment[],
    binaries: JSON.parse(input(v, 'binaries')) as { id: number; hex: string }[],
  };
}

function read(name: string, maxBinaries = MAX): { message: OdcMessage; payload: Uint8Array; v: Vector } {
  const v = vector(FILE, name);
  const payload = fromHex(v.hex);
  return { message: decodeOdcMessage(payload, Number(input(v, 'encoding')), maxBinaries), payload, v };
}

function summary(message: OdcMessage): { id: number; hex: string }[] {
  return message.binaries.map((b) => ({ id: b.id, hex: toHex(b.bytes) }));
}

const ascii = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'latin1'));
const fill = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) & 0xff);
const block = (id: number | string, bytes: Uint8Array, size: number | string = bytes.length): Uint8Array =>
  concatBytes([ascii(`<DATA ID="${id}" SIZE="${size}">`), bytes, ascii('</DATA>')]);
const section = (...blocks: Uint8Array[]): Uint8Array => concatBytes([ascii('<BINARY>'), ...blocks, ascii('</BINARY>')]);
const header = (over: Partial<OdcHeader> = {}): OdcHeader => ({ cookie: 0x1122334455667788n, payloadBytes: 0, encoding: 0, flags: 0, screenName: 'Alice', ...over });

// Each length that a typed array is made with, while `run` runs.
function allocations(run: () => void): number[] {
  const sizes: number[] = [];
  const Real = Uint8Array;
  const Counted: Uint8ArrayConstructor = new Proxy(Real, {
    construct(target, args: unknown[], newTarget): object {
      if (typeof args[0] === 'number') sizes.push(args[0]);
      return Reflect.construct(target, args, newTarget === Counted ? target : newTarget) as object;
    },
  });
  const alloc = vi.spyOn(Buffer, 'alloc');
  const unsafe = vi.spyOn(Buffer, 'allocUnsafe');
  vi.stubGlobal('Uint8Array', Counted);
  try {
    run();
  } finally {
    vi.unstubAllGlobals();
  }
  for (const call of [...alloc.mock.calls, ...unsafe.mock.calls]) sizes.push(call[0]);
  return sizes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the constants', () => {
  it('the header has 76 bytes, and the default limits are 16 MB and 16 attachments', () => {
    expect(ODC_HEADER_BYTES).toBe(76);
    expect(ODC_HEADER_MAX_BYTES).toBe(256);
    expect(DIRECT_IM_MAX_MESSAGE_BYTES).toBe(16 * 1024 * 1024);
    expect(DIRECT_IM_MAX_ATTACHMENTS).toBe(16);
  });

  it('each vector says that it is assembled from the assumed layout', () => {
    expect(FILE.vectors.length).toBeGreaterThan(0);
    for (const v of FILE.vectors) expect(v.note, v.name).toContain('assembled from the assumed layout');
  });
});

describe('the ODC header', () => {
  it('decodes the hello: cookie 0x1122334455667788, payloadBytes 0, flags 0x0060, kind hello, screenName "Alice"', () => {
    const h = decodeOdcHeader(fromHex(vector(FILE, 'hello').hex));
    expect(h).toEqual({ cookie: 0x1122334455667788n, payloadBytes: 0, encoding: 0, flags: 0x0060, screenName: 'Alice' });
    expect(odcKind(h)).toBe('hello');
  });

  it.each(FILE.vectors.filter((v) => v.inputs?.kind === 'header').map((v): [string, Vector] => [v.name, v]))('decodes "%s" to its recorded fields', (_name, v) => {
    const bytes = fromHex(v.hex);
    expect(bytes.length).toBe(Number(input(v, 'length')));
    expect(odcHeaderLength(bytes.subarray(0, 6))).toBe(bytes.length);
    expect(decodeOdcHeader(bytes)).toEqual(recordedHeader(v));
  });

  it('encodeOdcHeader gives 76 bytes with the cookie at offset 12 and the payload length at offset 28, and decodes back', () => {
    const h = header({ payloadBytes: 0x01020304, encoding: 2, flags: ODC_FLAG_AUTO, screenName: 'Bob Smith' });
    const bytes = encodeOdcHeader(h);
    expect(bytes.length).toBe(76);
    expect(toHex(bytes.subarray(0, 12))).toBe('4f444332004c000100060000');
    expect(toHex(bytes.subarray(12, 20))).toBe('1122334455667788');
    expect(toHex(bytes.subarray(28, 32))).toBe('01020304');
    expect(decodeOdcHeader(bytes)).toEqual(h);
  });

  it('encodeOdcHeader gives the bytes of the hello vector', () => {
    const v = vector(FILE, 'hello');
    expect(toHex(encodeOdcHeader(recordedHeader(v)))).toBe(v.hex);
  });

  it('encodeOdcHeader refuses a screen name over 32 bytes, a name outside ASCII and a payload length over 32 bits', () => {
    expect(() => encodeOdcHeader(header({ screenName: 'a'.repeat(33) }))).toThrow(RangeError);
    expect(() => encodeOdcHeader(header({ screenName: 'é' }))).toThrow(RangeError);
    expect(() => encodeOdcHeader(header({ payloadBytes: 0x1_0000_0000 }))).toThrow(RangeError);
    expect(decodeOdcHeader(encodeOdcHeader(header({ screenName: 'a'.repeat(32) }))).screenName).toBe('a'.repeat(32));
  });

  it('odcKind: 0x0002 idle, 0x000a and 0x000e typing, 0x0006 typed, 0x0000 and 0x0001 message', () => {
    expect(odcKind(header({ flags: 0x0002 }))).toBe('idle');
    expect(odcKind(header({ flags: 0x000a }))).toBe('typing');
    expect(odcKind(header({ flags: 0x000e }))).toBe('typing');
    expect(odcKind(header({ flags: 0x0006 }))).toBe('typed');
    expect(odcKind(header({ flags: 0x0000 }))).toBe('message');
    expect(odcKind(header({ flags: 0x0001 }))).toBe('message');
    expect(odcKind(header({ flags: ODC_FLAG_HELLO }))).toBe('hello');
    expect(ODC_FLAG_TYPING_NOTICE | ODC_FLAG_TYPING).toBe(0x000a);
    expect(ODC_FLAG_TYPING_NOTICE | ODC_FLAG_TYPED).toBe(0x0006);
    expect(odcKind(decodeOdcHeader(fromHex(vector(FILE, 'typing notice').hex)))).toBe('typing');
  });

  it('odcKind: a frame with the hello bits and a payload is a message', () => {
    expect(odcKind(header({ flags: ODC_FLAG_HELLO, payloadBytes: 71 }))).toBe('message');
    expect(odcKind(header({ flags: ODC_FLAG_HELLO | ODC_FLAG_AUTO, payloadBytes: 1 }))).toBe('message');
  });

  it('the frames of the two clients: hello, typing, typed, erased, and a message with and with no hello bits', () => {
    const kind = (name: string) => odcKind(decodeOdcHeader(fromHex(vector(AIM, name).hex)));
    expect(kind('5.9 hello')).toBe('hello');
    expect(kind('5.9 typing')).toBe('typing');
    expect(kind('5.9 typed')).toBe('typed');
    expect(kind('5.9 erased')).toBe('idle');
    expect(kind('5.9 message header')).toBe('message');
    expect(kind('5.1 message header')).toBe('message');
    for (const v of AIM.vectors.filter((x) => x.inputs?.kind === 'header')) expect(decodeOdcHeader(fromHex(v.hex))).toEqual(recordedHeader(v));
    expect(decodeOdcMessage(fromHex(vector(AIM, 'message text').hex), 0, MAX)).toEqual({ segments: [{ text: expect.stringContaining('hello') }], binaries: [], damaged: false });
  });

  it('odcHeaderLength throws for "ODC3", for a length of 75 and for a length of 257; a header of 80 bytes decodes', () => {
    const head = (magic: string, length: number): Uint8Array => concatBytes([ascii(magic), Uint8Array.of(length >>> 8, length & 0xff)]);
    expect(() => odcHeaderLength(head('ODC3', 76))).toThrow(OscarDecodeError);
    expect(() => odcHeaderLength(head('ODC2', 75))).toThrow(OscarDecodeError);
    expect(() => odcHeaderLength(head('ODC2', 257))).toThrow(OscarDecodeError);
    expect(() => odcHeaderLength(ascii('ODC2'))).toThrow(OscarDecodeError);
    expect(odcHeaderLength(head('ODC2', 76))).toBe(76);
    expect(odcHeaderLength(head('ODC2', 256))).toBe(256);
    const v = vector(FILE, 'message header, 80 bytes');
    const bytes = fromHex(v.hex);
    expect(odcHeaderLength(bytes)).toBe(80);
    expect(decodeOdcHeader(bytes)).toEqual(recordedHeader(v));
  });

  it('decodeOdcHeader throws when it has fewer bytes than the header declares', () => {
    const bytes = fromHex(vector(FILE, 'message header, 80 bytes').hex);
    expect(() => decodeOdcHeader(bytes.subarray(0, 79))).toThrow(OscarDecodeError);
    expect(() => decodeOdcHeader(bytes.subarray(0, 5))).toThrow(OscarDecodeError);
  });

  it('a header that declares a payload of 2 GB decodes to that number and makes no buffer', () => {
    const bytes = encodeOdcHeader(header({ payloadBytes: 0x8000_0000 }));
    let h: OdcHeader | undefined;
    const sizes = allocations(() => {
      h = decodeOdcHeader(bytes);
    });
    expect(h?.payloadBytes).toBe(0x8000_0000);
    expect(Math.max(0, ...sizes)).toBeLessThanOrEqual(ODC_HEADER_MAX_BYTES);
  });
});

describe('the ODC message', () => {
  it('reads text, one IMG with ID 1 and one DATA block of 137 bytes: segments [text, image 1, text], binaries [{ id: 1, 137 bytes }]', () => {
    const { message, payload, v } = read('message, one picture');
    const want = recordedMessage(v);
    expect(message.segments).toEqual(want.segments);
    expect(message.segments.map((s) => ('text' in s ? 'text' : s.image.id))).toEqual(['text', 1, 'text']);
    expect(summary(message)).toEqual(want.binaries);
    expect(message.binaries[0]?.bytes.length).toBe(137);
    expect(message.damaged).toBe(false);
    // The bytes are a view of the payload.
    expect(message.binaries[0]?.bytes.buffer).toBe(payload.buffer);
  });

  it('reads two pictures in the order of their DATA blocks', () => {
    const { message, v } = read('message, two pictures');
    const want = recordedMessage(v);
    expect(message.binaries.map((b) => b.id)).toEqual([2, 1]);
    expect(summary(message)).toEqual(want.binaries);
    expect(message.segments).toEqual(want.segments);
    expect(message.damaged).toBe(false);
  });

  it('UCS-2 text before an ASCII BINARY section decodes', () => {
    const { message, v } = read('message, UCS-2 text');
    const want = recordedMessage(v);
    expect(message.segments).toEqual(want.segments);
    expect(summary(message)).toEqual(want.binaries);
    expect(message.damaged).toBe(false);
  });

  it('SIZE="4294967295" with 10 bytes after it: damaged, no binary, and no allocation over the payload length', () => {
    const payload = concatBytes([ascii('hi<BINARY><DATA ID="1" SIZE="4294967295">'), fill(10, 3)]);
    let message: OdcMessage | undefined;
    const sizes = allocations(() => {
      message = decodeOdcMessage(payload, 0, MAX);
    });
    expect(message?.damaged).toBe(true);
    expect(message?.binaries).toEqual([]);
    expect(message?.segments).toEqual([{ text: 'hi' }]);
    expect(Math.max(0, ...sizes)).toBeLessThanOrEqual(payload.length);
  });

  it('the allocation count sees a buffer that is made', () => {
    expect(allocations(() => void new Uint8Array(4096))).toContain(4096);
    expect(allocations(() => void Buffer.alloc(8192))).toContain(8192);
  });

  it('SIZE larger by one than what follows, and a block with no </DATA>: damaged, earlier blocks kept', () => {
    const first = fill(12, 5);
    const second = fill(8, 9);
    const long = decodeOdcMessage(concatBytes([ascii('<BINARY>'), block(1, first), ascii('<DATA ID="2" SIZE="9">'), second]), 0, MAX);
    expect(long.damaged).toBe(true);
    expect(summary(long)).toEqual([{ id: 1, hex: toHex(first) }]);
    const open = decodeOdcMessage(concatBytes([ascii('<BINARY>'), block(1, first), ascii('<DATA ID="2" SIZE="8">'), second, ascii('</BINARY>')]), 0, MAX);
    expect(open.damaged).toBe(true);
    expect(summary(open)).toEqual([{ id: 1, hex: toHex(first) }]);
    // The size reaches the end of the payload exactly, with no room for the end tag.
    const exact = decodeOdcMessage(concatBytes([ascii('<BINARY>'), block(1, first), ascii('<DATA ID="2" SIZE="8">'), second]), 0, MAX);
    expect(exact.damaged).toBe(true);
    expect(exact.binaries.map((b) => b.id)).toEqual([1]);
  });

  it('17 DATA blocks with maxBinaries 16: damaged, 16 kept', () => {
    const blocks = Array.from({ length: 17 }, (_, i) => block(i + 1, fill(3, i + 1)));
    const message = decodeOdcMessage(section(...blocks), 0, 16);
    expect(message.damaged).toBe(true);
    expect(message.binaries.map((b) => b.id)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(decodeOdcMessage(section(...blocks.slice(0, 16)), 0, 16).damaged).toBe(false);
    expect(decodeOdcMessage(section(...blocks), 0, 0).binaries).toEqual([]);
  });

  it('a repeated id, and an ID or a SIZE that is not decimal: damaged, earlier blocks kept', () => {
    const a = fill(4, 3);
    const cases: [string, Uint8Array][] = [
      ['repeated id', section(block(1, a), block(1, a))],
      ['hexadecimal ID', section(block(1, a), block('0x2', a))],
      ['negative ID', section(block(1, a), block('-2', a))],
      ['ID 0', section(block(1, a), block(0, a))],
      ['ID 65536', section(block(1, a), block(65536, a))],
      ['hexadecimal SIZE', section(block(1, a), block(2, a, '0x4'))],
      ['SIZE with a sign', section(block(1, a), block(2, a, '+4'))],
      ['SIZE with a fraction', section(block(1, a), block(2, a, '4.0'))],
      ['SIZE of 30 digits', section(block(1, a), block(2, a, '4'.repeat(30)))],
      ['no SIZE', section(block(1, a), concatBytes([ascii('<DATA ID="2">'), a, ascii('</DATA>')]))],
      ['a tag that never closes', concatBytes([ascii('<BINARY>'), block(1, a), ascii(`<DATA ID="2" SIZE="4" ${'x'.repeat(4000)}`)])],
      ['other bytes between blocks', section(block(1, a), ascii('junk'), block(2, a))],
    ];
    for (const [name, payload] of cases) {
      const message = decodeOdcMessage(payload, 0, MAX);
      expect(message.damaged, name).toBe(true);
      expect(summary(message), name).toEqual([{ id: 1, hex: toHex(a) }]);
    }
  });

  it('a block whose bytes hold "</DATA>" and "</BINARY>" is read by its SIZE', () => {
    const tricky = ascii('ab</DATA></BINARY><DATA ID="9" SIZE="1">c');
    const after = fill(5, 7);
    const message = decodeOdcMessage(section(block(1, tricky), block(2, after)), 0, MAX);
    expect(message.damaged).toBe(false);
    expect(summary(message)).toEqual([{ id: 1, hex: toHex(tricky) }, { id: 2, hex: toHex(after) }]);
  });

  it('a block of no bytes, and a section that ends with no </BINARY>, are not damaged', () => {
    const a = fill(4, 3);
    const message = decodeOdcMessage(concatBytes([ascii('<binary>'), block(1, new Uint8Array(0)), ascii('\r\n'), block(2, a)]), 0, MAX);
    expect(message.damaged).toBe(false);
    expect(summary(message)).toEqual([{ id: 1, hex: '' }, { id: 2, hex: toHex(a) }]);
  });

  it('only the text before the first BINARY tag is text', () => {
    const a = ascii('<IMG ID="7" SRC="in-data.png"><BINARY>');
    const message = decodeOdcMessage(concatBytes([ascii('one<BiNaRy>'), block(1, a), ascii('</BINARY><IMG ID="8">two')]), 0, MAX);
    expect(message.segments).toEqual([{ text: 'one' }]);
    expect(summary(message)).toEqual([{ id: 1, hex: toHex(a) }]);
  });

  it('an IMG with SRC="http://203.0.113.9/x.gif" and no ID gives image.id null and name "x.gif"', () => {
    const message = decodeOdcMessage(ascii('a<IMG SRC="http://203.0.113.9/x.gif">b'), 0, MAX);
    expect(message.segments).toEqual([{ text: 'a' }, { image: { id: null, name: 'x.gif' } }, { text: 'b' }]);
    expect(message.binaries).toEqual([]);
    expect(message.damaged).toBe(false);
  });

  it('the name of an image is the last path part of its SRC, at most 64 characters', () => {
    const name = (tag: string): string | undefined => {
      const first = decodeOdcMessage(ascii(tag), 0, MAX).segments[0];
      return first && 'image' in first ? first.image.name : undefined;
    };
    expect(name('<IMG SRC="file:///etc/passwd" ID="1">')).toBe('passwd');
    expect(name('<IMG SRC="C:\\Documents\\My Pictures\\cat.bmp" ID="1">')).toBe('cat.bmp');
    expect(name('<img src=\'http://203.0.113.9/a/b.png?x=/c.gif#/d\' id=1>')).toBe('b.png');
    expect(name('<IMG SRC="http://203.0.113.9/dir/" ID="1">')).toBe('');
    expect(name('<IMG ID="1">')).toBe('');
    expect(name(`<IMG SRC="${'n'.repeat(200)}.png" ID="1">`)).toBe('n'.repeat(64));
    expect(name('<IMG SRC="a&amp;b.png" ID="1">')).toBe('a&b.png');
    expect(name('<IMG SRC="a\u0001b\u007f.png" ID="1">')).toBe('ab.png');
  });

  it('the id of an image is a whole number from 1 to 65535, else null', () => {
    const id = (value: string): number | null | undefined => {
      const first = decodeOdcMessage(ascii(`<IMG SRC="a.png" ID=${value}>`), 0, MAX).segments[0];
      return first && 'image' in first ? first.image.id : undefined;
    };
    expect(id('"1"')).toBe(1);
    expect(id('65535')).toBe(65535);
    for (const bad of ['"0"', '"65536"', '"-1"', '"1.5"', '"0x10"', '"1e3"', '" 1"', '""', '"one"', '"99999999999999999999"']) expect(id(bad), bad).toBeNull();
  });

  it('an ID that names no attached data is an image with that id, and the message is not damaged', () => {
    const message = decodeOdcMessage(concatBytes([ascii('<IMG SRC="a.png" ID="5">'), section(block(1, fill(4, 3)))]), 0, MAX);
    expect(message.segments).toEqual([{ image: { id: 5, name: 'a.png' } }]);
    expect(message.binaries.map((b) => b.id)).toEqual([1]);
    expect(message.damaged).toBe(false);
  });

  it('other markup stays text, and an IMG inside the value of another tag is not an image', () => {
    const html = '<script>alert(1)</script><A HREF="<IMG ID=1>">x</A><!-- <IMG ID="2"> --><IMGX ID="3">< IMG ID="4">';
    expect(decodeOdcMessage(ascii(html), 0, MAX).segments).toEqual([{ text: html }]);
    const open = 'a<IMG SRC="x.png" ID="1"';
    expect(decodeOdcMessage(ascii(open), 0, MAX).segments).toEqual([{ text: open }]);
    expect(decodeOdcMessage(ascii('<img/><IMG\nID="2">'), 0, MAX).segments).toEqual([{ image: { id: null, name: '' } }, { image: { id: 2, name: '' } }]);
  });

  it('IMG tags past maxImages stay text, and the message is damaged', () => {
    const message = decodeOdcMessage(ascii('a<IMG ID="1">b<IMG ID="2">c<IMG ID="3">d'), 0, MAX, 2);
    expect(message.segments).toEqual([{ text: 'a' }, { image: { id: 1, name: '' } }, { text: 'b' }, { image: { id: 2, name: '' } }, { text: 'c<IMG ID="3">d' }]);
    expect(message.damaged).toBe(true);
    expect(decodeOdcMessage(ascii('<IMG ID="1"><IMG ID="2">'), 0, MAX, 2).damaged).toBe(false);
  });

  it('a text of 100,000 IMG tags gives no more segments than maxBinaries images and the text between them', () => {
    const message = decodeOdcMessage(ascii('<img>'.repeat(100_000)), 0, MAX);
    expect(message.segments.filter((segment) => 'image' in segment)).toHaveLength(MAX);
    expect(message.segments.length).toBeLessThanOrEqual(MAX + 1);
    expect(message.damaged).toBe(true);
  });

  it('odcTextBytes is the byte count before the BINARY tag, or of the payload when there is no tag', () => {
    expect(odcTextBytes(ascii('hello'))).toBe(5);
    expect(odcTextBytes(ascii('hi<binary><DATA ID="1" SIZE="0"></DATA></BINARY>'))).toBe(2);
    expect(odcTextBytes(new Uint8Array(0))).toBe(0);
  });

  it('a payload with no BINARY section gives one text segment and no binary', () => {
    const { message, v } = read('message, no BINARY section');
    expect(message.segments).toEqual(recordedMessage(v).segments);
    expect(message.segments.length).toBe(1);
    expect(message.binaries).toEqual([]);
    expect(message.damaged).toBe(false);
    expect(decodeOdcMessage(new Uint8Array(0), 0, MAX)).toEqual({ segments: [], binaries: [], damaged: false });
  });

  it('encodeOdcMessage round-trips one picture, and writes "é" as &#233; and the name "my pic.png" as "my_pic.png"', () => {
    const bytes = fill(137, 7);
    const payload = encodeOdcMessage('caf\u00e9 <B>now</B>', [{ id: 1, name: 'my pic.png', bytes, width: 640, height: 480 }]);
    expect(payload.every((byte, i) => byte <= 0x7f || i >= payload.indexOf(0x3e, Buffer.from(payload).indexOf('<DATA')))).toBe(true);
    const text = Buffer.from(payload).toString('latin1');
    expect(text.startsWith('caf&#233; <B>now</B><IMG SRC="my_pic.png" ID="1" WIDTH="640" HEIGHT="480" DATASIZE="137"><BINARY><DATA ID="1" SIZE="137">')).toBe(true);
    expect(text.endsWith('</DATA></BINARY>')).toBe(true);
    const message = decodeOdcMessage(payload, 0, MAX);
    expect(message.segments).toEqual([{ text: 'caf&#233; <B>now</B>' }, { image: { id: 1, name: 'my_pic.png' } }]);
    expect(summary(message)).toEqual([{ id: 1, hex: toHex(bytes) }]);
    expect(message.damaged).toBe(false);
  });

  it('encodeOdcMessage writes each picture in order, and no BINARY section for no picture', () => {
    const a = fill(5, 3);
    const b = fill(9, 11);
    const payload = encodeOdcMessage('', [
      { id: 1, name: '../a b/\u00e9"><x.gif', bytes: a, width: 1, height: 2 },
      { id: 2, name: 'b.bmp', bytes: b, width: 3, height: 4 },
    ]);
    const message = decodeOdcMessage(payload, 0, MAX);
    expect(message.segments).toEqual([{ image: { id: 1, name: '.._a_b_____x.gif' } }, { image: { id: 2, name: 'b.bmp' } }]);
    expect(summary(message)).toEqual([{ id: 1, hex: toHex(a) }, { id: 2, hex: toHex(b) }]);
    expect(Buffer.from(encodeOdcMessage('hi \u2603', [])).toString('latin1')).toBe('hi &#9731;');
  });

  it('encodeOdcMessage refuses an id outside 1 to 65535, a repeated id and a size that is not a whole number', () => {
    const picture = { id: 1, name: 'a.png', bytes: fill(4, 3), width: 1, height: 1 };
    expect(() => encodeOdcMessage('', [{ ...picture, id: 0 }])).toThrow(RangeError);
    expect(() => encodeOdcMessage('', [{ ...picture, id: 65536 }])).toThrow(RangeError);
    expect(() => encodeOdcMessage('', [picture, picture])).toThrow(RangeError);
    expect(() => encodeOdcMessage('', [{ ...picture, width: 1.5 }])).toThrow(RangeError);
    expect(() => encodeOdcMessage('', [{ ...picture, height: -1 }])).toThrow(RangeError);
  });
});
