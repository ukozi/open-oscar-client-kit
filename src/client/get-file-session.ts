import { OscarDecodeError } from '../wire/bytes.js';
import {
  encodeListing, encodeLst1Listing, listedPart, listingAck, listingDone, listingFrame, listingLength, readListing, requestHeader, requestedFile,
} from '../wire/listing.js';
import type { ListingEntry, ListingForm } from '../wire/listing.js';
import { OFT_FILE_REQUEST, OFT_LISTING, OFT_LISTING_ACK, OFT_LISTING_DONE, OFT_LISTING_UNREAD, OFT_PROMPT } from '../wire/oft.js';
import type { OftFrame } from '../wire/oft.js';
import type { Logger, TimerApi } from '../wire/types.js';
import type { SharedSource } from '../model/get-file.js';
import type { FileSink, OutgoingFile, TransferProgress } from '../model/transfer.js';
import { ByteStore } from './byte-store.js';
import { OftError, readOftFrame, receiveAnswered, sendFile } from './oft-session.js';
import type { OftSignal } from './oft-session.js';
import { PeerClosedError } from './peer-link.js';
import type { PeerLink } from './peer-link.js';

/** 'not-there': the holder closed the connection in answer to a request. A holder does this for a name that it does not have. */
export type GetFileFailure = 'peer-closed' | 'bad-cookie' | 'bad-frame' | 'too-large' | 'not-there';

export class GetFileError extends Error {
  readonly failure: GetFileFailure | 'not-open' | 'refused';

  constructor(failure: GetFileFailure | 'not-open' | 'refused', options?: ErrorOptions) {
    super(failure, options);
    this.name = 'GetFileError';
    this.failure = failure;
  }
}

export type BrowseSessionDeps = {
  link: PeerLink;
  cookie: bigint;
  log: Logger;
  timers: TimerApi;
  now: () => number;
  maxListingBytes: number;
  maxEntries: number;
  onVerified(): void;
  /** One time. The listing holds each file of the whole shared folder. */
  onListing(listing: { entries: ListingEntry[]; truncated: boolean; damaged: boolean }): void;
  /** One time. 'closed' is a close that this side asked for. */
  onEnd(why: GetFileFailure | 'closed'): void;
};

const READ_MAX_BYTES = 64 * 1024;

// A link with a read that waits while no request runs. The bytes of that read are the first bytes of the next read.
class WatchedLink implements PeerLink {
  private ahead: Uint8Array | null = null;
  private watching: Promise<void> | null = null;
  // The watch saw the end of the link. `clean` is true for an end with no error.
  private over: { clean: boolean } | null = null;

  constructor(private readonly inner: PeerLink) {}

  get closed(): boolean {
    return this.inner.closed;
  }

  write(bytes: Uint8Array): Promise<void> {
    return this.inner.write(bytes);
  }

  close(): void {
    this.inner.close();
  }

  /** Starts the read. `onEnd` runs when the link ends before a byte comes. */
  watch(onEnd: () => void): void {
    if (this.watching || this.ahead || this.over) return;
    const ended = (clean: boolean): void => {
      this.watching = null;
      this.over = { clean };
      onEnd();
    };
    this.watching = this.inner.readSome(READ_MAX_BYTES).then((bytes) => {
      if (bytes === null) return ended(true);
      this.watching = null;
      this.ahead = bytes;
    }, () => ended(false));
  }

  async read(n: number): Promise<Uint8Array> {
    await this.watching;
    if (this.over) throw new PeerClosedError();
    const head = this.ahead;
    if (!head) return this.inner.read(n);
    if (head.length > n) {
      this.ahead = head.subarray(n);
      return head.slice(0, n);
    }
    this.ahead = null;
    if (head.length === n) return head;
    const rest = await this.inner.read(n - head.length);
    const out = new Uint8Array(n);
    out.set(head);
    out.set(rest, head.length);
    return out;
  }

  async readSome(max: number): Promise<Uint8Array | null> {
    await this.watching;
    if (this.over?.clean) return null;
    if (this.over) throw new PeerClosedError();
    const head = this.ahead;
    if (!head) return this.inner.readSome(max);
    this.ahead = head.length > max ? head.subarray(max) : null;
    return head.length > max ? head.slice(0, max) : head;
  }
}

