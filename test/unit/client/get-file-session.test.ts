import { describe, expect, it } from 'vitest';
import { BrowseSession, GetFileError, LISTING_UNREAD_MAX, NOT_TAKEN_MAX, NOT_THERE_CLOSE_MS, ServeSession } from '../../../src/client/get-file-session.js';
import type { BrowseSessionDeps, GetFileFailure, ServeSessionDeps } from '../../../src/client/get-file-session.js';
import { OftError } from '../../../src/client/oft-session.js';
import { PeerClosedError } from '../../../src/client/peer-link.js';
import type { PeerLink } from '../../../src/client/peer-link.js';
import type { SharedEntry, SharedSource } from '../../../src/model/get-file.js';
import type { FileSink, IncomingFile, OutgoingFile, TransferProgress } from '../../../src/model/transfer.js';
import { GET_FILE_MAX_ENTRIES, GET_FILE_MAX_LISTING_BYTES } from '../../../src/wire/constants.js';
import {
  decodeListing, decodeLst1Listing, encodeListing, encodeLst1Listing, listingAck, listingDone, listingFrame, listingHeader, listingLength,
  requestHeader, requestedPath,
} from '../../../src/wire/listing.js';
import type { ListingEntry } from '../../../src/wire/listing.js';
import {
  OFT_ACK, OFT_CHECKSUM_START, OFT_DONE, OFT_FILE_REQUEST, OFT_FLAG_LST1, OFT_FLAG_RECEIVED, OFT_LISTING, OFT_LISTING_ACK, OFT_LISTING_DONE,
  OFT_LISTING_UNREAD, OFT_PROMPT, OFT_RESUME, OFT_RESUME_ANSWER, answerOftFrame, decodeOftFrame, decodeOftHeader, encodeOftHeader, oftChecksum, oftHeaderLength,
} from '../../../src/wire/oft.js';
import type { OftFrame, OftHeader } from '../../../src/wire/oft.js';
import { toHex } from '../../../src/wire/bytes.js';
import { ManualTimers, captureLog, waitFor } from '../../fake/oscar-client.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';

const COOKIE = 0x0102030405060708n;
const OTHER_COOKIE = 0x1112131415161718n;
const READ_MAX = 64 * 1024;
const MINUTE = Math.trunc(new Date(2020, 0, 2, 3, 4).getTime() / 1000);

// One end of a connection in memory. `sent` holds each write of this end.
class MemoryLink implements PeerLink {
  readonly sent: Uint8Array[] = [];
  peer!: MemoryLink;
  // The byte count that the reads of this end took.
  taken = 0;
  largestReadSome = 0;
  private inbox: Uint8Array[] = [];
  private buffered = 0;
  private ended = false;
  private shut = false;
  private wake: (() => void) | null = null;

  get closed(): boolean {
    return this.shut;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.shut || this.peer.shut) return Promise.reject(new PeerClosedError());
    const copy = bytes.slice();
    this.sent.push(copy);
    if (copy.length > 0) this.peer.put(copy);
    return Promise.resolve();
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.buffered < n) {
      if (this.ended) throw new PeerClosedError();
      await this.more();
    }
    return this.take(n);
  }

  async readSome(max: number): Promise<Uint8Array | null> {
    this.largestReadSome = Math.max(this.largestReadSome, max);
    while (this.buffered === 0) {
      if (this.shut) throw new PeerClosedError();
      if (this.ended) return null;
      await this.more();
    }
    return this.take(Math.min(max, this.buffered));
  }

  close(): void {
    if (this.shut) return;
    this.shut = true;
    this.ended = true;
    this.inbox = [];
    this.buffered = 0;
    this.woken();
    this.peer.end();
  }

  private put(bytes: Uint8Array): void {
    if (this.shut) return;
    this.inbox.push(bytes);
    this.buffered += bytes.length;
    this.woken();
  }

  private end(): void {
    this.ended = true;
    this.woken();
  }

  private woken(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private more(): Promise<void> {
    if (this.wake) return Promise.reject(new Error('a read is in progress'));
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const chunk = this.inbox[0] as Uint8Array;
      const part = Math.min(chunk.length, n - at);
      out.set(chunk.subarray(0, part), at);
      at += part;
      if (part === chunk.length) this.inbox.shift();
      else this.inbox[0] = chunk.subarray(part);
    }
    this.buffered -= n;
    this.taken += n;
    return out;
  }
}

function pair(): [MemoryLink, MemoryLink] {
  const a = new MemoryLink();
  const b = new MemoryLink();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function content(bytes: number, seed = 7): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pause(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Taken = { file: IncomingFile; chunks: Uint8Array[]; finished: number; aborted: number };

// A sink in memory. `onWrite` runs before each chunk is kept.
function memorySink(onWrite?: (taken: Taken) => void): FileSink & { files: Taken[] } {
  const files: Taken[] = [];
  return {
    files,
    begin: async (file) => {
      const taken: Taken = { file, chunks: [], finished: 0, aborted: 0 };
      files.push(taken);
      return {
        write: async (chunk) => {
          onWrite?.(taken);
          taken.chunks.push(chunk.slice());
        },
        finish: async () => {
          taken.finished += 1;
        },
        abort: async () => {
          taken.aborted += 1;
        },
      };
    },
  };
}

type Heard = { entries: ListingEntry[]; truncated: boolean; damaged: boolean };
type Side = {
  session: BrowseSession;
  link: MemoryLink;
  holder: MemoryLink;
  verified: number;
  listings: Heard[];
  ends: (GetFileFailure | 'closed')[];
};

// A session on one end. The test is the holder and has the other end.
function browse(over: Partial<BrowseSessionDeps> = {}): Side {
  const [a, b] = pair();
  const out: Side = { session: undefined as unknown as BrowseSession, link: a, holder: b, verified: 0, listings: [], ends: [] };
  out.session = new BrowseSession({
    link: a,
    cookie: COOKIE,
    log: captureLog().log,
    timers: new ManualTimers().api,
    now: () => 0,
    maxListingBytes: GET_FILE_MAX_LISTING_BYTES,
    maxEntries: GET_FILE_MAX_ENTRIES,
    onVerified: () => {
      out.verified += 1;
    },
    onListing: (listing) => {
      out.listings.push(listing);
    },
    onEnd: (why) => {
      out.ends.push(why);
    },
    ...over,
  });
  return out;
}

// One header with each byte as it came.
async function frame(link: PeerLink): Promise<OftFrame> {
  const first = await link.read(6);
  return decodeOftFrame(joined([first, await link.read(oftHeaderLength(first) - 6)]));
}

async function header(link: PeerLink): Promise<OftHeader> {
  return (await frame(link)).header;
}

// The name has a slash between its folders.
function file(name: string, bytes = 1024): ListingEntry {
  return { path: name.split('/'), bytes, modifiedAt: MINUTE };
}

// The bytes of the header of a listing. `declared` is a length that is not the length of the listing.
function listingHead(entries: readonly ListingEntry[] = [], cookie = COOKIE, declared?: number): Uint8Array {
  const made = listingHeader(cookie, encodeListing(entries), MINUTE);
  return encodeOftHeader(declared === undefined ? made : { ...made, bytes: declared });
}

// The holder sends one listing and reads the two answers.
async function sendListing(holder: MemoryLink, entries: readonly ListingEntry[]): Promise<OftFrame[]> {
  await holder.write(listingHead(entries));
  const ack = await frame(holder);
  await holder.write(encodeListing(entries).bytes);
  return [ack, await frame(holder)];
}

// A session that has the listing.
async function open(over: Partial<BrowseSessionDeps> = {}, entries: readonly ListingEntry[] = [file('a.txt'), file('sub/c.txt')]): Promise<Side> {
  const s = browse(over);
  s.session.start();
  await sendListing(s.holder, entries);
  await waitFor(() => s.listings.length === 1, 'the first listing');
  return s;
}

function prompt(data: Uint8Array, name: string, over: Partial<OftHeader> = {}): OftHeader {
  return {
    type: OFT_PROMPT, cookie: COOKIE, totalFiles: 1, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: data.length,
    bytes: data.length, modifiedAt: MINUTE, checksum: oftChecksum(data), received: 0, receivedChecksum: OFT_CHECKSUM_START,
    nameEncoding: 0, name, ...over,
  };
}

// The holder reads one request, sends the file and reads the DONE.
async function serve(holder: MemoryLink, data: Uint8Array, name: string): Promise<{ request: OftFrame; done: OftFrame }> {
  const request = await frame(holder);
  await holder.write(encodeOftHeader(prompt(data, name)));
  const ack = await header(holder);
  expect(ack.type).toBe(OFT_ACK);
  await holder.write(data);
  return { request, done: await frame(holder) };
}

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'resolved';
  } catch (error) {
    if (error instanceof GetFileError) return `get-file:${error.failure}`;
    return error instanceof OftError ? `oft:${error.failure}` : 'other';
  }
}

const quiet = (): void => {};
const live = (): { cancelled: boolean } => ({ cancelled: false });

