import { describe, expect, it } from 'vitest';
import { ByteWriter, fromHex, toHex } from '../../../src/wire/bytes.js';
import { GET_FILE_MAX_ENTRIES, GET_FILE_MAX_NAME_BYTES, ICBM_CHANNEL_RENDEZVOUS } from '../../../src/wire/constants.js';
import {
  LISTING_COLUMNS, LISTING_FOLDER, LISTING_LST1_NUMBER, decodeListing, decodeLst1Listing, encodeListing, encodeLst1Listing, listingAck,
  listingDone, listingFolder, listingFormFor, listingFrame, listingHeader, readListing, requestHeader, requestedFile, requestedPath,
} from '../../../src/wire/listing.js';
import type { ListingEntry } from '../../../src/wire/listing.js';
import {
  OFT_ACK, OFT_CHECKSUM_START, OFT_DONE, OFT_FILE_REQUEST, OFT_FLAGS, OFT_FLAG_LST1, OFT_LISTING, OFT_LISTING_ACK, OFT_LISTING_DONE,
  OFT_LISTING_UNREAD, OFT_PROMPT, answerOftFrame, decodeOftFrame, decodeOftHeader, encodeOftHeader, oftChecksum,
} from '../../../src/wire/oft.js';
import type { OftFrame } from '../../../src/wire/oft.js';
import { encodeGetFileProposal, getFileProposalNumber, parseRendezvous } from '../../../src/wire/rendezvous.js';
import { encodeUserInfo } from '../../../src/wire/snac.js';
import { encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';
import type { Vector } from '../../support/vectors.js';

const FILE = loadVectors('aim-get-file-lst1.json');
const OLDER = loadVectors('aim-get-file.json');
const PROPOSALS = loadVectors('aim-rendezvous.json');
const HEADERS = FILE.vectors.filter((v) => v.inputs?.kind === 'header');
const COOKIE = 0x0102030405060708n;
const MAX = 20_000;
// The time of each generated file of the shared folder, in seconds.
const SHARED_AT = 1794519649;

const frame = (name: string): OftFrame => decodeOftFrame(bytesOf(FILE, name));
const file = (name: string, bytes: number, modifiedAt = SHARED_AT): ListingEntry => ({ path: name.split('\\'), bytes, modifiedAt });
const below = (folder: string, entries: readonly ListingEntry[]): ListingEntry[] => entries.map((entry) => ({ ...entry, path: [folder, ...entry.path] }));

// The 207 files of the folder that the listing of the vectors shows.
function shared(): ListingEntry[] {
  const many = Array.from({ length: 200 }, (_, i) => file(`many\\f-${String(i).padStart(3, '0')}.txt`, 16));
  return [
    file('a.txt', 1024), file('b.bin', 1048576), file('caf\u00e9.txt', 64), ...many, file('name with space.txt', 64), file('player.exe', 64),
    file('sub\\c.txt', 64), file('sub\\deep\\d.txt', 64),
  ];
}

// One record. `fields` are tag and value pairs, and the end tag follows them.
function record(fields: readonly (readonly [number, Uint8Array])[], end = true): Uint8Array {
  const out = new ByteWriter();
  for (const [tag, value] of fields) out.u16(tag).u16(value.length).bytes(value);
  if (end) out.u16(0x0909).u16(0);
  return out.toBytes();
}

const u32 = (value: number): Uint8Array => new ByteWriter().u32(value).toBytes();
const text = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'latin1'));
const good = (path: string, bytes = 5): Uint8Array => record([[0x0101, u32(SHARED_AT)], [0x0303, u32(bytes)], [0x0505, Uint8Array.of(0, 0)], [0x0404, text(path)], [0x0900, u32(0)]]);
const all = (records: readonly Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat([Buffer.from('Lst1', 'latin1'), ...records]));
const lst1 = (...records: Uint8Array[]): Uint8Array => all(records);