/**
 * The side of a Get File connection that asks. It shows no listing and writes no file before the holder shows the cookie.
 * A close of the holder while no request runs ends the session 'peer-closed' at once.
 */
export class BrowseSession {
  private readonly link: WatchedLink;
  // The requests that run or wait for their turn.
  private waiting = 0;
  private started = false;
  private ended = false;
  private shown = false;
  // The last answer that this side wrote. A request is made from it.
  private last: OftFrame | null = null;
  // The end of the request that runs last. One request runs at a time.
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BrowseSessionDeps) {
    this.link = new WatchedLink(deps.link);
  }

  /** Reads the listing. It writes nothing before the holder speaks. */
  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.queued(async () => this.listing(await this.header())).catch(() => {});
  }

  /**
   * Asks for one file and receives it. `maxBytes` is the size that the listing gave. More takes can follow on the same connection.
   * It rejects with GetFileError, or with OftError for a failure after the header of the file.
   * The failure 'not-there' tells that the holder does not have the name.
   */
  take(path: readonly string[], maxBytes: number, sink: FileSink, on: (p: TransferProgress) => void, signal: OftSignal): Promise<void> {
    return this.queued(async () => {
      // A take that was stopped before its turn asks for nothing.
      if (signal.cancelled) throw new OftError('cancelled');
      const answer = await this.asked(path);
      // A header that is not a PROMPT is not the file.
      if (answer.header.type !== OFT_PROMPT) throw new GetFileError('refused');
      const { cookie, now, log } = this.deps;
      const { link } = this;
      // The name of the file is the name that this side asked for. The name in the header of the holder is not used.
      const named: FileSink = { begin: (file) => sink.begin({ ...file, name: path[path.length - 1] ?? '' }) };
      try {
        // The answer after the file is the header that the next request is made from.
        this.last = await receiveAnswered(link, cookie, named, { index: 0, count: 1, maxBytes }, on, signal, now, answer);
      } catch (error) {
        // Nothing in the format stops one file, so the connection ends with the file.
        const failure = error instanceof OftError ? error.failure : 'unknown';
        const closedHere = this.ended;
        this.finish(failure === 'peer-closed' ? 'peer-closed' : 'closed');
        log.debug('a file from a get file connection failed', { failure });
        if (closedHere && failure === 'peer-closed') throw new GetFileError('not-open', { cause: error });
        throw error;
      }
      log.debug('a file came on a get file connection', { bytes: answer.header.bytes });
    });
  }

  close(): void {
    this.finish('closed');
  }

  private finish(why: GetFileFailure | 'closed'): void {
    if (this.ended) return;
    this.ended = true;
    this.link.close();
    this.deps.log.debug('a get file connection ended', { why, verified: this.shown });
    this.told('onEnd', () => this.deps.onEnd(why));
  }

  // A throw from the host does not stop the session.
  private told(name: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.deps.log.warn('a get file listener threw', { listener: name, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  // Runs the request after the requests before it. A refusal leaves the session open. A failure of the connection ends it.
  private queued(request: () => Promise<void>): Promise<void> {
    this.waiting += 1;
    const run = this.tail.then(async () => {
      try {
        if (!this.started || this.ended) throw new GetFileError('not-open');
        try {
          await request();
        } catch (error) {
          throw this.failed(error);
        }
      } finally {
        this.waiting -= 1;
        this.watch();
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }

  // No request reads the link, thus a read waits for the close of the holder.
  private watch(): void {
    if (this.waiting > 0 || !this.started || this.ended) return;
    this.link.watch(() => {
      // A request that runs sees the close itself.
      if (this.waiting === 0) this.finish('peer-closed');
    });
  }

  private failed(error: unknown): unknown {
    if (error instanceof OftError) return error;
    if (error instanceof GetFileError && (error.failure === 'refused' || error.failure === 'not-open')) return error;
    // The connection closed because this side ended the session.
    if (this.ended) return new GetFileError('not-open', { cause: error });
    let failure: GetFileFailure = 'bad-frame';
    if (error instanceof GetFileError) failure = error.failure as GetFileFailure;
    else if (error instanceof PeerClosedError) failure = 'peer-closed';
    else if (!(error instanceof OscarDecodeError)) {
      this.deps.log.warn('a get file read failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
    this.finish(failure);
    return error instanceof GetFileError ? error : new GetFileError(failure, { cause: error });
  }

  // Each header shows the cookie before the session uses it.
  private async header(): Promise<OftFrame> {
    const d = this.deps;
    const frame = await readOftFrame(this.link);
    const { header } = frame;
    if (this.ended) throw new GetFileError('not-open');
    d.log.debug('a get file header came', { type: header.type, bytes: header.bytes });
    if (header.cookie !== d.cookie) throw new GetFileError('bad-cookie');
    if (!this.shown) {
      this.shown = true;
      this.told('onVerified', () => d.onVerified());
    }
    return frame;
  }

  // Writes the request and reads the header that answers it. A path that is not below the shared folder is not sent.
  private async asked(path: readonly string[]): Promise<OftFrame> {
    if (!this.last) throw new GetFileError('not-open');
    let request: OftFrame;
    try {
      request = requestHeader(this.last, path);
    } catch (error) {
      throw new GetFileError('refused', { cause: error });
    }
    await this.link.write(request.bytes);
    try {
      return await this.header();
    } catch (error) {
      // No header refuses a request. A holder closes the connection for a name that it does not have.
      if (error instanceof PeerClosedError && !this.ended) throw new GetFileError('not-there', { cause: error });
      throw error;
    }
  }

  // The buffer grows with the bytes that come. The declared length is only its limit.
  private async listing(frame: OftFrame): Promise<void> {
    const d = this.deps;
    if (frame.header.type !== OFT_LISTING) throw new GetFileError('bad-frame');
    const length = listingLength(frame.header);
    if (length > d.maxListingBytes) throw new GetFileError('too-large');
    await this.link.write(listingAck(frame).bytes);
    const store = new ByteStore(length);
    while (store.length < length) {
      const piece = await this.link.readSome(Math.min(READ_MAX_BYTES, length - store.length));
      if (piece === null) throw new PeerClosedError();
      store.add(piece);
    }
    if (this.ended) throw new GetFileError('not-open');
    const body = store.bytes();
    this.last = listingDone(frame, body);
    await this.link.write(this.last.bytes);
    // The header of the holder tells the form of the listing and the columns of its lines.
    const read = readListing(frame, body, d.maxEntries);
    d.log.debug('a get file listing came', { bytes: length, entries: read.entries.length, truncated: read.truncated, damaged: read.damaged });
    this.told('onListing', () => d.onListing(read));
  }
}

export type ServeSessionDeps = {
  link: PeerLink;
  cookie: bigint;
  log: Logger;
  timers: TimerApi;
  now: () => number;
  source: SharedSource;
  /** The form of the listing that goes out. The number of the proposal of the requester decides it. */
  form: ListingForm;
  /** The most entries of one listing that goes out. */
  maxEntries: number;
  /** Asked before the listing and before each file. False closes the link. */
  mayServe(): boolean;
  onVerified(): void;
  /** One time for each file that went out whole. The requester does not control it: no answer after the file is necessary. */
  onTaken(path: readonly string[], bytes: number): void;
  /** One time. 'closed' is a close that this side asked for. */
  onEnd(why: GetFileFailure | 'closed'): void;
};

const MAX_FILE_BYTES = 0xffff_ffff;
const DIVIDER = '\u0001';
/** The time that the holder keeps the connection open after a request for a name that it does not have. AIM 5.1 waits this long. */
export const NOT_THERE_CLOSE_MS = 1000;
// The holder passes over this many frames of the type 0x120e on one link. One more ends the session.
export const LISTING_UNREAD_MAX = 4;
// The holder reads a file again for each request. One link gets this many answers of DONE to a PROMPT. One more ends the session.
export const NOT_TAKEN_MAX = 16;

/** The side of a Get File connection that holds the files. It speaks first. It writes no listing byte and no file byte before the requester shows the cookie. */
export class ServeSession {
  private started = false;
  private ended = false;
  private shown = false;
  private unread = 0;
  private notTaken = 0;
  private readonly signal: OftSignal = { cancelled: false };
  // Each name of the listing that went out, with the path of its file in the source. No other file goes out.
  private readonly listed = new Map<string, readonly string[]>();
  // Ends the wait before a close.
  private stopWait: (() => void) | null = null;

  constructor(private readonly deps: ServeSessionDeps) {}

  /** Writes the header of the listing, then answers one request for a file at a time. */
  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    void this.run();
  }

  close(): void {
    this.finish('closed');
  }

  private async run(): Promise<void> {
    const d = this.deps;
    try {
      if (!d.mayServe()) {
        this.finish('closed');
        return;
      }
      if (!(await this.listing())) {
        this.finish('closed');
        return;
      }
      for (;;) {
        const request = await this.header();
        if (request.header.type !== OFT_FILE_REQUEST) throw new GetFileError('bad-frame');
        if (!d.mayServe()) {
          this.finish('closed');
          return;
        }
        // No header refuses a request. A name that is not in the listing closes the link after a wait, as AIM 5.1 does.
        if (!(await this.answer(request))) {
          await this.waited();
          this.finish('closed');
          return;
        }
      }
    } catch (error) {
      this.finish(this.why(error));
    }
  }

  // The result is false when the listing does not have the name or the source does not have the file.
  private async answer(request: OftFrame): Promise<boolean> {
    const d = this.deps;
    // Only the type, the cookie and the name of a request are read. A request can be a header with no other field.
    const asked = requestedFile(request);
    // A name of the Lst1 form has the name of the folder first. The source gets the path without it.
    const path = asked ? this.listed.get(asked.path.join(DIVIDER)) : undefined;
    const file = path ? await this.held(() => d.source.open(path)) : null;
    if (!asked || !path || !file || file.bytes > MAX_FILE_BYTES) {
      d.log.debug('a get file request named no file that is shared');
      return false;
    }
    // The header of the file has the name of the request, as it came.
    await this.send(path, { ...file, name: asked.name });
    return true;
  }

  private waited(): Promise<void> {
    if (this.ended) return Promise.resolve();
    const { timers } = this.deps;
    return new Promise((resolve) => {
      const timer = timers.setTimeout(() => {
        this.stopWait = null;
        resolve();
      }, NOT_THERE_CLOSE_MS);
      this.stopWait = () => {
        timers.clearTimeout(timer);
        resolve();
      };
    });
  }

  // Each file of the source, from one folder down, to the limit of the entries. The result is false when the source has no such folder.
  private async files(folder: readonly string[], out: ListingEntry[]): Promise<boolean> {
    const d = this.deps;
    const entries = await this.held(() => d.source.list(folder));
    if (!entries) return false;
    for (const entry of entries) {
      if (out.length >= d.maxEntries) break;
      if (entry.folder) await this.files(entry.path, out);
      else out.push(entry);
    }
    return true;
  }

  private async send(path: readonly string[], file: OutgoingFile): Promise<void> {
    const d = this.deps;
    // AIM writes the name of a file in Latin-1 with the encoding 0. The header is a new header, as the header of each holder is.
    const written = (): void => this.told('onTaken', () => d.onTaken(path, file.bytes));
    const sent = await sendFile(d.link, d.cookie, file, { index: 0, count: 1, totalBytes: file.bytes }, () => {}, this.signal, d.now, 'latin-1', written);
    d.log.debug('a file went out on a get file connection', { bytes: file.bytes, taken: sent === 'sent' });
    if (sent === 'sent') return;
    this.notTaken += 1;
    if (this.notTaken <= NOT_TAKEN_MAX) return;
    d.log.info('a get file requester answered DONE to a PROMPT more times than the limit', { count: this.notTaken });
    throw new GetFileError('bad-frame');
  }

  // One listing holds the whole source. No byte of the listing goes out before the requester shows the cookie.
  private async listing(): Promise<boolean> {
    const d = this.deps;
    const entries: ListingEntry[] = [];
    if (!(await this.files([], entries))) return false;
    const lst1 = d.form === 'lst1';
    const listing = lst1 ? encodeLst1Listing(entries, d.source.name) : encodeListing(entries);
    const first = listingFrame(d.cookie, listing, Math.floor(d.now() / 1000));
    // A listing writes a name as listedPart gives it. The source gets the path as the source gave it.
    const origin = new Map<string, readonly string[]>();
    for (const entry of entries) {
      const key = entry.path.map(listedPart).join(DIVIDER);
      if (!origin.has(key)) origin.set(key, entry.path);
    }
    // The files that a requester reads from these bytes are the files that it can ask for.
    for (const entry of readListing(first, listing.bytes, entries.length).entries) {
      const path = lst1 ? entry.path.slice(1) : entry.path;
      this.listed.set(entry.path.join(DIVIDER), origin.get(path.join(DIVIDER)) ?? path);
    }
    await d.link.write(first.bytes);
    const ack = await this.header();
    if (ack.header.type !== OFT_LISTING_ACK) throw new GetFileError('bad-frame');
    await d.link.write(listing.bytes);
    const done = await this.header();
    if (done.header.type !== OFT_LISTING_DONE) throw new GetFileError('bad-frame');
    d.log.debug('a get file listing went out', { form: listing.form, bytes: listing.bytes.length, entries: listing.files });
    // The listing holds Latin-1 names and files below 4 GB only.
    if (listing.files < entries.length) d.log.info('a get file listing left out entries', { count: entries.length - listing.files });
    return true;
  }

  // Each header shows the cookie before the session uses it.
  private async header(): Promise<OftFrame> {
    const d = this.deps;
    for (;;) {
      const frame = await readOftFrame(d.link);
      const { header } = frame;
      d.log.debug('a get file header came', { type: header.type, bytes: header.bytes });
      if (header.cookie !== d.cookie) throw new GetFileError('bad-cookie');
      if (!this.shown) {
        this.shown = true;
        this.told('onVerified', () => d.onVerified());
      }
      if (header.type !== OFT_LISTING_UNREAD) return frame;
      // AIM 5.9 sends this type after a listing that it did not show. It gets no answer.
      this.unread += 1;
      if (this.unread > LISTING_UNREAD_MAX) throw new GetFileError('bad-frame');
      d.log.info('a get file requester did not show the listing', { form: d.form });
    }
  }

  // A source that fails gives the same answer as a source that does not have the path.
  private async held<T>(ask: () => Promise<T | null>): Promise<T | null> {
    try {
      return await ask();
    } catch (error) {
      this.deps.log.warn('the source of a get file connection failed', { error: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }

  private why(error: unknown): GetFileFailure | 'closed' {
    if (error instanceof GetFileError && error.failure !== 'not-open' && error.failure !== 'refused') return error.failure;
    if (error instanceof PeerClosedError) return 'peer-closed';
    if (error instanceof OscarDecodeError) return 'bad-frame';
    if (error instanceof OftError) {
      if (error.failure === 'peer-closed' || error.failure === 'bad-cookie') return error.failure;
      if (error.failure === 'bad-header') return 'bad-frame';
      // A part of the file is out, thus the connection ends with the file.
      return 'closed';
    }
    if (!this.ended) this.deps.log.warn('a get file connection failed', { error: error instanceof Error ? error.name : 'unknown' });
    return 'closed';
  }

  private finish(why: GetFileFailure | 'closed'): void {
    if (this.ended) return;
    this.ended = true;
    this.signal.cancelled = true;
    this.stopWait?.();
    this.stopWait = null;
    this.deps.link.close();
    this.deps.log.debug('a get file connection ended', { why, verified: this.shown });
    this.told('onEnd', () => this.deps.onEnd(why));
  }

  // A throw from the host does not stop the session.
  private told(name: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.deps.log.warn('a get file listener threw', { listener: name, error: error instanceof Error ? error.name : 'unknown' });
    }
  }
}