describe('the requester side of a Get File link', () => {
  it('start writes nothing until the holder header arrives, then answers 0x1209 with the cookie', async () => {
    const s = browse();
    s.session.start();
    await pause();
    expect(s.link.sent).toHaveLength(0);
    expect(s.verified).toBe(0);
    await s.holder.write(listingHead());
    const answer = await header(s.holder);
    expect(answer.type).toBe(OFT_LISTING_ACK);
    expect(answer.type).toBe(0x1209);
    expect(answer.cookie).toBe(COOKIE);
    expect(s.verified).toBe(1);
    const done = await header(s.holder);
    expect(done.type).toBe(OFT_LISTING_DONE);
    await waitFor(() => s.listings.length === 1, 'the empty listing');
    expect(s.listings[0]).toEqual({ entries: [], truncated: false, damaged: false });
    expect(s.ends).toEqual([]);
  });

  it('a listing of three lines arrives as three files of the whole shared folder', async () => {
    const entries = [file('a.txt', 1024), file('b.bin', 70_000), file('sub/deep/c.txt', 5)];
    const s = browse();
    s.session.start();
    const [ack, done] = await sendListing(s.holder, entries);
    const body = encodeListing(entries).bytes;
    expect(ack?.header.type).toBe(OFT_LISTING_ACK);
    expect(done?.header.type).toBe(OFT_LISTING_DONE);
    expect([done?.header.received, done?.header.receivedChecksum]).toEqual([body.length, oftChecksum(body)]);
    expect([(ack?.flags ?? 0) & OFT_FLAG_RECEIVED, (done?.flags ?? 0) & OFT_FLAG_RECEIVED]).toEqual([0, OFT_FLAG_RECEIVED]);
    await waitFor(() => s.listings.length === 1, 'the listing');
    expect(s.listings[0]).toEqual({ entries, truncated: false, damaged: false });
    expect(s.link.largestReadSome).toBeLessThanOrEqual(READ_MAX);
    expect(s.verified).toBe(1);
  });

  it('a first header with another cookie ends bad-cookie and onListing is not called', async () => {
    const s = browse();
    s.session.start();
    await s.holder.write(listingHead([file('a.txt')], OTHER_COOKIE));
    await s.holder.write(encodeListing([file('a.txt')]).bytes).catch(() => {});
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-cookie']);
    expect(s.listings).toEqual([]);
    expect(s.verified).toBe(0);
    expect(s.link.sent).toHaveLength(0);
    expect(s.link.closed).toBe(true);
  });

  it('a first header of type 0x0101 ends bad-frame', async () => {
    const s = browse();
    s.session.start();
    await s.holder.write(encodeOftHeader(prompt(content(10), 'a.txt')));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-frame']);
    expect(s.link.sent).toHaveLength(0);
    expect(s.listings).toEqual([]);
  });

  it('a first header with a bad magic ends bad-frame', async () => {
    const s = browse();
    s.session.start();
    const bytes = listingHead();
    bytes[0] = 0x58;
    await s.holder.write(bytes);
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-frame']);
    expect(s.link.sent).toHaveLength(0);
  });

  it('a listing header that declares maxListingBytes + 1 ends too-large, and nothing was read past the header', async () => {
    const s = browse({ maxListingBytes: 4096 });
    s.session.start();
    const head = listingHead([], COOKIE, 4097);
    await s.holder.write(joined([head, new Uint8Array(4097)]));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['too-large']);
    expect(s.link.taken).toBe(head.length);
    expect(s.link.sent).toHaveLength(0);
    expect(s.listings).toEqual([]);
  });

  it('a listing of exactly maxListingBytes arrives', async () => {
    const entries = [file('a.txt'), file('b.txt')];
    const s = browse({ maxListingBytes: encodeListing(entries).bytes.length });
    s.session.start();
    await sendListing(s.holder, entries);
    await waitFor(() => s.listings.length === 1, 'the listing');
    expect(s.listings[0]?.entries).toEqual(entries);
  });

  it('a holder that declares 1 MB of listing, sends 1 KB and closes ends peer-closed with no onListing', async () => {
    const s = browse();
    s.session.start();
    await s.holder.write(listingHead([], COOKIE, 1024 * 1024));
    expect((await header(s.holder)).type).toBe(OFT_LISTING_ACK);
    await s.holder.write(new Uint8Array(1024).fill(0x20));
    s.holder.close();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['peer-closed']);
    expect(s.listings).toEqual([]);
  });

  it('300000 lines with maxEntries 20000: onListing has 20000 entries and truncated true', async () => {
    const line = encodeListing([file('a.txt')]).bytes;
    const body = new Uint8Array(line.length * 300_000);
    for (let at = 0; at < body.length; at += line.length) body.set(line, at);
    const s = browse({ maxEntries: 20_000 });
    s.session.start();
    await s.holder.write(listingHead([], COOKIE, body.length));
    await header(s.holder);
    await s.holder.write(body);
    await waitFor(() => s.listings.length === 1, 'the listing', 10_000);
    expect(s.listings[0]?.entries).toHaveLength(20_000);
    expect(s.listings[0]?.truncated).toBe(true);
    expect(s.link.largestReadSome).toBeLessThanOrEqual(READ_MAX);
    expect(s.ends).toEqual([]);
  });

  it('take(["a.txt"], 1024) writes a request for a.txt and the sink receives 1024 equal bytes', async () => {
    const s = await open();
    const data = content(1024);
    const sink = memorySink();
    const steps: TransferProgress[] = [];
    const taking = s.session.take(['a.txt'], 1024, sink, (p) => steps.push(p), live());
    const { request, done } = await serve(s.holder, data, 'a.txt');
    await taking;
    expect(request.header.type).toBe(OFT_FILE_REQUEST);
    expect(request.header.cookie).toBe(COOKIE);
    expect([request.header.totalBytes, request.header.bytes, request.flags & OFT_FLAG_RECEIVED]).toEqual([0, 0, OFT_FLAG_RECEIVED]);
    expect(requestedPath(request)).toEqual(['a.txt']);
    expect(done.header.type).toBe(OFT_DONE);
    expect(done.header.received).toBe(1024);
    expect(done.flags & OFT_FLAG_RECEIVED).toBe(OFT_FLAG_RECEIVED);
    expect(sink.files).toHaveLength(1);
    const taken = sink.files[0] as Taken;
    expect(taken.file).toEqual({ name: 'a.txt', bytes: 1024, modifiedAt: MINUTE, index: 0, count: 1 });
    expect(joined(taken.chunks)).toEqual(data);
    expect(taken.finished).toBe(1);
    expect(steps.at(-1)).toMatchObject({ index: 0, count: 1, fileBytes: 1024, fileDone: 1024, bytesDone: 1024, bytesTotal: 1024 });
    expect(s.link.closed).toBe(false);
    expect(s.ends).toEqual([]);
  });

  it('take(["sub","c.txt"]) asks for the two parts', async () => {
    const s = await open();
    const sink = memorySink();
    const taking = s.session.take(['sub', 'c.txt'], 300, sink, quiet, live());
    const { request } = await serve(s.holder, content(300), 'c.txt');
    await taking;
    expect(requestedPath(request)).toEqual(['sub', 'c.txt']);
    expect(sink.files[0]?.finished).toBe(1);
  });

  it('take of a file whose PROMPT says 2048 for a listed 1024: size-mismatch, the sink got no byte', async () => {
    const s = await open();
    const sink = memorySink();
    const taking = failure(s.session.take(['a.txt'], 1024, sink, quiet, live()));
    await header(s.holder);
    const data = content(2048);
    await s.holder.write(encodeOftHeader(prompt(data, 'a.txt')));
    await s.holder.write(data).catch(() => {});
    expect(await taking).toBe('oft:size-mismatch');
    expect(sink.files).toHaveLength(0);
    // No answer went out after the request.
    expect(decodeOftHeader(s.link.sent.at(-1) as Uint8Array).type).toBe(OFT_FILE_REQUEST);
    expect(s.link.closed).toBe(true);
    expect(s.ends).toEqual(['closed']);
  });

  it('take(["..","x"]) rejects refused and writes nothing', async () => {
    const s = await open();
    const before = s.link.sent.length;
    const sink = memorySink();
    expect(await failure(s.session.take(['..', 'x'], 10, sink, quiet, live()))).toBe('get-file:refused');
    expect(await failure(s.session.take([], 10, sink, quiet, live()))).toBe('get-file:refused');
    expect(await failure(s.session.take(['a/b'], 10, sink, quiet, live()))).toBe('get-file:refused');
    expect(s.link.sent).toHaveLength(before);
    expect(sink.files).toHaveLength(0);
    expect(s.ends).toEqual([]);
  });

  it('a header that is not a PROMPT in answer to a take rejects refused and the session stays open', async () => {
    const s = await open();
    const sink = memorySink();
    const taking = failure(s.session.take(['a.txt'], 1024, sink, quiet, live()));
    const request = await header(s.holder);
    await s.holder.write(encodeOftHeader({ ...request, type: OFT_DONE }));
    expect(await taking).toBe('get-file:refused');
    expect(sink.files).toHaveLength(0);
    expect(s.link.closed).toBe(false);
    expect(s.ends).toEqual([]);
  });

  it('a PROMPT with another cookie ends bad-cookie and sink.begin was not called', async () => {
    const s = await open();
    const sink = memorySink();
    const taking = failure(s.session.take(['a.txt'], 1024, sink, quiet, live()));
    await header(s.holder);
    await s.holder.write(encodeOftHeader(prompt(content(1024), 'a.txt', { cookie: OTHER_COOKIE })));
    expect(await taking).toBe('get-file:bad-cookie');
    expect(sink.files).toHaveLength(0);
    expect(s.ends).toEqual(['bad-cookie']);
  });

  it('two takes run one after the other, in order', async () => {
    const s = await open();
    const sink = memorySink();
    const order: string[] = [];
    const first = s.session.take(['a.txt'], 1024, sink, quiet, live()).then(() => order.push('a'));
    const second = s.session.take(['b.txt'], 2000, sink, quiet, live()).then(() => order.push('b'));
    await pause();
    // The second request waits for the end of the first.
    expect(s.link.sent.filter((bytes) => decodeOftHeader(bytes).type === OFT_FILE_REQUEST)).toHaveLength(1);
    const one = await serve(s.holder, content(1024, 1), 'a.txt');
    const two = await serve(s.holder, content(2000, 2), 'b.txt');
    await Promise.all([first, second]);
    expect(requestedPath(one.request)).toEqual(['a.txt']);
    expect(requestedPath(two.request)).toEqual(['b.txt']);
    expect(order).toEqual(['a', 'b']);
    expect(sink.files.map((taken) => joined(taken.chunks))).toEqual([content(1024, 1), content(2000, 2)]);
  });

  it('a take cancelled midway closes the link and the writer was aborted', async () => {
    const s = await open();
    const signal = live();
    const sink = memorySink((taken) => {
      if (taken.chunks.length === 1) signal.cancelled = true;
    });
    const data = content(300_000);
    const taking = failure(s.session.take(['big.bin'], data.length, sink, quiet, signal));
    await header(s.holder);
    await s.holder.write(encodeOftHeader(prompt(data, 'big.bin')));
    await header(s.holder);
    await s.holder.write(data).catch(() => {});
    expect(await taking).toBe('oft:cancelled');
    const taken = sink.files[0] as Taken;
    expect(taken.aborted).toBe(1);
    expect(taken.finished).toBe(0);
    expect(s.link.closed).toBe(true);
    expect(s.ends).toEqual(['closed']);
  });

  it('a take that is cancelled before its turn writes nothing and leaves the session open', async () => {
    const s = await open();
    const before = s.link.sent.length;
    const sink = memorySink();
    expect(await failure(s.session.take(['a.txt'], 1024, sink, quiet, { cancelled: true }))).toBe('oft:cancelled');
    expect(s.link.sent).toHaveLength(before);
    expect(s.ends).toEqual([]);
  });

  it('the holder closes during a take: the take rejects peer-closed and the session ends peer-closed', async () => {
    const s = await open();
    const sink = memorySink();
    const data = content(100_000);
    const taking = failure(s.session.take(['a.bin'], data.length, sink, quiet, live()));
    await header(s.holder);
    await s.holder.write(encodeOftHeader(prompt(data, 'a.bin')));
    await header(s.holder);
    await s.holder.write(data.subarray(0, 50_000));
    s.holder.close();
    expect(await taking).toBe('oft:peer-closed');
    expect(sink.files[0]?.aborted).toBe(1);
    expect(s.ends).toEqual(['peer-closed']);
  });

  it('a close during a take: the take rejects not-open and the writer was aborted', async () => {
    const s = await open();
    const sink = memorySink();
    const data = content(100_000);
    const taking = failure(s.session.take(['a.bin'], data.length, sink, quiet, live()));
    await header(s.holder);
    await s.holder.write(encodeOftHeader(prompt(data, 'a.bin')));
    await header(s.holder);
    await s.holder.write(data.subarray(0, 50_000));
    await waitFor(() => (sink.files[0]?.chunks.length ?? 0) > 0, 'the first bytes');
    s.session.close();
    expect(await taking).toBe('get-file:not-open');
    expect(sink.files[0]?.aborted).toBe(1);
    expect(s.ends).toEqual(['closed']);
  });

  it('after the end, take rejects not-open', async () => {
    const s = await open();
    const waiting = failure(s.session.take(['a.txt'], 10, memorySink(), quiet, live()));
    await header(s.holder);
    s.session.close();
    s.session.close();
    expect(await waiting).toBe('get-file:not-open');
    expect(s.ends).toEqual(['closed']);
    expect(s.link.closed).toBe(true);
    const before = s.link.sent.length;
    expect(await failure(s.session.take(['a.txt'], 10, memorySink(), quiet, live()))).toBe('get-file:not-open');
    expect(s.link.sent).toHaveLength(before);
  });

  it('take before start rejects not-open', async () => {
    const s = browse();
    expect(await failure(s.session.take(['a.txt'], 10, memorySink(), quiet, live()))).toBe('get-file:not-open');
    expect(s.link.sent).toHaveLength(0);
  });

  it('the holder closes between requests: the session ends peer-closed at once, with no request', async () => {
    const s = await open();
    await pause();
    expect(s.ends).toEqual([]);
    s.holder.close();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['peer-closed']);
    expect(s.link.closed).toBe(true);
    expect(await failure(s.session.take(['a.txt'], 10, memorySink(), quiet, live()))).toBe('get-file:not-open');
  });

  it('the holder closes after a file, between requests: the session ends peer-closed at once', async () => {
    const s = await open();
    const data = content(10);
    const taking = s.session.take(['a.txt'], 10, memorySink(), quiet, live());
    await serve(s.holder, data, 'a.txt');
    await taking;
    expect(s.ends).toEqual([]);
    s.holder.close();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['peer-closed']);
  });

  it('bytes that come between requests are the first bytes of the answer to the next request', async () => {
    const s = await open();
    const data = content(10);
    const head = encodeOftHeader(prompt(data, 'a.txt'));
    await s.holder.write(head.subarray(0, 100));
    await pause();
    expect(s.ends).toEqual([]);
    const sink = memorySink();
    const taking = s.session.take(['a.txt'], 10, sink, quiet, live());
    expect((await header(s.holder)).type).toBe(OFT_FILE_REQUEST);
    await s.holder.write(head.subarray(100));
    expect((await header(s.holder)).type).toBe(OFT_ACK);
    await s.holder.write(data);
    expect((await header(s.holder)).type).toBe(OFT_DONE);
    await taking;
    expect(joined(sink.files[0]?.chunks ?? [])).toEqual(data);
    expect(s.ends).toEqual([]);
  });

  it('a close of this side between requests ends closed, one time', async () => {
    const s = await open();
    await pause();
    s.session.close();
    await pause();
    expect(s.ends).toEqual(['closed']);
  });

  it('the holder closes in answer to a request: the name is not there, and the end is not-there, not a broken connection', async () => {
    const s = await open();
    const sink = memorySink();
    const taking = failure(s.session.take(['gone.txt'], 10, sink, quiet, live()));
    expect(requestedPath(await frame(s.holder))).toEqual(['gone.txt']);
    s.holder.close();
    expect(await taking).toBe('get-file:not-there');
    expect(sink.files).toHaveLength(0);
    expect(s.ends).toEqual(['not-there']);
  });

  it('the holder closes after the header of a file: the take rejects peer-closed', async () => {
    const s = await open();
    const taking = failure(s.session.take(['a.txt'], 1024, memorySink(), quiet, live()));
    await frame(s.holder);
    await s.holder.write(encodeOftHeader(prompt(content(1024), 'a.txt')));
    await frame(s.holder);
    s.holder.close();
    expect(await taking).toBe('oft:peer-closed');
    expect(s.ends).toEqual(['peer-closed']);
  });

  it('each answer to the header of a file is that header with a different type; the answer after the file has the count, the checksum and bit 0', async () => {
    const s = await open();
    const data = content(1024);
    const taking = s.session.take(['a.txt'], 1024, memorySink(), quiet, live());
    await frame(s.holder);
    // The holder has an id text, flags and offsets that a new header does not have.
    const own = decodeOftFrame(encodeOftHeader(prompt(data, 'a.txt'))).bytes;
    own.set(Buffer.from('OFT_Windows ICBMFT V1.1 32\0', 'latin1'), 68);
    own.set([0x02, 0x1a, 0x10], 100);
    const sent = decodeOftFrame(own);
    await s.holder.write(sent.bytes);
    const ack = await frame(s.holder);
    expect(toHex(ack.bytes)).toBe(toHex(answerOftFrame(sent, { type: OFT_ACK }).bytes));
    expect(ack.flags).toBe(0x02);
    await s.holder.write(data);
    const done = await frame(s.holder);
    await taking;
    expect(toHex(done.bytes)).toBe(toHex(answerOftFrame(sent, { type: OFT_DONE, received: { bytes: 1024, checksum: oftChecksum(data) } }).bytes));
    expect([done.flags, done.nameOffset, done.sizeOffset, done.idText]).toEqual([0x03, 0x1a, 0x10, 'OFT_Windows ICBMFT V1.1 32']);
  });

  it('the request after a file is made from the answer after that file', async () => {
    const s = await open();
    const first = s.session.take(['a.txt'], 1024, memorySink(), quiet, live());
    const one = await serve(s.holder, content(1024), 'a.txt');
    await first;
    const second = s.session.take(['sub', 'c.txt'], 300, memorySink(), quiet, live());
    const two = await serve(s.holder, content(300), 'sub\u0001c.txt');
    await second;
    expect(toHex(two.request.bytes)).toBe(toHex(requestHeader(one.done, ['sub', 'c.txt']).bytes));
    expect(two.request.header.received).toBe(1024);
  });

  it('the sink has the last part of the path as the name, whatever name the header of the file has', async () => {
    const s = await open();
    const sink = memorySink();
    const taking = s.session.take(['sub', 'c.txt'], 300, sink, quiet, live());
    await serve(s.holder, content(300), 'sub\u0001..\u0001other.exe');
    await taking;
    expect(sink.files[0]?.file.name).toBe('c.txt');
  });

  it('a listener that throws does not stop the session', async () => {
    const s = browse({
      onVerified: () => {
        throw new Error('the host failed');
      },
      onListing: () => {
        throw new Error('the host failed');
      },
    });
    s.session.start();
    await sendListing(s.holder, [file('a.txt')]);
    const taking = s.session.take(['a.txt'], 1024, memorySink(), quiet, live());
    await serve(s.holder, content(1024), 'a.txt');
    await taking;
    expect(s.ends).toEqual([]);
  });

  it('the log has no listed name and no requested name', async () => {
    const log = captureLog();
    const s = browse({ log: log.log });
    s.session.start();
    await sendListing(s.holder, [file('secret-name.txt')]);
    await waitFor(() => s.listings.length === 1, 'the listing');
    const taking = s.session.take(['secret-name.txt'], 1024, memorySink(), quiet, live());
    await serve(s.holder, content(1024), 'secret-name.txt');
    await taking;
    expect(log.text()).not.toContain('secret-name');
    expect(log.lines.length).toBeGreaterThan(0);
  });

  it('the answers to the listing of AIM are the bytes that AIM took, and the listing is read at the columns of its header', async () => {
    const aim = loadVectors('aim-get-file.json');
    const listing = decodeOftFrame(bytesOf(aim, '5.1 listing header'));
    expect(listing.header.type).toBe(OFT_LISTING);
    const s = browse({ cookie: listing.header.cookie });
    s.session.start();
    await s.holder.write(listing.bytes);
    expect(toHex((await frame(s.holder)).bytes)).toBe(vector(aim, 'listing acknowledge that 5.1 took').hex);
    await s.holder.write(bytesOf(aim, '5.1 listing'));
    const done = await frame(s.holder);
    expect(toHex(done.bytes)).toBe(vector(aim, 'listing done that 5.1 took').hex);
    await waitFor(() => s.listings.length === 1, 'the listing');
    expect(s.listings[0]?.entries).toHaveLength(207);
    expect(s.listings[0]?.entries.at(-1)?.path).toEqual(['sub', 'deep', 'd.txt']);
    expect([s.listings[0]?.truncated, s.listings[0]?.damaged]).toEqual([false, false]);
    // A request is the last answer with the name of the file.
    const taking = s.session.take(['a.txt'], 1024, memorySink(), quiet, live());
    expect(toHex((await frame(s.holder)).bytes)).toBe(toHex(requestHeader(done, ['a.txt']).bytes));
    // 1024 bytes with the checksum of the file that AIM sent.
    const data = new Uint8Array(1024);
    data.set([0xd5, 0x42]);
    await s.holder.write(bytesOf(aim, '5.1 prompt'));
    expect(toHex((await frame(s.holder)).bytes)).toBe(vector(aim, 'ack that 5.1 took').hex);
    await s.holder.write(data);
    const fileDone = await frame(s.holder);
    expect(toHex(fileDone.bytes)).toBe(vector(aim, 'done that 5.1 took').hex);
    await taking;
    void s.session.take(['sub', 'c.txt'], 64, memorySink(), quiet, live()).catch(() => {});
    expect(toHex((await frame(s.holder)).bytes)).toBe(toHex(requestHeader(fileDone, ['sub', 'c.txt']).bytes));
  });
});