// The vectors hold the fragment only. The test puts the head of a channel 2 message from Alice before it.
function toClient(fragment: Uint8Array): Uint8Array {
  const sender = encodeUserInfo({ name: 'Alice', warning: 0, tlvs: [] });
  return new ByteWriter().u64(0n).u16(ICBM_CHANNEL_RENDEZVOUS).bytes(sender).bytes(encodeTlvs([tlv.bytes(0x0005, fragment)])).toBytes();
}

// A Get File proposal with the inner tags that the test gives.
function proposal(inner: Uint8Array, type = 0x0000): Uint8Array {
  const head = bytesOf(PROPOSALS, '5.1 get file proposal').slice(0, 26);
  head[1] = type;
  return toClient(new Uint8Array(Buffer.concat([head, inner])));
}

describe('the vectors of the Lst1 form', () => {
  it('the source says the clients and the day, and each vector has a note', () => {
    expect(FILE.source).toMatch(/^Captured from AIM 5\.9\.3861 and AIM 3\.5 on 2026-11-12/);
    expect(HEADERS).toHaveLength(12);
    for (const v of FILE.vectors) expect(v.note, v.name).toMatch(/^(AIM 5\.9\.3861 wrote this\.|AIM 3\.5 wrote this\.|A test client wrote this, and AIM 5\.9\.3861 )/);
  });

  it.each(HEADERS.map((v): [string, Vector] => [v.name, v]))('%s: the frame has the id text, the flags and the two offsets', (_name, v) => {
    const bytes = fromHex(v.hex);
    const read = decodeOftFrame(bytes);
    const n = (key: string): number => Number(v.inputs?.[key]);
    expect(read.header).toEqual(decodeOftHeader(bytes));
    expect(read.header.type).toBe(n('type'));
    expect([read.header.totalFiles, read.header.filesLeft, read.header.totalBytes, read.header.bytes]).toEqual([n('totalFiles'), n('filesLeft'), n('totalBytes'), n('bytes')]);
    expect([read.header.checksum, read.header.received, read.header.receivedChecksum]).toEqual([n('checksum'), n('received'), n('receivedChecksum')]);
    expect(read.header.name).toBe(v.inputs?.name);
    expect(read.idText).toBe(v.inputs?.idText);
    expect([read.flags, read.nameOffset, read.sizeOffset]).toEqual([n('flags'), n('nameOffset'), n('sizeOffset')]);
  });

  it('the constants have their values', () => {
    expect([OFT_FLAG_LST1, OFT_FLAGS, OFT_LISTING_UNREAD, LISTING_LST1_NUMBER, LISTING_FOLDER]).toEqual([0x10, 0x20, 0x120e, 2, 'shared']);
  });
});

