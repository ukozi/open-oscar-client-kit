import { randomBytes } from 'node:crypto';
import { FAMILY_ICBM, ICBM_CHANNEL_RENDEZVOUS, ICBM_CLIENT_ERR, ICBM_MSG_TO_CLIENT, RDV_CANCEL_DECLINED, RDV_CANCEL_TIMEOUT } from '../wire/constants.js';
import { listingFormFor } from '../wire/listing.js';
import type { ListingForm, ListingRead } from '../wire/listing.js';
import { decodeClientError, encodeRendezvousCancel, getFileProposalNumber, parseRendezvous, rendezvousCapability, serviceOf } from '../wire/rendezvous.js';
import type { RendezvousMessage } from '../wire/rendezvous.js';
import type { Snac } from '../wire/snac.js';
import type { Logger, TimerApi } from '../wire/types.js';
import type { BrowseStatus, FileListing, GetFileEnd, ShareRequest, ShareStatus, ShareTaken, SharedSource } from '../model/get-file.js';
import { normalizeScreenName } from '../model/screen-name.js';
import type { FileSink, TransferFailure, TransferProgress, TransferState, TransferStatus } from '../model/transfer.js';
import { OscarError } from './errors.js';
import { BrowseSession, GetFileError, ServeSession } from './get-file-session.js';
import type { GetFileFailure } from './get-file-session.js';
import { OftError } from './oft-session.js';
import type { OftSignal } from './oft-session.js';
import type { PeerLink } from './peer-link.js';
import { OFFER_ACCEPT_MS, rendezvousEnded } from './rendezvous.js';
import type { Rendezvous, RendezvousEnd } from './rendezvous.js';
import { MAX_WAITING_OFFERS } from './transfers.js';

export type GetFileDeps = {
  log: Logger;
  now: () => number;
  timers: TimerApi;
  /** When false, the part ignores each message and refuses each command. */
  enabled: boolean;
  /** The offers of the session. Its owner resets it. */
  rendezvous: Rendezvous;
  /** Sends one ICBM 0x04/0x06 body on the BOS link. It rejects when the session is not online. */
  send(body: Uint8Array): Promise<void>;
  isBlocked(name: string): boolean;
  maxListingBytes: number;
  /** The most entries of one listing, for a listing that comes and for a listing that goes out. */
  maxEntries: number;
  /** The most requesters that have a connection at one time. */
  maxServing: number;
  emitListing(listing: FileListing): void;
  emitBrowse(status: BrowseStatus): void;
  emitTransfer(status: TransferStatus): void;
  emitRequest(request: ShareRequest): void;
  emitShare(status: ShareStatus): void;
  emitTaken(taken: ShareTaken): void;
  /** The cookie of a new offer. Tests replace it. */
  cookie?: () => bigint;
};

type Take = {
  readonly id: string;
  readonly path: readonly string[];
  readonly name: string;
  /** The size that the listing gave. */
  readonly bytes: number;
  readonly sink: FileSink;
  readonly signal: OftSignal;
  state: TransferState;
  bytesDone: number;
  over: boolean;
};

type Browse = {
  readonly id: string;
  readonly cookie: bigint;
  /** The name of the peer as the messages to it carry it. */
  readonly peer: string;
  readonly ident: string;
  state: BrowseStatus['state'];
  session: BrowseSession | null;
  /** The size of each file of the listing, by path. The holder sends one listing. */
  readonly files: Map<string, number>;
  readonly takes: Set<Take>;
  /** The take that has its turn. */
  moving: Take | null;
  /** The connection closed on this side because a file failed. */
  dropped: boolean;
  // The end of the request that runs last. One request runs at a time.
  tail: Promise<void>;
  over: boolean;
};

// One requester of the files that this client shares.
type Share = {
  readonly id: string;
  readonly cookie: bigint;
  /** The name of the peer as the messages to it carry it. */
  readonly peer: string;
  readonly ident: string;
  readonly proposal: RendezvousMessage;
  /** The form of the listing for this requester. The number of its proposal decides it. */
  readonly form: ListingForm;
  state: ShareStatus['state'];
  session: ServeSession | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Lets the next offer meet the relay. */
  paired: () => void;
  over: boolean;
};

const DIVIDER = '\u0001';

function invalid(): OscarError {
  return new OscarError({ kind: 'local', code: 'invalid-argument' });
}

function keyOf(path: readonly string[]): string {
  return path.join(DIVIDER);
}

function hex(cookie: bigint): string {
  return cookie.toString(16).padStart(16, '0');
}