type Held = { path: string[]; data: Uint8Array };
type Source = SharedSource & { opened: string[][]; listed: string[][] };

// A source in memory. `opened` and `listed` hold each path that the session asked for.
function memorySource(files: readonly Held[], over: Partial<SharedSource> = {}): Source {
  const opened: string[][] = [];
  const listed: string[][] = [];
  const under = (path: readonly string[], dir: readonly string[]): boolean => path.length > dir.length && dir.every((part, i) => path[i] === part);
  return {
    opened,
    listed,
    list: async (dir) => {
      listed.push([...dir]);
      const inside = files.filter((held) => under(held.path, dir));
      if (dir.length > 0 && inside.length === 0) return null;
      const out: SharedEntry[] = [];
      for (const held of inside) {
        const name = held.path[dir.length] as string;
        const isFolder = held.path.length > dir.length + 1;
        if (out.some((entry) => entry.path[dir.length] === name)) continue;
        out.push({ path: [...dir, name], folder: isFolder, bytes: isFolder ? 0 : held.data.length, modifiedAt: MINUTE });
      }
      return out;
    },
    open: async (path) => {
      opened.push([...path]);
      const held = files.find((one) => one.path.length === path.length && one.path.every((part, i) => part === path[i]));
      return held ? outgoing(path[path.length - 1] as string, held.data) : null;
    },
    ...over,
  };
}