describe('a listing of the Lst1 form that comes', () => {
  it('the listing that AIM 5.9 read: 207 files of the whole tree, each below the folder name', () => {
    const read = decodeLst1Listing(bytesOf(FILE, 'listing that 5.9 read'), GET_FILE_MAX_ENTRIES);
    expect(read).toEqual({ entries: below('share', shared()), truncated: false, damaged: false });
    expect(read.entries.at(-1)).toEqual({ path: ['share', 'sub', 'deep', 'd.txt'], bytes: 64, modifiedAt: SHARED_AT });
    expect(read.entries[2]?.path).toEqual(['share', 'caf\u00e9.txt']);
  });

  it('readListing reads Lst1 when bit 0x10 of the flags is set, and the lines at the columns of the header when it is clear', () => {
    const header = frame('listing header that 5.9 answered');
    const body = bytesOf(FILE, 'listing that 5.9 read');
    expect(header.flags & OFT_FLAG_LST1).toBe(OFT_FLAG_LST1);
    expect(readListing(header, body, GET_FILE_MAX_ENTRIES).entries).toHaveLength(207);
    // The same bytes below a header that has the bit clear are lines that do not decode.
    expect(readListing({ ...header, flags: 0x20 }, body, GET_FILE_MAX_ENTRIES)).toMatchObject({ entries: [], damaged: true });
    const older = decodeOftFrame(bytesOf(OLDER, '5.1 listing header'));
    const lines = bytesOf(OLDER, '5.1 listing');
    expect(readListing(older, lines, GET_FILE_MAX_ENTRIES)).toEqual(decodeListing(lines, older, GET_FILE_MAX_ENTRIES));
    expect(readListing(older, lines, GET_FILE_MAX_ENTRIES).entries).toHaveLength(207);
    // Lines below a header that has the bit set are not records.
    expect(readListing({ ...older, flags: 0x30 }, lines, GET_FILE_MAX_ENTRIES)).toEqual({ entries: [], truncated: false, damaged: true });
  });

  it('the header has the count of the files, 1 left, the length of the listing two times, its checksum and no name', () => {
    const { header } = frame('listing header that 5.9 answered');
    const body = bytesOf(FILE, 'listing that 5.9 read');
    expect([header.totalFiles, header.filesLeft, header.totalBytes, header.bytes]).toEqual([207, 1, body.length, body.length]);
    expect([header.checksum, header.name]).toEqual([oftChecksum(body), '']);
  });

  it('no byte is no entry; four letters that are not Lst1, and fewer than four, are damaged', () => {
    expect(decodeLst1Listing(new Uint8Array(0), MAX)).toEqual({ entries: [], truncated: false, damaged: false });
    expect(decodeLst1Listing(lst1(), MAX)).toEqual({ entries: [], truncated: false, damaged: false });
    for (const bytes of [text('Lst'), text('Lst2'), text('lst1'), new Uint8Array(Buffer.concat([text('Xst1'), good('share\u0001a.txt')]))]) {
      expect(decodeLst1Listing(bytes, MAX)).toEqual({ entries: [], truncated: false, damaged: true });
    }
  });

  it('a record that is cut, in a head or in a value: the records before it are kept and damaged is set', () => {
    const whole = lst1(good('share\u0001a.txt', 1), good('share\u0001b.txt', 2));
    const kept = [{ path: ['share', 'a.txt'], bytes: 1, modifiedAt: SHARED_AT }];
    for (const cut of [1, 3, 5, 12, 30]) {
      expect(decodeLst1Listing(whole.subarray(0, whole.length - cut), MAX), String(cut)).toEqual({ entries: kept, truncated: false, damaged: true });
    }
    // A record with no end tag.
    const open = lst1(good('share\u0001a.txt', 1), record([[0x0303, u32(2)], [0x0404, text('share\u0001b.txt')]], false));
    expect(decodeLst1Listing(open, MAX)).toEqual({ entries: kept, truncated: false, damaged: true });
  });

  it('a record with no path, with no size, or with a size that does not have 4 bytes: skipped, damaged true, the good records kept', () => {
    const bad = [
      record([[0x0101, u32(1)], [0x0303, u32(2)]]),
      record([[0x0101, u32(1)], [0x0404, text('share\u0001x.txt')]]),
      record([[0x0303, Uint8Array.of(0, 2)], [0x0404, text('share\u0001x.txt')]]),
      record([[0x0303, new Uint8Array(8)], [0x0404, text('share\u0001x.txt')]]),
      record([]),
    ];
    for (const one of bad) {
      expect(decodeLst1Listing(lst1(good('share\u0001a.txt', 1), one, good('share\u0001b.txt', 2)), MAX)).toEqual({
        entries: [{ path: ['share', 'a.txt'], bytes: 1, modifiedAt: SHARED_AT }, { path: ['share', 'b.txt'], bytes: 2, modifiedAt: SHARED_AT }],
        truncated: false, damaged: true,
      });
    }
  });

  it('a path "share\\u0001..\\u0001x.exe", "/etc/passwd", "C:\\x", "", a part of spaces, and a name of 1025 bytes: skipped and damaged', () => {
    const names = ['share\u0001..\u0001x.exe', '..\u0001x', '/etc/passwd', 'C:\\x', 'C:\u0001x', '', 'share\u0001 \u0001x', 'share\u0001', '\u0001a', 'a\u0000b', 'a\tb', 'a'.repeat(GET_FILE_MAX_NAME_BYTES + 1)];
    for (const name of names) {
      expect(decodeLst1Listing(lst1(good(name)), MAX), JSON.stringify(name).slice(0, 40)).toEqual({ entries: [], truncated: false, damaged: true });
    }
    const read = decodeLst1Listing(lst1(...names.map((name) => good(name)), good('share\u0001ok.txt')), MAX);
    expect(read).toEqual({ entries: [{ path: ['share', 'ok.txt'], bytes: 5, modifiedAt: SHARED_AT }], truncated: false, damaged: true });
    expect(decodeLst1Listing(lst1(good('a'.repeat(GET_FILE_MAX_NAME_BYTES))), MAX).entries).toHaveLength(1);
  });

  it('a path is used as it came: the first part stays, and a backslash divides parts too', () => {
    expect(decodeLst1Listing(lst1(good('a.txt'), good('one\\two\u0001c.txt')), MAX).entries.map((entry) => entry.path)).toEqual([['a.txt'], ['one', 'two', 'c.txt']]);
  });

  it('a tag that this codec does not know is passed over; a time that does not have 4 bytes gives modifiedAt 0; a size of 4294967295 is kept', () => {
    const odd = record([[0x7777, text('more')], [0x0101, Uint8Array.of(1, 2)], [0x0303, u32(0xffff_ffff)], [0x0404, text('share\u0001x.bin')], [0x0606, new Uint8Array(0)]]);
    expect(decodeLst1Listing(lst1(odd), MAX)).toEqual({ entries: [{ path: ['share', 'x.bin'], bytes: 0xffff_ffff, modifiedAt: 0 }], truncated: false, damaged: false });
  });

  it('300000 records with maxEntries 20000: 20000 entries, truncated true', () => {
    const records: Uint8Array[] = [];
    for (let i = 0; i < 300_000; i++) records.push(good(`share\u0001file-${i}.txt`, i));
    const read = decodeLst1Listing(all(records), MAX);
    expect([read.entries.length, read.truncated, read.damaged]).toEqual([MAX, true, false]);
    expect(read.entries[MAX - 1]).toEqual({ path: ['share', `file-${MAX - 1}.txt`], bytes: MAX - 1, modifiedAt: SHARED_AT });
    const exact = decodeLst1Listing(all(records.slice(0, MAX)), MAX);
    expect([exact.entries.length, exact.truncated]).toEqual([MAX, false]);
    expect(readListing({ ...LISTING_COLUMNS, flags: 0x30 }, all(records.slice(0, MAX + 1)), MAX).truncated).toBe(true);
  });
});

