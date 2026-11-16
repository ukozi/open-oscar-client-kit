import { randomBytes } from 'node:crypto';
import {
  FAMILY_ICBM, ICBM_CHANNEL_RENDEZVOUS, ICBM_CLIENT_ERR, ICBM_MSG_TO_CLIENT, MAX_OFFER_BYTES, RDV_CANCEL_DECLINED, RDV_CANCEL_ELSEWHERE,
  RDV_CANCEL_TIMEOUT,
} from '../wire/constants.js';
import { decodeClientError, encodeRendezvousCancel, offeredFolder, parseRendezvous, rendezvousCapability, serviceOf } from '../wire/rendezvous.js';
import type { RendezvousMessage } from '../wire/rendezvous.js';
import type { Snac } from '../wire/snac.js';
import type { Logger, TimerApi } from '../wire/types.js';
import { normalizeScreenName } from '../model/screen-name.js';
import type {
  FileOfferNotice, FileSink, OutgoingFile, TransferFailure, TransferProgress, TransferState, TransferStatus,
} from '../model/transfer.js';
import { OscarError } from './errors.js';
import { offerAllowed } from './guard.js';
import { OftError, receiveFiles, sendFiles as sendOverLink } from './oft-session.js';
import type { OftSignal } from './oft-session.js';
import type { PeerLink } from './peer-link.js';
import { OFFER_ACCEPT_MS, rendezvousEnded } from './rendezvous.js';
import type { Rendezvous, RendezvousEnd } from './rendezvous.js';

export { MAX_OFFER_BYTES } from '../wire/constants.js';

/** Past this many offers with no answer, a new offer gets a cancel. */
export const MAX_WAITING_OFFERS = 16;
/** The time a transfer waits for the second of the two signs of a cancel: the message and the close of the connection. */
export const PEER_CANCEL_WAIT_MS = 1000;

const MAX_OFFER_FILES = 0xffff;

export type TransfersDeps = {
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
  /** Asked one time for each offer that comes. Only true keeps the offer. For each other result, nothing is sent and nothing is kept. */
  allowOffer(from: string): boolean;
  emitOffer(offer: FileOfferNotice): void;
  emitTransfer(status: TransferStatus): void;
  /** The cookie of a new offer. Tests replace it. */
  cookie?: () => bigint;
};

type Transfer = {
  readonly id: string;
  readonly cookie: bigint;
  readonly direction: 'in' | 'out';
  /** The name of the peer as the messages to it carry it. */
  readonly peer: string;
  /** offered: the offer has no answer yet. closing: the connection closed and the cancel of the peer can still come. */
  phase: 'offered' | 'meeting' | 'moving' | 'closing';
  state: TransferState;
  count: number;
  index: number;
  name: string;
  bytesDone: number;
  bytesTotal: number;
  /** What the offer of the peer named. */
  readonly offered: { count: number; bytes: number };
  readonly proposal: RendezvousMessage | null;
  link: PeerLink | null;
  readonly signal: OftSignal;
  timer: ReturnType<typeof setTimeout> | null;
  /** The peer showed the cookie of the offer. */
  prompted: boolean;
  /** Lets the next offer meet the relay. */
  paired: () => void;
  /** A cancel came on the BOS link while the offer moved. */
  peerCancelled: boolean;
  /** The peer sent more than its offer named. */
  beyondOffer: boolean;
  over: boolean;
};

function invalid(): OscarError {
  return new OscarError({ kind: 'local', code: 'invalid-argument' });
}

function isSize(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_OFFER_BYTES;
}

/** The file offers of one session: offers in and out, their ids, and the events of each transfer. */
export class Transfers {
  private readonly transfers = new Map<string, Transfer>();
  private readonly rendezvous: Rendezvous;

  constructor(private readonly deps: TransfersDeps) {
    this.rendezvous = deps.rendezvous;
  }

