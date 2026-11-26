import { describe, expect, it } from 'vitest';
import { CANCEL_AFTER_CLOSE_MS, CROSSED_OFFER_MS, DirectIm } from '../../../src/client/direct-im.js';
import type { DirectImDeps } from '../../../src/client/direct-im.js';
import { OscarClient } from '../../../src/client/oscar-client.js';
import { PeerClosedError } from '../../../src/client/peer-link.js';
import type { PeerLink } from '../../../src/client/peer-link.js';
import { OFFER_ACCEPT_MS, Rendezvous } from '../../../src/client/rendezvous.js';
import { MAX_WAITING_OFFERS } from '../../../src/client/transfers.js';
import { ByteReader, ByteWriter } from '../../../src/wire/bytes.js';
import {
  CAP_DIRECT_IM, DIRECT_IM_MAX_ATTACHMENTS, DIRECT_IM_MAX_MESSAGE_BYTES, DIRECT_IM_MAX_SESSION_BYTES, DIRECT_IM_MAX_TEXT_BYTES, FAMILY_ICBM, ICBM_CHANNEL_RENDEZVOUS, ICBM_CLIENT_ERR, ICBM_MSG_TO_CLIENT,
  ICBM_TLV_RENDEZVOUS, ODC_FLAG_HELLO, RDV_CANCEL_DECLINED, RDV_CANCEL_ELSEWHERE, RDV_CANCEL_TIMEOUT, RDV_TLV_SEQUENCE, RDV_TLV_USE_PROXY,
  RDV_TYPE_PROPOSE,
} from '../../../src/wire/constants.js';
import { encodeRendezvousToHost, rendezvousHead } from '../../../src/wire/icbm.js';
import { encodeOdcHeader } from '../../../src/wire/odc.js';
import { encodeDirectImProposal, encodeFileProposal, encodeRendezvousAccept, encodeRendezvousCancel } from '../../../src/wire/rendezvous.js';
import type { PeerAddress } from '../../../src/wire/rendezvous.js';
import type { Snac } from '../../../src/wire/snac.js';
import { encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import type { Tlv } from '../../../src/wire/tlv.js';
import type { DirectImOffer, DirectImStatus, DirectMessage, OutgoingDirectMessage } from '../../../src/model/direct-im.js';
import { ManualTimers, captureLog, tick } from '../../fake/oscar-client.js';

const ID = 'bob:0000000000000001';

describe('Direct IM calls on a client that never signed on', () => {
  const calls: [string, (client: OscarClient) => Promise<unknown>][] = [
    ['openDirectIm', (client) => client.openDirectIm('Bob')],
    ['acceptDirectIm', (client) => client.acceptDirectIm(ID)],
    ['declineDirectIm', (client) => client.declineDirectIm(ID)],
    ['closeDirectIm', (client) => client.closeDirectIm(ID)],
    ['sendDirectMessage', (client) => client.sendDirectMessage(ID, { pictures: [] })],
  ];

  it.each(calls)('%s rejects not-signed-on', async (_name, call) => {
    const client = new OscarClient({ directIm: {} });
    await expect(call(client)).rejects.toMatchObject({ name: 'OscarError', info: { kind: 'not-signed-on' } });
  });
});

const COOKIE = 0x0102030405060708n;
const OFFER = 'alice:0102030405060708';
const ADDRESS: PeerAddress = { ip: '192.0.2.7', port: 5190 };
const INVALID = { name: 'OscarError', info: { kind: 'local', code: 'invalid-argument' } };
// The first bytes of the sign-on service: a FLAP frame on channel 1 with the version.
const SIGN_ON_HELLO = Uint8Array.from([0x2a, 0x01, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01]);

// A connection that gives the bytes the test feeds it.
class ScriptLink implements PeerLink {
  readonly written: Uint8Array[] = [];
  closed = false;
  private held = new Uint8Array(0);
  private wake: (() => void) | null = null;
  private ended = false;

  feed(bytes: Uint8Array): void {
    this.held = Uint8Array.from([...this.held, ...bytes]);
    this.wake?.();
  }

  /** The peer closes. */
  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new PeerClosedError();
    this.written.push(bytes.slice());
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.held.length < n) {
      if (this.ended || this.closed) throw new PeerClosedError();
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    const out = this.held.slice(0, n);
    this.held = this.held.slice(n);
    return out;
  }

  async readSome(max: number): Promise<Uint8Array | null> {
    return this.read(Math.min(max, Math.max(1, this.held.length)));
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }
}

