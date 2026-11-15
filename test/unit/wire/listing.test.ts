import { describe, expect, it } from 'vitest';
import { toHex } from '../../../src/wire/bytes.js';
import {
  GET_FILE_MAX_ENTRIES, GET_FILE_MAX_LISTING_BYTES, GET_FILE_MAX_NAME_BYTES, GET_FILE_MAX_SERVING, ICBM_CHARSET_UNICODE,
} from '../../../src/wire/constants.js';
import {
  LISTING_COLUMNS, LISTING_NAME, decodeListing, encodeListing, listingAck, listingDone, listingHeader, listingLength, pathParts,
  requestHeader, requestedPath,
} from '../../../src/wire/listing.js';
import type { ListingEntry } from '../../../src/wire/listing.js';
import {
  OFT_CHECKSUM_START, OFT_FILE_REQUEST, OFT_LISTING, OFT_LISTING_ACK, OFT_LISTING_DONE, OFT_PROMPT, answerOftFrame, decodeOftFrame,
  encodeOftHeader, oftChecksum,
} from '../../../src/wire/oft.js';
import type { OftFrame } from '../../../src/wire/oft.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';

const FILE = loadVectors('aim-get-file.json');
const COOKIE = 0x0102030405060708n;
const MAX = 20_000;
const AIM_COLUMNS = { sizeOffset: 0x10, nameOffset: 0x1a };

const frame = (name: string): OftFrame => decodeOftFrame(bytesOf(FILE, name));

// The date of a line is local time.
function seconds(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute).getTime() / 1000;
}

function latin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

// A line with the columns of this codec.
function line(size: string, name: string): string {
  return `11/01/2002 12:00 ${size.padStart(10)} ${name}\r\n`;
}

// A line with the columns of AIM.
function aimLine(size: string, name: string): string {
  return `11/01/2002 12:00${size.padStart(9)} ${name}\r\n`;
}

const AT = seconds(2002, 11, 1, 12, 0);
const SHARED_AT = seconds(2026, 11, 12, 16, 40);
const file = (name: string, bytes: number, modifiedAt = AT): ListingEntry => ({ path: name.split('\\'), bytes, modifiedAt });
const own = (bytes: Uint8Array, max = MAX) => decodeListing(bytes, LISTING_COLUMNS, max);

// The 207 files of the folder that the two listings of the vectors show.
function shared(): ListingEntry[] {
  const many = Array.from({ length: 200 }, (_, i) => file(`many\\f-${String(i).padStart(3, '0')}.txt`, 16, SHARED_AT));
  return [
    file('a.txt', 1024, SHARED_AT), file('b.bin', 1048576, SHARED_AT), file('caf\u00e9.txt', 64, SHARED_AT), ...many,
    file('name with space.txt', 64, SHARED_AT), file('player.exe', 64, SHARED_AT), file('sub\\c.txt', 64, SHARED_AT),
    file('sub\\deep\\d.txt', 64, SHARED_AT),
  ];
}

describe('the limits and the frame types', () => {
  it('have their values', () => {
    expect([OFT_LISTING, OFT_LISTING_ACK, OFT_LISTING_DONE, OFT_FILE_REQUEST]).toEqual([0x1108, 0x1209, 0x120b, 0x120c]);
    expect(GET_FILE_MAX_LISTING_BYTES).toBe(16 * 1024 * 1024);
    expect(GET_FILE_MAX_ENTRIES).toBe(65_535);
    expect(GET_FILE_MAX_SERVING).toBe(4);
    expect(GET_FILE_MAX_NAME_BYTES).toBe(1024);
    expect(LISTING_COLUMNS).toEqual({ sizeOffset: 17, nameOffset: 28 });
    expect(LISTING_NAME).toBe('listing.txt');
  });
});