  /** Offers the files and gives the id of the transfer. The first event comes before the result. */
  sendFiles(screenName: string, files: readonly OutgoingFile[]): string {
    if (!this.deps.enabled || files.length === 0 || files.length > MAX_OFFER_FILES) throw invalid();
    if (files.some((file) => !isSize(file.bytes) || file.name === '' || file.name.includes('\0'))) throw invalid();
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const first = files[0];
    if (!first || !isSize(bytes)) throw invalid();
    const cookie = this.freshCookie(screenName);
    const t = this.add({
      cookie, direction: 'out', peer: screenName, phase: 'meeting', count: files.length, name: first.name, bytes, proposal: null,
    });
    this.deps.log.info('a file offer went out', { count: t.count, bytes });
    this.emit(t);
    void this.send(t, [...files]);
    return t.id;
  }

  /** Accept first, then the dial. The events of the transfer tell the result. */
  accept(id: string, sink: FileSink): void {
    const t = this.transfers.get(id);
    if (t?.phase !== 'offered' || !t.proposal) throw invalid();
    this.unarm(t);
    t.phase = 'meeting';
    this.move(t, 'connecting');
    void this.receive(t, t.proposal, sink);
  }

  /** Declines an offer that waits for an answer. It ignores each other id. */
  async decline(id: string): Promise<void> {
    const t = this.transfers.get(id);
    if (t?.phase !== 'offered') return;
    this.finish(t, 'declined', 'self');
    await this.tell(t);
  }

  /** Ends a transfer in each state and tells the peer. It ignores an id that is not live. */
  async cancel(id: string): Promise<void> {
    const t = this.transfers.get(id);
    if (!t) return;
    if (t.phase === 'offered') return this.decline(id);
    const meeting = t.phase === 'meeting';
    this.finish(t, 'cancelled', 'self');
    // The offer sends its own cancel while it holds the cookie.
    if (meeting) await this.rendezvous.cancel(t.cookie);
    else await this.tell(t);
  }

  /** Takes each SNAC of the BOS link. The result is true for a message of the Send File service. */
  handle(snac: Snac): boolean {
    if (!this.deps.enabled || snac.family !== FAMILY_ICBM) return false;
    if (snac.subtype === ICBM_CLIENT_ERR) return this.refused(snac.body);
    if (snac.subtype !== ICBM_MSG_TO_CLIENT) return false;
    const capability = rendezvousCapability(snac.body);
    if (!capability || serviceOf(capability) !== 'send-file') return false;
    const message = parseRendezvous(snac.body);
    if (!message) {
      this.deps.log.debug('ignored a file message of an unknown type');
      return true;
    }
    const t = this.transfers.get(this.idOf(message.from, message.cookie));
    if (t) this.heard(t, message);
    else if (message.type === 'propose') this.proposed(message);
    else this.deps.log.debug('ignored a file message for no transfer of this session', { type: message.type });
    return true;
  }

  /** Sign-off: each transfer ends 'failed' with 'signed-off', and each offer with no answer ends 'cancelled'. Nothing is sent. The owner of the Rendezvous resets it after. */
  reset(): void {
    for (const t of [...this.transfers.values()]) {
      if (t.phase === 'offered') this.finish(t, 'cancelled', 'self');
      else this.finish(t, 'failed', undefined, 'signed-off');
    }
  }

  private idOf(peer: string, cookie: bigint): string {
    return `${normalizeScreenName(peer)}:${cookie.toString(16).padStart(16, '0')}`;
  }

  private freshCookie(peer: string): bigint {
    const draw = this.deps.cookie ?? (() => randomBytes(8).readBigUInt64BE(0));
    for (;;) {
      const cookie = draw();
      if (!this.transfers.has(this.idOf(peer, cookie))) return cookie;
    }
  }

