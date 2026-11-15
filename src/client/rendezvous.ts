import { RDV_CANCEL_DECLINED, RDV_CANCEL_TIMEOUT } from '../wire/constants.js';
import {
  encodeDirectImProposal, encodeFileProposal, encodeGetFileProposal, encodeRendezvousAccept, encodeRendezvousCancel,
} from '../wire/rendezvous.js';
import type { FileDescription, PeerAddress, RendezvousMessage, RendezvousService } from '../wire/rendezvous.js';
import type { Logger, TimerApi } from '../wire/types.js';
import { normalizeScreenName } from '../model/screen-name.js';
import { openPeerLink } from './peer-link.js';
import type { PeerLink } from './peer-link.js';

/** The time the relay waits for the recipient. */
export const OFFER_ACCEPT_MS = 300_000;
/** The time the relay waits for the offerer after its counter-offer. */
export const COUNTER_DIAL_MS = 30_000;

// The relay writes its own address over this one. The client never writes the address of its machine.
const PLACEHOLDER_ADDRESS: PeerAddress = { ip: '0.0.0.0', port: 5190 };

export type RendezvousOutcome = 'connected' | 'declined' | 'cancelled' | 'timed-out' | 'refused-address' | 'failed';
export type RendezvousEnd = { outcome: Exclude<RendezvousOutcome, 'connected'>; by: 'self' | 'peer' | 'server' };
export type RendezvousDeps = {
  log: Logger;
  timers: TimerApi;
  now: () => number;
  /** Sends one ICBM 0x04/0x06 body on the BOS link. */
  send(body: Uint8Array): Promise<void>;
  /** Sends sequence 1 of an offer. It calls `refused` when the server answers the proposal with an error. The default is `send`. */
  propose?(body: Uint8Array, refused: () => void): Promise<void>;
  /** Asked before each dial. The service lets the owner choose the rule. */
  allowDial(address: PeerAddress, service: RendezvousService): Promise<boolean>;
  /** Opens the connection. Tests replace it. */
  open?: typeof openPeerLink;
};

type Offer = {
  cookie: bigint;
  /** The name of the peer as the messages to it carry it. */
  peer: string;
  ident: string;
  service: RendezvousService;
  role: 'offering' | 'receiving';
  phase: 'waiting' | 'meeting';
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Receiving: it settles when the offerer showed the cookie, or when the connection ended. */
  paired: Promise<void> | null;
  settle(result: PeerLink | RendezvousEnd): void;
};

export function rendezvousEnded(result: PeerLink | RendezvousEnd): result is RendezvousEnd {
  return 'outcome' in result;
}

// Sequence 1 of an offer. A file service needs the file, and Direct IM takes none.
function firstProposal(to: string, cookie: bigint, service: RendezvousService, file: FileDescription | null): Uint8Array {
  if (service === 'send-file' && file) return encodeFileProposal(cookie, to, { sequence: 1, address: PLACEHOLDER_ADDRESS, file });
  if (service === 'direct-im' && !file) return encodeDirectImProposal(cookie, to, { sequence: 1, address: PLACEHOLDER_ADDRESS });
  if (service === 'get-file' && !file) return encodeGetFileProposal(cookie, to, { sequence: 1, address: PLACEHOLDER_ADDRESS });
  throw new RangeError(file ? `the service ${service} takes no file` : `the service ${service} needs a file`);
}

