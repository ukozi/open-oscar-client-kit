import { randomBytes } from 'node:crypto';
import {
  FAMILY_ICBM, ICBM_CHANNEL_RENDEZVOUS, ICBM_CLIENT_ERR, ICBM_MSG_TO_CLIENT, RDV_CANCEL_DECLINED, RDV_CANCEL_ELSEWHERE, RDV_CANCEL_TIMEOUT,
} from '../wire/constants.js';
import { decodeClientError, encodeRendezvousCancel, parseRendezvous, rendezvousCapability, serviceOf } from '../wire/rendezvous.js';
import type { RendezvousMessage } from '../wire/rendezvous.js';
import type { Snac } from '../wire/snac.js';
import type { Logger, TimerApi } from '../wire/types.js';
import type { DirectImEnd, DirectImOffer, DirectImState, DirectImStatus, DirectMessage, OutgoingDirectMessage } from '../model/direct-im.js';
import { normalizeScreenName } from '../model/screen-name.js';
import { OscarError } from './errors.js';
import { offerAllowed } from './guard.js';
import { OdcSession } from './odc-session.js';
import type { OdcFailure } from './odc-session.js';
import type { PeerLink } from './peer-link.js';
import { OFFER_ACCEPT_MS, rendezvousEnded } from './rendezvous.js';
import type { Rendezvous, RendezvousEnd } from './rendezvous.js';
import { MAX_WAITING_OFFERS } from './transfers.js';

/** Two offers that started in this time of each other crossed. After it, an offer that still waits when the peer makes its own is dead. */
export const CROSSED_OFFER_MS = 10_000;
/** The relay closes a recipient that waits alone before the cancel of the offerer comes. The session waits this long for the cancel. */
export const CANCEL_AFTER_CLOSE_MS = 2_000;

export type DirectImDeps = {
  log: Logger;
  now: () => number;
  timers: TimerApi;
  /** When false, the part ignores each message and refuses each command. */
  enabled: boolean;
  /** The offers of the session. Its owner resets it. */
  rendezvous: Rendezvous;
  /** The name of this client, for the header of each frame. */
  self(): string;
  /** Sends one ICBM 0x04/0x06 body on the BOS link. It rejects when the session is not online. */
  send(body: Uint8Array): Promise<void>;
  isBlocked(name: string): boolean;
  /** Asked one time for each offer that comes. Only true keeps the offer. For each other result, the client sends nothing and keeps nothing. */
  allowOffer(from: string): boolean;
  maxMessageBytes: number;
  maxAttachments: number;
  maxTextBytes: number;
  maxSessionBytes: number;
  /** null: a message waits until the peer shows the cookie. */
  sendUnverifiedAfterMs: number | null;
  emitOffer(offer: DirectImOffer): void;
  emitStatus(status: DirectImStatus): void;
  emitMessage(message: DirectMessage): void;
  emitTyping(typing: { from: string; typing: boolean }): void;
  /** The cookie of a new offer. Tests replace it. */
  cookie?: () => bigint;
};

type Session = {
  /** The id the host has. It stays when the session takes the cookie of the peer. */
  readonly id: string;
  cookie: bigint;
  /** The name of the peer as the messages to it carry it. */
  readonly peer: string;
  readonly ident: string;
  readonly role: 'offering' | 'receiving';
  /** offered: the offer has no answer yet. */
  phase: 'offered' | 'meeting' | 'open';
  state: DirectImState;
  verified: boolean;
  proposal: RendezvousMessage | null;
  startedAt: number;
  /** The connection of a recipient closed before the cookie, and the session waits for the cancel that tells why. */
  lost: boolean;
  odc: OdcSession | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Lets the next offer meet the relay. */
  paired: () => void;
  over: boolean;
};

function invalid(): OscarError {
  return new OscarError({ kind: 'local', code: 'invalid-argument' });
}

/** The Direct IM sessions of one client: offers in and out, their ids, and one connection for each peer. */
export class DirectIm {
  private readonly sessions = new Map<string, Session>();
  // By peer and cookie, for the messages that come.
  private readonly cookies = new Map<string, Session>();

  constructor(private readonly deps: DirectImDeps) {}

  /** Offers Direct IM and gives the id of the session. A peer with a session that is live gets no second offer: the result is the id of that session. */
  open(screenName: string): string {
    if (!this.deps.enabled) throw invalid();
    const live = this.withPeer(normalizeScreenName(screenName));
    if (live) return live.id;
    const s = this.add({ cookie: this.freshCookie(screenName), peer: screenName, role: 'offering', phase: 'meeting', proposal: null });
    this.deps.log.info('a direct im offer went out');
    this.emit(s);
    void this.offer(s);
    return s.id;
  }