  private add(o: {
    cookie: bigint; direction: Transfer['direction']; peer: string; phase: Transfer['phase']; count: number; name: string; bytes: number;
    proposal: RendezvousMessage | null;
  }): Transfer {
    const t: Transfer = {
      id: this.idOf(o.peer, o.cookie), cookie: o.cookie, direction: o.direction, peer: o.peer, phase: o.phase, state: 'waiting',
      count: o.count, index: 0, name: o.name, bytesDone: 0, bytesTotal: o.bytes, offered: { count: o.count, bytes: o.bytes },
      proposal: o.proposal, link: null, signal: { cancelled: false }, timer: null, prompted: false, paired: () => {}, peerCancelled: false, beyondOffer: false, over: false,
    };
    this.transfers.set(t.id, t);
    return t;
  }

  private proposed(message: RendezvousMessage): void {
    const { log } = this.deps;
    if (this.deps.isBlocked(message.fromDisplay)) {
      log.debug('dropped a file offer from a blocked name');
      return;
    }
    if (!offerAllowed(this.deps.allowOffer, message.fromDisplay, log, 'file')) {
      log.debug('dropped a file offer that the host does not allow');
      return;
    }
    const file = message.file;
    if (message.sequence !== 1 || message.useProxy || !message.address || !file || file.count < 1) {
      log.info('sent a cancel for a file offer that has no answer', { sequence: message.sequence, proxy: message.useProxy });
      void this.say(message.fromDisplay, message.cookie, RDV_CANCEL_DECLINED);
      return;
    }
    const waiting = [...this.transfers.values()].filter((t) => t.phase === 'offered').length;
    if (waiting >= MAX_WAITING_OFFERS) {
      log.warn('sent a cancel for a file offer past the limit of offers', { waiting });
      void this.say(message.fromDisplay, message.cookie, RDV_CANCEL_DECLINED);
      return;
    }
    const t = this.add({
      cookie: message.cookie, direction: 'in', peer: message.fromDisplay, phase: 'offered', count: file.count, name: file.name,
      bytes: file.totalBytes, proposal: message,
    });
    // The offerer and the relay wait this long. No cancel comes when another instance took the offer.
    t.timer = this.deps.timers.setTimeout(() => {
      t.timer = null;
      this.finish(t, 'failed', undefined, 'timed-out');
    }, OFFER_ACCEPT_MS);
    log.info('a file offer came in', { count: file.count, bytes: file.totalBytes });
    this.deps.emitOffer({ id: t.id, from: t.peer, count: t.count, totalBytes: t.bytesTotal, name: t.name, folder: offeredFolder(file), at: this.deps.now() });
  }

  private heard(t: Transfer, message: RendezvousMessage): void {
    if (message.type === 'cancel') {
      this.cancelled(t, message);
      return;
    }
    if (message.type === 'propose' && message.sequence === 2 && t.direction === 'out' && t.phase === 'meeting') {
      if (t.state === 'waiting') this.move(t, 'connecting');
      this.rendezvous.heard(message);
      return;
    }
    this.deps.log.debug('ignored a file message that does not fit the transfer', { type: message.type, phase: t.phase });
  }

  private cancelled(t: Transfer, message: RendezvousMessage): void {
    const reason = message.cancelReason;
    const meeting = t.phase === 'meeting';
    if (t.direction === 'out' && t.phase === 'moving') {
      this.cancelledWhileMoving(t);
      return;
    }
    if (reason === RDV_CANCEL_TIMEOUT && (meeting || t.phase === 'offered')) this.finish(t, 'failed', undefined, 'timed-out');
    else if (reason === RDV_CANCEL_ELSEWHERE && t.phase === 'offered') this.finish(t, 'failed', undefined, 'taken-elsewhere');
    else if (reason === RDV_CANCEL_DECLINED && t.direction === 'out' && t.state === 'waiting') this.finish(t, 'declined', 'peer');
    else this.finish(t, 'cancelled', 'peer');
    // The offer lets go of the cookie.
    if (meeting) this.rendezvous.heard(message);
  }

