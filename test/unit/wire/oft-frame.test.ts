import { describe, expect, it } from 'vitest';
import { OscarDecodeError, fromHex, toHex } from '../../../src/wire/bytes.js';
import { ICBM_CHARSET_ASCII, ICBM_CHARSET_UNICODE } from '../../../src/wire/constants.js';
import {
  OFT_ACK, OFT_CHECKSUM_START, OFT_DONE, OFT_FILE_REQUEST, OFT_FLAG_RECEIVED, OFT_LISTING_ACK, OFT_LISTING_DONE, OFT_NAME_OFFSET,
  OFT_PROMPT, OFT_SIZE_OFFSET, answerOftFrame, decodeOftFrame, decodeOftHeader, encodeOftHeader,
} from '../../../src/wire/oft.js';
import type { OftFrame, OftHeader } from '../../../src/wire/oft.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';
import type { Vector } from '../../support/vectors.js';

const FILE = loadVectors('aim-get-file.json');
const HEADERS = FILE.vectors.filter((v) => v.inputs?.kind === 'header');
const frame = (name: string): OftFrame => decodeOftFrame(bytesOf(FILE, name));

// AIM writes its own id text and zero in the two checksums of the resource fork. All other bytes are the bytes of an answer.
function withoutIdAndForks(bytes: Uint8Array): string {
  const out = Uint8Array.from(bytes);
  out.fill(0, 44, 48);
  out.fill(0, 56, 60);
  out.fill(0, 68, 100);
  return toHex(out);
}

const SAMPLE: OftHeader = {
  type: OFT_PROMPT, cookie: 0x0102030405060708n, totalFiles: 1, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: 7, bytes: 7,
  modifiedAt: 1036152000, checksum: 0x12340000, received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: ICBM_CHARSET_ASCII,
  name: 'a.txt',
};

describe('the vectors of Get File', () => {
  it('the source says the client and the day, and each vector has a note', () => {
    expect(FILE.source).toMatch(/^Captured from AIM 5\.1\.3036 on 2026-11-12/);
    expect(HEADERS).toHaveLength(16);
    for (const v of FILE.vectors) expect(v.note, v.name).toMatch(/^(AIM 5\.1\.3036 wrote this\.|A test client wrote this, and AIM 5\.1\.3036 |The body of the client error )/);
  });
});

describe('a header as it was read', () => {
  it.each(HEADERS.map((v): [string, Vector] => [v.name, v]))('%s: the frame has the id text, the flags and the two offsets', (_name, v) => {
    const bytes = fromHex(v.hex);
    const read = decodeOftFrame(bytes);
    const n = (key: string): number => Number(v.inputs?.[key]);
    expect(read.header).toEqual(decodeOftHeader(bytes));
    expect(read.header.type).toBe(n('type'));
    expect([read.header.totalFiles, read.header.totalBytes, read.header.bytes]).toEqual([n('totalFiles'), n('totalBytes'), n('bytes')]);
    expect([read.header.checksum, read.header.received, read.header.receivedChecksum]).toEqual([n('checksum'), n('received'), n('receivedChecksum')]);
    expect(read.header.name).toBe(v.inputs?.name);
    expect(read.idText).toBe(v.inputs?.idText);
    expect([read.flags, read.nameOffset, read.sizeOffset]).toEqual([n('flags'), n('nameOffset'), n('sizeOffset')]);
    expect(toHex(read.bytes)).toBe(v.hex);
  });

  it('the header of AIM has the offsets 0x1a and 0x10, and a header of encodeOftHeader has 0x1c and 0x11', () => {
    const aim = frame('5.1 listing header');
    expect([aim.idText, aim.flags, aim.nameOffset, aim.sizeOffset]).toEqual(['OFT_Windows ICBMFT V1.1 32', 0x02, 0x1a, 0x10]);
    const own = decodeOftFrame(encodeOftHeader(SAMPLE));
    expect([own.idText, own.flags, own.nameOffset, own.sizeOffset]).toEqual(['Cool FileXfer', 0x20, 0x1c, 0x11]);
    expect([OFT_NAME_OFFSET, OFT_SIZE_OFFSET, OFT_FLAG_RECEIVED]).toEqual([0x1c, 0x11, 0x01]);
    expect(own.header).toEqual(SAMPLE);
  });

  it('the frame keeps its own copy of the header, and no byte after it', () => {
    const bytes = new Uint8Array(300);
    bytes.set(encodeOftHeader(SAMPLE));
    const read = decodeOftFrame(bytes);
    expect(read.bytes.length).toBe(256);
    bytes[100] = 0xff;
    expect(read.bytes[100]).toBe(0x20);
  });

  it('decodeOftFrame throws on bytes that decodeOftHeader refuses', () => {
    const bytes = encodeOftHeader(SAMPLE);
    expect(() => decodeOftFrame(bytes.subarray(0, 255))).toThrow(OscarDecodeError);
    expect(() => decodeOftFrame(new Uint8Array(0))).toThrow(OscarDecodeError);
    const other = Uint8Array.from(bytes);
    other[3] = 0x33;
    expect(() => decodeOftFrame(other)).toThrow(OscarDecodeError);
  });
});