function outgoing(name: string, data: Uint8Array, yielded = data): OutgoingFile {
  return {
    name,
    bytes: data.length,
    modifiedAt: MINUTE,
    read: async function* () {
      for (let at = 0; at < yielded.length; at += 4096) yield yielded.subarray(at, at + 4096);
    },
  };
}

type Serving = {
  session: ServeSession;
  /** The end of the requester. The test has it. */
  link: MemoryLink;
  holder: MemoryLink;
  source: Source;
  verified: number;
  taken: { path: readonly string[]; bytes: number }[];
  ends: (GetFileFailure | 'closed')[];
  may: boolean;
  timers: ManualTimers;
  /** The last answer that the requester wrote. A request is made from it. */
  last: OftFrame;
};

const SHARED: Held[] = [
  { path: ['a.txt'], data: content(1000, 1) },
  { path: ['b.bin'], data: content(70_000, 2) },
  { path: ['sub', 'c.txt'], data: content(20, 3) },
];

function serving(files: readonly Held[] = SHARED, over: Partial<ServeSessionDeps> = {}, sourceOver: Partial<SharedSource> = {}): Serving {
  const [a, b] = pair();
  const out: Serving = {
    session: undefined as unknown as ServeSession, link: b, holder: a, source: memorySource(files, sourceOver), verified: 0, taken: [], ends: [], may: true,
    timers: new ManualTimers(), last: undefined as unknown as OftFrame,
  };
  out.session = new ServeSession({
    link: a,
    cookie: COOKIE,
    log: captureLog().log,
    timers: out.timers.api,
    now: () => 0,
    source: out.source,
    form: 'text',
    maxEntries: GET_FILE_MAX_ENTRIES,
    mayServe: () => out.may,
    onVerified: () => {
      out.verified += 1;
    },
    onTaken: (path, bytes) => {
      out.taken.push({ path, bytes });
    },
    onEnd: (why) => {
      out.ends.push(why);
    },
    ...over,
  });
  return out;
}

// The requester reads the listing: the header, its two answers and the body.
async function readListing(s: Serving, cookie = COOKIE): Promise<ListingEntry[]> {
  const first = await frame(s.link);
  expect(first.header.type).toBe(OFT_LISTING);
  expect(first.header.cookie).toBe(cookie);
  await s.link.write(listingAck(first).bytes);
  const length = listingLength(first.header);
  const body = length > 0 ? await s.link.read(length) : new Uint8Array(0);
  s.last = listingDone(first, body);
  await s.link.write(s.last.bytes);
  return decodeListing(body, first, GET_FILE_MAX_ENTRIES).entries;
}

// A session whose listing the requester has.
async function served(files: readonly Held[] = SHARED, over: Partial<ServeSessionDeps> = {}, sourceOver: Partial<SharedSource> = {}): Promise<Serving> {
  const s = serving(files, over, sourceOver);
  s.session.start();
  await readListing(s, over.cookie);
  return s;
}

// The holder writes nothing and keeps the link open for the wait, then closes it.
async function closedAfterTheWait(s: Serving): Promise<void> {
  await waitFor(() => s.timers.pending().length === 1, 'the wait');
  expect(s.timers.pending()).toEqual([NOT_THERE_CLOSE_MS]);
  await s.timers.advance(NOT_THERE_CLOSE_MS - 1);
  expect(s.ends).toEqual([]);
  expect(s.holder.closed).toBe(false);
  await s.timers.advance(1);
  await waitFor(() => s.ends.length === 1, 'the end');
}

// A request with a name that the codec of a request refuses.
function rawRequest(s: Serving, name: string): Uint8Array {
  return answerOftFrame(s.last, { type: OFT_FILE_REQUEST, name }).bytes;
}

// The requester asks for one file and takes it.
async function fetched(s: Serving, path: readonly string[]): Promise<Uint8Array | OftHeader> {
  const { link } = s;
  await link.write(requestHeader(s.last, path).bytes);
  const first = await header(link);
  if (first.type !== OFT_PROMPT) return first;
  await link.write(encodeOftHeader({ ...first, type: OFT_ACK }));
  const data = await link.read(first.bytes);
  await link.write(encodeOftHeader({ ...first, type: OFT_DONE, received: data.length }));
  return data;
}