/** One state machine for each offer, by cookie. It meets the peer at the address a rendezvous message names. */
export class Rendezvous {
  private readonly offers = new Map<bigint, Offer>();
  private readonly links = new Set<PeerLink>();
  // Each meeting with the relay starts when the meeting before it has ended.
  private dials: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RendezvousDeps) {}

  /** Offering: sends sequence 1 and resolves when the peer is met or the offer ends. `file` is null for a service with no file block. */
  offer(to: string, cookie: bigint, service: RendezvousService, file: FileDescription | null): Promise<PeerLink | RendezvousEnd> {
    let body: Uint8Array;
    try {
      body = firstProposal(to, cookie, service, file);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.begin(to, cookie, service, 'offering', (offer) => {
      offer.timer = this.deps.timers.setTimeout(() => this.expired(offer), OFFER_ACCEPT_MS);
      // An error of the server tells that the peer is not there to answer.
      const refused = (): void => {
        if (offer.phase === 'waiting') this.end(offer, 'failed', 'server');
      };
      const { propose } = this.deps;
      void this.say(offer, body, propose && ((bytes) => propose(bytes, refused))).then((sent) => {
        if (!sent) this.end(offer, 'failed', 'server');
      });
    });
  }

  /**
   * Receiving: Accept first, then the dial. The relay pairs connections by address, oldest offer first.
   * Thus the next meeting waits for `paired`: the caller settles it when the offerer showed the cookie or the connection ended.
   */
  accept(proposal: RendezvousMessage, paired?: Promise<void>): Promise<PeerLink | RendezvousEnd> {
    return this.begin(proposal.fromDisplay, proposal.cookie, proposal.service, 'receiving', (offer) => {
      offer.paired = paired ?? null;
      this.meet(offer, proposal.address);
    });
  }

  /** Sends a cancel with the declined reason. */
  decline(proposal: RendezvousMessage): Promise<void> {
    return this.deps.send(encodeRendezvousCancel(proposal.cookie, proposal.fromDisplay, proposal.service, RDV_CANCEL_DECLINED));
  }

  /** Ends an offer that did not meet the peer yet, and tells the peer. */
  async cancel(cookie: bigint): Promise<void> {
    const offer = this.offers.get(cookie);
    if (!offer) return;
    const told = this.say(offer, encodeRendezvousCancel(offer.cookie, offer.peer, offer.service, RDV_CANCEL_DECLINED));
    this.end(offer, 'cancelled', 'self');
    await told;
  }

  /** Takes each parsed message. It ignores a message for a cookie it does not hold. */
  heard(message: RendezvousMessage): void {
    const offer = this.offers.get(message.cookie);
    if (!offer || offer.ident !== message.from) {
      this.deps.log.debug('ignored a rendezvous message for no offer of this session', { type: message.type });
      return;
    }
    if (message.type === 'cancel') {
      if (message.cancelReason === RDV_CANCEL_TIMEOUT) this.end(offer, 'timed-out', 'peer');
      else if (offer.role === 'offering' && offer.phase === 'waiting' && message.cancelReason === RDV_CANCEL_DECLINED) this.end(offer, 'declined', 'peer');
      else this.end(offer, 'cancelled', 'peer');
      return;
    }
    if (message.type === 'propose' && message.sequence === 2 && offer.role === 'offering' && offer.phase === 'waiting') {
      this.meet(offer, message.address);
      return;
    }
    this.deps.log.debug('ignored a rendezvous message that does not fit the offer', { type: message.type, role: offer.role, phase: offer.phase });
  }

  /** Takes the client error of the peer for a cookie. */
  refused(cookie: bigint): void {
    const offer = this.offers.get(cookie);
    if (offer) this.end(offer, offer.role === 'offering' ? 'declined' : 'cancelled', 'peer');
  }

  /** Sign-off: each offer ends 'cancelled' by 'self' and each connection closes. Nothing is sent. */
  reset(): void {
    for (const offer of [...this.offers.values()]) this.end(offer, 'cancelled', 'self');
    for (const link of this.links) link.close();
    this.links.clear();
  }

  private begin(
    peer: string,
    cookie: bigint,
    service: RendezvousService,
    role: Offer['role'],
    start: (offer: Offer) => void,
  ): Promise<PeerLink | RendezvousEnd> {
    if (this.offers.has(cookie)) {
      this.deps.log.warn('refused a rendezvous whose cookie is in use', { service, role });
      return Promise.resolve({ outcome: 'failed', by: 'self' });
    }
    return new Promise((settle) => {
      const offer: Offer = {
        cookie, peer, ident: normalizeScreenName(peer), service, role, phase: 'waiting', startedAt: this.deps.now(), timer: null, paired: null, settle,
      };
      this.offers.set(cookie, offer);
      start(offer);
    });
  }

  private live(offer: Offer): boolean {
    return this.offers.get(offer.cookie) === offer;
  }

  private meet(offer: Offer, address: PeerAddress | null): void {
    offer.phase = 'meeting';
    this.unarm(offer);
    this.dialFor(offer, address).catch((error: unknown) => {
      this.deps.log.warn('a rendezvous failed', { service: offer.service, error: error instanceof Error ? error.name : typeof error });
      this.end(offer, 'failed', 'self');
    });
  }

  private async dialFor(offer: Offer, address: PeerAddress | null): Promise<void> {
    const accept = encodeRendezvousAccept(offer.cookie, offer.peer, offer.service);
    if (!address) {
      this.tellCancel(offer, RDV_CANCEL_DECLINED);
      this.end(offer, 'failed', 'peer');
      return;
    }
    const allowed = await this.allowed(address, offer.service);
    if (!this.live(offer)) return;
    if (!allowed) {
      this.tellCancel(offer, RDV_CANCEL_DECLINED);
      this.end(offer, 'refused-address', 'self');
      return;
    }
    // The relay gives a silent connection to its owner only after the Accept of that owner.
    const link = await this.dial(offer, address, offer.role === 'receiving' ? accept : null);
    if (!this.live(offer)) {
      if (link !== 'unsent') link?.close();
      return;
    }
    if (link === 'unsent') {
      this.end(offer, 'failed', 'server');
      return;
    }
    if (!link) {
      this.tellCancel(offer, RDV_CANCEL_DECLINED);
      this.end(offer, 'failed', 'server');
      return;
    }
    if (offer.role === 'offering' && !(await this.say(offer, accept))) {
      link.close();
      this.end(offer, 'failed', 'server');
      return;
    }
    if (!this.live(offer)) {
      link.close();
      return;
    }
    this.connected(offer, link);
  }

  private async allowed(address: PeerAddress, service: RendezvousService): Promise<boolean> {
    try {
      return await this.deps.allowDial(address, service);
    } catch (error) {
      this.deps.log.warn('the dial rule failed', { error: error instanceof Error ? error.name : typeof error });
      return false;
    }
  }

  // The result is null when the offer ended before its turn, and when the connection did not open. It is 'unsent' when `first` did not go out.
  private dial(offer: Offer, address: PeerAddress, first: Uint8Array | null): Promise<PeerLink | 'unsent' | null> {
    const { log, timers } = this.deps;
    const open = this.deps.open ?? openPeerLink;
    const turn = this.dials.then(async () => {
      if (!this.live(offer)) return null;
      if (first && !(await this.say(offer, first))) return 'unsent';
      if (!this.live(offer)) return null;
      try {
        return await open({ host: address.ip, port: address.port, log, timers });
      } catch (error) {
        log.info('a rendezvous connection did not open', { service: offer.service, error: error instanceof Error ? error.name : typeof error });
        return null;
      }
    });
    // A recipient that waits alone at the relay takes the next connection from its address.
    this.dials = turn.then((link) => (link && link !== 'unsent' && offer.paired ? this.untilPaired(offer.paired) : undefined));
    return turn;
  }

  // The relay closes a recipient that waits alone after this time. The next meeting does not wait longer.
  private untilPaired(paired: Promise<void>): Promise<void> {
    const { timers } = this.deps;
    return new Promise((resolve) => {
      const timer = timers.setTimeout(resolve, COUNTER_DIAL_MS);
      const done = (): void => {
        timers.clearTimeout(timer);
        resolve();
      };
      paired.then(done, done);
    });
  }

  private connected(offer: Offer, link: PeerLink): void {
    this.offers.delete(offer.cookie);
    for (const old of this.links) if (old.closed) this.links.delete(old);
    this.links.add(link);
    this.deps.log.info('a rendezvous met the peer', { service: offer.service, role: offer.role, waitedMs: this.deps.now() - offer.startedAt });
    offer.settle(link);
  }

  private end(offer: Offer, outcome: RendezvousEnd['outcome'], by: RendezvousEnd['by']): void {
    if (!this.live(offer)) return;
    this.offers.delete(offer.cookie);
    this.unarm(offer);
    this.deps.log.info('a rendezvous ended', { service: offer.service, role: offer.role, outcome, by, waitedMs: this.deps.now() - offer.startedAt });
    offer.settle({ outcome, by });
  }

  private expired(offer: Offer): void {
    offer.timer = null;
    if (!this.live(offer)) return;
    this.tellCancel(offer, RDV_CANCEL_TIMEOUT);
    this.end(offer, 'timed-out', 'self');
  }

  private unarm(offer: Offer): void {
    if (offer.timer) this.deps.timers.clearTimeout(offer.timer);
    offer.timer = null;
  }

  private tellCancel(offer: Offer, reason: number): void {
    void this.say(offer, encodeRendezvousCancel(offer.cookie, offer.peer, offer.service, reason));
  }

  // The result is false when the link refused the message.
  private async say(offer: Offer, body: Uint8Array, send?: (body: Uint8Array) => Promise<void>): Promise<boolean> {
    try {
      await (send ? send(body) : this.deps.send(body));
      return true;
    } catch (error) {
      this.deps.log.warn('a rendezvous message was not sent', { service: offer.service, error: error instanceof Error ? error.name : typeof error });
      return false;
    }
  }
}