describe('an answer made from a header that was read', () => {
  it('an acknowledge of a listing is the header with a different type: the bytes that AIM took', () => {
    const answer = answerOftFrame(frame('5.1 listing header'), { type: OFT_LISTING_ACK });
    expect(toHex(answer.bytes)).toBe(vector(FILE, 'listing acknowledge that 5.1 took').hex);
    expect(answer.flags).toBe(0x02);
  });

  it('a done of a listing has the count, the checksum and the flag bit: the bytes that AIM took', () => {
    const answer = answerOftFrame(frame('5.1 listing header'), { type: OFT_LISTING_DONE, received: { bytes: 8666, checksum: 0x40730000 } });
    expect(toHex(answer.bytes)).toBe(vector(FILE, 'listing done that 5.1 took').hex);
    expect([answer.flags, answer.header.received, answer.header.receivedChecksum]).toEqual([0x03, 8666, 0x40730000]);
  });

  it('the ack and the done of a file: the bytes that AIM took', () => {
    const prompt = frame('5.1 prompt');
    expect(toHex(answerOftFrame(prompt, { type: OFT_ACK }).bytes)).toBe(vector(FILE, 'ack that 5.1 took').hex);
    const done = answerOftFrame(prompt, { type: OFT_DONE, received: { bytes: 1024, checksum: 0x2abd0000 } });
    expect(toHex(done.bytes)).toBe(vector(FILE, 'done that 5.1 took').hex);
    expect(done.flags).toBe(0x21);
  });

  it('the answers of AIM to a listing header are the answers of answerOftFrame, but for the id text and the fork checksums', () => {
    const listing = frame('listing header that 5.1 answered');
    const ack = answerOftFrame(listing, { type: OFT_LISTING_ACK });
    expect(withoutIdAndForks(ack.bytes)).toBe(withoutIdAndForks(bytesOf(FILE, '5.1 listing acknowledge')));
    const done = answerOftFrame(listing, { type: OFT_LISTING_DONE, received: { bytes: 9080, checksum: 0x46790000 } });
    expect(withoutIdAndForks(done.bytes)).toBe(withoutIdAndForks(bytesOf(FILE, '5.1 listing done')));
    const request = answerOftFrame(done, { type: OFT_FILE_REQUEST, name: 'a.txt' });
    expect(withoutIdAndForks(request.bytes)).toBe(withoutIdAndForks(bytesOf(FILE, '5.1 request, a name at the top')));
  });

  it('the answers of AIM to a prompt, and its next request, the same', () => {
    const prompt = frame('prompt that 5.1 answered');
    expect(withoutIdAndForks(answerOftFrame(prompt, { type: OFT_ACK }).bytes)).toBe(withoutIdAndForks(bytesOf(FILE, '5.1 ack')));
    const done = answerOftFrame(prompt, { type: OFT_DONE, received: { bytes: 1024, checksum: 0x2abd0000 } });
    expect(withoutIdAndForks(done.bytes)).toBe(withoutIdAndForks(bytesOf(FILE, '5.1 done')));
    const request = answerOftFrame(done, { type: OFT_FILE_REQUEST, name: 'sub\u0001c.txt' });
    expect(withoutIdAndForks(request.bytes)).toBe(withoutIdAndForks(bytesOf(FILE, '5.1 request, a path')));
  });

  it('an answer made from an answer of AIM is that answer, byte for byte', () => {
    const done = frame('5.1 listing done');
    expect(toHex(answerOftFrame(done, { type: OFT_FILE_REQUEST, name: 'a.txt' }).bytes)).toBe(vector(FILE, '5.1 request, a name at the top').hex);
    expect(toHex(answerOftFrame(frame('5.1 done'), { type: OFT_FILE_REQUEST, name: 'sub\u0001c.txt' }).bytes)).toBe(vector(FILE, '5.1 request, a path').hex);
  });

  it('a request has the sizes zero, the flag bit set and the name; all other fields are the fields of the header', () => {
    const from = frame('5.1 listing header');
    const request = answerOftFrame(from, { type: OFT_FILE_REQUEST, name: 'sub\u0001c.txt' });
    expect(request.header).toEqual({ ...from.header, type: OFT_FILE_REQUEST, totalBytes: 0, bytes: 0, name: 'sub\u0001c.txt' });
    expect([request.idText, request.flags, request.nameOffset, request.sizeOffset]).toEqual([from.idText, 0x03, 0x1a, 0x10]);
    expect(request.bytes.length).toBe(256);
  });

  it('an answer changes no byte of the header that was read', () => {
    const from = frame('5.1 prompt');
    const before = toHex(from.bytes);
    answerOftFrame(from, { type: OFT_DONE, received: { bytes: 1, checksum: 2 } });
    answerOftFrame(from, { type: OFT_FILE_REQUEST, name: 'x' });
    expect(toHex(from.bytes)).toBe(before);
  });

  it('a name in Latin-1 has one byte for each character and the encoding 0, as AIM writes it', () => {
    const request = answerOftFrame(frame('5.1 done'), { type: OFT_FILE_REQUEST, name: 'café.txt' });
    expect(toHex(request.bytes.subarray(192, 201))).toBe('636166e92e74787400');
    expect(request.header.nameEncoding).toBe(ICBM_CHARSET_ASCII);
  });

  it('a name that Latin-1 cannot hold is UTF-16 with the encoding 2', () => {
    const request = answerOftFrame(frame('5.1 done'), { type: OFT_FILE_REQUEST, name: '中.txt' });
    expect(request.header.nameEncoding).toBe(ICBM_CHARSET_UNICODE);
    expect(request.header.name).toBe('中.txt');
    const back = answerOftFrame(request, { type: OFT_FILE_REQUEST, name: 'a.txt' });
    expect([back.header.nameEncoding, back.header.name]).toEqual([ICBM_CHARSET_ASCII, 'a.txt']);
  });

  it('a name of 64 bytes or more makes the header longer', () => {
    const name = `${'n'.repeat(96)}.txt`;
    const from = frame('5.1 done');
    const request = answerOftFrame(from, { type: OFT_FILE_REQUEST, name });
    expect(request.bytes.length).toBe(192 + 101);
    expect(request.header).toEqual({ ...from.header, type: OFT_FILE_REQUEST, totalBytes: 0, bytes: 0, name });
    expect(toHex(request.bytes.subarray(6, 192))).toBe(toHex(answerOftFrame(from, { type: OFT_FILE_REQUEST, name: 'a' }).bytes.subarray(6, 192)));
    expect(answerOftFrame(from, { type: OFT_FILE_REQUEST, name: 'n'.repeat(63) }).bytes.length).toBe(256);
    expect(answerOftFrame(from, { type: OFT_FILE_REQUEST, name: 'n'.repeat(64) }).bytes.length).toBe(257);
  });

  it('answerOftFrame throws RangeError for a value out of range and for a name with a zero character', () => {
    const from = frame('5.1 prompt');
    expect(() => answerOftFrame(from, { type: 0x1_0000 })).toThrow(RangeError);
    expect(() => answerOftFrame(from, { type: OFT_DONE, received: { bytes: -1, checksum: 0 } })).toThrow(RangeError);
    expect(() => answerOftFrame(from, { type: OFT_DONE, received: { bytes: 0, checksum: 0x1_0000_0000 } })).toThrow(RangeError);
    expect(() => answerOftFrame(from, { type: OFT_FILE_REQUEST, name: 'a\u0000b' })).toThrow(RangeError);
    expect(() => answerOftFrame(from, { type: OFT_FILE_REQUEST, name: 'n'.repeat(0x1_0000) })).toThrow(RangeError);
  });
});