describe('the holder side of a Get File link', () => {
  it('start writes the header of the listing, and no listing byte before 0x1209', async () => {
    const s = serving(SHARED, { now: () => MINUTE * 1000 });
    s.session.start();
    const first = await frame(s.link);
    expect(first.header.type).toBe(OFT_LISTING);
    expect(first.header.cookie).toBe(COOKIE);
    await pause();
    expect(s.holder.sent).toHaveLength(1);
    expect(s.verified).toBe(0);
    await s.link.write(listingAck(first).bytes);
    const body = await s.link.read(listingLength(first.header));
    expect(s.verified).toBe(1);
    // One listing holds each file of the whole source, and no folder.
    expect(decodeListing(body, first, 100).entries.map((entry) => [entry.path.join('/'), entry.bytes])).toEqual([
      ['a.txt', 1000], ['b.bin', 70_000], ['sub/c.txt', 20],
    ]);
    expect(s.source.listed).toEqual([[], ['sub']]);
    expect(first.header).toMatchObject({
      totalFiles: 3, filesLeft: 3, totalBytes: 71_020, bytes: body.length, checksum: oftChecksum(body), modifiedAt: MINUTE, name: 'listing.txt',
    });
    await s.link.write(listingDone(first, body).bytes);
    await pause();
    expect(s.holder.sent).toHaveLength(2);
    expect(s.ends).toEqual([]);
  });

  it('0x1209 with another cookie ends bad-cookie and no listing byte was written', async () => {
    const s = serving();
    s.session.start();
    const first = await frame(s.link);
    await s.link.write(encodeOftHeader({ ...listingAck(first).header, cookie: OTHER_COOKIE }));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-cookie']);
    expect(s.holder.sent).toHaveLength(1);
    expect(s.verified).toBe(0);
    expect(s.holder.closed).toBe(true);
  });

  it('a header that is not 0x1209 in answer to the listing ends bad-frame', async () => {
    const s = serving();
    s.session.start();
    const first = await frame(s.link);
    await s.link.write(listingDone(first, new Uint8Array(0)).bytes);
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-frame']);
    expect(s.holder.sent).toHaveLength(1);
  });

  it('an empty shared folder goes out as a listing of 0 bytes', async () => {
    const s = serving([]);
    s.session.start();
    const first = await frame(s.link);
    expect(listingLength(first.header)).toBe(0);
    expect(first.header.totalFiles).toBe(0);
    await s.link.write(listingAck(first).bytes);
    await s.link.write(listingDone(first, new Uint8Array(0)).bytes);
    await pause();
    expect(s.ends).toEqual([]);
    expect(s.verified).toBe(1);
  });

  it('a source with no shared folder closes the link and writes nothing', async () => {
    const s = serving([], {}, { list: async () => null });
    s.session.start();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['closed']);
    expect(s.holder.sent).toHaveLength(0);
    expect(s.holder.closed).toBe(true);
  });

  it('mayServe false at the start: nothing is written and the source is not asked', async () => {
    const s = serving();
    s.may = false;
    s.session.start();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['closed']);
    expect(s.holder.sent).toHaveLength(0);
    expect(s.source.listed).toEqual([]);
  });

  it('a request for a file: the file goes out and onTaken has the path and the size', async () => {
    const s = await served();
    expect(s.taken).toEqual([]);
    expect(await fetched(s, ['a.txt'])).toEqual(content(1000, 1));
    await waitFor(() => s.taken.length === 1, 'the file was taken');
    expect(s.taken).toEqual([{ path: ['a.txt'], bytes: 1000 }]);
    expect(await fetched(s, ['sub', 'c.txt'])).toEqual(content(20, 3));
    await waitFor(() => s.taken.length === 2, 'the second file was taken');
    expect(s.taken[1]).toEqual({ path: ['sub', 'c.txt'], bytes: 20 });
    expect(s.ends).toEqual([]);
  });

  it('a requester that closes after the last byte and writes no DONE: the file is taken', async () => {
    const s = await served();
    await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
    const first = await header(s.link);
    await s.link.write(encodeOftHeader({ ...first, type: OFT_ACK }));
    expect(await s.link.read(first.bytes)).toEqual(content(1000, 1));
    s.link.close();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.taken).toEqual([{ path: ['a.txt'], bytes: 1000 }]);
    expect(s.ends).toEqual(['peer-closed']);
  });

  it('a requester that writes a header that is not DONE after the last byte: the file is taken one time', async () => {
    const s = await served();
    await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
    const first = await header(s.link);
    await s.link.write(encodeOftHeader({ ...first, type: OFT_ACK }));
    await s.link.read(first.bytes);
    await s.link.write(encodeOftHeader({ ...first, type: OFT_ACK }));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.taken).toEqual([{ path: ['a.txt'], bytes: 1000 }]);
  });

  it('a request for a folder closes the link after the wait: no header refuses a request, and no listing of one folder exists', async () => {
    const s = await served();
    const before = s.holder.sent.length;
    await s.link.write(requestHeader(s.last, ['sub']).bytes);
    await closedAfterTheWait(s);
    expect(s.ends).toEqual(['closed']);
    expect(s.holder.sent).toHaveLength(before);
    expect(s.holder.closed).toBe(true);
    expect(s.taken).toEqual([]);
  });

  it('requests for "..\\u0001secret.txt", "/etc/passwd" and "": each closes the link after the wait, and the source was not asked', async () => {
    for (const name of ['..\u0001secret.txt', '/etc/passwd', '']) {
      const s = await served();
      const before = s.holder.sent.length;
      s.source.listed.length = 0;
      await s.link.write(rawRequest(s, name));
      await closedAfterTheWait(s);
      expect(s.ends, name).toEqual(['closed']);
      expect(s.holder.sent).toHaveLength(before);
      expect(s.source.opened).toEqual([]);
      expect(s.source.listed).toEqual([]);
    }
  });

  it('a name that is not in the listing: no byte goes out, the source is not asked, and the link closes after the wait', async () => {
    const s = await served();
    const before = s.holder.sent.length;
    s.source.listed.length = 0;
    await s.link.write(requestHeader(s.last, ['nope.txt']).bytes);
    await closedAfterTheWait(s);
    expect(s.ends).toEqual(['closed']);
    expect(s.source.opened).toEqual([]);
    expect(s.source.listed).toEqual([]);
    expect(s.holder.sent).toHaveLength(before);
    expect(s.holder.closed).toBe(true);
  });

  it('a file that the listing has and the source does not open closes the link after the wait', async () => {
    const s = await served(SHARED, {}, { open: async () => null });
    const before = s.holder.sent.length;
    await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
    await closedAfterTheWait(s);
    expect(s.ends).toEqual(['closed']);
    expect(s.holder.sent).toHaveLength(before);
  });

  it('a file that the source has and the listing does not have is not opened', async () => {
    const s = await served(SHARED, { maxEntries: 2 });
    await s.link.write(requestHeader(s.last, ['sub', 'c.txt']).bytes);
    await closedAfterTheWait(s);
    expect(s.source.opened).toEqual([]);
    expect(s.taken).toEqual([]);
  });

  it('close during the wait ends the session one time and stops the wait', async () => {
    const s = await served();
    await s.link.write(requestHeader(s.last, ['nope.txt']).bytes);
    await waitFor(() => s.timers.pending().length === 1, 'the wait');
    s.session.close();
    expect(s.timers.pending()).toEqual([]);
    await pause();
    expect(s.ends).toEqual(['closed']);
  });

  it('the header of a file has the path as its name, with byte 0x01 between the parts', async () => {
    const s = await served();
    await s.link.write(requestHeader(s.last, ['sub', 'c.txt']).bytes);
    const first = await header(s.link);
    expect([first.type, first.name, first.totalFiles, first.filesLeft, first.bytes]).toEqual([OFT_PROMPT, 'sub\u0001c.txt', 1, 1, 20]);
  });

  it('the header of a file with a Latin-1 name has the encoding 0 and one byte for each character', async () => {
    const data = content(64, 4);
    const s = await served([{ path: ['caf\u00e9.txt'], data }]);
    await s.link.write(requestHeader(s.last, ['caf\u00e9.txt']).bytes);
    const first = await frame(s.link);
    expect(first.header.type).toBe(OFT_PROMPT);
    expect(toHex(first.bytes.subarray(188, 192))).toBe('00000000');
    expect(toHex(first.bytes.subarray(192, 201))).toBe('636166e92e74787400');
    expect(first.header.name).toBe('caf\u00e9.txt');
    await s.link.write(answerOftFrame(first, { type: OFT_ACK }).bytes);
    expect(await s.link.read(64)).toEqual(data);
    await s.link.write(answerOftFrame(first, { type: OFT_DONE, received: { bytes: 64, checksum: oftChecksum(data) } }).bytes);
    await waitFor(() => s.taken.length === 1, 'the file was taken');
    expect(s.taken).toEqual([{ path: ['caf\u00e9.txt'], bytes: 64 }]);
  });

  it('the answer to a resume request has the name bytes of the PROMPT: Latin-1 with the encoding 0', async () => {
    const s = await served([{ path: ['caf\u00e9.txt'], data: content(64, 4) }]);
    await s.link.write(requestHeader(s.last, ['caf\u00e9.txt']).bytes);
    const first = await frame(s.link);
    await s.link.write(answerOftFrame(first, { type: OFT_RESUME }).bytes);
    const answer = await frame(s.link);
    expect(answer.header.type).toBe(OFT_RESUME_ANSWER);
    expect(toHex(answer.bytes.subarray(188, 201))).toBe(toHex(first.bytes.subarray(188, 201)));
    expect(toHex(answer.bytes.subarray(192, 201))).toBe('636166e92e74787400');
  });

  it('the answers to the header of a file are accepted with another name, as AIM writes them', async () => {
    const s = await served();
    await s.link.write(requestHeader(s.last, ['sub', 'c.txt']).bytes);
    const first = await frame(s.link);
    await s.link.write(encodeOftHeader({ ...first.header, type: OFT_ACK, name: 'sub\\c.txt' }));
    expect(await s.link.read(20)).toEqual(content(20, 3));
    await s.link.write(encodeOftHeader({ ...first.header, type: OFT_DONE, received: 20, name: 'sub\\c.txt' }));
    await waitFor(() => s.taken.length === 1, 'the file was taken');
    expect(s.ends).toEqual([]);
  });

  it('a source that throws closes the link', async () => {
    const s = await served(SHARED, {}, {
      open: async () => {
        throw new Error('the disk failed');
      },
    });
    const before = s.holder.sent.length;
    await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
    await closedAfterTheWait(s);
    expect(s.ends).toEqual(['closed']);
    expect(s.holder.sent).toHaveLength(before);
  });

  it('a file that has 4 GB or more when it is opened closes the link after the wait, and no byte goes out', async () => {
    const s = await served(SHARED, {}, { open: async () => ({ ...outgoing('big.bin', new Uint8Array(0)), bytes: 0x1_0000_0000 }) });
    const before = s.holder.sent.length;
    await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
    await closedAfterTheWait(s);
    expect(s.ends).toEqual(['closed']);
    expect(s.holder.sent).toHaveLength(before);
  });

  it('the requests of AIM for a name at the top and for a path are read', async () => {
    const aim = loadVectors('aim-get-file.json');
    const top = decodeOftFrame(bytesOf(aim, '5.1 request, a name at the top'));
    const s = await served(SHARED, { cookie: top.header.cookie });
    await s.link.write(top.bytes);
    const first = await header(s.link);
    expect(first.type).toBe(OFT_PROMPT);
    await s.link.write(encodeOftHeader({ ...first, type: OFT_DONE }));
    await s.link.write(bytesOf(aim, '5.1 request, a path'));
    expect((await header(s.link)).type).toBe(OFT_PROMPT);
    expect(s.source.opened).toEqual([['a.txt'], ['sub', 'c.txt']]);
  });

  it('mayServe false before a request: no byte goes out and the link closes', async () => {
    const s = await served();
    const before = s.holder.sent.length;
    s.source.listed.length = 0;
    s.may = false;
    await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['closed']);
    expect(s.holder.sent).toHaveLength(before);
    expect(s.source.opened).toEqual([]);
    expect(s.source.listed).toEqual([]);
    expect(s.holder.closed).toBe(true);
  });

  it('the requester answers the PROMPT with DONE: no file byte goes out, nothing is taken, and the next request works', async () => {
    const s = await served();
    await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
    const first = await header(s.link);
    expect(first.type).toBe(OFT_PROMPT);
    const before = s.holder.sent.length;
    await s.link.write(encodeOftHeader({ ...first, type: OFT_DONE }));
    expect(await fetched(s, ['sub', 'c.txt'])).toEqual(content(20, 3));
    await waitFor(() => s.taken.length === 1, 'the second file was taken');
    expect(s.taken).toEqual([{ path: ['sub', 'c.txt'], bytes: 20 }]);
    // The PROMPT of the second file and its bytes are each write after the DONE.
    expect(s.holder.sent.slice(before).reduce((sum, part) => sum + part.length, 0)).toBeLessThan(1000);
    expect(s.ends).toEqual([]);
  });

  it('more answers of DONE to a PROMPT than the limit end the session bad-frame, and the source is not opened again', async () => {
    const s = await served();
    const refuse = async (): Promise<void> => {
      await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
      const first = await header(s.link);
      expect(first.type).toBe(OFT_PROMPT);
      await s.link.write(encodeOftHeader({ ...first, type: OFT_DONE }));
    };
    for (let i = 0; i < NOT_TAKEN_MAX; i++) await refuse();
    await pause();
    expect(s.ends).toEqual([]);
    await refuse();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-frame']);
    expect(s.source.opened).toHaveLength(NOT_TAKEN_MAX + 1);
    expect(s.taken).toEqual([]);
    expect(s.holder.closed).toBe(true);
  });

  it('the source yields fewer bytes than it listed: the link closes and nothing is taken', async () => {
    const s = await served(SHARED, {}, { open: async () => outgoing('a.txt', content(1000, 1), content(400, 1)) });
    await s.link.write(requestHeader(s.last, ['a.txt']).bytes);
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['closed']);
    expect(s.taken).toEqual([]);
    expect(s.holder.closed).toBe(true);
  });

  it('a header that is not a request ends bad-frame', async () => {
    const s = await served();
    await s.link.write(encodeOftHeader(prompt(content(4), 'x')));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-frame']);
  });

  it('a name that the source has with a letter and a mark after it is listed as one character, and a request for it opens the path of the source', async () => {
    const apart = 'cafe\u0301.txt';
    const one = 'caf\u00e9.txt';
    for (const form of ['text', 'lst1'] as const) {
      const s = await servedAs(form, [{ path: ['sub', apart], data: content(20, 5) }]);
      const top = form === 'lst1' ? ['shared'] : [];
      expect(s.entries.map((entry) => entry.path)).toEqual([[...top, 'sub', one]]);
      expect((await asked(s, requestHeader(s.last, [...top, 'sub', one]).bytes)).data).toEqual(content(20, 5));
      expect(s.source.opened).toEqual([['sub', apart]]);
    }
  });

  it('the count of the entries that a listing leaves out is in a line at info, with no name', async () => {
    const log = captureLog();
    await served([{ path: ['a.txt'], data: content(4) }, { path: ['\u0416.txt'], data: content(4) }, { path: ['\u5199.jpg'], data: content(4) }], { log: log.log });
    await waitFor(() => log.lines.some((line) => line.msg === 'a get file listing left out entries'), 'the line');
    const line = log.lines.find((entry) => entry.msg === 'a get file listing left out entries');
    expect([line?.level, line?.fields]).toEqual(['info', { count: 2 }]);
    const none = captureLog();
    const s = await served(SHARED, { log: none.log });
    expect(await fetched(s, ['a.txt'])).toEqual(content(1000, 1));
    expect(none.lines.some((entry) => entry.msg === 'a get file listing left out entries')).toBe(false);
  });

  it('a request with another cookie ends bad-cookie and the source was not asked', async () => {
    const s = await served();
    await s.link.write(encodeOftHeader({ ...requestHeader(s.last, ['a.txt']).header, cookie: OTHER_COOKIE }));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-cookie']);
    expect(s.source.opened).toEqual([]);
  });

  it('the requester closes: the session ends peer-closed', async () => {
    const s = await served();
    s.link.close();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['peer-closed']);
  });

  it('close during a file: the end is closed, one time, and nothing is taken', async () => {
    const s = await served();
    await s.link.write(requestHeader(s.last, ['b.bin']).bytes);
    const first = await header(s.link);
    await s.link.write(encodeOftHeader({ ...first, type: OFT_ACK }));
    await s.link.read(100);
    s.session.close();
    await pause();
    expect(s.ends).toEqual(['closed']);
    expect(s.taken).toEqual([]);
    expect(s.holder.closed).toBe(true);
  });

  it('a listing has no more entries than maxEntries', async () => {
    const s = serving(SHARED, { maxEntries: 2 });
    s.session.start();
    expect(await readListing(s)).toHaveLength(2);
  });

  it('a listener that throws does not stop the session', async () => {
    const s = await served(SHARED, {
      onVerified: () => {
        throw new Error('the host failed');
      },
      onTaken: () => {
        throw new Error('the host failed');
      },
    });
    expect(await fetched(s, ['a.txt'])).toEqual(content(1000, 1));
    expect(await fetched(s, ['sub', 'c.txt'])).toEqual(content(20, 3));
    expect(s.ends).toEqual([]);
  });

  it('the log has no listed name and no requested name', async () => {
    const log = captureLog();
    const s = await served([{ path: ['secret-name.txt'], data: content(10) }], { log: log.log });
    expect(await fetched(s, ['secret-name.txt'])).toEqual(content(10));
    // The link closes for a name that is not shared.
    await s.link.write(requestHeader(s.last, ['secret-other.txt']).bytes);
    await closedAfterTheWait(s);
    expect(log.text()).not.toContain('secret-');
    expect(log.lines.length).toBeGreaterThan(0);
  });
});

