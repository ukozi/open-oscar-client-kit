// The layouts are the layouts that AIM 5.1 and AIM 5.9 write and read. The vectors of Get File show each rule.
import { ByteWriter } from './bytes.js';
import { GET_FILE_MAX_ENTRIES, GET_FILE_MAX_NAME_BYTES, ICBM_CHARSET_ASCII } from './constants.js';
import {
  OFT_CHECKSUM_START, OFT_FILE_REQUEST, OFT_FLAGS, OFT_FLAG_LST1, OFT_LISTING, OFT_LISTING_ACK, OFT_LISTING_DONE, OFT_NAME_OFFSET,
  OFT_SIZE_OFFSET, answerOftFrame, decodeOftFrame, encodeOftHeader, oftChecksum,
} from './oft.js';
import type { OftFrame, OftHeader } from './oft.js';
import { isAscii } from './text.js';

/** One file. `path`: the names from the shared folder down. `modifiedAt` is in seconds. */
export type ListingEntry = { path: readonly string[]; bytes: number; modifiedAt: number };
/** `truncated`: the listing has more entries than the limit. `damaged`: one line or one record or more did not decode. */
export type ListingRead = { entries: ListingEntry[]; truncated: boolean; damaged: boolean };
/** The columns of a line where the size and the name start. The header of a listing gives them. */
export type ListingColumns = { sizeOffset: number; nameOffset: number };
/** 'text': one line for each file, as AIM 5.1 writes it. 'lst1': one record for each file, as AIM 5.9 writes it. */
export type ListingForm = 'text' | 'lst1';
/** The fields of a listing header that tell how to read the listing. An OftFrame has them. */
export type ListingShape = ListingColumns & { flags: number };
/** `files` is the count of the files. `totalBytes` is the sum of their sizes in 32 bits. */
export type ListingWritten = { form: ListingForm; bytes: Uint8Array; files: number; totalBytes: number };

/** The columns of the lines that encodeListing writes. A header of encodeOftHeader gives the same columns. */
export const LISTING_COLUMNS: ListingColumns = { sizeOffset: OFT_SIZE_OFFSET, nameOffset: OFT_NAME_OFFSET };
export const LISTING_NAME = 'listing.txt';
/** The name of the folder in a listing of the Lst1 form when the caller gives no name that the listing can hold. */
export const LISTING_FOLDER = 'shared';
/** The lowest number of a proposal that gets a listing of the Lst1 form. AIM 5.9 writes this number. */
export const LISTING_LST1_NUMBER = 2;

const LST1 = Uint8Array.of(0x4c, 0x73, 0x74, 0x31);
const LST1_TIME = 0x0101;
const LST1_SIZE = 0x0303;
const LST1_KIND = 0x0505;
const LST1_PATH = 0x0404;
const LST1_SPARE = 0x0900;
const LST1_END = 0x0909;
const LST1_HEAD_BYTES = 4;

const CR = 0x0d;
const LF = 0x0a;
const DATE_CHARS = 16;
const MAX_FILE_BYTES = 0xffff_ffff;
const FOLDER_MARK = '\\';
const DIVIDER = '\u0001';
const NAME_AT = 192;
const DATE = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)$/;

// A name that is not ASCII has 2 bytes for each character in a header.
function wireBytes(name: string): number {
  return isAscii(name) ? name.length : name.length * 2;
}

function inRange(text: string, low: number, high: number): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < low || unit > high) return false;
  }
  return true;
}

/** The parts of a name that a peer sent, or null for a name that is not a path below the shared folder. */
export function pathParts(name: string): string[] | null {
  if (name === '' || wireBytes(name) > GET_FILE_MAX_NAME_BYTES) return null;
  const parts = name.replaceAll('\\', DIVIDER).replaceAll('/', DIVIDER).split(DIVIDER);
  for (const part of parts) {
    // A part of dots and spaces only is the folder itself or a folder above it.
    if (/^[. ]*$/.test(part) || !inRange(part, 0x20, 0xffff)) return null;
  }
  if (parts[0]?.endsWith(':')) return null;
  return parts;
}

function sameParts(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((part, i) => part === b[i]);
}