type Rig = {
  d: DirectIm;
  rendezvous: Rendezvous;
  timers: ManualTimers;
  sent: Uint8Array[];
  offers: DirectImOffer[];
  statuses: DirectImStatus[];
  messages: DirectMessage[];
  typings: { from: string; typing: boolean }[];
  link: ScriptLink;
  opened: number;
  blocked: Set<string>;
};

function rig(over: Partial<DirectImDeps> = {}): Rig {
  const timers = new ManualTimers();
  const log = captureLog().log;
  const send = async (body: Uint8Array): Promise<void> => {
    one.sent.push(body);
  };
  const rendezvous = new Rendezvous({
    log,
    now: timers.now,
    timers: timers.api,
    send,
    allowDial: async () => true,
    open: async () => {
      one.opened++;
      return one.link;
    },
  });
  const one: Rig = {
    d: undefined as unknown as DirectIm, rendezvous, timers, sent: [], offers: [], statuses: [], messages: [], typings: [], link: new ScriptLink(),
    opened: 0, blocked: new Set(),
  };
  one.d = new DirectIm({
    log,
    now: timers.now,
    timers: timers.api,
    enabled: () => true,
    rendezvous,
    self: () => 'Bob',
    send,
    isBlocked: (name) => one.blocked.has(name.toLowerCase()),
    allowOffer: () => true,
    maxMessageBytes: DIRECT_IM_MAX_MESSAGE_BYTES,
    maxAttachments: DIRECT_IM_MAX_ATTACHMENTS,
    maxTextBytes: DIRECT_IM_MAX_TEXT_BYTES,
    maxSessionBytes: DIRECT_IM_MAX_SESSION_BYTES,
    sendUnverifiedAfterMs: null,
    emitOffer: (offer) => one.offers.push(offer),
    emitStatus: (status) => one.statuses.push(status),
    emitMessage: (message) => one.messages.push(message),
    emitTyping: (typing) => one.typings.push(typing),
    cookie: () => COOKIE,
    ...over,
  });
  return one;
}

// The body the server gives the recipient for a body a client sent.
function toClient(host: Uint8Array, from: string): Snac {
  const r = new ByteReader(host);
  const cookie = r.u64();
  const channel = r.u16();
  r.str8();
  const body = new ByteWriter().u64(cookie).u16(channel).str8(from).u16(0).u16(0).bytes(r.rest()).toBytes();
  return { family: FAMILY_ICBM, subtype: ICBM_MSG_TO_CLIENT, flags: 0, requestId: 0, body };
}

function proposal(over: { cookie?: bigint; from?: string; sequence?: 1 | 2; address?: PeerAddress } = {}): Snac {
  const body = encodeDirectImProposal(over.cookie ?? COOKIE, 'Bob', { sequence: over.sequence ?? 1, address: over.address ?? ADDRESS });
  return toClient(body, over.from ?? 'Alice');
}

// A proposal with other tags in its fragment in place of the address.
function oddProposal(tlvs: Tlv[]): Snac {
  const fragment = rendezvousHead(RDV_TYPE_PROPOSE, COOKIE, CAP_DIRECT_IM).bytes(encodeTlvs(tlvs)).toBytes();
  return toClient(encodeRendezvousToHost(COOKIE, 'Bob', [tlv.bytes(ICBM_TLV_RENDEZVOUS, fragment)]), 'Alice');
}

const cancelFrom = (from: string, reason: number, cookie = COOKIE): Snac => toClient(encodeRendezvousCancel(cookie, 'Bob', 'direct-im', reason), from);
const cancelTo = (to: string, cookie = COOKIE): Uint8Array => encodeRendezvousCancel(cookie, to, 'direct-im', RDV_CANCEL_DECLINED);
const clientError = (from: string, cookie = COOKIE): Snac => ({
  family: FAMILY_ICBM, subtype: ICBM_CLIENT_ERR, flags: 0, requestId: 0,
  body: new ByteWriter().u64(cookie).u16(ICBM_CHANNEL_RENDEZVOUS).str8(from).u16(3).toBytes(),
});
const hello = (cookie = COOKIE): Uint8Array => encodeOdcHeader({ cookie, payloadBytes: 0, encoding: 0, flags: ODC_FLAG_HELLO, screenName: 'Alice' });
const last = (r: Rig): DirectImStatus | undefined => r.statuses.at(-1);
const trail = (r: Rig): string[] => r.statuses.map((s) => s.end ?? (s.verified ? `${s.state}+cookie` : s.state));
const picture: OutgoingDirectMessage = { pictures: [{ name: 'a.png', bytes: new Uint8Array(4), width: 1, height: 1 }] };