describe('the listing of AIM', () => {
  it('read at the columns of its header: 207 files of the whole tree, no folder', () => {
    const header = frame('5.1 listing header');
    expect([header.sizeOffset, header.nameOffset]).toEqual([AIM_COLUMNS.sizeOffset, AIM_COLUMNS.nameOffset]);
    const read = decodeListing(bytesOf(FILE, '5.1 listing'), header, GET_FILE_MAX_ENTRIES);
    expect(read).toEqual({ entries: shared(), truncated: false, damaged: false });
    expect(read.entries.at(-1)).toEqual({ path: ['sub', 'deep', 'd.txt'], bytes: 64, modifiedAt: SHARED_AT });
  });

  it('the header has the count of the files, the sum of their sizes, and the length and the checksum of the listing', () => {
    const { header } = frame('5.1 listing header');
    const body = bytesOf(FILE, '5.1 listing');
    const files = shared();
    expect([header.totalFiles, header.filesLeft]).toEqual([files.length, files.length]);
    expect(header.totalBytes).toBe(files.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(listingLength(header)).toBe(body.length);
    expect(header.checksum).toBe(oftChecksum(body));
    expect(header.name).toBe(LISTING_NAME);
  });

  it('read at the columns of this codec, the listing of AIM gives no entry', () => {
    const read = own(bytesOf(FILE, '5.1 listing'));
    expect([read.entries.length, read.damaged]).toEqual([0, true]);
  });
});

describe('the listing that this codec writes', () => {
  it('encodeListing writes the bytes that AIM read', () => {
    const written = encodeListing(shared());
    expect(toHex(written.bytes)).toBe(vector(FILE, 'listing that 5.1 read').hex);
    expect([written.files, written.totalBytes]).toEqual([207, 1053120]);
  });

  it('listingHeader makes the header that AIM answered', () => {
    const answered = frame('listing header that 5.1 answered');
    const header = listingHeader(answered.header.cookie, encodeListing(shared()), answered.header.modifiedAt);
    expect(toHex(encodeOftHeader(header))).toBe(toHex(answered.bytes));
    expect(header).toEqual(answered.header);
  });

  it('the offsets of the header are the columns of the lines', () => {
    const written = encodeListing([file('a.txt', 1024)]);
    const header = decodeOftFrame(encodeOftHeader(listingHeader(COOKIE, written, AT)));
    expect([header.sizeOffset, header.nameOffset]).toEqual([LISTING_COLUMNS.sizeOffset, LISTING_COLUMNS.nameOffset]);
    const line0 = text(written.bytes);
    expect(line0.slice(0, 16)).toBe('11/01/2002 12:00');
    expect(line0.slice(header.sizeOffset, header.nameOffset - 1)).toBe('      1024');
    expect(line0[header.nameOffset - 1]).toBe(' ');
    expect(line0.slice(header.nameOffset)).toBe('a.txt\r\n');
    expect(decodeListing(written.bytes, header, MAX)).toEqual({ entries: [file('a.txt', 1024)], truncated: false, damaged: false });
  });

  it('the header counts the lines that encodeListing wrote, not the entries that it got', () => {
    const written = encodeListing([file('a.txt', 10), file('big.bin', 4294967296), file('sub\\c.txt', 5), file('..', 1)]);
    const header = listingHeader(COOKIE, written, AT);
    expect([written.files, written.totalBytes]).toEqual([2, 15]);
    expect(header).toEqual({
      type: OFT_LISTING, cookie: COOKIE, totalFiles: 2, filesLeft: 2, totalParts: 1, partsLeft: 1, totalBytes: 15, bytes: written.bytes.length,
      modifiedAt: AT, checksum: oftChecksum(written.bytes), received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: 0, name: 'listing.txt',
    });
    expect(own(written.bytes).entries).toEqual([file('a.txt', 10), file('sub\\c.txt', 5)]);
  });

  it('a listing of no file has no byte, the count 0 and the checksum of no byte', () => {
    const written = encodeListing([]);
    expect(written).toEqual({ form: 'text', bytes: new Uint8Array(0), files: 0, totalBytes: 0 });
    const header = listingHeader(COOKIE, written, AT);
    expect([header.totalFiles, header.bytes, header.checksum]).toEqual([0, 0, OFT_CHECKSUM_START]);
    expect(own(new Uint8Array(0))).toEqual({ entries: [], truncated: false, damaged: false });
  });

  it('the sum of the sizes stays in 32 bits', () => {
    const written = encodeListing([file('a.bin', 4294967295), file('b.bin', 4294967295), file('c.bin', 3)]);
    expect([written.files, written.totalBytes]).toEqual([3, 1]);
    expect(listingHeader(COOKIE, written, AT).totalBytes).toBe(1);
  });

  it('encodeListing writes no more than 65535 lines', () => {
    const entries = Array.from({ length: GET_FILE_MAX_ENTRIES + 5 }, (_, i) => file(`f${i}`, 1));
    const written = encodeListing(entries);
    expect(written.files).toBe(GET_FILE_MAX_ENTRIES);
    expect(listingHeader(COOKIE, written, AT).totalFiles).toBe(GET_FILE_MAX_ENTRIES);
    expect(text(written.bytes).split('\r\n').length - 1).toBe(GET_FILE_MAX_ENTRIES);
  });

  it('listingHeader throws RangeError for a time out of range', () => {
    expect(() => listingHeader(COOKIE, encodeListing([]), -1)).toThrow(RangeError);
    expect(() => listingHeader(COOKIE, encodeListing([]), 0x1_0000_0000)).toThrow(RangeError);
  });

  it('encodeListing then decodeListing gives the same entries', () => {
    const entries: ListingEntry[] = [
      { path: ['top', 'sub', 'x.txt'], bytes: 0, modifiedAt: AT },
      { path: ['top', 'caf\u00e9 menu.txt'], bytes: 12, modifiedAt: AT + 60 },
      { path: [' spaced .bin'], bytes: 0xffff_ffff, modifiedAt: seconds(1999, 2, 28, 23, 59) },
    ];
    expect(own(encodeListing(entries).bytes)).toEqual({ entries, truncated: false, damaged: false });
  });

  it('encodeListing leaves out an entry of 4294967296 bytes and keeps one of 4294967295', () => {
    const kept = file('edge.bin', 4294967295);
    expect(own(encodeListing([file('big.bin', 4294967296), kept]).bytes)).toEqual({ entries: [kept], truncated: false, damaged: false });
  });

  it('encodeListing leaves out a name that a line cannot hold', () => {
    const kept = file('ok.txt', 1);
    const parts = ['a\rb', 'a\nb', 'a\u0000b', 'a\\b', 'a/b', 'a\u0001b', '..', '', '\u4e2d.txt'];
    const bad: ListingEntry[] = [
      ...parts.map((part) => ({ path: [part], bytes: 1, modifiedAt: AT })),
      ...parts.map((part) => ({ path: ['sub', part], bytes: 1, modifiedAt: AT })),
      { path: ['C:', 'x'], bytes: 1, modifiedAt: AT },
      { path: [], bytes: 0, modifiedAt: AT },
      { path: ['half.bin'], bytes: 1.5, modifiedAt: AT },
      { path: ['less.bin'], bytes: -1, modifiedAt: AT },
      { path: ['a'.repeat(GET_FILE_MAX_NAME_BYTES + 1)], bytes: 1, modifiedAt: AT },
      { path: ['a'.repeat(600), 'b'.repeat(600)], bytes: 1, modifiedAt: AT },
    ];
    const written = encodeListing([...bad, kept]);
    expect(written.files).toBe(1);
    expect(own(written.bytes)).toEqual({ entries: [kept], truncated: false, damaged: false });
  });
});

describe('the lines of a listing', () => {
  it('a line is read at the columns that it gets: the columns of AIM and the columns of this codec', () => {
    const aim = latin1(aimLine('1024', 'a.txt') + aimLine('123456789', 'sub\\deep\\d.txt'));
    const entries = [file('a.txt', 1024), file('sub\\deep\\d.txt', 123456789)];
    expect(decodeListing(aim, AIM_COLUMNS, MAX)).toEqual({ entries, truncated: false, damaged: false });
    const kit = latin1(line('1024', 'a.txt') + line('123456789', 'sub\\deep\\d.txt'));
    expect(own(kit)).toEqual({ entries, truncated: false, damaged: false });
    // The lines of this codec, read at the columns of AIM: no size is there.
    expect(decodeListing(kit, AIM_COLUMNS, MAX)).toEqual({ entries: [], truncated: false, damaged: true });
  });

  it('columns that are not after the date, or a name column that is not after the size, give no entry', () => {
    const bytes = latin1(line('1', 'a.txt'));
    for (const columns of [{ sizeOffset: 0, nameOffset: 0 }, { sizeOffset: 15, nameOffset: 28 }, { sizeOffset: 17, nameOffset: 18 }, { sizeOffset: 28, nameOffset: 17 }, { sizeOffset: 17.5, nameOffset: 28 }]) {
      expect(decodeListing(bytes, columns, MAX), JSON.stringify(columns)).toEqual({ entries: [], truncated: false, damaged: true });
      expect(decodeListing(new Uint8Array(0), columns, MAX)).toEqual({ entries: [], truncated: false, damaged: false });
    }
  });

  it('a name that ends with a backslash is not an entry: a listing has no folder', () => {
    const read = own(latin1(line('0', 'sub\\') + line('7', 'c.txt')));
    expect(read).toEqual({ entries: [file('c.txt', 7)], truncated: false, damaged: true });
  });

  it('a line with size "99999999999", a line of 10 characters and a line with no CR LF: skipped, damaged true, the good lines kept', () => {
    const bytes = latin1(`${line('1', 'good1.txt')}${line('99999999999', 'big.bin')}0123456789\r\n${line('2', 'good2.txt')}${line('3', 'tail.txt').slice(0, -2)}`);
    expect(own(bytes)).toEqual({ entries: [file('good1.txt', 1), file('good2.txt', 2)], truncated: false, damaged: true });
    for (const bad of [line('12a4', 'x.txt'), line('-1', 'x.txt'), line('4294967296', 'x.txt'), line('', 'x.txt'), line('1', ''), '11/01/2002 12:00 1024        a.txt\r\n']) {
      expect(own(latin1(line('1', 'good.txt') + bad)), bad).toEqual({ entries: [file('good.txt', 1)], truncated: false, damaged: true });
    }
    expect(own(latin1(line('4294967295', 'x.txt'))).entries).toEqual([file('x.txt', 4294967295)]);
  });

  it('a date that is not a date gives modifiedAt 0 and keeps the line', () => {
    for (const date of ['13/01/2002 12:00', '11/01/2002 24:00', 'yesterday, 12:00']) {
      const read = own(latin1(`${date} ${'5'.padStart(10)} x.txt\r\n`));
      expect(read, date).toEqual({ entries: [file('x.txt', 5, 0)], truncated: false, damaged: false });
    }
  });

  it('300000 lines with maxEntries 20000: 20000 entries, truncated true', () => {
    const parts: string[] = [];
    for (let i = 0; i < 300_000; i++) parts.push(line(String(i), `file-${i}.txt`));
    const read = own(latin1(parts.join('')));
    expect(read.entries.length).toBe(MAX);
    expect(read.truncated).toBe(true);
    expect(read.damaged).toBe(false);
    expect(read.entries[MAX - 1]).toEqual(file(`file-${MAX - 1}.txt`, MAX - 1));
    const exact = own(latin1(parts.slice(0, MAX).join('')));
    expect([exact.entries.length, exact.truncated]).toEqual([MAX, false]);
  });

  it('a name "..\\..\\x.exe", "/etc/passwd", "C:\\x", "a\\u0001..\\u0001b" and "a\\u0000b": the line is skipped and damaged is set', () => {
    const names = ['..\\..\\x.exe', '/etc/passwd', 'C:\\x', 'a\u0001..\u0001b', 'a\u0000b', '\\', '..\\', 'sub\\..\\x', 'sub\\\\x'];
    for (const name of names) {
      expect(own(latin1(line('1', name))), name).toEqual({ entries: [], truncated: false, damaged: true });
    }
    const read = own(latin1(names.map((name) => line('1', name)).join('') + line('5', 'ok.txt')));
    expect(read).toEqual({ entries: [file('ok.txt', 5)], truncated: false, damaged: true });
  });
});

describe('the parts of a name', () => {
  it('pathParts("sub\\u0001c.txt") is ["sub", "c.txt"]; pathParts("sub\\\\c.txt") the same', () => {
    expect(pathParts('sub\u0001c.txt')).toEqual(['sub', 'c.txt']);
    expect(pathParts('sub\\c.txt')).toEqual(['sub', 'c.txt']);
    expect(pathParts('sub/c.txt')).toEqual(['sub', 'c.txt']);
    expect(pathParts('c.txt')).toEqual(['c.txt']);
    expect(pathParts('a b\u0001.hidden\u0001x..y')).toEqual(['a b', '.hidden', 'x..y']);
  });

  it('pathParts gives null for "", "..", ".", "a//b", "\\\\a", "C:\\\\a", and a name of 1025 bytes', () => {
    for (const name of ['', '..', '.', 'a//b', '\\a', 'C:\\a', 'C:', 'a\u0001..\u0001b', 'a\u0001.', 'a\u0001', '/a', '\u0001a', 'a\u0000b', 'a\tb', 'a\r\nb']) {
      expect(pathParts(name), JSON.stringify(name)).toBeNull();
    }
    expect(pathParts('a'.repeat(GET_FILE_MAX_NAME_BYTES + 1))).toBeNull();
    expect(pathParts('a'.repeat(GET_FILE_MAX_NAME_BYTES))).toEqual(['a'.repeat(GET_FILE_MAX_NAME_BYTES)]);
    // A name that is not ASCII has 2 bytes for each character in a header.
    expect(pathParts('\u00e9'.repeat(GET_FILE_MAX_NAME_BYTES / 2 + 1))).toBeNull();
    expect(pathParts('\u00e9'.repeat(GET_FILE_MAX_NAME_BYTES / 2))).not.toBeNull();
  });

  it('pathParts gives null for a part of dots and spaces only', () => {
    for (const name of ['...', '.. ', ' ', 'a\u0001. .\u0001b']) expect(pathParts(name), JSON.stringify(name)).toBeNull();
  });
});

describe('the answers to a listing header', () => {
  it('listingAck and listingDone make the bytes that AIM took', () => {
    const listing = frame('5.1 listing header');
    const body = bytesOf(FILE, '5.1 listing');
    expect(toHex(listingAck(listing).bytes)).toBe(vector(FILE, 'listing acknowledge that 5.1 took').hex);
    const done = listingDone(listing, body);
    expect(toHex(done.bytes)).toBe(vector(FILE, 'listing done that 5.1 took').hex);
    expect([done.header.type, done.header.received, done.header.receivedChecksum]).toEqual([OFT_LISTING_DONE, body.length, oftChecksum(body)]);
    expect(listingAck(listing).header.type).toBe(OFT_LISTING_ACK);
  });

  it('listingDone gives the count and the checksum of the bytes that came, not of the header', () => {
    const listing = frame('5.1 listing header');
    const part = bytesOf(FILE, '5.1 listing').subarray(0, 100);
    const done = listingDone(listing, part);
    expect([done.header.received, done.header.receivedChecksum, done.header.bytes]).toEqual([100, oftChecksum(part), listing.header.bytes]);
    expect(done.flags & 0x01).toBe(0x01);
    expect(listingAck(listing).flags & 0x01).toBe(0);
  });

  it('the answers keep the cookie, the offsets and the id text of the holder', () => {
    const listing = decodeOftFrame(encodeOftHeader(listingHeader(COOKIE, encodeListing([file('a.txt', 1)]), AT)));
    for (const answer of [listingAck(listing), listingDone(listing, new Uint8Array(0))]) {
      expect([answer.header.cookie, answer.idText, answer.nameOffset, answer.sizeOffset]).toEqual([COOKIE, listing.idText, 28, 17]);
    }
  });
});

describe('the request for one file', () => {
  it('requestHeader makes the request of AIM for a name at the top and for a path, byte for byte', () => {
    const top = requestHeader(frame('5.1 listing done'), ['a.txt']);
    expect(toHex(top.bytes)).toBe(vector(FILE, '5.1 request, a name at the top').hex);
    const deep = requestHeader(frame('5.1 done'), ['sub', 'c.txt']);
    expect(toHex(deep.bytes)).toBe(vector(FILE, '5.1 request, a path').hex);
  });

  it('requestHeader(["sub","c.txt"]) has type 0x120c, the name sub\\u0001c.txt, the sizes zero and the flag bit', () => {
    const last = listingDone(frame('5.1 listing header'), bytesOf(FILE, '5.1 listing'));
    const request = requestHeader(last, ['sub', 'c.txt']);
    expect(request.header).toEqual({ ...last.header, type: OFT_FILE_REQUEST, totalBytes: 0, bytes: 0, name: 'sub\u0001c.txt' });
    expect([request.flags, request.nameOffset, request.sizeOffset, request.idText]).toEqual([0x03, 0x1a, 0x10, last.idText]);
    expect(requestedPath(request)).toEqual(['sub', 'c.txt']);
    expect(toHex(request.bytes)).toBe(toHex(answerOftFrame(last, { type: OFT_FILE_REQUEST, name: 'sub\u0001c.txt' }).bytes));
  });

  it('requestedPath reads the requests of AIM', () => {
    expect(requestedPath(frame('5.1 request, a name at the top'))).toEqual(['a.txt']);
    expect(requestedPath(frame('5.1 request, a path'))).toEqual(['sub', 'c.txt']);
  });

  it('a name in Latin-1 comes back as it went; bytes that are UTF-8 also are read as Latin-1', () => {
    const last = frame('5.1 done');
    expect(requestedPath(requestHeader(last, ['caf\u00e9.txt']))).toEqual(['caf\u00e9.txt']);
    expect(requestedPath(requestHeader(last, ['\u00c3\u00a9.txt']))).toEqual(['\u00c3\u00a9.txt']);
    const wide = requestHeader(last, ['caf\u00e9', '\u4e2d.txt']);
    expect(wide.header.nameEncoding).toBe(ICBM_CHARSET_UNICODE);
    expect(requestedPath(wide)).toEqual(['caf\u00e9', '\u4e2d.txt']);
  });

  it('requestHeader throws RangeError for a path that is not a path below the shared folder', () => {
    const last = frame('5.1 done');
    for (const path of [[], ['..', 'x'], ['a\\b'], ['a', ''], ['a\u0001b'], ['a'.repeat(GET_FILE_MAX_NAME_BYTES + 1)]]) {
      expect(() => requestHeader(last, path), JSON.stringify(path).slice(0, 40)).toThrow(RangeError);
    }
  });

  it('requestedPath is null for a request named "..\\u0001x", for no name, and for a header that is not a request', () => {
    const last = frame('5.1 done');
    expect(requestedPath(answerOftFrame(last, { type: OFT_FILE_REQUEST, name: '..\u0001x' }))).toBeNull();
    expect(requestedPath(answerOftFrame(last, { type: OFT_FILE_REQUEST, name: '' }))).toBeNull();
    expect(requestedPath(answerOftFrame(last, { type: OFT_PROMPT, name: 'a.txt' }))).toBeNull();
    expect(requestedPath(frame('5.1 listing done'))).toBeNull();
  });
});