  // Each instance of the recipient can send a cancel. Only the instance that holds the connection can close it.
  private cancelledWhileMoving(t: Transfer): void {
    if (t.link?.closed) {
      this.finish(t, 'cancelled', 'peer');
      return;
    }
    if (t.peerCancelled) return;
    t.peerCancelled = true;
    t.timer = this.deps.timers.setTimeout(() => {
      t.timer = null;
      if (t.link?.closed) this.finish(t, 'cancelled', 'peer');
      else t.peerCancelled = false;
    }, PEER_CANCEL_WAIT_MS);
  }

  // The result is true for the error of a peer about a transfer of this session.
  private refused(body: Uint8Array): boolean {
    let error: ReturnType<typeof decodeClientError>;
    try {
      error = decodeClientError(body);
    } catch {
      return false;
    }
    if (error.channel !== ICBM_CHANNEL_RENDEZVOUS) return false;
    const t = this.transfers.get(this.idOf(error.screenName, error.cookie));
    if (!t) return false;
    if (t.phase === 'meeting') this.rendezvous.refused(t.cookie);
    else this.deps.log.debug('ignored a client error for a transfer that does not wait for the peer', { phase: t.phase });
    return true;
  }

  private async send(t: Transfer, files: readonly OutgoingFile[]): Promise<void> {
    try {
      // A name in an offer of the "several" kind is the name of a folder. Loose files have none.
      const several = t.count > 1;
      const file = { multiple: several, count: t.count, totalBytes: t.bytesTotal, name: several ? '' : t.name };
      const link = this.met(t, await this.rendezvous.offer(t.peer, t.cookie, 'send-file', file));
      if (!link) return;
      await sendOverLink(link, t.cookie, files, (progress) => this.progress(t, progress), t.signal, this.deps.now);
      this.finish(t, 'done');
    } catch (error) {
      this.broke(t, error);
    }
  }

  private async receive(t: Transfer, proposal: RendezvousMessage, sink: FileSink): Promise<void> {
    try {
      const paired = new Promise<void>((resolve) => {
        t.paired = resolve;
      });
      // An offer that ended already has its end here.
      if (t.over) t.paired();
      const link = this.met(t, await this.rendezvous.accept(proposal, paired));
      if (!link) return;
      await receiveFiles(link, t.cookie, this.guarded(t, sink), (progress) => this.progress(t, progress), t.signal, this.deps.now);
      this.finish(t, 'done');
    } catch (error) {
      this.broke(t, error);
    }
  }

  // The result is the connection of a transfer that is live, or null when the transfer ended.
  private met(t: Transfer, result: PeerLink | RendezvousEnd): PeerLink | null {
    if (rendezvousEnded(result)) {
      this.ended(t, result);
      return null;
    }
    if (t.over) {
      // The transfer ended while the connection opened. The peer hears why.
      result.close();
      void this.tell(t);
      return null;
    }
    t.link = result;
    t.phase = 'moving';
    // The recipient waits for the offerer here. Its first header starts the bar.
    if (t.direction === 'out') this.move(t, 'transferring');
    return result;
  }

  private ended(t: Transfer, end: RendezvousEnd): void {
    if (end.outcome === 'declined') this.finish(t, 'declined', 'peer');
    else if (end.outcome === 'cancelled') this.finish(t, 'cancelled', end.by === 'peer' ? 'peer' : 'self');
    else if (end.outcome === 'timed-out' || end.outcome === 'refused-address') this.finish(t, 'failed', undefined, end.outcome);
    else this.finish(t, 'failed', undefined, 'peer-closed');
  }