const LST1 = loadVectors('aim-get-file-lst1.json');
// 1024 bytes with the checksum of the file of the vectors.
function vectorFile(): Uint8Array {
  const data = new Uint8Array(1024);
  data.set([0xd5, 0x42]);
  return data;
}

describe('the requester side: a listing of the Lst1 form', () => {
  it('the listing that AIM 5.9 read arrives: the answers are without bit 0x10, and each path keeps the name of the folder', async () => {
    const listing = decodeOftFrame(bytesOf(LST1, 'listing header that 5.9 answered'));
    const body = bytesOf(LST1, 'listing that 5.9 read');
    const s = browse({ cookie: listing.header.cookie });
    s.session.start();
    await s.holder.write(listing.bytes);
    const ack = await frame(s.holder);
    expect([ack.header.type, ack.flags]).toEqual([OFT_LISTING_ACK, 0x20]);
    await s.holder.write(body);
    const done = await frame(s.holder);
    expect([done.header.type, done.flags, done.header.received, done.header.receivedChecksum]).toEqual([OFT_LISTING_DONE, 0x21, body.length, oftChecksum(body)]);
    // Each byte that the answers do not change is a byte of the holder.
    expect(toHex(ack.bytes)).toBe(toHex(listingAck(listing).bytes));
    await waitFor(() => s.listings.length === 1, 'the listing');
    expect(s.listings[0]?.entries).toHaveLength(207);
    expect(s.listings[0]?.entries[0]).toEqual({ path: ['share', 'a.txt'], bytes: 1024, modifiedAt: 1794519649 });
    expect(s.listings[0]?.entries.at(-1)?.path).toEqual(['share', 'sub', 'deep', 'd.txt']);
    expect([s.listings[0]?.truncated, s.listings[0]?.damaged]).toEqual([false, false]);
  });

  it('a take asks with the path as it came, and the ack and the done of the file are the header of the holder sent back: the bytes of AIM 5.9', async () => {
    const listing = decodeOftFrame(bytesOf(LST1, 'listing header that 5.9 answered'));
    const s = browse({ cookie: listing.header.cookie });
    s.session.start();
    await s.holder.write(listing.bytes);
    await frame(s.holder);
    await s.holder.write(bytesOf(LST1, 'listing that 5.9 read'));
    await frame(s.holder);
    const sink = memorySink();
    const taking = s.session.take(['share', 'a.txt'], 1024, sink, quiet, live());
    const request = await frame(s.holder);
    expect([request.header.type, request.header.name, request.flags]).toEqual([OFT_FILE_REQUEST, 'share\u0001a.txt', 0x21]);
    await s.holder.write(bytesOf(LST1, 'prompt that 5.9 answered'));
    expect(toHex((await frame(s.holder)).bytes)).toBe(vector(LST1, '5.9 ack').hex);
    await s.holder.write(vectorFile());
    const fileDone = await frame(s.holder);
    expect(toHex(fileDone.bytes)).toBe(vector(LST1, '5.9 done').hex);
    await taking;
    expect(sink.files[0]?.file.name).toBe('a.txt');
    // The next request is made from the answer after the file.
    void s.session.take(['share', 'sub', 'c.txt'], 64, memorySink(), quiet, live()).catch(() => {});
    const next = await frame(s.holder);
    expect([next.header.name, next.flags]).toEqual(['share\u0001sub\u0001c.txt', 0x21]);
    expect(toHex(next.bytes)).toBe(toHex(requestHeader(fileDone, ['share', 'sub', 'c.txt']).bytes));
  });

  it('a header of a file that has bit 0x10 gets answers without it', async () => {
    const s = await open();
    const data = content(50);
    const taking = s.session.take(['a.txt'], 1024, memorySink(), quiet, live());
    await frame(s.holder);
    await s.holder.write(encodeOftHeader(prompt(data, 'a.txt'), 'utf-8', 0x30));
    expect((await frame(s.holder)).flags).toBe(0x20);
    await s.holder.write(data);
    expect((await frame(s.holder)).flags).toBe(0x21);
    await taking;
  });

  it('three records with maxEntries 2: two entries and truncated true; records that do not decode set damaged', async () => {
    const entries = [file('a.txt'), file('b.txt'), file('sub/c.txt')];
    const send = async (s: Side, body: Uint8Array): Promise<void> => {
      const written = { ...encodeLst1Listing(entries, 'share'), bytes: body };
      await s.holder.write(listingFrame(COOKIE, written, MINUTE).bytes);
      await frame(s.holder);
      await s.holder.write(body);
      await frame(s.holder);
      await waitFor(() => s.listings.length === 1, 'the listing');
    };
    const whole = encodeLst1Listing(entries, 'share').bytes;
    const cut = browse({ maxEntries: 2 });
    cut.session.start();
    await send(cut, whole);
    expect([cut.listings[0]?.entries.length, cut.listings[0]?.truncated, cut.listings[0]?.damaged]).toEqual([2, true, false]);
    const broken = browse();
    broken.session.start();
    await send(broken, whole.subarray(0, whole.length - 3));
    expect([broken.listings[0]?.entries.length, broken.listings[0]?.truncated, broken.listings[0]?.damaged]).toEqual([2, false, true]);
  });

  it('a Lst1 header that declares maxListingBytes + 1 ends too-large, and nothing was read past the header', async () => {
    const s = browse({ maxListingBytes: 1000 });
    s.session.start();
    const written = { ...encodeLst1Listing([], 'share'), bytes: new Uint8Array(1001) };
    await s.holder.write(listingFrame(COOKIE, written, MINUTE).bytes);
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['too-large']);
    expect(s.link.sent).toHaveLength(0);
  });
});