/** The Get File connections of one client. It reads the folders of peers, takes files from them, and shares its own files. */
export class GetFile {
  private readonly browses = new Map<string, Browse>();
  private readonly takes = new Map<string, { b: Browse; t: Take }>();
  private readonly shares = new Map<string, Share>();
  private source: SharedSource | null = null;

  constructor(private readonly deps: GetFileDeps) {}

  /** Asks for the files of a peer and gives the id of the browse. A peer with a browse that is live gets no second offer: the result is the id of that browse. */
  browse(screenName: string): string {
    if (!this.deps.enabled) throw invalid();
    const ident = normalizeScreenName(screenName);
    for (const live of this.browses.values()) if (live.ident === ident) return live.id;
    const cookie = this.freshCookie(ident);
    const b: Browse = {
      id: `${ident}:${hex(cookie)}`, cookie, peer: screenName, ident, state: 'waiting', session: null, files: new Map(),
      takes: new Set(), moving: null, dropped: false, tail: Promise.resolve(), over: false,
    };
    this.browses.set(b.id, b);
    this.deps.log.info('a get file offer went out');
    this.emit(b);
    void this.offer(b);
    return b.id;
  }

  /**
   * Asks for one file of the listing and gives the id of the transfer. The first event comes before the result.
   * More files can follow on the same connection. A holder that does not have the file ends the browse 'not-there'.
   */
  take(browseId: string, path: readonly string[], sink: FileSink): string {
    const b = this.browses.get(browseId);
    if (!b) throw invalid();
    const listed = b.files.get(keyOf(path));
    const t: Take = {
      id: this.freshTakeId(b), path: [...path], name: path[path.length - 1] ?? '', bytes: listed ?? 0, sink,
      signal: { cancelled: false }, state: 'connecting', bytesDone: 0, over: false,
    };
    if (listed === undefined || !b.session) {
      // No listing named this file, thus no request goes out.
      this.finishTake(b, t, 'failed', undefined, 'file-problem');
      return t.id;
    }
    b.takes.add(t);
    this.takes.set(t.id, { b, t });
    this.emitTake(b, t);
    void this.queued(b, () => this.move(b, t));
    return t.id;
  }

  /** True for a transfer id of this part. A take that has its turn ends the browse: nothing in the format stops one file. */
  cancelTransfer(id: string): boolean {
    const held = this.takes.get(id);
    if (!held) return false;
    const { b, t } = held;
    const moving = b.moving === t;
    this.finishTake(b, t, 'cancelled', 'self');
    if (moving) this.finish(b, 'closed', 'self');
    return true;
  }

  /** Ends a browse in each state. It ignores an id that is not live. */
  async close(browseId: string): Promise<void> {
    const b = this.browses.get(browseId);
    if (!b) return;
    const meeting = !b.session;
    this.finish(b, 'closed', 'self');
    // The offer sends its own cancel while it holds the cookie.
    if (meeting) await this.deps.rendezvous.cancel(b.cookie);
  }

  /** True while a source is set. */
  get sharing(): boolean {
    return this.source !== null;
  }

  /**
   * Sets the source of the files that this client shares. Null stops the sharing and answers each request that waits with a cancel.
   * A source that is not the source in use closes each connection of a requester. The same source changes nothing.
   */
  share(source: SharedSource | null): void {
    if (!this.deps.enabled) throw invalid();
    if (source === this.source) return;
    this.source = source;
    for (const s of [...this.shares.values()]) {
      if (s.state !== 'asked') {
        const meeting = !s.session;
        this.end(s, 'closed', 'self');
        // The offer sends its own cancel while it holds the cookie. No accept and no dial follow.
        if (meeting) void this.deps.rendezvous.cancel(s.cookie).catch(() => {});
      } else if (!source) {
        this.end(s, 'cancelled', 'self');
        void this.say(s.peer, s.cookie);
      }
    }
  }

  /** Accept first, then the dial. The `share` events tell the result. A request that passes the limit of requesters gets a cancel. */
  allow(requestId: string): void {
    const s = this.shares.get(requestId);
    const source = this.source;
    if (!this.deps.enabled || s?.state !== 'asked' || !source) throw invalid();
    this.unarm(s);
    if (this.serving() >= this.deps.maxServing) {
      this.deps.log.warn('sent a cancel for a get file request past the limit of requesters');
      this.end(s, 'cancelled', 'self');
      void this.say(s.peer, s.cookie);
      return;
    }
    s.state = 'connecting';
    this.tell(s);
    void this.receive(s, source);
  }

