import net from 'node:net';
import { COUNTER_DIAL_MS, OFFER_ACCEPT_MS } from '../../src/client/rendezvous.js';
import {
  CAP_DIRECT_IM, CAP_GET_FILE, CAP_SEND_FILE, RDV_FRAGMENT_MIN_BYTES, RDV_TLV_IP_XOR, RDV_TLV_PORT, RDV_TLV_PORT_XOR, RDV_TLV_RDV_IP,
  RDV_TLV_REQUESTER_IP, RDV_TLV_SEQUENCE, RDV_TLV_USE_PROXY, RDV_TLV_VERIFIED_IP, RDV_TYPE_ACCEPT, RDV_TYPE_CANCEL, RDV_TYPE_PROPOSE,
} from '../../src/wire/constants.js';
import { rendezvousHead, tolerantTlvs } from '../../src/wire/icbm.js';
import { encodeTlvs, hasTlv, tlv, tlvU16 } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { TimerApi } from '../../src/wire/types.js';

/** server/relay/server.go Route: a connection that sends nothing is routed after this wait. */
export const RELAY_SILENCE_MS = 500;
// server/relay/server.go evenWriteWait: the longest wait for the byte that makes a file write even.
const EVEN_WRITE_WAIT_MS = 100;
const FLAP_START = 0x2a;
// server/oscar/server.go routeConnection: the sign-on service speaks first, with its version on channel 1.
const SIGN_ON_HELLO = Uint8Array.from([FLAP_START, 0x01, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01]);
// server/relay/broker.go relayedCaps.
const RELAYED = [CAP_DIRECT_IM, CAP_SEND_FILE, CAP_GET_FILE];
const REMOVED = [RDV_TLV_RDV_IP, RDV_TLV_IP_XOR, RDV_TLV_PORT_XOR];

export type Relayed = { cookie: bigint; bytesToOfferer: number; bytesToRecipient: number };
export type RelaySender = { instance: unknown; name: string; ip: string };
export type RelayRecipient = { name: string; ips: string[] };
export type CounterOffer = { offerer: unknown; recipient: string; cookie: bigint; fragment: Uint8Array };
export type RelayDeps = {
  host: string;
  timers: TimerApi;
  /** Sends the sequence 2 proposal to the instance that made the offer. */
  counterOffer(offer: CounterOffer): void;
};

type Side = { socket: net.Socket; early: Buffer[]; take(chunk: Buffer): void };
type Arrival = Side & { ip: string; timer: ReturnType<typeof setTimeout> };
type Session = {
  cookie: bigint;
  capability: Buffer;
  offerer: unknown;
  offererIp: string;
  recipient: string;
  recipientIps: string[];
  accepted: boolean;
  first: Side | null;
  paired: boolean;
  abandoned: boolean;
  expiry: ReturnType<typeof setTimeout> | null;
  wait: ReturnType<typeof setTimeout> | null;
};

const addressOf = (socket: net.Socket): string => (socket.remoteAddress ?? '').replace(/^::ffff:/, '');
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** The relay of open-oscar-server (server/relay): it pairs two connections by address and copies bytes between them. */
export class FakeRelay {
  // In order of creation: the oldest session comes first.
  private readonly sessions = new Map<bigint, Session>();
  private readonly arrivals = new Set<Arrival>();
  private readonly sockets = new Set<net.Socket>();
  private readonly waits = new Set<ReturnType<typeof setTimeout>>();
  private readonly done: Relayed[] = [];
  private server: net.Server | null = null;
  private listenPort = 0;

  constructor(private readonly deps: RelayDeps) {}

  get port(): number {
    return this.listenPort;
  }