// A holder session that writes the form that the test gives. The requester has the listing.
async function servedAs(form: 'text' | 'lst1', files: readonly Held[] = SHARED, over: Partial<ServeSessionDeps> = {}, sourceOver: Partial<SharedSource> = {}): Promise<Serving & { first: OftFrame; entries: ListingEntry[] }> {
  const s = serving(files, { form, ...over }, sourceOver);
  s.session.start();
  const first = await frame(s.link);
  await s.link.write(listingAck(first).bytes);
  const length = listingLength(first.header);
  const body = length > 0 ? await s.link.read(length) : new Uint8Array(0);
  s.last = listingDone(first, body);
  await s.link.write(s.last.bytes);
  const entries = form === 'lst1' ? decodeLst1Listing(body, GET_FILE_MAX_ENTRIES).entries : decodeListing(body, first, GET_FILE_MAX_ENTRIES).entries;
  return { ...s, first, entries };
}

// A request as AIM 5.9 writes it: a header with only the type, the cookie and the name.
function blankRequest(name: string, cookie = COOKIE): Uint8Array {
  return encodeOftHeader({
    type: OFT_FILE_REQUEST, cookie, totalFiles: 0, filesLeft: 0, totalParts: 0, partsLeft: 0, totalBytes: 0, bytes: 0, modifiedAt: 0, checksum: 0,
    received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: 0, name,
  }, 'latin-1');
}

// The requester writes the bytes of a request and takes the file, or sees the link close after the wait.
async function asked(s: Serving, request: Uint8Array): Promise<{ name: string; data: Uint8Array }> {
  await s.link.write(request);
  const first = await frame(s.link);
  expect(first.header.type).toBe(OFT_PROMPT);
  await s.link.write(answerOftFrame(first, { type: OFT_ACK }).bytes);
  const data = first.header.bytes > 0 ? await s.link.read(first.header.bytes) : new Uint8Array(0);
  s.last = answerOftFrame(first, { type: OFT_DONE, received: { bytes: data.length, checksum: oftChecksum(data) } });
  await s.link.write(s.last.bytes);
  return { name: first.header.name, data };
}