  /** Ends a share in each state. A request that waits for an answer is declined. It ignores an id that is not live. */
  async refuse(requestId: string): Promise<void> {
    const s = this.shares.get(requestId);
    if (!s) return;
    if (s.state === 'asked') {
      this.end(s, 'declined', 'self');
      await this.say(s.peer, s.cookie);
      return;
    }
    const meeting = !s.session;
    this.end(s, 'closed', 'self');
    // The offer sends its own cancel while it holds the cookie.
    if (meeting) await this.deps.rendezvous.cancel(s.cookie);
  }

  /** Sign-off: the source goes, and each share ends 'signed-off'. A reconnect keeps the source. */
  forget(): void {
    this.source = null;
    for (const s of [...this.shares.values()]) this.end(s, 'signed-off');
  }

  /** True for a message of the Get File service and for the client error of a peer about one. */
  handle(snac: Snac): boolean {
    if (!this.deps.enabled || snac.family !== FAMILY_ICBM) return false;
    if (snac.subtype === ICBM_CLIENT_ERR) return this.refused(snac.body);
    if (snac.subtype !== ICBM_MSG_TO_CLIENT) return false;
    const capability = rendezvousCapability(snac.body);
    if (!capability || serviceOf(capability) !== 'get-file') return false;
    const message = parseRendezvous(snac.body);
    if (!message) {
      this.deps.log.debug('ignored a get file message of an unknown type');
      return true;
    }
    const id = `${message.from}:${hex(message.cookie)}`;
    const b = this.browses.get(id);
    const s = this.shares.get(id);
    if (b) this.heard(b, message);
    else if (s) this.asked(s, message);
    else if (message.type === 'propose') this.proposed(message, getFileProposalNumber(snac.body));
    else this.deps.log.debug('ignored a get file message for no browse and no share', { type: message.type });
    return true;
  }

  /** Each browse and each share ends 'signed-off' and each connection closes. Nothing is sent. The source stays. The owner of the Rendezvous resets it after. */
  reset(): void {
    for (const b of [...this.browses.values()]) this.finish(b, 'signed-off');
    for (const s of [...this.shares.values()]) this.end(s, 'signed-off');
  }

  private freshCookie(ident: string): bigint {
    const draw = this.deps.cookie ?? (() => randomBytes(8).readBigUInt64BE(0));
    for (;;) {
      const cookie = draw();
      if (!this.browses.has(`${ident}:${hex(cookie)}`)) return cookie;
    }
  }

  // The id of a take has the form of each other transfer id.
  private freshTakeId(b: Browse): string {
    for (;;) {
      const id = `${b.ident}:${hex(randomBytes(8).readBigUInt64BE(0))}`;
      if (!this.takes.has(id) && !this.browses.has(id)) return id;
    }
  }

  private async offer(b: Browse): Promise<void> {
    try {
      this.met(b, await this.deps.rendezvous.offer(b.peer, b.cookie, 'get-file', null));
    } catch (error) {
      this.deps.log.warn('a get file offer failed', { error: error instanceof Error ? error.name : typeof error });
      this.finish(b, 'peer-closed');
    }
  }

  private met(b: Browse, result: PeerLink | RendezvousEnd): void {
    if (rendezvousEnded(result)) {
      if (result.outcome === 'declined') this.finish(b, 'declined', 'peer');
      else if (result.outcome === 'cancelled') this.finish(b, 'cancelled', result.by === 'peer' ? 'peer' : 'self');
      else if (result.outcome === 'timed-out' || result.outcome === 'refused-address') this.finish(b, result.outcome);
      else this.finish(b, 'peer-closed');
      return;
    }
    if (b.over) {
      result.close();
      return;
    }
    const d = this.deps;
    if (b.state === 'waiting') this.to(b, 'connecting');
    const session = new BrowseSession({
      link: result,
      cookie: b.cookie,
      log: d.log,
      timers: d.timers,
      now: d.now,
      maxListingBytes: d.maxListingBytes,
      maxEntries: d.maxEntries,
      onVerified: () => {},
      onListing: (listing) => this.listed(b, listing),
      onEnd: (why) => this.linkEnded(b, why),
    });
    b.session = session;
    session.start();
  }