describe('a listing of the Lst1 form that goes out', () => {
  it('encodeLst1Listing writes the bytes that AIM 5.9 read', () => {
    const written = encodeLst1Listing(shared(), 'share');
    expect(toHex(written.bytes)).toBe(vector(FILE, 'listing that 5.9 read').hex);
    expect([written.form, written.files, written.totalBytes]).toEqual(['lst1', 207, 1053120]);
  });

  it('listingFrame makes the header that AIM 5.9 answered: flags 0x30, the count, 1 left, the length two times, no name', () => {
    const answered = frame('listing header that 5.9 answered');
    const made = listingFrame(answered.header.cookie, encodeLst1Listing(shared(), 'share'), answered.header.modifiedAt);
    expect(toHex(made.bytes)).toBe(toHex(answered.bytes));
    expect(made.flags).toBe(0x30);
    expect(listingHeader(answered.header.cookie, encodeLst1Listing(shared(), 'share'), answered.header.modifiedAt)).toEqual(answered.header);
  });

  it('listingFrame of a text listing is the header of encodeOftHeader: flags 0x20, the count two times, the sum of the sizes, the name', () => {
    const written = encodeListing([file('a.txt', 10), file('sub\\c.txt', 5)]);
    expect(written.form).toBe('text');
    const made = listingFrame(COOKIE, written, 7);
    expect(toHex(made.bytes)).toBe(toHex(encodeOftHeader(listingHeader(COOKIE, written, 7))));
    expect([made.flags, made.header.totalFiles, made.header.filesLeft, made.header.totalBytes, made.header.name]).toEqual([0x20, 2, 2, 15, 'listing.txt']);
  });

  it('a listing of no file is the four letters, and its header has the count 0', () => {
    const written = encodeLst1Listing([], 'share');
    expect(toHex(written.bytes)).toBe('4c737431');
    const { header } = listingFrame(COOKIE, written, 7);
    expect(header).toEqual({
      type: OFT_LISTING, cookie: COOKIE, totalFiles: 0, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: 4, bytes: 4, modifiedAt: 7,
      checksum: oftChecksum(written.bytes), received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: 0, name: '',
    });
  });

  it('encodeLst1Listing then decodeLst1Listing gives the same entries below the folder name', () => {
    const entries: ListingEntry[] = [
      { path: ['top', 'sub', 'x.txt'], bytes: 0, modifiedAt: SHARED_AT },
      { path: ['top', 'caf\u00e9 menu.txt'], bytes: 12, modifiedAt: SHARED_AT + 60 },
      { path: [' spaced .bin'], bytes: 0xffff_ffff, modifiedAt: 0 },
    ];
    expect(decodeLst1Listing(encodeLst1Listing(entries, 'My Files').bytes, MAX)).toEqual({ entries: below('My Files', entries), truncated: false, damaged: false });
  });

  it('encodeLst1Listing leaves out an entry of 4 GB or more and a name that a path cannot hold', () => {
    const kept = file('ok.txt', 1);
    const parts = ['a\rb', 'a\u0000b', 'a\\b', 'a/b', 'a\u0001b', '..', '', '\u4e2d.txt'];
    const bad: ListingEntry[] = [
      ...parts.map((part) => ({ path: [part], bytes: 1, modifiedAt: SHARED_AT })),
      ...parts.map((part) => ({ path: ['sub', part], bytes: 1, modifiedAt: SHARED_AT })),
      { path: [], bytes: 0, modifiedAt: SHARED_AT },
      { path: ['big.bin'], bytes: 4294967296, modifiedAt: SHARED_AT },
      { path: ['half.bin'], bytes: 1.5, modifiedAt: SHARED_AT },
      { path: ['less.bin'], bytes: -1, modifiedAt: SHARED_AT },
      // The folder name counts in the length of the path.
      { path: ['a'.repeat(GET_FILE_MAX_NAME_BYTES - 5)], bytes: 1, modifiedAt: SHARED_AT },
    ];
    const written = encodeLst1Listing([...bad, kept], 'share');
    expect(written.files).toBe(1);
    expect(decodeLst1Listing(written.bytes, MAX)).toEqual({ entries: below('share', [kept]), truncated: false, damaged: false });
    expect(encodeLst1Listing([{ path: ['a'.repeat(GET_FILE_MAX_NAME_BYTES - 6)], bytes: 1, modifiedAt: 0 }], 'share').files).toBe(1);
  });

  it('a name with a letter and a mark after it goes out in each form as the one character that Latin-1 has', () => {
    const apart = 'cafe\u0301.txt';
    const one = 'caf\u00e9.txt';
    const entries = [file(`sub\\${apart}`, 3), file('\u0416.txt', 4)];
    const text = encodeListing(entries);
    expect(text.files).toBe(1);
    expect(decodeListing(text.bytes, LISTING_COLUMNS, MAX).entries.map((entry) => entry.path)).toEqual([['sub', one]]);
    const lst1 = encodeLst1Listing(entries, 'share');
    expect(lst1.files).toBe(1);
    expect(decodeLst1Listing(lst1.bytes, MAX).entries.map((entry) => entry.path)).toEqual([['share', 'sub', one]]);
  });

  it('encodeLst1Listing writes no more than 65535 records', () => {
    const written = encodeLst1Listing(Array.from({ length: GET_FILE_MAX_ENTRIES + 5 }, (_, i) => file(`f${i}`, 1)), 'share');
    expect(written.files).toBe(GET_FILE_MAX_ENTRIES);
    expect(listingHeader(COOKIE, written, 7).totalFiles).toBe(GET_FILE_MAX_ENTRIES);
    expect(decodeLst1Listing(written.bytes, GET_FILE_MAX_ENTRIES).entries).toHaveLength(GET_FILE_MAX_ENTRIES);
  });

  it('a folder name that a path cannot hold, and no folder name, become the name "shared"', () => {
    for (const name of [undefined, '', '..', ' ', 'a\\b', 'a/b', 'a\u0001b', 'C:', '\u4e2d', 'a\u0000']) {
      expect(listingFolder(name), JSON.stringify(name)).toBe('shared');
      expect(decodeLst1Listing(encodeLst1Listing([file('a.txt', 1)], name).bytes, MAX).entries[0]?.path).toEqual(['shared', 'a.txt']);
    }
    expect(listingFolder('Caf\u00e9 files')).toBe('Caf\u00e9 files');
  });
});