  // The sink of the user never starts a file after the transfer ended, or a file past the offer.
  private guarded(t: Transfer, sink: FileSink): FileSink {
    let before = 0;
    return {
      begin: async (file) => {
        if (t.over) throw new Error('the transfer ended');
        t.prompted = true;
        t.paired();
        if (file.count > t.offered.count || before + file.bytes > t.offered.bytes) {
          t.beyondOffer = true;
          throw new RangeError('the peer sent more than its offer named');
        }
        before += file.bytes;
        if (t.state !== 'transferring') this.move(t, 'transferring');
        return sink.begin(file);
      },
    };
  }

  private progress(t: Transfer, p: TransferProgress): void {
    if (t.over) return;
    // The header of a peer never makes the count or the total larger than the offer.
    t.count = Math.min(p.count, t.offered.count);
    t.index = p.index;
    t.name = p.name;
    t.bytesTotal = Math.min(p.bytesTotal, t.offered.bytes);
    t.bytesDone = Math.min(p.bytesDone, t.bytesTotal);
    this.emit(t);
  }

  private broke(t: Transfer, error: unknown): void {
    if (t.over) return;
    const failure = error instanceof OftError ? error.failure : null;
    if (failure === 'peer-closed') {
      if (t.peerCancelled) {
        this.finish(t, 'cancelled', 'peer');
        return;
      }
      // A cancel on the BOS link tells why the peer closed. It can come after the close.
      t.phase = 'closing';
      t.link = null;
      t.timer = this.deps.timers.setTimeout(() => {
        t.timer = null;
        this.finish(t, 'failed', undefined, 'peer-closed');
      }, PEER_CANCEL_WAIT_MS);
      return;
    }
    if (failure === 'bad-header' && t.direction === 'in' && !t.prompted) {
      // The relay did not wait for this connection: another instance took the offer. The offerer hears nothing.
      this.finish(t, 'failed', undefined, 'taken-elsewhere');
      return;
    }
    if (failure === null) this.deps.log.warn('a transfer failed', { direction: t.direction, error: error instanceof Error ? error.name : typeof error });
    void this.tell(t);
    if (failure === 'source-changed') this.finish(t, 'failed', undefined, 'source-changed');
    else if (failure === 'sink-failed' && !t.beyondOffer) this.finish(t, 'failed', undefined, 'folder-problem');
    else this.finish(t, 'failed', undefined, 'file-problem');
  }

  private move(t: Transfer, state: TransferState): void {
    t.state = state;
    this.emit(t);
  }

  private emit(t: Transfer, end: { by?: 'self' | 'peer'; failure?: TransferFailure } = {}): void {
    const { id, direction, peer, state, count, index, name, bytesDone, bytesTotal } = t;
    this.deps.emitTransfer({
      id, direction, peer, state, count, index, name, bytesDone, bytesTotal,
      ...(end.failure !== undefined && { failure: end.failure }),
      ...(end.by !== undefined && { by: end.by }),
    });
  }

  // Only the first end of a transfer counts.
  private finish(t: Transfer, state: TransferState, by?: 'self' | 'peer', failure?: TransferFailure): void {
    if (t.over) return;
    t.over = true;
    t.paired();
    t.signal.cancelled = true;
    this.unarm(t);
    this.transfers.delete(t.id);
    t.link?.close();
    t.link = null;
    t.state = state;
    this.deps.log.info('a transfer ended', { direction: t.direction, state, failure, by, count: t.count, bytesDone: t.bytesDone, bytesTotal: t.bytesTotal });
    this.emit(t, { by, failure });
  }

  private unarm(t: Transfer): void {
    if (t.timer) this.deps.timers.clearTimeout(t.timer);
    t.timer = null;
  }

  private tell(t: Transfer): Promise<void> {
    return this.say(t.peer, t.cookie, RDV_CANCEL_DECLINED);
  }

  private async say(to: string, cookie: bigint, reason: number): Promise<void> {
    try {
      await this.deps.send(encodeRendezvousCancel(cookie, to, 'send-file', reason));
    } catch (error) {
      this.deps.log.debug('a cancel for a file offer was not sent', { error: error instanceof Error ? error.name : typeof error });
    }
  }
}