  private heard(b: Browse, message: RendezvousMessage): void {
    if (message.type === 'cancel') {
      if (b.session) {
        // Each instance of the peer can send a cancel. Only the close of the connection ends a browse that has one.
        this.deps.log.debug('ignored a cancel for a get file browse that has a connection');
        return;
      }
      const reason = message.cancelReason;
      if (reason === RDV_CANCEL_TIMEOUT) this.finish(b, 'timed-out');
      else if (reason === RDV_CANCEL_DECLINED && b.state === 'waiting') this.finish(b, 'declined', 'peer');
      else this.finish(b, 'cancelled', 'peer');
      // The offer lets go of the cookie.
      this.deps.rendezvous.heard(message);
      return;
    }
    if (message.type === 'propose' && message.sequence === 2 && !b.session) {
      if (b.state === 'waiting') this.to(b, 'connecting');
      this.deps.rendezvous.heard(message);
      return;
    }
    this.deps.log.debug('ignored a get file message that does not fit the browse', { type: message.type, state: b.state });
  }

  // The result is true for the error of a peer about a browse of this client.
  private refused(body: Uint8Array): boolean {
    let error: ReturnType<typeof decodeClientError>;
    try {
      error = decodeClientError(body);
    } catch {
      return false;
    }
    if (error.channel !== ICBM_CHANNEL_RENDEZVOUS) return false;
    const id = `${normalizeScreenName(error.screenName)}:${hex(error.cookie)}`;
    const b = this.browses.get(id);
    const s = this.shares.get(id);
    if (b && !b.session) this.deps.rendezvous.refused(b.cookie);
    else if (s?.state === 'asked') this.end(s, 'cancelled', 'peer');
    else if (s && !s.session) this.deps.rendezvous.refused(s.cookie);
    else if (b || s) this.deps.log.debug('ignored a client error for a get file connection that is open');
    return b !== undefined || s !== undefined;
  }

  // A proposal for a cookie that this client does not hold: a peer asks for the shared files. `number` is the number of the proposal.
  private proposed(message: RendezvousMessage, number: number | null): void {
    const { log } = this.deps;
    if (this.deps.isBlocked(message.fromDisplay)) {
      log.debug('dropped a get file request from a blocked name');
      return;
    }
    if (!this.source) {
      // The capability shows at each sign-on. Thus a request can come while no files are shared.
      log.debug('sent a cancel for a get file request while no files are shared');
      void this.say(message.fromDisplay, message.cookie);
      return;
    }
    if (message.sequence !== 1 || message.useProxy || !message.address) {
      log.info('sent a cancel for a get file request that has no answer', { sequence: message.sequence, proxy: message.useProxy });
      void this.say(message.fromDisplay, message.cookie);
      return;
    }
    const all = [...this.shares.values()];
    if (all.some((s) => s.ident === message.from)) {
      log.info('sent a cancel for a second get file request of one peer');
      void this.say(message.fromDisplay, message.cookie);
      return;
    }
    const waiting = all.filter((s) => s.state === 'asked').length;
    if (this.serving() >= this.deps.maxServing) {
      log.warn('sent a cancel for a get file request past a limit', { serving: this.serving(), waiting });
      void this.say(message.fromDisplay, message.cookie);
      return;
    }
    const s: Share = {
      id: `${message.from}:${hex(message.cookie)}`, cookie: message.cookie, peer: message.fromDisplay, ident: message.from, proposal: message,
      form: listingFormFor(number), state: 'asked', session: null, timer: null, paired: () => {}, over: false,
    };
    this.shares.set(s.id, s);
    // The requester and the relay wait this long.
    s.timer = this.deps.timers.setTimeout(() => {
      s.timer = null;
      this.end(s, 'timed-out');
    }, OFFER_ACCEPT_MS);
    log.info('a get file request came in', { number, form: s.form });
    this.deps.emitRequest({ id: s.id, from: s.peer, at: this.deps.now() });
    // The host can answer in the event. Only a request that waits after it counts against the limit of the requests that wait.
    if (!s.over && s.state === 'asked' && waiting >= MAX_WAITING_OFFERS) {
      log.warn('sent a cancel for a get file request past a limit', { serving: this.serving(), waiting });
      this.end(s, 'cancelled', 'self');
      void this.say(s.peer, s.cookie);
      return;
    }
    this.tell(s);
  }

  // A message of the requester about its request.
  private asked(s: Share, message: RendezvousMessage): void {
    if (message.type !== 'cancel') {
      this.deps.log.debug('ignored a get file message that does not fit the share', { type: message.type, state: s.state });
      return;
    }
    if (s.state === 'open') {
      // Each instance of the peer can send a cancel. Only the close of the connection ends a share that the two sides opened.
      this.deps.log.debug('ignored a cancel for a get file share that is open');
      return;
    }
    const meeting = s.state === 'connecting';
    if (message.cancelReason === RDV_CANCEL_TIMEOUT) this.end(s, 'timed-out');
    else this.end(s, 'cancelled', 'peer');
    // The offer lets go of the cookie.
    if (meeting) this.deps.rendezvous.heard(message);
  }