// The offer of Alice is accepted and the connection is open.
async function accepted(r: Rig): Promise<void> {
  expect(r.d.handle(proposal())).toBe(true);
  r.d.accept(OFFER);
  await tick();
  expect(r.opened).toBe(1);
  expect(trail(r)).toEqual(['connecting', 'open']);
}

// The offer of this client is accepted and the connection is open.
async function offering(r: Rig): Promise<string> {
  const id = r.d.open('Alice');
  await tick();
  expect(r.d.handle(proposal({ sequence: 2 }))).toBe(true);
  await tick();
  expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
  return id;
}

describe('a Direct IM proposal the client hears', () => {
  it('a proposal that allowOffer refuses emits nothing, sends nothing and takes no place', async () => {
    const asked: string[] = [];
    const r = rig({
      allowOffer: (from) => {
        asked.push(from);
        return !from.startsWith('Mallory');
      },
    });
    // A second and a third offer of one name, then an offer with no address and an offer with sequence 2.
    for (const cookie of [1n, 2n, 3n]) expect(r.d.handle(proposal({ from: 'Mallory', cookie }))).toBe(true);
    expect(r.d.handle(proposal({ from: 'Mallory', cookie: 4n, address: { ip: '0.0.0.0', port: 5190 } }))).toBe(true);
    expect(r.d.handle(proposal({ from: 'Mallory', cookie: 5n, sequence: 2 }))).toBe(true);
    for (let i = 0; i < MAX_WAITING_OFFERS + 4; i++) r.d.handle(proposal({ from: `Mallory${i}`, cookie: BigInt(100 + i) }));
    await tick();
    expect(r.offers).toEqual([]);
    expect(r.statuses).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(() => r.d.accept('mallory:0000000000000001')).toThrow(expect.objectContaining(INVALID));
    // The offers of allowed names still have each place.
    for (let i = 0; i < MAX_WAITING_OFFERS; i++) r.d.handle(proposal({ from: `Peer${i}`, cookie: BigInt(i + 1) }));
    await tick();
    expect(r.offers).toHaveLength(MAX_WAITING_OFFERS);
    expect(r.sent).toEqual([]);
    expect(asked).toContain('Mallory');
    expect(asked).toContain('Peer0');
  });

  it('a blocked name is not shown to allowOffer', () => {
    const asked: string[] = [];
    const r = rig({
      allowOffer: (from) => {
        asked.push(from);
        return true;
      },
    });
    r.blocked.add('alice');
    r.d.handle(proposal());
    expect(asked).toEqual([]);
  });

  it('a rule that throws drops the offer: nothing is sent, nothing is shown, and the next offer is heard', async () => {
    const captured = captureLog();
    let fail = true;
    const r = rig({
      log: captured.log,
      allowOffer: () => {
        if (fail) throw new Error('the list of Cathy is gone');
        return true;
      },
    });
    expect(r.d.handle(proposal())).toBe(true);
    expect(r.d.handle(proposal({ cookie: 9n, sequence: 2 }))).toBe(true);
    await tick();
    expect([r.offers, r.statuses, r.sent, r.timers.pending()]).toEqual([[], [], [], []]);
    const warned = captured.lines.filter((l) => l.level === 'warn');
    expect(warned.map((l) => [l.msg, l.fields])).toEqual(Array(2).fill(['the rule for direct im offers threw, and the offer is dropped', { error: 'Error' }]));
    expect(captured.text()).not.toContain('Cathy');
    fail = false;
    r.d.handle(proposal());
    expect(r.offers.map((o) => o.id)).toEqual([OFFER]);
  });

  it.each([
    ['a promise', (): unknown => Promise.resolve(true)],
    ['a number', (): unknown => 1],
    ['a string', (): unknown => 'yes'],
    ['nothing', (): unknown => undefined],
  ])('a rule that gives %s, not true, drops the offer', async (_name, answer) => {
    const captured = captureLog();
    const r = rig({ log: captured.log, allowOffer: answer as () => boolean });
    expect(r.d.handle(proposal())).toBe(true);
    await tick();
    expect([r.offers, r.statuses, r.sent, r.timers.pending()]).toEqual([[], [], [], []]);
    expect(captured.lines.filter((l) => l.level === 'warn').map((l) => l.msg)).toEqual(['the rule for direct im offers gave a value that is not true or false, and the offer is dropped']);
  });

  it('a dropped offer leaves nothing: a cancel for it has no effect, and the same cookie is a new offer when the rule allows it', async () => {
    let allow = false;
    const asked: string[] = [];
    const r = rig({
      allowOffer: (from) => {
        asked.push(from);
        return allow;
      },
    });
    r.d.handle(proposal());
    expect(r.timers.pending()).toEqual([]);
    expect(r.d.handle(cancelFrom('Alice', RDV_CANCEL_DECLINED))).toBe(true);
    await r.d.decline(OFFER);
    await r.d.close(OFFER);
    await tick();
    expect([r.offers, r.statuses, r.sent]).toEqual([[], [], []]);
    // The cancel is not an offer, thus the rule is not asked for it.
    expect(asked).toEqual(['Alice']);
    allow = true;
    r.d.handle(proposal());
    expect(r.offers.map((o) => o.id)).toEqual([OFFER]);
    expect(r.sent).toEqual([]);
  });

  it('an offer that waits stays when the rule drops the next offer of that name: no cancel goes for one or the other', async () => {
    let allow = true;
    const r = rig({ allowOffer: () => allow });
    r.d.handle(proposal());
    allow = false;
    r.d.handle(proposal({ cookie: 2n }));
    await tick();
    expect(r.offers.map((o) => o.id)).toEqual([OFFER]);
    expect([r.statuses, r.sent]).toEqual([[], []]);
    // The offer that waits has its timer, and the client can accept it.
    expect(r.timers.pending()).toEqual([OFFER_ACCEPT_MS]);
    r.d.accept(OFFER);
    await tick();
    expect(trail(r)).toEqual(['connecting', 'open']);
  });

  it('the rule is asked for an offer that crosses the offer of this client, and a dropped offer leaves the offer of this client as it is', async () => {
    const asked: string[] = [];
    const r = rig({
      self: () => 'Zed',
      allowOffer: (from) => {
        asked.push(from);
        return false;
      },
    });
    r.d.open('Alice');
    await tick();
    const before = r.sent.length;
    // Alice sorts before Zed, thus the offer of Alice is the offer that stays for two crossed offers.
    expect(r.d.handle(proposal({ cookie: 2n }))).toBe(true);
    await tick();
    expect(asked).toEqual(['Alice']);
    expect(r.sent).toHaveLength(before);
    // The offer of this client still waits for Alice.
    expect([r.offers, trail(r)]).toEqual([[], ['waiting']]);
  });

  it('a proposal from a blocked name emits nothing and sends nothing', async () => {
    const r = rig();
    r.blocked.add('alice');
    expect(r.d.handle(proposal())).toBe(true);
    await tick();
    expect(r.offers).toEqual([]);
    expect(r.statuses).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(() => r.d.accept(OFFER)).toThrow(expect.objectContaining(INVALID));
  });

  it('a proposal is one offer with the id of the session, and no status', async () => {
    const r = rig();
    expect(r.d.handle(proposal())).toBe(true);
    expect(r.offers).toEqual([{ id: OFFER, from: 'Alice', at: r.timers.now() }]);
    expect(r.statuses).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it.each([
    ['with the proxy tag', oddProposal([tlv.u16(RDV_TLV_SEQUENCE, 1), tlv.empty(RDV_TLV_USE_PROXY)])],
    ['with no address', oddProposal([tlv.u16(RDV_TLV_SEQUENCE, 1)])],
    ['with sequence 2 and no offer of this client', proposal({ sequence: 2 })],
    ['with sequence 3', oddProposal([tlv.u16(RDV_TLV_SEQUENCE, 3)])],
  ])('a proposal %s is answered with a cancel and emits nothing', async (_what, snac) => {
    const r = rig();
    expect(r.d.handle(snac)).toBe(true);
    await tick();
    expect(r.sent).toEqual([cancelTo('Alice')]);
    expect(r.offers).toEqual([]);
    expect(r.statuses).toEqual([]);
  });

  it('a new proposal from a peer whose offer waits ends that offer cancelled by peer, and is a new offer', async () => {
    const r = rig();
    r.d.handle(proposal());
    expect(r.d.handle(proposal({ cookie: 9n }))).toBe(true);
    await tick();
    expect(r.sent).toEqual([cancelTo('Alice')]);
    expect(r.statuses).toEqual([{ id: OFFER, peer: 'Alice', role: 'receiving', state: 'closed', end: 'cancelled', by: 'peer', verified: false }]);
    expect(r.offers.map((offer) => offer.id)).toEqual([OFFER, 'alice:0000000000000009']);
    expect(() => r.d.accept(OFFER)).toThrow(expect.objectContaining(INVALID));
    r.d.accept('alice:0000000000000009');
    await tick();
    expect(r.opened).toBe(1);
    await r.timers.advance(OFFER_ACCEPT_MS);
    expect(trail(r)).toEqual(['cancelled', 'connecting', 'open']);
  });

  it('two offers that cross, the name of the peer sorts first: the session takes the offer of the peer and keeps its id', async () => {
    const r = rig();
    const id = r.d.open('Alice');
    await tick();
    expect(r.d.handle(proposal({ cookie: 9n }))).toBe(true);
    await tick();
    expect(r.offers).toEqual([]);
    expect(r.sent.slice(1)).toEqual(expect.arrayContaining([cancelTo('Alice'), encodeRendezvousAccept(9n, 'Alice', 'direct-im')]));
    expect(r.sent).toHaveLength(3);
    expect(r.opened).toBe(1);
    expect(r.statuses.map((status) => status.id)).toEqual([id, id, id]);
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
    expect(r.link.written).toEqual([encodeOdcHeader({ cookie: 9n, payloadBytes: 0, encoding: 0, flags: ODC_FLAG_HELLO, screenName: 'Bob' })]);
    // The peer cancels the offer that this client let go.
    expect(r.d.handle(cancelFrom('Alice', RDV_CANCEL_DECLINED))).toBe(true);
    r.link.feed(hello(9n));
    await tick();
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open', 'open+cookie']);
    expect(last(r)).toMatchObject({ id, role: 'offering' });
    await r.d.sendMessage(id, picture);
    expect(r.d.open('Alice')).toBe(id);
  });

  it('two offers that cross, the name of this client sorts first: the offer of the peer gets a cancel and the offer of this client stays', async () => {
    const r = rig({ self: () => 'Aaron' });
    r.d.open('Alice');
    await tick();
    expect(r.d.handle(proposal({ cookie: 9n }))).toBe(true);
    await tick();
    expect(r.sent.slice(1)).toEqual([cancelTo('Alice', 9n)]);
    expect(r.offers).toEqual([]);
    expect(trail(r)).toEqual(['waiting']);
    expect(r.d.handle(proposal({ sequence: 2 }))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
  });

  it('a proposal from a peer after the offer of this client waited longer than the crossing time: the session takes it, whatever the names', async () => {
    const r = rig({ self: () => 'Aaron' });
    const id = r.d.open('Alice');
    await r.timers.advance(CROSSED_OFFER_MS + 1);
    expect(r.d.handle(proposal({ cookie: 9n }))).toBe(true);
    await tick();
    expect(r.sent.slice(1)).toEqual(expect.arrayContaining([cancelTo('Alice'), encodeRendezvousAccept(9n, 'Alice', 'direct-im')]));
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
    expect(last(r)?.id).toBe(id);
    // The timer of the offer that the session let go does not end it.
    await r.timers.advance(OFFER_ACCEPT_MS);
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
  });

  it('a proposal from a peer whose offer this client accepted is answered with a cancel', async () => {
    const r = rig();
    await offering(r);
    const before = r.sent.length;
    expect(r.d.handle(proposal({ cookie: 9n }))).toBe(true);
    await tick();
    expect(r.sent.slice(before)).toEqual([cancelTo('Alice', 9n)]);
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
  });

  it('a proposal from a peer with a session open is answered with a cancel', async () => {
    const r = rig();
    await accepted(r);
    const before = r.sent.length;
    expect(r.d.handle(proposal({ cookie: 9n }))).toBe(true);
    await tick();
    expect(r.sent.slice(before)).toEqual([cancelTo('Alice', 9n)]);
    expect(trail(r)).toEqual(['connecting', 'open']);
  });

  it('with Direct IM off, each message is left alone and each command is refused', async () => {
    const r = rig({ enabled: () => false });
    expect(r.d.handle(proposal())).toBe(false);
    expect(r.d.handle(clientError('Alice'))).toBe(false);
    expect(() => r.d.open('Alice')).toThrow(expect.objectContaining(INVALID));
    expect(() => r.d.accept(OFFER)).toThrow(expect.objectContaining(INVALID));
    await tick();
    expect(r.sent).toEqual([]);
    expect(r.offers).toEqual([]);
  });

  it('a session that runs goes on when Direct IM turns off, and a new offer is left alone', async () => {
    let on = true;
    const r = rig({ enabled: () => on });
    r.d.open('Alice');
    await tick();
    on = false;
    expect(r.d.handle(proposal({ sequence: 2 }))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
    const before = r.sent.length;
    expect(r.d.handle(proposal({ from: 'Carol', cookie: 9n }))).toBe(false);
    expect(r.d.handle(clientError('Carol', 9n))).toBe(false);
    await tick();
    expect([r.offers, r.sent.length]).toEqual([[], before]);
    r.link.feed(hello());
    await tick();
    r.link.end();
    await tick();
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open', 'open+cookie', 'peer-closed']);
  });

  it('an offer of this client that waits still hears the decline of the peer when Direct IM turns off', async () => {
    let on = true;
    const r = rig({ enabled: () => on });
    r.d.open('Alice');
    await tick();
    on = false;
    expect(r.d.handle(cancelFrom('Alice', RDV_CANCEL_DECLINED))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['waiting', 'declined']);
    expect(last(r)).toMatchObject({ by: 'peer' });
    // With no session left, each message is left alone.
    expect(r.d.handle(proposal())).toBe(false);
  });

  it('a message of the Send File service and the client error for a cookie of no session are left alone', () => {
    const r = rig();
    const file = encodeFileProposal(COOKIE, 'Bob', { sequence: 1, address: ADDRESS, file: { multiple: false, count: 1, totalBytes: 1, name: 'a' } });
    expect(r.d.handle(toClient(file, 'Alice'))).toBe(false);
    expect(r.d.handle(clientError('Alice'))).toBe(false);
    expect(r.offers).toEqual([]);
  });

  it('past MAX_WAITING_OFFERS offers with no answer, a new offer gets a cancel', async () => {
    const r = rig();
    for (let i = 0; i < MAX_WAITING_OFFERS; i++) r.d.handle(proposal({ from: `Peer${i}`, cookie: BigInt(i + 1) }));
    expect(r.offers).toHaveLength(MAX_WAITING_OFFERS);
    r.d.handle(proposal({ from: 'Late', cookie: 99n }));
    await tick();
    expect(r.offers).toHaveLength(MAX_WAITING_OFFERS);
    expect(r.sent).toEqual([cancelTo('Late', 99n)]);
  });
});

describe('the commands of Direct IM', () => {
  it('sendMessage for an id that is not open rejects invalid-argument', async () => {
    const r = rig();
    await expect(r.d.sendMessage(OFFER, picture)).rejects.toMatchObject(INVALID);
    r.d.handle(proposal());
    await expect(r.d.sendMessage(OFFER, picture)).rejects.toMatchObject(INVALID);
    const waiting = rig();
    const id = waiting.d.open('Alice');
    await expect(waiting.d.sendMessage(id, picture)).rejects.toMatchObject(INVALID);
    expect(r.link.written).toEqual([]);
  });

  it('open for a peer with a session that is live gives its id and sends nothing', async () => {
    const r = rig();
    const id = r.d.open('Alice');
    await tick();
    expect(id).toBe(OFFER);
    expect(r.sent).toHaveLength(1);
    expect(r.d.open('alice')).toBe(id);
    await tick();
    expect(r.sent).toHaveLength(1);
    expect(trail(r)).toEqual(['waiting']);
  });

  it('open for a peer whose offer waits gives the id of that offer', async () => {
    const r = rig();
    r.d.handle(proposal());
    expect(r.d.open('Alice')).toBe(OFFER);
    await tick();
    expect(r.sent).toEqual([]);
    expect(r.statuses).toEqual([]);
  });

  it('decline sends a cancel and ends declined by self; a second decline does nothing', async () => {
    const r = rig();
    r.d.handle(proposal());
    await r.d.decline(OFFER);
    expect(r.statuses).toEqual([{ id: OFFER, peer: 'Alice', role: 'receiving', state: 'closed', end: 'declined', by: 'self', verified: false }]);
    expect(r.sent).toEqual([cancelTo('Alice')]);
    await r.d.decline(OFFER);
    expect(r.sent).toHaveLength(1);
    expect(r.statuses).toHaveLength(1);
  });

  it('close on an offer that waits declines it; close between accept and the connection sends a cancel', async () => {
    const waiting = rig();
    waiting.d.handle(proposal());
    await waiting.d.close(OFFER);
    expect(last(waiting)).toMatchObject({ end: 'declined', by: 'self' });
    const r = rig();
    let open: (link: PeerLink) => void = () => {};
    (r.rendezvous as unknown as { deps: { open: unknown } }).deps.open = () => new Promise<PeerLink>((resolve) => (open = resolve));
    r.d.handle(proposal());
    r.d.accept(OFFER);
    await tick();
    await r.d.close(OFFER);
    expect(trail(r)).toEqual(['connecting', 'closed']);
    expect(last(r)).toMatchObject({ by: 'self' });
    expect(r.sent.at(-1)).toEqual(cancelTo('Alice'));
    open(r.link);
    await tick();
    expect(r.link.closed).toBe(true);
    expect(r.link.written).toEqual([]);
  });

  it('a message past maxAttachments rejects invalid-argument', async () => {
    const r = rig({ maxAttachments: 1 });
    await accepted(r);
    const two = { pictures: [...picture.pictures, ...picture.pictures] };
    await expect(r.d.sendMessage(OFFER, two)).rejects.toMatchObject(INVALID);
  });
});

describe('how a Direct IM session ends', () => {
  it('an offer nobody answers ends timed-out after OFFER_ACCEPT_MS, for the recipient too', async () => {
    const r = rig();
    r.d.handle(proposal());
    await r.timers.advance(OFFER_ACCEPT_MS - 1);
    expect(r.statuses).toEqual([]);
    await r.timers.advance(1);
    expect(r.statuses).toEqual([{ id: OFFER, peer: 'Alice', role: 'receiving', state: 'closed', end: 'timed-out', verified: false }]);
    expect(r.sent).toEqual([]);
    expect(() => r.d.accept(OFFER)).toThrow(expect.objectContaining(INVALID));
  });

  it.each([
    [RDV_CANCEL_ELSEWHERE, 'taken-elsewhere', undefined],
    [RDV_CANCEL_TIMEOUT, 'timed-out', undefined],
    [RDV_CANCEL_DECLINED, 'cancelled', 'peer'],
  ])('a cancel with reason %i for an offer that waits ends %s', async (reason, end, by) => {
    const r = rig();
    r.d.handle(proposal());
    expect(r.d.handle(cancelFrom('Alice', reason))).toBe(true);
    expect(last(r)).toMatchObject({ state: 'closed', end });
    expect(last(r)?.by).toBe(by);
    expect(r.sent).toEqual([]);
  });

  it('a decline and a client error of the peer end the offer of this client declined by peer', async () => {
    const r = rig();
    r.d.open('Alice');
    await tick();
    expect(r.d.handle(cancelFrom('Alice', RDV_CANCEL_DECLINED))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['waiting', 'declined']);
    expect(last(r)).toMatchObject({ by: 'peer' });
    const other = rig();
    other.d.open('Alice');
    await tick();
    expect(other.d.handle(clientError('Alice'))).toBe(true);
    await tick();
    expect(trail(other)).toEqual(['waiting', 'declined']);
  });

  it('a cancel on the BOS link does not end a session that is open after the peer showed the cookie', async () => {
    const r = rig();
    await accepted(r);
    r.link.feed(hello());
    await tick();
    expect(r.d.handle(cancelFrom('Alice', RDV_CANCEL_DECLINED))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['connecting', 'open', 'open+cookie']);
    expect(r.link.closed).toBe(false);
  });

  it('a cancel on the BOS link does not end the open session of an offerer', async () => {
    const r = rig();
    await offering(r);
    expect(r.d.handle(cancelFrom('Alice', RDV_CANCEL_DECLINED))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
    expect(r.link.closed).toBe(false);
  });

  it.each([
    [RDV_CANCEL_DECLINED, 'cancelled', 'peer'],
    [RDV_CANCEL_ELSEWHERE, 'cancelled', 'peer'],
    [RDV_CANCEL_TIMEOUT, 'timed-out', undefined],
  ])('a cancel with reason %i for a recipient that waits alone at the relay ends %s', async (reason, end, by) => {
    const r = rig();
    await accepted(r);
    expect(r.d.handle(cancelFrom('Alice', reason))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['connecting', 'open', end]);
    expect(last(r)?.by).toBe(by);
    expect(r.link.closed).toBe(true);
  });

  it('a recipient whose connection gives the bytes of the sign-on service ends taken-elsewhere', async () => {
    const r = rig();
    await accepted(r);
    r.link.feed(SIGN_ON_HELLO);
    await tick();
    expect(r.link.closed).toBe(true);
    await expect(r.d.sendMessage(OFFER, picture)).rejects.toMatchObject(INVALID);
    await r.timers.advance(CANCEL_AFTER_CLOSE_MS - 1);
    expect(trail(r)).toEqual(['connecting', 'open']);
    await r.timers.advance(1);
    expect(trail(r)).toEqual(['connecting', 'open', 'taken-elsewhere']);
    expect(last(r)?.by).toBeUndefined();
    expect(r.link.closed).toBe(true);
  });

  it.each([
    [RDV_CANCEL_DECLINED, 'cancelled', 'peer'],
    [RDV_CANCEL_TIMEOUT, 'timed-out', undefined],
  ])('a cancel with reason %i that comes after the relay closed a recipient that waited alone ends %s', async (reason, end, by) => {
    const r = rig();
    await accepted(r);
    r.link.end();
    await tick();
    expect(r.d.handle(cancelFrom('Alice', reason))).toBe(true);
    expect(trail(r)).toEqual(['connecting', 'open', end]);
    expect(last(r)?.by).toBe(by);
    await r.timers.advance(CANCEL_AFTER_CLOSE_MS);
    expect(r.statuses).toHaveLength(3);
  });

  it('a new proposal of the peer after the relay closed a recipient that waited alone ends that session and is a new offer', async () => {
    const r = rig();
    await accepted(r);
    r.link.end();
    await tick();
    expect(r.d.handle(proposal({ cookie: 9n }))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['connecting', 'open', 'cancelled']);
    expect(r.offers.map((offer) => offer.id)).toEqual([OFFER, 'alice:0000000000000009']);
    expect(r.sent.at(-1)).not.toEqual(cancelTo('Alice', 9n));
  });

  it('a recipient whose connection closes before the cookie ends taken-elsewhere; after the cookie it ends peer-closed', async () => {
    const early = rig();
    await accepted(early);
    early.link.end();
    await tick();
    await early.timers.advance(CANCEL_AFTER_CLOSE_MS);
    expect(trail(early)).toEqual(['connecting', 'open', 'taken-elsewhere']);
    const late = rig();
    await accepted(late);
    late.link.feed(hello());
    await tick();
    late.link.end();
    await tick();
    expect(trail(late)).toEqual(['connecting', 'open', 'open+cookie', 'peer-closed']);
    expect(last(late)).toMatchObject({ by: 'peer', verified: true });
  });

  it('an offerer whose connection closes before the cookie ends peer-closed', async () => {
    const r = rig();
    await offering(r);
    r.link.end();
    await tick();
    expect(trail(r)).toEqual(['waiting', 'connecting', 'open', 'peer-closed']);
  });

  it('a connection that does not open ends taken-elsewhere for a recipient', async () => {
    const r = rig();
    (r.rendezvous as unknown as { deps: { open: unknown } }).deps.open = () => Promise.reject(new Error('no route'));
    r.d.handle(proposal());
    r.d.accept(OFFER);
    await tick();
    expect(trail(r)).toEqual(['connecting', 'taken-elsewhere']);
  });

  it('the session writes the hello with the cookie and the name of this client', async () => {
    const r = rig();
    await accepted(r);
    expect(r.link.written).toEqual([encodeOdcHeader({ cookie: COOKIE, payloadBytes: 0, encoding: 0, flags: ODC_FLAG_HELLO, screenName: 'Bob' })]);
  });

  it('reset ends each session signed-off, closes the connection and sends nothing; a send that waits rejects', async () => {
    const r = rig();
    await accepted(r);
    r.d.handle(proposal({ from: 'Carol', cookie: 5n }));
    const sending = r.d.sendMessage(OFFER, picture);
    const refused = expect(sending).rejects.toMatchObject({ name: 'OdcError', failure: 'not-open' });
    const before = r.sent.length;
    r.d.reset();
    r.rendezvous.reset();
    await refused;
    await tick();
    expect(r.statuses.slice(2)).toEqual([
      { id: OFFER, peer: 'Alice', role: 'receiving', state: 'closed', end: 'signed-off', verified: false },
      { id: 'carol:0000000000000005', peer: 'Carol', role: 'receiving', state: 'closed', end: 'signed-off', verified: false },
    ]);
    expect(r.link.closed).toBe(true);
    expect(r.sent).toHaveLength(before);
    r.d.reset();
    await r.timers.advance(OFFER_ACCEPT_MS);
    expect(r.statuses).toHaveLength(4);
  });
});