// The date of a line is local time. The result is 0 for text that is not a date.
function readDate(text: string): number {
  const found = DATE.exec(text);
  if (!found) return 0;
  const [month, day, year, hour, minute] = found.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return 0;
  const seconds = Math.trunc(new Date(year, month - 1, day, hour, minute).getTime() / 1000);
  return seconds > 0 && seconds <= 0xffff_ffff ? seconds : 0;
}

function writeDate(seconds: number): string {
  const d = new Date((Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds) : 0) * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  const year = String(d.getFullYear()).padStart(4, '0');
  return `${two(d.getMonth() + 1)}/${two(d.getDate())}/${year} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// The size ends one column before the name. A name that ends with a backslash is not a file.
function readLine(line: string, at: ListingColumns): ListingEntry | null {
  if (line.length <= at.nameOffset || line[at.nameOffset - 1] !== ' ') return null;
  const size = line.slice(at.sizeOffset, at.nameOffset - 1).trimStart();
  if (!/^\d+$/.test(size)) return null;
  const bytes = Number(size);
  if (bytes > MAX_FILE_BYTES) return null;
  const path = pathParts(line.slice(at.nameOffset));
  if (!path) return null;
  return { path, bytes, modifiedAt: readDate(line.slice(0, DATE_CHARS)) };
}

function usable(at: ListingColumns): boolean {
  return Number.isInteger(at.sizeOffset) && Number.isInteger(at.nameOffset) && at.sizeOffset >= DATE_CHARS && at.nameOffset >= at.sizeOffset + 2;
}

/** A listing holds each file of the whole shared folder. `columns` are the offsets of the header of the listing. */
export function decodeListing(bytes: Uint8Array, columns: ListingColumns, maxEntries: number): ListingRead {
  const entries: ListingEntry[] = [];
  if (!usable(columns)) return { entries, truncated: false, damaged: bytes.length > 0 };
  let damaged = false;
  let at = 0;
  while (at < bytes.length) {
    if (entries.length >= maxEntries) return { entries, truncated: true, damaged };
    let end = bytes.indexOf(CR, at);
    while (end !== -1 && bytes[end + 1] !== LF) end = bytes.indexOf(CR, end + 1);
    if (end === -1) {
      damaged = true;
      break;
    }
    const entry = readLine(Buffer.from(bytes.buffer, bytes.byteOffset + at, end - at).toString('latin1'), columns);
    if (entry) entries.push(entry);
    else damaged = true;
    at = end + 2;
  }
  return { entries, truncated: false, damaged };
}

/** The part as a listing writes it: a letter and a mark after it become the one character that has the two. */
export function listedPart(part: string): string {
  return part.normalize('NFC');
}

function listedEntry(entry: ListingEntry): ListingEntry {
  return { ...entry, path: entry.path.map(listedPart) };
}

// The folders of a name are divided by a backslash.
function writeLine(entry: ListingEntry): string | null {
  if (entry.path.length === 0) return null;
  for (const part of entry.path) {
    if (!inRange(part, 0, 0xff) || part.includes(FOLDER_MARK) || pathParts(part)?.length !== 1) return null;
  }
  const name = entry.path.join(FOLDER_MARK);
  if (!sameParts(pathParts(name), entry.path)) return null;
  if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) return null;
  const size = String(entry.bytes).padStart(OFT_NAME_OFFSET - 1 - OFT_SIZE_OFFSET);
  return `${writeDate(entry.modifiedAt).padEnd(OFT_SIZE_OFFSET)}${size} ${name}\r\n`;
}

/**
 * One line for each file, at LISTING_COLUMNS. Entries of 4 GB or more are left out. Each part of a name is written as listedPart gives it.
 * An entry with a name that a line cannot hold is left out. Entries after the first 65535 lines are left out.
 */
export function encodeListing(entries: readonly ListingEntry[]): ListingWritten {
  const lines: string[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (lines.length >= GET_FILE_MAX_ENTRIES) break;
    const line = writeLine(listedEntry(entry));
    if (line === null) continue;
    lines.push(line);
    totalBytes = (totalBytes + entry.bytes) % 0x1_0000_0000;
  }
  return { form: 'text', bytes: new Uint8Array(Buffer.from(lines.join(''), 'latin1')), files: lines.length, totalBytes };
}

/** The form of the listing for a requester. `number` is the number of its proposal, or null when the proposal has none. */
export function listingFormFor(number: number | null): ListingForm {
  return number !== null && number >= LISTING_LST1_NUMBER ? 'lst1' : 'text';
}

// One part of a path that the two forms can hold: Latin-1, no divider, and not the folder itself.
function plainPart(part: string): boolean {
  return inRange(part, 0, 0xff) && !part.includes(FOLDER_MARK) && pathParts(part)?.length === 1;
}

/** The name of the folder that encodeLst1Listing writes for `name`: the name, or LISTING_FOLDER for a name that a path cannot hold. */
export function listingFolder(name: string | undefined): string {
  return name !== undefined && plainPart(name) ? name : LISTING_FOLDER;
}

// The path of a record: the name of the folder, then the parts of the entry, with byte 0x01 between them.
function lst1Path(folder: string, entry: ListingEntry): string | null {
  if (entry.path.length === 0 || !entry.path.every(plainPart)) return null;
  if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) return null;
  const parts = [folder, ...entry.path];
  const name = parts.join(DIVIDER);
  return sameParts(pathParts(name), parts) ? name : null;
}

/**
 * The Lst1 form: one record for each file, and `folder` is the first part of each path. The limits are the limits of encodeListing.
 * A folder name that a path cannot hold becomes LISTING_FOLDER.
 */
export function encodeLst1Listing(entries: readonly ListingEntry[], folder?: string): ListingWritten {
  const first = listingFolder(folder);
  const out = new ByteWriter().bytes(LST1);
  let files = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (files >= GET_FILE_MAX_ENTRIES) break;
    const name = lst1Path(first, listedEntry(entry));
    if (name === null) continue;
    const at = Number.isFinite(entry.modifiedAt) && entry.modifiedAt > 0 ? Math.min(MAX_FILE_BYTES, Math.trunc(entry.modifiedAt)) : 0;
    const path = Buffer.from(name, 'latin1');
    out.u16(LST1_TIME).u16(4).u32(at).u16(LST1_SIZE).u16(4).u32(entry.bytes).u16(LST1_KIND).u16(2).u16(0);
    out.u16(LST1_PATH).u16(path.length).bytes(path).u16(LST1_SPARE).u16(4).u32(0).u16(LST1_END).u16(0);
    files += 1;
    totalBytes = (totalBytes + entry.bytes) % 0x1_0000_0000;
  }
  return { form: 'lst1', bytes: out.toBytes(), files, totalBytes };
}

// One record of the Lst1 form from `at`. `next` is null when the bytes end before the record ends.
function readRecord(bytes: Uint8Array, at: number): { entry: ListingEntry | null; next: number | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let time = 0;
  let size: number | null = null;
  let path: string[] | null = null;
  let whole = true;
  for (let from = at; from + LST1_HEAD_BYTES <= bytes.length; ) {
    const tag = view.getUint16(from);
    const length = view.getUint16(from + 2);
    const value = from + LST1_HEAD_BYTES;
    if (value + length > bytes.length) break;
    from = value + length;
    if (tag === LST1_END) return { entry: whole && size !== null && path ? { path, bytes: size, modifiedAt: time } : null, next: from };
    if (tag === LST1_TIME) time = length === 4 ? view.getUint32(value) : 0;
    else if (tag === LST1_SIZE) {
      size = length === 4 ? view.getUint32(value) : null;
      whole &&= length === 4;
    } else if (tag === LST1_PATH) {
      path = pathParts(Buffer.from(bytes.buffer, bytes.byteOffset + value, length).toString('latin1'));
      whole &&= path !== null;
    }
  }
  return { entry: null, next: null };
}

/** A listing of the Lst1 form. Each path has the name of the shared folder of the holder as its first part. */
export function decodeLst1Listing(bytes: Uint8Array, maxEntries: number): ListingRead {
  const entries: ListingEntry[] = [];
  if (bytes.length === 0) return { entries, truncated: false, damaged: false };
  if (bytes.length < LST1.length || !LST1.every((byte, i) => bytes[i] === byte)) return { entries, truncated: false, damaged: true };
  let damaged = false;
  let at = LST1.length;
  while (at < bytes.length) {
    if (entries.length >= maxEntries) return { entries, truncated: true, damaged };
    const { entry, next } = readRecord(bytes, at);
    if (entry) entries.push(entry);
    else damaged = true;
    if (next === null) break;
    at = next;
  }
  return { entries, truncated: false, damaged };
}

/** The listing that `header` announces. OFT_FLAG_LST1 in the flags of the header tells the form. */
export function readListing(header: ListingShape, bytes: Uint8Array, maxEntries: number): ListingRead {
  return (header.flags & OFT_FLAG_LST1) !== 0 ? decodeLst1Listing(bytes, maxEntries) : decodeListing(bytes, header, maxEntries);
}

/**
 * The header that the holder writes first. `listing` is the result of encodeListing or of encodeLst1Listing. `now` is in seconds.
 * The text form: the count of the files two times, the sum of their sizes and a name. The Lst1 form: the count, 1, the length two times and no name.
 */
export function listingHeader(cookie: bigint, listing: ListingWritten, now: number): OftHeader {
  if (!Number.isInteger(now) || now < 0 || now > 0xffff_ffff) throw new RangeError('the time is out of range');
  const lst1 = listing.form === 'lst1';
  return {
    type: OFT_LISTING, cookie, totalFiles: listing.files, filesLeft: lst1 ? 1 : listing.files, totalParts: 1, partsLeft: 1,
    totalBytes: lst1 ? listing.bytes.length : listing.totalBytes, bytes: listing.bytes.length, modifiedAt: now, checksum: oftChecksum(listing.bytes),
    received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: ICBM_CHARSET_ASCII, name: lst1 ? '' : LISTING_NAME,
  };
}

/** The header of listingHeader as the holder writes it. A listing of the Lst1 form has OFT_FLAG_LST1 in the flags. */
export function listingFrame(cookie: bigint, listing: ListingWritten, now: number): OftFrame {
  const flags = listing.form === 'lst1' ? OFT_FLAGS | OFT_FLAG_LST1 : OFT_FLAGS;
  return decodeOftFrame(encodeOftHeader(listingHeader(cookie, listing, now), 'utf-8', flags));
}

/** The length that a listing header announces. */
export function listingLength(header: OftHeader): number {
  return header.bytes;
}

/** The answer of the requester to a listing header. The holder sends the listing after it. Each answer is without OFT_FLAG_LST1. */
export function listingAck(listing: OftFrame): OftFrame {
  return answerOftFrame(listing, { type: OFT_LISTING_ACK });
}

/** The answer of the requester after the listing. `body` holds the bytes that came. */
export function listingDone(listing: OftFrame, body: Uint8Array): OftFrame {
  return answerOftFrame(listing, { type: OFT_LISTING_DONE, received: { bytes: body.length, checksum: oftChecksum(body) } });
}

/** The request for one file. `last` is the last answer that the requester wrote: a listing done, or the done of a file. */
export function requestHeader(last: OftFrame, path: readonly string[]): OftFrame {
  const name = path.join(DIVIDER);
  if (!sameParts(pathParts(name), path)) throw new RangeError('the path is not a path below the shared folder');
  return answerOftFrame(last, { type: OFT_FILE_REQUEST, name });
}

// AIM 5.1 writes a name in Latin-1 with the encoding 0.
function requestedName(request: OftFrame): string {
  if (request.header.nameEncoding !== ICBM_CHARSET_ASCII) return request.header.name;
  const field = request.bytes.subarray(NAME_AT);
  const end = field.indexOf(0);
  return Buffer.from(field.subarray(0, end === -1 ? field.length : end)).toString('latin1');
}

/**
 * The file that a request names, or null for a name that pathParts refuses. Only the type and the name of the header are read.
 * `name` is the name as it came. Byte 0x01 or a backslash divides its parts: AIM 3.5 writes a backslash.
 */
export function requestedFile(request: OftFrame): { name: string; path: string[] } | null {
  if (request.header.type !== OFT_FILE_REQUEST) return null;
  const name = requestedName(request);
  const path = pathParts(name);
  return path ? { name, path } : null;
}

/** The path that a request names, or null for a name that pathParts refuses. */
export function requestedPath(request: OftFrame): string[] | null {
  return requestedFile(request)?.path ?? null;
}