  private serving(): number {
    let count = 0;
    for (const s of this.shares.values()) if (s.state !== 'asked') count++;
    return count;
  }

  private async receive(s: Share, source: SharedSource): Promise<void> {
    const d = this.deps;
    let met: PeerLink | RendezvousEnd;
    try {
      const paired = new Promise<void>((resolve) => {
        s.paired = resolve;
      });
      met = await d.rendezvous.accept(s.proposal, paired);
    } catch (error) {
      d.log.warn('a get file accept failed', { error: error instanceof Error ? error.name : typeof error });
      this.end(s, 'taken-elsewhere');
      return;
    }
    if (rendezvousEnded(met)) {
      if (met.outcome === 'cancelled') this.end(s, 'cancelled', met.by === 'peer' ? 'peer' : 'self');
      else if (met.outcome === 'timed-out' || met.outcome === 'refused-address') this.end(s, met.outcome);
      // The relay gives a connection that it does not wait for to no requester: another instance took the request.
      else this.end(s, 'taken-elsewhere');
      return;
    }
    if (s.over || this.source !== source) {
      met.close();
      this.end(s, 'closed', 'self');
      return;
    }
    const session = new ServeSession({
      link: met,
      cookie: s.cookie,
      log: d.log,
      timers: d.timers,
      now: d.now,
      source,
      form: s.form,
      maxEntries: d.maxEntries,
      mayServe: () => !s.over && this.source === source && !d.isBlocked(s.peer),
      onVerified: () => {
        if (s.over) return;
        s.paired();
        s.state = 'open';
        this.tell(s);
      },
      onTaken: (path, bytes) => {
        if (!s.over) d.emitTaken({ id: s.id, peer: s.peer, path: [...path], bytes, at: d.now() });
      },
      onEnd: (why) => {
        if (why === 'closed') this.end(s, 'closed', 'self');
        else this.end(s, why, 'peer');
      },
    });
    s.session = session;
    session.start();
  }

  private tell(s: Share, end?: GetFileEnd, by?: 'self' | 'peer'): void {
    this.deps.emitShare({ id: s.id, peer: s.peer, state: s.state, ...(end !== undefined && { end }), ...(by !== undefined && { by }) });
  }

  // Only the first end of a share counts.
  private end(s: Share, end: GetFileEnd, by?: 'self' | 'peer'): void {
    if (s.over) return;
    s.over = true;
    s.paired();
    this.unarm(s);
    this.shares.delete(s.id);
    s.session?.close();
    s.session = null;
    s.state = 'closed';
    this.deps.log.info('a get file share ended', { end, by });
    this.tell(s, end, by);
  }

  private unarm(s: Share): void {
    if (s.timer) this.deps.timers.clearTimeout(s.timer);
    s.timer = null;
  }

  private async say(to: string, cookie: bigint): Promise<void> {
    try {
      await this.deps.send(encodeRendezvousCancel(cookie, to, 'get-file', RDV_CANCEL_DECLINED));
    } catch (error) {
      this.deps.log.debug('a cancel for a get file request was not sent', { error: error instanceof Error ? error.name : typeof error });
    }
  }

  private listed(b: Browse, read: ListingRead): void {
    if (b.over) return;
    b.files.clear();
    // A path that the listing has two times is one file. The first size is its size.
    for (const entry of read.entries) if (!b.files.has(keyOf(entry.path))) b.files.set(keyOf(entry.path), entry.bytes);
    // One listing holds each file of the whole shared folder. The host makes the folders from the paths.
    const entries = read.entries.map((entry) => ({ ...entry, folder: false }));
    if (b.state !== 'open') this.to(b, 'open');
    this.deps.emitListing({ browseId: b.id, from: b.peer, folder: [], entries, truncated: read.truncated, damaged: read.damaged });
  }

  private linkEnded(b: Browse, why: GetFileFailure | 'closed'): void {
    if (b.over) return;
    // The holder does not have the file of the take that has its turn. The connection is closed for each other take.
    if (why === 'not-there' && b.moving) this.finishTake(b, b.moving, 'failed', undefined, 'file-problem');
    if (why !== 'closed') this.finish(b, why, 'peer');
    // The take that has its turn tells why this side closed.
    else if (b.moving) b.dropped = true;
    else this.finish(b, 'closed', 'self');
  }