describe('the number of a Get File proposal', () => {
  it('the proposal of AIM 5.9 has the number 2; the proposals of AIM 5.1 and AIM 3.5 have 1', () => {
    expect(getFileProposalNumber(toClient(bytesOf(PROPOSALS, '5.9 get file proposal')))).toBe(2);
    expect(getFileProposalNumber(toClient(bytesOf(PROPOSALS, '5.1 get file proposal')))).toBe(1);
    expect(getFileProposalNumber(toClient(bytesOf(PROPOSALS, '3.5 get file proposal')))).toBe(1);
    for (const name of ['5.9 get file proposal', '3.5 get file proposal']) {
      expect(parseRendezvous(toClient(bytesOf(PROPOSALS, name)))).toMatchObject({ service: 'get-file', type: 'propose', sequence: 1, address: { ip: '203.0.113.7', port: 5190 } });
    }
  });

  it('the proposal of this codec keeps the 12 bytes with the number 1', () => {
    const body = encodeGetFileProposal(1n, 'bob', { sequence: 1, address: { ip: '203.0.113.7', port: 5190 } });
    // The body to the host has the same place for the fragment as the body to the client with a sender of no tags.
    const fragment = body.subarray(8 + 2 + 1 + 3 + 4, body.length - 4);
    expect(getFileProposalNumber(toClient(fragment))).toBe(1);
    expect(toHex(fragment.subarray(fragment.length - 12))).toBe('001200010000000000000000');
  });

  it('no tag 0x2711, a tag of 3 bytes and a tag of no byte give null; a tag of 4 bytes gives its number', () => {
    expect(getFileProposalNumber(proposal(encodeTlvs([tlv.u16(0x000a, 1)])))).toBeNull();
    expect(getFileProposalNumber(proposal(encodeTlvs([tlv.bytes(0x2711, Uint8Array.of(0, 0x12, 0))])))).toBeNull();
    expect(getFileProposalNumber(proposal(encodeTlvs([tlv.bytes(0x2711, new Uint8Array(0))])))).toBeNull();
    expect(getFileProposalNumber(proposal(encodeTlvs([tlv.bytes(0x2711, Uint8Array.of(0, 0x12, 0, 0))])))).toBe(0);
    expect(getFileProposalNumber(proposal(encodeTlvs([tlv.bytes(0x2711, Uint8Array.of(0, 0x12, 0, 7))])))).toBe(7);
    expect(getFileProposalNumber(proposal(encodeTlvs([tlv.bytes(0x2711, Uint8Array.of(0, 0x12, 0xff, 0xff, 9))])))).toBe(0xffff);
  });

  it('a cancel, an accept, a Send File proposal and bytes that are no message give null', () => {
    const two = encodeTlvs([tlv.bytes(0x2711, Uint8Array.of(0, 0x12, 0, 2))]);
    expect(getFileProposalNumber(proposal(two, 0x0001))).toBeNull();
    expect(getFileProposalNumber(proposal(two, 0x0002))).toBeNull();
    expect(getFileProposalNumber(toClient(bytesOf(PROPOSALS, '5.9 proposal, a folder')))).toBeNull();
    expect(getFileProposalNumber(new Uint8Array(0))).toBeNull();
    expect(getFileProposalNumber(toClient(new Uint8Array(10)))).toBeNull();
  });

  it('the number 2 or more gets the Lst1 form; 1, 0 and no number get the text form', () => {
    expect([2, 3, 0xffff].map(listingFormFor)).toEqual(['lst1', 'lst1', 'lst1']);
    expect([null, 0, 1].map(listingFormFor)).toEqual(['text', 'text', 'text']);
  });
});