  listen(): Promise<void> {
    const server = net.createServer((socket) => this.arrived(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, this.deps.host, () => {
        this.listenPort = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const session of this.sessions.values()) this.unarm(session);
    this.sessions.clear();
    for (const arrival of this.arrivals) this.deps.timers.clearTimeout(arrival.timer);
    this.arrivals.clear();
    for (const wait of this.waits) clearTimeout(wait);
    this.waits.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return new Promise((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  }

  /** Each pair the relay joined, in order. The counts grow while the pair is open. */
  relayed(): Relayed[] {
    return this.done.map((entry) => ({ ...entry }));
  }

  /** The cookie of each session that waits for a side or copies bytes. */
  waiting(): bigint[] {
    return [...this.sessions.keys()];
  }

  /**
   * One rendezvous fragment on its way to the recipient. The result is the fragment to pass on, or 'held' for an Accept the relay keeps
   * (foodgroup/icbm.go rendezvousTLV).
   */
  route(from: RelaySender, to: RelayRecipient, fragment: Uint8Array): Uint8Array | 'held' {
    const f = Buffer.from(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    const type = f.readUInt16BE(0);
    const cookie = f.readBigUInt64BE(2);
    const capability = f.subarray(10, RDV_FRAGMENT_MIN_BYTES);
    const tlvs = tolerantTlvs(f.subarray(RDV_FRAGMENT_MIN_BYTES));
    const held = this.sessions.get(cookie);
    // broker.go HoldRendezvous: the Accept only says that the recipient reached the server.
    if (type === RDV_TYPE_ACCEPT && held && held.recipient === from.name) {
      held.accepted = true;
      for (const arrival of [...this.arrivals]) this.place(arrival);
      return 'held';
    }
    if (type === RDV_TYPE_CANCEL) {
      this.refuse(cookie);
      return fragment;
    }
    const relayed = RELAYED.some((cap) => same(cap, capability));
    if (type !== RDV_TYPE_PROPOSE || !relayed || hasTlv(tlvs, RDV_TLV_USE_PROXY) || tlvU16(tlvs, RDV_TLV_SEQUENCE) !== 1 || held) return fragment;
    const session: Session = {
      cookie, capability: Buffer.from(capability), offerer: from.instance, offererIp: from.ip, recipient: to.name, recipientIps: to.ips,
      accepted: false, first: null, paired: false, abandoned: false, expiry: null, wait: null,
    };
    // session.go expire: a session that no recipient reached ends after the accept wait.
    session.expiry = this.deps.timers.setTimeout(() => {
      session.expiry = null;
      if (!session.first) this.forget(session);
    }, OFFER_ACCEPT_MS);
    this.sessions.set(cookie, session);
    return new Uint8Array(Buffer.concat([f.subarray(0, RDV_FRAGMENT_MIN_BYTES), encodeTlvs(this.addressed(tlvs))]));
  }

  /** A cancel from either side, or a client error from the recipient: the session ends (broker.go RefuseRendezvous). */
  refuse(cookie: bigint): void {
    const session = this.sessions.get(cookie);
    if (!session) return;
    this.forget(session);
    // A pair that copies bytes stays open. A recipient that waits alone is closed.
    if (session.first && !session.paired) this.abandon(session);
  }

  // broker.go setAddress: the address of the server takes the place of each address of the client.
  private addressed(tlvs: readonly Tlv[]): Tlv[] {
    const ip = Uint8Array.from(this.deps.host.split('.').map(Number));
    const out = tlvs.filter((t) => !REMOVED.includes(t.tag));
    for (const fresh of [tlv.bytes(RDV_TLV_REQUESTER_IP, ip), tlv.bytes(RDV_TLV_VERIFIED_IP, ip), tlv.u16(RDV_TLV_PORT, this.port)]) {
      const at = out.map((t, i) => (t.tag === fresh.tag ? i : -1)).filter((i) => i >= 0);
      for (const i of at) out[i] = fresh;
      if (at.length === 0) out.push(fresh);
    }
    return out;
  }

  private arrived(socket: net.Socket): void {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    const arrival: Arrival = {
      socket,
      early: [],
      ip: addressOf(socket),
      take: (chunk) => {
        arrival.early.push(chunk);
        this.place(arrival);
      },
      // After the wait a silent connection belongs to the sign-on service.
      timer: this.deps.timers.setTimeout(() => this.turnAway(arrival), RELAY_SILENCE_MS),
    };
    this.arrivals.add(arrival);
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => arrival.take(chunk));
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.settled(arrival);
    });
    this.place(arrival);
  }

  private settled(arrival: Arrival): void {
    this.deps.timers.clearTimeout(arrival.timer);
    this.arrivals.delete(arrival);
  }

  // server.go RouteFirstBytes: the sign-on service takes each connection the relay does not wait for. Here it says hello and no more.
  private turnAway(arrival: Arrival): void {
    this.settled(arrival);
    arrival.take = () => arrival.socket.destroy();
    if (arrival.early.length > 0) arrival.socket.destroy();
    else arrival.socket.write(SIGN_ON_HELLO);
  }

  // server.go Route: silence counts only when the owner of the connection was told to dial.
  private place(arrival: Arrival): void {
    if (!this.arrivals.has(arrival)) return;
    const spoke = arrival.early.length > 0;
    if (spoke && arrival.early[0]?.[0] === FLAP_START) {
      this.turnAway(arrival);
      return;
    }
    const session = this.find(arrival.ip, !spoke);
    if (session) {
      this.settled(arrival);
      this.meet(session, arrival);
    } else if (spoke) this.turnAway(arrival);
  }

  // session.go awaits and find: the oldest session whose next side dials from this address.
  private find(ip: string, ready: boolean): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.abandoned || session.paired) continue;
      if (session.first ? session.offererIp === ip : session.recipientIps.includes(ip) && (session.accepted || !ready)) return session;
    }
    return undefined;
  }

  // server.go meet: the recipient comes first and waits, then the offerer opens the pipe.
  private meet(session: Session, side: Side): void {
    const first = session.first;
    if (first) {
      session.paired = true;
      this.unarm(session);
      this.pipe(session, first, side);
      return;
    }
    session.first = side;
    this.unarm(session);
    // The recipient keeps the bytes it sends before the offerer comes.
    side.take = (chunk) => side.early.push(chunk);
    side.socket.once('close', () => {
      if (!session.paired) this.abandon(session);
    });
    session.wait = this.deps.timers.setTimeout(() => {
      session.wait = null;
      this.abandon(session);
    }, COUNTER_DIAL_MS);
    const fragment = rendezvousHead(RDV_TYPE_PROPOSE, session.cookie, session.capability)
      .bytes(encodeTlvs(this.addressed([tlv.u16(RDV_TLV_SEQUENCE, 2)])))
      .toBytes();
    this.deps.counterOffer({ offerer: session.offerer, recipient: session.recipient, cookie: session.cookie, fragment });
  }

  private unarm(session: Session): void {
    if (session.expiry) this.deps.timers.clearTimeout(session.expiry);
    if (session.wait) this.deps.timers.clearTimeout(session.wait);
    session.expiry = null;
    session.wait = null;
  }

  private forget(session: Session): void {
    this.unarm(session);
    if (this.sessions.get(session.cookie) === session) this.sessions.delete(session.cookie);
  }

  // session.go abandon: the side that waited is gone, and no second side can join.
  private abandon(session: Session): void {
    session.abandoned = true;
    this.forget(session);
    session.first?.socket.destroy();
  }

  // server.go relay: bytes go each way until one side closes, then the two sides close.
  private pipe(session: Session, recipient: Side, offerer: Side): void {
    const record: Relayed = { cookie: session.cookie, bytesToOfferer: 0, bytesToRecipient: 0 };
    this.done.push(record);
    const even = !same(session.capability, CAP_DIRECT_IM);
    const flushes = [
      this.copy(recipient, offerer, even, (n) => (record.bytesToOfferer += n)),
      this.copy(offerer, recipient, even, (n) => (record.bytesToRecipient += n)),
    ];
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      for (const flush of flushes) flush();
      for (const side of [recipient, offerer]) side.socket.end(() => side.socket.destroy());
      this.forget(session);
    };
    for (const side of [recipient, offerer]) {
      side.socket.once('end', close);
      side.socket.once('close', close);
      if (side.socket.destroyed || side.socket.readableEnded) close();
    }
  }

  // server.go copyEven: file bytes go out in writes of even size. The result writes a byte that is held.
  private copy(from: Side, to: Side, even: boolean, count: (n: number) => void): () => void {
    let carry: Buffer | null = null;
    let wait: ReturnType<typeof setTimeout> | null = null;
    const write = (data: Buffer): void => {
      if (data.length === 0 || to.socket.destroyed || to.socket.writableEnded) return;
      count(data.length);
      if (to.socket.write(data)) return;
      from.socket.pause();
      to.socket.once('drain', () => from.socket.resume());
    };
    const flush = (): void => {
      if (wait) {
        clearTimeout(wait);
        this.waits.delete(wait);
      }
      wait = null;
      if (carry) write(carry);
      carry = null;
    };
    from.take = (chunk) => {
      const data = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      flush();
      const whole = even ? data.length - (data.length % 2) : data.length;
      write(data.subarray(0, whole));
      if (whole === data.length) return;
      carry = data.subarray(whole);
      // The wait is real time, also under a manual clock: it paces writes and is no part of the protocol.
      wait = setTimeout(flush, EVEN_WRITE_WAIT_MS);
      this.waits.add(wait);
    };
    for (const chunk of from.early.splice(0)) from.take(chunk);
    return flush;
  }
}