  // Runs the request after the requests before it.
  private queued(b: Browse, request: () => Promise<void>): Promise<void> {
    const run = b.tail.then(request);
    b.tail = run.catch(() => {});
    return run;
  }

  private async move(b: Browse, t: Take): Promise<void> {
    const session = b.session;
    if (t.over || !session) return;
    b.moving = t;
    try {
      await session.take(t.path, t.bytes, this.guarded(b, t), (progress) => this.progress(b, t, progress), t.signal);
      this.finishTake(b, t, 'done');
    } catch (error) {
      this.broke(b, t, error);
    } finally {
      if (b.moving === t) b.moving = null;
    }
  }

  // The sink of the user never starts a file after the take ended.
  private guarded(b: Browse, t: Take): FileSink {
    return {
      begin: async (file) => {
        if (t.over) throw new Error('the take ended');
        t.state = 'transferring';
        this.emitTake(b, t);
        return t.sink.begin(file);
      },
    };
  }

  private progress(b: Browse, t: Take, p: TransferProgress): void {
    if (t.over) return;
    // The header of a peer never makes the total larger than the listing.
    t.bytesDone = Math.min(p.bytesDone, t.bytes);
    this.emitTake(b, t);
  }

  private broke(b: Browse, t: Take, error: unknown): void {
    if (t.over) return;
    let failure: TransferFailure = 'file-problem';
    if (error instanceof OftError) {
      if (error.failure === 'sink-failed') failure = 'folder-problem';
      else if (error.failure === 'peer-closed') failure = 'peer-closed';
    } else if (error instanceof GetFileError) {
      if (error.failure !== 'refused') failure = 'peer-closed';
    } else this.deps.log.warn('a get file take failed', { error: error instanceof Error ? error.name : typeof error });
    this.finishTake(b, t, 'failed', undefined, failure);
    if (!b.dropped) return;
    // The folder of the user fails each file that waits, in the same way.
    if (failure === 'folder-problem') this.finish(b, 'closed', 'self', failure);
    else this.finish(b, 'bad-frame', 'peer');
  }

  private to(b: Browse, state: BrowseStatus['state']): void {
    b.state = state;
    this.emit(b);
  }

  private emit(b: Browse, end?: GetFileEnd, by?: 'self' | 'peer'): void {
    this.deps.emitBrowse({ id: b.id, peer: b.peer, state: b.state, ...(end !== undefined && { end }), ...(by !== undefined && { by }) });
  }

  private emitTake(b: Browse, t: Take, end: { by?: 'self' | 'peer'; failure?: TransferFailure } = {}): void {
    this.deps.emitTransfer({
      id: t.id, direction: 'in', peer: b.peer, state: t.state, count: 1, index: 0, name: t.name, bytesDone: t.bytesDone, bytesTotal: t.bytes,
      ...(end.failure !== undefined && { failure: end.failure }),
      ...(end.by !== undefined && { by: end.by }),
    });
  }

  // Only the first end of a take counts.
  private finishTake(b: Browse, t: Take, state: TransferState, by?: 'self' | 'peer', failure?: TransferFailure): void {
    if (t.over) return;
    t.over = true;
    t.signal.cancelled = true;
    b.takes.delete(t);
    this.takes.delete(t.id);
    t.state = state;
    this.deps.log.info('a get file take ended', { state, failure, by, bytesDone: t.bytesDone, bytesTotal: t.bytes });
    this.emitTake(b, t, { by, failure });
  }

  // Only the first end of a browse counts. `rest` is the failure of each take that waits, when the end does not give it.
  private finish(b: Browse, end: GetFileEnd, by?: 'self' | 'peer', rest?: TransferFailure): void {
    if (b.over) return;
    b.over = true;
    this.browses.delete(b.id);
    for (const t of [...b.takes]) {
      if (end === 'signed-off') this.finishTake(b, t, 'failed', undefined, 'signed-off');
      else if (rest) this.finishTake(b, t, 'failed', undefined, rest);
      else if (end === 'closed' && by === 'self') this.finishTake(b, t, 'cancelled', 'self');
      else this.finishTake(b, t, 'failed', undefined, 'peer-closed');
    }
    b.session?.close();
    b.session = null;
    b.files.clear();
    b.state = 'closed';
    this.deps.log.info('a get file browse ended', { end, by });
    this.emit(b, end, by);
  }
}