describe('the answers to a header of the Lst1 form', () => {
  it('listingAck clears bit 0x10, and listingDone clears it and sets bit 0x01: the flags of AIM 5.9', () => {
    const listing = frame('listing header that 5.9 answered');
    const body = bytesOf(FILE, 'listing that 5.9 read');
    const ack = listingAck(listing);
    const done = listingDone(listing, body);
    expect([listing.flags, ack.flags, done.flags]).toEqual([0x30, 0x20, 0x21]);
    expect([ack.flags, done.flags]).toEqual([frame('5.9 listing acknowledge').flags, frame('5.9 listing done').flags]);
    expect([ack.header.type, done.header.type]).toEqual([OFT_LISTING_ACK, OFT_LISTING_DONE]);
  });

  it('the answers of AIM 5.9 are the answers of answerOftFrame, but for the count of the files', () => {
    const listing = frame('listing header that 5.9 answered');
    const body = bytesOf(FILE, 'listing that 5.9 read');
    // AIM 5.9 writes zero in the count of the files.
    const noCount = (bytes: Uint8Array): string => toHex(Uint8Array.from(bytes).fill(0, 20, 22));
    expect(noCount(listingAck(listing).bytes)).toBe(noCount(bytesOf(FILE, '5.9 listing acknowledge')));
    expect(noCount(listingDone(listing, body).bytes)).toBe(noCount(bytesOf(FILE, '5.9 listing done')));
  });

  it('the ack and the done of a file are the header of the file sent back: the bytes of AIM 5.9', () => {
    const prompt = frame('prompt that 5.9 answered');
    expect(toHex(answerOftFrame(prompt, { type: OFT_ACK }).bytes)).toBe(vector(FILE, '5.9 ack').hex);
    expect(toHex(answerOftFrame(prompt, { type: OFT_DONE, received: { bytes: 1024, checksum: 0x2abd0000 } }).bytes)).toBe(vector(FILE, '5.9 done').hex);
  });

  it('each answer made from a header that has bit 0x10 is without it: the ack and the done of a file, and a request', () => {
    const bytes = bytesOf(FILE, 'prompt that 5.9 answered').slice();
    bytes[100] = 0x30;
    const marked = decodeOftFrame(bytes);
    expect(answerOftFrame(marked, { type: OFT_ACK }).flags).toBe(0x20);
    expect(answerOftFrame(marked, { type: OFT_DONE, received: { bytes: 1, checksum: 2 } }).flags).toBe(0x21);
    expect(answerOftFrame(marked, { type: OFT_FILE_REQUEST, name: 'a.txt' }).flags).toBe(0x21);
    expect(toHex(marked.bytes)).toBe(toHex(bytes));
  });

  it('a request made from the answer after a listing of the Lst1 form has bit 0x01 and not bit 0x10', () => {
    const listing = frame('listing header that 5.9 answered');
    const request = requestHeader(listingDone(listing, bytesOf(FILE, 'listing that 5.9 read')), ['share', 'sub', 'c.txt']);
    expect([request.header.type, request.flags, request.header.name]).toEqual([OFT_FILE_REQUEST, 0x21, 'share\u0001sub\u0001c.txt']);
    expect([request.header.totalBytes, request.header.bytes]).toEqual([0, 0]);
  });

  it('a header of encodeOftHeader has the flags that the caller gives, and 0x20 with none', () => {
    const { header } = frame('prompt that 5.9 answered');
    expect(decodeOftFrame(encodeOftHeader(header)).flags).toBe(0x20);
    expect(decodeOftFrame(encodeOftHeader(header, 'utf-8', 0x30)).flags).toBe(0x30);
    expect(toHex(encodeOftHeader(header, 'utf-8', 0x20))).toBe(toHex(encodeOftHeader(header)));
    for (const flags of [-1, 256, 1.5]) expect(() => encodeOftHeader(header, 'utf-8', flags)).toThrow(RangeError);
  });
});