  /** Accept first, then the dial. The events of the session tell the result. */
  accept(id: string): void {
    const s = this.sessions.get(id);
    if (s?.phase !== 'offered' || !s.proposal) throw invalid();
    this.unarm(s);
    s.phase = 'meeting';
    this.move(s, 'connecting');
    void this.receive(s, s.proposal);
  }

  /** Declines an offer that waits for an answer. It ignores each other id. */
  async decline(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s?.phase !== 'offered' || !s.proposal) return;
    this.finish(s, 'declined', 'self');
    await this.say(s.peer, s.cookie);
  }

  /** Ends a session in each state. An offer that waits for an answer is declined. It ignores an id that is not live. */
  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.phase === 'offered') return this.decline(id);
    const meeting = s.phase === 'meeting';
    this.finish(s, 'closed', 'self');
    // The offer sends its own cancel while it holds the cookie.
    if (meeting) await this.deps.rendezvous.cancel(s.cookie);
  }

  /** Resolves when the frame is written. It rejects with OdcError when the connection ends first. */
  async sendMessage(id: string, message: OutgoingDirectMessage): Promise<void> {
    const s = this.sessions.get(id);
    if (s?.phase !== 'open' || !s.odc || message.pictures.length > this.deps.maxAttachments) throw invalid();
    return s.odc.send(message);
  }

  /** True for a message of the Direct IM service and for the client error of a peer about one. */
  handle(snac: Snac): boolean {
    if (!this.deps.enabled || snac.family !== FAMILY_ICBM) return false;
    if (snac.subtype === ICBM_CLIENT_ERR) return this.refused(snac.body);
    if (snac.subtype !== ICBM_MSG_TO_CLIENT) return false;
    const capability = rendezvousCapability(snac.body);
    if (!capability || serviceOf(capability) !== 'direct-im') return false;
    const message = parseRendezvous(snac.body);
    if (!message) {
      this.deps.log.debug('ignored a direct im message of an unknown type');
      return true;
    }
    const s = this.cookies.get(this.idOf(message.from, message.cookie));
    if (s) this.heard(s, message);
    else if (message.type === 'propose') this.proposed(message);
    else this.deps.log.debug('ignored a direct im message for no session', { type: message.type });
    return true;
  }

  /** Sign-off: each session ends 'signed-off' and each connection closes. Nothing is sent. The owner of the Rendezvous resets it after. */
  reset(): void {
    for (const s of [...this.sessions.values()]) this.finish(s, 'signed-off');
  }

  private idOf(peer: string, cookie: bigint): string {
    return `${normalizeScreenName(peer)}:${cookie.toString(16).padStart(16, '0')}`;
  }

  private withPeer(ident: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.ident === ident) return s;
    return undefined;
  }

  private freshCookie(peer: string): bigint {
    const draw = this.deps.cookie ?? (() => randomBytes(8).readBigUInt64BE(0));
    for (;;) {
      const cookie = draw();
      const id = this.idOf(peer, cookie);
      if (!this.sessions.has(id) && !this.cookies.has(id)) return cookie;
    }
  }

  private add(o: Pick<Session, 'cookie' | 'peer' | 'role' | 'phase' | 'proposal'>): Session {
    const s: Session = {
      ...o, id: this.idOf(o.peer, o.cookie), ident: normalizeScreenName(o.peer), state: 'waiting', verified: false, startedAt: this.deps.now(), lost: false, odc: null,
      timer: null, paired: () => {}, over: false,
    };
    this.sessions.set(s.id, s);
    this.cookies.set(s.id, s);
    return s;
  }

  private proposed(message: RendezvousMessage): void {
    const { log } = this.deps;
    if (this.deps.isBlocked(message.fromDisplay)) {
      log.debug('dropped a direct im offer from a blocked name');
      return;
    }
    if (!offerAllowed(this.deps.allowOffer, message.fromDisplay, log, 'direct im')) {
      log.debug('dropped a direct im offer that the host does not allow');
      return;
    }
    if (message.sequence !== 1 || message.useProxy || !message.address) {
      log.info('sent a cancel for a direct im offer that has no answer', { sequence: message.sequence, proxy: message.useProxy });
      void this.say(message.fromDisplay, message.cookie);
      return;
    }
    const live = this.withPeer(message.from);
    if (live?.lost) this.finish(live, 'cancelled', 'peer');
    else if (live?.phase === 'offered') {
      // The peer made a new offer, thus the offer that waits is dead.
      log.info('a new direct im offer of the peer came in place of the offer that waits');
      this.finish(live, 'cancelled', 'peer');
      // The relay and each other instance of the peer let go of the old offer.
      void this.say(live.peer, live.cookie);
    } else if (live && live.role === 'offering' && live.state === 'waiting' && this.yields(live)) {
      this.take(live, message);
      return;
    } else if (live) {
      log.info('sent a cancel for a second direct im offer of one peer');
      void this.say(message.fromDisplay, message.cookie);
      return;
    }
    const waiting = [...this.sessions.values()].filter((s) => s.phase === 'offered').length;
    if (waiting >= MAX_WAITING_OFFERS) {
      log.warn('sent a cancel for a direct im offer past the limit of offers', { waiting });
      void this.say(message.fromDisplay, message.cookie);
      return;
    }
    const s = this.add({ cookie: message.cookie, peer: message.fromDisplay, role: 'receiving', phase: 'offered', proposal: message });
    // The offerer and the relay wait this long. No cancel comes when another instance took the offer.
    s.timer = this.deps.timers.setTimeout(() => {
      s.timer = null;
      this.finish(s, 'timed-out');
    }, OFFER_ACCEPT_MS);
    log.info('a direct im offer came in');
    this.deps.emitOffer({ id: s.id, from: s.peer, at: this.deps.now() });
  }

  // The offer of this client and the offer of the peer are for one connection, and one of them stays.
  // An offer of this client that waited longer than the crossing time is dead: the peer does not hold it.
  // For two offers that crossed, the offer of the name that sorts first stays.
  private yields(s: Session): boolean {
    if (this.deps.now() - s.startedAt > CROSSED_OFFER_MS) return true;
    return s.ident < normalizeScreenName(this.deps.self());
  }

  // The session of this client goes on with the offer of the peer. Its id stays, and its own offer is cancelled.
  private take(s: Session, proposal: RendezvousMessage): void {
    const own = s.cookie;
    this.cookies.delete(this.idOf(s.peer, own));
    s.cookie = proposal.cookie;
    s.proposal = proposal;
    this.cookies.set(this.idOf(s.peer, s.cookie), s);
    this.deps.log.info('a direct im session took the offer of the peer in place of its own offer');
    void this.deps.rendezvous.cancel(own);
    this.move(s, 'connecting');
    void this.receive(s, proposal);
  }

  private heard(s: Session, message: RendezvousMessage): void {
    if (message.type === 'cancel') {
      this.cancelled(s, message);
      return;
    }
    if (message.type === 'propose' && message.sequence === 2 && s.role === 'offering' && s.phase === 'meeting') {
      if (s.state === 'waiting') this.move(s, 'connecting');
      this.deps.rendezvous.heard(message);
      return;
    }
    this.deps.log.debug('ignored a direct im message that does not fit the session', { type: message.type, phase: s.phase });
  }

  private cancelled(s: Session, message: RendezvousMessage): void {
    const reason = message.cancelReason;
    if (s.phase === 'open' && (s.verified || s.role === 'offering')) {
      // Each instance of the peer can send a cancel. Only the close of the connection ends a session that the two sides opened.
      this.deps.log.debug('ignored a cancel for a direct im session that is open');
      return;
    }
    const meeting = s.phase === 'meeting';
    // A recipient that waits alone at the relay ends as the offerer says.
    if (reason === RDV_CANCEL_TIMEOUT) this.finish(s, 'timed-out');
    else if (reason === RDV_CANCEL_ELSEWHERE && s.phase === 'offered') this.finish(s, 'taken-elsewhere');
    else if (reason === RDV_CANCEL_DECLINED && s.role === 'offering' && s.state === 'waiting') this.finish(s, 'declined', 'peer');
    else this.finish(s, 'cancelled', 'peer');
    // The offer lets go of the cookie.
    if (meeting) this.deps.rendezvous.heard(message);
  }

  // The result is true for the error of a peer about a session of this client.
  private refused(body: Uint8Array): boolean {
    let error: ReturnType<typeof decodeClientError>;
    try {
      error = decodeClientError(body);
    } catch {
      return false;
    }
    if (error.channel !== ICBM_CHANNEL_RENDEZVOUS) return false;
    const s = this.cookies.get(this.idOf(error.screenName, error.cookie));
    if (!s) return false;
    if (s.phase === 'meeting') this.deps.rendezvous.refused(s.cookie);
    else this.deps.log.debug('ignored a client error for a direct im session that does not wait for the peer', { phase: s.phase });
    return true;
  }

  private async offer(s: Session): Promise<void> {
    const cookie = s.cookie;
    try {
      const result = await this.deps.rendezvous.offer(s.peer, cookie, 'direct-im', null);
      // The session took the offer of the peer, and this offer is not its offer now.
      if (s.cookie !== cookie) return;
      this.met(s, result);
    } catch (error) {
      this.deps.log.warn('a direct im offer failed', { error: error instanceof Error ? error.name : typeof error });
      if (s.cookie === cookie) this.finish(s, 'peer-closed');
    }
  }

  private async receive(s: Session, proposal: RendezvousMessage): Promise<void> {
    try {
      const paired = new Promise<void>((resolve) => {
        s.paired = resolve;
      });
      // A session that ended already has its end here.
      if (s.over) s.paired();
      this.met(s, await this.deps.rendezvous.accept(proposal, paired));
    } catch (error) {
      this.deps.log.warn('a direct im accept failed', { error: error instanceof Error ? error.name : typeof error });
      this.finish(s, s.role === 'receiving' ? 'taken-elsewhere' : 'peer-closed');
    }
  }

  private met(s: Session, result: PeerLink | RendezvousEnd): void {
    if (rendezvousEnded(result)) {
      this.ended(s, result);
      return;
    }
    if (s.over) {
      result.close();
      return;
    }
    const d = this.deps;
    const odc = new OdcSession({
      link: result,
      cookie: s.cookie,
      self: d.self(),
      log: d.log,
      timers: d.timers,
      maxMessageBytes: d.maxMessageBytes,
      maxAttachments: d.maxAttachments,
      maxTextBytes: d.maxTextBytes,
      maxSessionBytes: d.maxSessionBytes,
      sendUnverifiedAfterMs: d.sendUnverifiedAfterMs,
      onVerified: () => this.shown(s),
      onMessage: (message) => {
        if (!s.over) d.emitMessage({ id: s.id, from: s.peer, at: d.now(), ...message });
      },
      onTyping: (state) => {
        if (!s.over) d.emitTyping({ from: s.peer, typing: state === 'typing' });
      },
      onEnd: (why) => this.linkEnded(s, why),
    });
    s.odc = odc;
    s.phase = 'open';
    this.move(s, 'open');
    odc.start();
  }

  private shown(s: Session): void {
    if (s.over || s.verified) return;
    s.verified = true;
    s.paired();
    this.emit(s);
  }

  private ended(s: Session, end: RendezvousEnd): void {
    if (end.outcome === 'declined') this.finish(s, 'declined', 'peer');
    else if (end.outcome === 'cancelled') this.finish(s, 'cancelled', end.by === 'peer' ? 'peer' : 'self');
    else if (end.outcome === 'timed-out' || end.outcome === 'refused-address') this.finish(s, end.outcome);
    else this.finish(s, s.role === 'receiving' ? 'taken-elsewhere' : 'peer-closed');
  }

  private linkEnded(s: Session, why: OdcFailure | 'closed'): void {
    if (why === 'closed') this.finish(s, 'closed', 'self');
    else if (s.role === 'receiving' && !s.verified && (why === 'peer-closed' || why === 'bad-frame')) this.lose(s);
    else this.finish(s, why, 'peer');
  }

  // The relay gives a connection that it does not wait for to the sign-on service: another instance took the offer.
  // The relay also closes the connection for a cancel of the offerer, and that cancel can come after the close.
  private lose(s: Session): void {
    if (s.over || s.lost) return;
    s.lost = true;
    s.odc = null;
    s.paired();
    s.timer = this.deps.timers.setTimeout(() => {
      s.timer = null;
      this.finish(s, 'taken-elsewhere');
    }, CANCEL_AFTER_CLOSE_MS);
  }

  private move(s: Session, state: DirectImState): void {
    s.state = state;
    this.emit(s);
  }

  private emit(s: Session, end?: DirectImEnd, by?: 'self' | 'peer'): void {
    const { id, peer, role, state, verified } = s;
    this.deps.emitStatus({ id, peer, role, state, ...(end !== undefined && { end }), ...(by !== undefined && { by }), verified });
  }

  // Only the first end of a session counts.
  private finish(s: Session, end: DirectImEnd, by?: 'self' | 'peer'): void {
    if (s.over) return;
    s.over = true;
    s.paired();
    this.unarm(s);
    this.sessions.delete(s.id);
    this.cookies.delete(this.idOf(s.peer, s.cookie));
    s.odc?.close();
    s.odc = null;
    s.state = 'closed';
    this.deps.log.info('a direct im session ended', { role: s.role, end, by, verified: s.verified });
    this.emit(s, end, by);
  }

  private unarm(s: Session): void {
    if (s.timer) this.deps.timers.clearTimeout(s.timer);
    s.timer = null;
  }

  private async say(to: string, cookie: bigint): Promise<void> {
    try {
      await this.deps.send(encodeRendezvousCancel(cookie, to, 'direct-im', RDV_CANCEL_DECLINED));
    } catch (error) {
      this.deps.log.debug('a cancel for a direct im offer was not sent', { error: error instanceof Error ? error.name : typeof error });
    }
  }
}