describe('the holder side: the form of the listing', () => {
  it('a proposal whose number is 2 gets the Lst1 listing, flags 0x30, the folder name first', async () => {
    const s = await servedAs('lst1', SHARED, { now: () => MINUTE * 1000 }, { name: 'My Files' });
    expect(s.first.flags).toBe(0x30);
    expect(s.first.flags & OFT_FLAG_LST1).toBe(OFT_FLAG_LST1);
    const length = listingLength(s.first.header);
    expect(s.first.header).toMatchObject({ type: OFT_LISTING, totalFiles: 3, filesLeft: 1, totalBytes: length, bytes: length, modifiedAt: MINUTE, name: '' });
    expect(s.entries.map((entry) => [entry.path.join('/'), entry.bytes, entry.modifiedAt])).toEqual([
      ['My Files/a.txt', 1000, MINUTE], ['My Files/b.bin', 70_000, MINUTE], ['My Files/sub/c.txt', 20, MINUTE],
    ]);
    expect(s.source.listed).toEqual([[], ['sub']]);
  });

  it('a proposal whose number is 1 gets the text listing, no folder name', async () => {
    const s = await servedAs('text', SHARED, { now: () => MINUTE * 1000 }, { name: 'My Files' });
    expect(s.first.flags).toBe(0x20);
    expect(s.first.header).toMatchObject({ type: OFT_LISTING, totalFiles: 3, filesLeft: 3, totalBytes: 71_020, name: 'listing.txt' });
    expect(s.entries.map((entry) => entry.path.join('/'))).toEqual(['a.txt', 'b.bin', 'sub/c.txt']);
  });

  it('a source with no name, and a source with a name that a path cannot hold, show below the folder "shared"', async () => {
    for (const name of [undefined, '', 'a\\b', '..']) {
      const s = await servedAs('lst1', SHARED, {}, name === undefined ? {} : { name });
      expect(s.entries[0]?.path, JSON.stringify(name)).toEqual(['shared', 'a.txt']);
    }
  });

  it('a requested path is found with the folder name first (after an Lst1 listing) and without it (after a text listing)', async () => {
    const lst1 = await servedAs('lst1', SHARED, {}, { name: 'My Files' });
    expect((await asked(lst1, requestHeader(lst1.last, ['My Files', 'sub', 'c.txt']).bytes)).data).toEqual(content(20, 3));
    await waitFor(() => lst1.taken.length === 1, 'the file was taken');
    // The source and the host get the path without the name of the folder.
    expect(lst1.source.opened).toEqual([['sub', 'c.txt']]);
    expect(lst1.taken).toEqual([{ path: ['sub', 'c.txt'], bytes: 20 }]);
    const before = lst1.holder.sent.length;
    await lst1.link.write(requestHeader(lst1.last, ['sub', 'c.txt']).bytes);
    await closedAfterTheWait(lst1);
    expect(lst1.holder.sent).toHaveLength(before);
    expect(lst1.source.opened).toEqual([['sub', 'c.txt']]);

    const text = await servedAs('text', SHARED, {}, { name: 'My Files' });
    expect((await asked(text, requestHeader(text.last, ['sub', 'c.txt']).bytes)).data).toEqual(content(20, 3));
    await text.link.write(requestHeader(text.last, ['My Files', 'sub', 'c.txt']).bytes);
    await closedAfterTheWait(text);
    expect(text.source.opened).toEqual([['sub', 'c.txt']]);
  });

  it('after an Lst1 listing, a name that the listing did not hold opens nothing: another folder name, a file that is not there, and the folder', async () => {
    for (const path of [['Other', 'a.txt'], ['My Files', 'nope.txt'], ['My Files'], ['My Files', 'sub'], ['My Files', 'My Files', 'a.txt']]) {
      const s = await servedAs('lst1', SHARED, {}, { name: 'My Files' });
      const before = s.holder.sent.length;
      await s.link.write(requestHeader(s.last, path).bytes);
      await closedAfterTheWait(s);
      expect(s.ends, path.join('/')).toEqual(['closed']);
      expect(s.holder.sent).toHaveLength(before);
      expect(s.source.opened).toEqual([]);
    }
  });

  it('a request for "sub\\c.txt" and one for "sub\x01c.txt" open the same file, and "..\\x" and "..\x01x" open none', async () => {
    const s = await servedAs('text');
    expect(await asked(s, rawRequest(s, 'sub\\c.txt'))).toEqual({ name: 'sub\\c.txt', data: content(20, 3) });
    expect(await asked(s, rawRequest(s, 'sub\u0001c.txt'))).toEqual({ name: 'sub\u0001c.txt', data: content(20, 3) });
    expect(s.source.opened).toEqual([['sub', 'c.txt'], ['sub', 'c.txt']]);
    for (const name of ['..\\x', '..\u0001x', 'sub\\..\\a.txt', 'sub\u0001..\u0001a.txt']) {
      const bad = await servedAs('text');
      const before = bad.holder.sent.length;
      await bad.link.write(rawRequest(bad, name));
      await closedAfterTheWait(bad);
      expect(bad.holder.sent, JSON.stringify(name)).toHaveLength(before);
      expect(bad.source.opened).toEqual([]);
    }
    // The same rules after an Lst1 listing.
    const lst1 = await servedAs('lst1', SHARED, {}, { name: 'My Files' });
    expect((await asked(lst1, rawRequest(lst1, 'My Files\\sub\\c.txt'))).data).toEqual(content(20, 3));
    await lst1.link.write(rawRequest(lst1, 'My Files\\..\\a.txt'));
    await closedAfterTheWait(lst1);
    expect(lst1.source.opened).toEqual([['sub', 'c.txt']]);
  });

  it('a request that is a header with only the type, the cookie and the name is read, as a request that is the last header sent back is', async () => {
    const s = await servedAs('lst1', SHARED, {}, { name: 'share' });
    expect(await asked(s, blankRequest('share\u0001a.txt'))).toEqual({ name: 'share\u0001a.txt', data: content(1000, 1) });
    expect(await asked(s, requestHeader(s.last, ['share', 'sub', 'c.txt']).bytes)).toEqual({ name: 'share\u0001sub\u0001c.txt', data: content(20, 3) });
    expect(await asked(s, blankRequest('share\\b.bin'))).toEqual({ name: 'share\\b.bin', data: content(70_000, 2) });
    const text = await servedAs('text');
    expect((await asked(text, blankRequest('a.txt'))).data).toEqual(content(1000, 1));
    expect(s.ends).toEqual([]);
  });

  it('the requests of AIM 5.9 are read, and the header of the file is the header that AIM 5.9 answered', async () => {
    const top = decodeOftFrame(bytesOf(LST1, '5.9 request, a name at the top'));
    const answered = decodeOftFrame(bytesOf(LST1, 'prompt that 5.9 answered'));
    const files: Held[] = [{ path: ['a.txt'], data: vectorFile() }, { path: ['sub', 'c.txt'], data: content(64, 3) }];
    const open = async (path: readonly string[]): Promise<OutgoingFile | null> => {
      const held = files.find((one) => one.path.join('/') === path.join('/'));
      return held ? { ...outgoing(path[path.length - 1] as string, held.data), modifiedAt: answered.header.modifiedAt } : null;
    };
    const s = await servedAs('lst1', files, { cookie: top.header.cookie }, { name: 'share', open });
    await s.link.write(top.bytes);
    const first = await frame(s.link);
    expect(toHex(first.bytes)).toBe(toHex(answered.bytes));
    await s.link.write(bytesOf(LST1, '5.9 ack'));
    expect(await s.link.read(1024)).toEqual(vectorFile());
    await s.link.write(bytesOf(LST1, '5.9 done'));
    await waitFor(() => s.taken.length === 1, 'the file was taken');
    await s.link.write(bytesOf(LST1, '5.9 request, a path'));
    const second = await header(s.link);
    expect([second.type, second.name, second.bytes]).toEqual([OFT_PROMPT, 'share\u0001sub\u0001c.txt', 64]);
    expect(s.taken).toEqual([{ path: ['a.txt'], bytes: 1024 }]);
  });

  it('the requests of AIM 3.5 are read: a backslash between the parts, and the header of the file has the name as it came', async () => {
    const top = decodeOftFrame(bytesOf(LST1, '3.5 request, a name at the top'));
    const s = await servedAs('text', [{ path: ['a.txt'], data: content(1024, 1) }, { path: ['sub', 'c.txt'], data: content(64, 3) }], { cookie: top.header.cookie });
    expect(await asked(s, top.bytes)).toEqual({ name: 'a.txt', data: content(1024, 1) });
    expect(await asked(s, bytesOf(LST1, '3.5 request, a path'))).toEqual({ name: 'sub\\c.txt', data: content(64, 3) });
    expect(s.source.opened).toEqual([['a.txt'], ['sub', 'c.txt']]);
  });

  it('the frame 0x120e is logged and not answered: nothing goes out, the link stays open, and the next request is answered', async () => {
    const log = captureLog();
    const unread = decodeOftFrame(bytesOf(LST1, '5.9 frame after a listing that it did not show'));
    const s = await servedAs('text', SHARED, { cookie: unread.header.cookie, log: log.log });
    const before = s.holder.sent.length;
    await s.link.write(unread.bytes);
    await pause();
    expect(s.holder.sent).toHaveLength(before);
    expect(s.ends).toEqual([]);
    expect(s.timers.pending()).toEqual([]);
    expect(log.lines.filter((line) => line.msg === 'a get file requester did not show the listing')).toHaveLength(1);
    expect((await asked(s, requestHeader(s.last, ['a.txt']).bytes)).data).toEqual(content(1000, 1));
  });

  it('the frame 0x120e in the place of an answer to the listing is passed over, and one with another cookie ends bad-cookie', async () => {
    const s = serving();
    s.session.start();
    const first = await frame(s.link);
    const unread = encodeOftHeader({ ...first.header, type: OFT_LISTING_UNREAD });
    await s.link.write(unread);
    await s.link.write(listingAck(first).bytes);
    expect(await s.link.read(listingLength(first.header))).toHaveLength(listingLength(first.header));
    expect(s.ends).toEqual([]);
    const other = await served();
    await other.link.write(encodeOftHeader({ ...first.header, type: OFT_LISTING_UNREAD, cookie: OTHER_COOKIE }));
    await waitFor(() => other.ends.length === 1, 'the end');
    expect(other.ends).toEqual(['bad-cookie']);
  });

  it('more frames 0x120e than the limit end the session bad-frame', async () => {
    const unread = decodeOftFrame(bytesOf(LST1, '5.9 frame after a listing that it did not show'));
    const s = await servedAs('text', SHARED, { cookie: unread.header.cookie });
    for (let i = 0; i < LISTING_UNREAD_MAX; i++) await s.link.write(unread.bytes);
    await pause();
    expect(s.ends).toEqual([]);
    await s.link.write(unread.bytes);
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-frame']);
  });

  it('an empty shared folder goes out as the four letters in the Lst1 form', async () => {
    const s = await servedAs('lst1', []);
    expect([listingLength(s.first.header), s.first.header.totalFiles, s.first.flags]).toEqual([4, 0, 0x30]);
    expect(s.entries).toEqual([]);
    expect(s.ends).toEqual([]);
  });

  it('the log has no listed name, no requested name and no folder name in the Lst1 form', async () => {
    const log = captureLog();
    const s = await servedAs('lst1', [{ path: ['secret-name.txt'], data: content(10) }], { log: log.log }, { name: 'secret-folder' });
    expect((await asked(s, requestHeader(s.last, ['secret-folder', 'secret-name.txt']).bytes)).data).toEqual(content(10));
    await s.link.write(requestHeader(s.last, ['secret-folder', 'secret-other.txt']).bytes);
    await closedAfterTheWait(s);
    expect(log.text()).not.toContain('secret-');
    expect(log.lines.length).toBeGreaterThan(0);
  });
});

describe('the holder side: what a source gives', () => {
  // A source that gives each file of the whole tree for the empty path, and no folder.
  const whole = (): Partial<SharedSource> => ({
    list: async (folder) => (folder.length === 0 ? SHARED.map((held) => ({ path: [...held.path], folder: false, bytes: held.data.length, modifiedAt: MINUTE })) : null),
  });

  it('a source that gives the whole tree for the empty path is asked one time, and each file of it can be taken', async () => {
    const listed: string[][] = [];
    const inner = whole().list as SharedSource['list'];
    const list: SharedSource['list'] = async (folder) => {
      listed.push([...folder]);
      return inner(folder);
    };
    const s = await servedAs('text', SHARED, {}, { list });
    expect(s.entries.map((entry) => entry.path.join('/'))).toEqual(['a.txt', 'b.bin', 'sub/c.txt']);
    expect(listed).toEqual([[]]);
    expect((await asked(s, requestHeader(s.last, ['sub', 'c.txt']).bytes)).data).toEqual(content(20, 3));
    expect(s.source.opened).toEqual([['sub', 'c.txt']]);
  });

  it('the limit of the listing is the limit of the files that go out: a file after maxEntries is not opened, in each form', async () => {
    for (const form of ['text', 'lst1'] as const) {
      const s = await servedAs(form, SHARED, { maxEntries: 2 }, { ...whole(), name: 'share' });
      expect(s.entries).toHaveLength(2);
      const first = form === 'lst1' ? ['share'] : [];
      expect((await asked(s, requestHeader(s.last, [...first, 'b.bin']).bytes)).data).toEqual(content(70_000, 2));
      const before = s.holder.sent.length;
      await s.link.write(requestHeader(s.last, [...first, 'sub', 'c.txt']).bytes);
      await closedAfterTheWait(s);
      expect(s.holder.sent).toHaveLength(before);
      expect(s.source.opened, form).toEqual([['b.bin']]);
    }
  });
});