describe('a request in each shape', () => {
  it('the request of AIM 5.9: a header with only the type, the cookie and the name', () => {
    const top = frame('5.9 request, a name at the top');
    expect([top.header.totalFiles, top.header.totalBytes, top.header.bytes, top.header.modifiedAt, top.header.checksum, top.header.received]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(requestedFile(top)).toEqual({ name: 'share\u0001a.txt', path: ['share', 'a.txt'] });
    expect(requestedFile(frame('5.9 request, a path'))).toEqual({ name: 'share\u0001sub\u0001c.txt', path: ['share', 'sub', 'c.txt'] });
  });

  it('the request of AIM 3.5: a backslash between the parts', () => {
    expect(requestedFile(frame('3.5 request, a name at the top'))).toEqual({ name: 'a.txt', path: ['a.txt'] });
    expect(requestedFile(frame('3.5 request, a path'))).toEqual({ name: 'sub\\c.txt', path: ['sub', 'c.txt'] });
    expect(requestedPath(frame('3.5 request, a path'))).toEqual(['sub', 'c.txt']);
  });

  it('a request for "sub\\\\c.txt" and one for "sub\\u0001c.txt" name the same path, and "..\\\\x" and "..\\u0001x" name none', () => {
    const last = frame('5.9 done');
    const asks = (name: string): OftFrame => answerOftFrame(last, { type: OFT_FILE_REQUEST, name });
    expect(requestedPath(asks('sub\\c.txt'))).toEqual(requestedPath(asks('sub\u0001c.txt')));
    expect(requestedPath(asks('sub\\c.txt'))).toEqual(['sub', 'c.txt']);
    for (const name of ['..\\x', '..\u0001x', 'sub\\..\\x', 'sub\u0001..\u0001x', '\\x', 'sub\\', 'C:\\x', '']) {
      expect(requestedFile(asks(name)), JSON.stringify(name)).toBeNull();
    }
  });

  it('a header that is not a request names no file: the frame that AIM 5.9 sends after a listing that it did not show, and a prompt', () => {
    expect(frame('5.9 frame after a listing that it did not show').header.type).toBe(OFT_LISTING_UNREAD);
    expect(requestedFile(frame('5.9 frame after a listing that it did not show'))).toBeNull();
    expect(frame('prompt that 5.9 answered').header.type).toBe(OFT_PROMPT);
    expect(requestedFile(frame('prompt that 5.9 answered'))).toBeNull();
  });
});
