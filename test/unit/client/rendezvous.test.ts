import { beforeEach, describe, expect, it } from 'vitest';
import { PeerClosedError } from '../../../src/client/peer-link.js';
import type { PeerLink } from '../../../src/client/peer-link.js';
import { COUNTER_DIAL_MS, OFFER_ACCEPT_MS, Rendezvous, rendezvousEnded } from '../../../src/client/rendezvous.js';
import type { RendezvousEnd } from '../../../src/client/rendezvous.js';
import { ByteReader } from '../../../src/wire/bytes.js';
import {
  ICBM_TLV_RENDEZVOUS, RDV_CANCEL_DECLINED, RDV_CANCEL_TIMEOUT, RDV_FRAGMENT_MIN_BYTES, RDV_TLV_CANCEL_REASON, RDV_TLV_PORT, RDV_TLV_RDV_IP,
  RDV_TLV_REQUESTER_IP, RDV_TLV_SEQUENCE, RDV_TLV_SERVICE_DATA, RDV_TLV_VERIFIED_IP, RDV_TYPE_ACCEPT, RDV_TYPE_CANCEL, RDV_TYPE_PROPOSE,
} from '../../../src/wire/constants.js';
import { serviceOf } from '../../../src/wire/rendezvous.js';
import type { FileDescription, PeerAddress, RendezvousMessage, RendezvousService } from '../../../src/wire/rendezvous.js';
import { decodeTlvs, findTlv, hasTlv, tlvU16 } from '../../../src/wire/tlv.js';
import { ManualTimers, captureLog, tick } from '../../fake/oscar-client.js';

const COOKIE = 0x1122334455667788n;
const FILE: FileDescription = { multiple: false, count: 1, totalBytes: 90112, name: 'budget.xls' };
const RELAY: PeerAddress = { ip: '203.0.113.7', port: 5190 };
const TYPES: Record<number, string> = { [RDV_TYPE_PROPOSE]: 'propose', [RDV_TYPE_CANCEL]: 'cancel', [RDV_TYPE_ACCEPT]: 'accept' };

type Sent = { to: string; cookie: bigint; type: string; sequence: number | null; reason: number | null; ips: string[]; port: number | null };
type FakeLink = PeerLink & { name: string };
type Dial = { host: string; port: number; resolve(link: FakeLink): void; reject(error: Error): void };

// The fields of one message to the host: the fragment is the value of tag 0x0005.
function read(body: Uint8Array): Sent {
  const r = new ByteReader(body);
  const cookie = r.u64();
  r.u16();
  const to = r.str8();
  const fragment = findTlv(decodeTlvs(r.rest()), ICBM_TLV_RENDEZVOUS) ?? new Uint8Array(0);
  const inner = decodeTlvs(fragment.subarray(RDV_FRAGMENT_MIN_BYTES));
  const ips = [RDV_TLV_RDV_IP, RDV_TLV_REQUESTER_IP, RDV_TLV_VERIFIED_IP].flatMap((tag) => {
    const value = findTlv(inner, tag);
    return value ? [value.join('.')] : [];
  });
  return {
    to,
    cookie,
    type: TYPES[Buffer.from(fragment).readUInt16BE(0)] ?? 'unknown',
    sequence: tlvU16(inner, RDV_TLV_SEQUENCE) ?? null,
    reason: tlvU16(inner, RDV_TLV_CANCEL_REASON) ?? null,
    ips,
    port: tlvU16(inner, RDV_TLV_PORT) ?? null,
  };
}

// The service a message to the host names, and whether its fragment holds a file block.
function serviceAndFile(body: Uint8Array): { service: string; file: boolean } {
  const r = new ByteReader(body);
  r.u64();
  r.u16();
  r.str8();
  const fragment = findTlv(decodeTlvs(r.rest()), ICBM_TLV_RENDEZVOUS) ?? new Uint8Array(0);
  const inner = decodeTlvs(fragment.subarray(RDV_FRAGMENT_MIN_BYTES));
  return { service: serviceOf(fragment.subarray(10, RDV_FRAGMENT_MIN_BYTES)) ?? 'unknown', file: hasTlv(inner, RDV_TLV_SERVICE_DATA) };
}

function fakeLink(name: string): FakeLink {
  let closed = false;
  return {
    name,
    write: async () => {},
    read: async () => new Uint8Array(0),
    readSome: async () => null,
    close: () => {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

function message(type: RendezvousMessage['type'], over: Partial<RendezvousMessage> = {}): RendezvousMessage {
  return {
    from: 'bob', fromDisplay: 'Bob', cookie: COOKIE, service: 'send-file', type, sequence: null, address: null, useProxy: false,
    cancelReason: null, file: null, invitation: null, ...over,
  };
}

const proposal = (over: Partial<RendezvousMessage> = {}): RendezvousMessage =>
  message('propose', { from: 'alice', fromDisplay: 'Alice', sequence: 1, address: RELAY, file: FILE, ...over });
const counter = (over: Partial<RendezvousMessage> = {}): RendezvousMessage => message('propose', { sequence: 2, address: RELAY, ...over });

let timers: ManualTimers;
let sent: Sent[];
let order: string[];
let dials: Dial[];
let allow: (address: PeerAddress, service: RendezvousService) => boolean;
let sendFails: boolean;
let auto: boolean;
let made: number;
let services: string[];
let hadFile: boolean[];
let r: Rendezvous;

beforeEach(() => {
  timers = new ManualTimers();
  sent = [];
  order = [];
  dials = [];
  allow = () => true;
  sendFails = false;
  auto = true;
  made = 0;
  services = [];
  hadFile = [];
  r = new Rendezvous({
    log: captureLog().log,
    timers: timers.api,
    now: timers.now,
    send: async (body) => {
      if (sendFails) throw new Error('the link is gone');
      const one = read(body);
      const about = serviceAndFile(body);
      services.push(about.service);
      hadFile.push(about.file);
      sent.push(one);
      order.push(one.type);
    },
    allowDial: async (address, service) => {
      order.push('allow');
      return allow(address, service);
    },
    open: (o) => {
      order.push('open');
      return new Promise<PeerLink>((resolve, reject) => {
        const dial: Dial = { host: o.host, port: o.port, resolve, reject };
        dials.push(dial);
        if (auto) resolve(fakeLink(`link ${++made}`));
      });
    },
  });
});

// Promise steps only: the scripted parts never touch a socket.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function ended(result: PeerLink | RendezvousEnd): RendezvousEnd {
  if (!rendezvousEnded(result)) throw new Error('the offer met the peer');
  return result;
}

// A rejected offer holds no cookie: the same cookie is free for the next offer.
function offerAndMeet(): Promise<PeerLink | RendezvousEnd> {
  const result = r.offer('Bob', COOKIE, 'send-file', FILE);
  r.heard(counter());
  return result;
}

function linked(result: PeerLink | RendezvousEnd): PeerLink {
  if (rendezvousEnded(result)) throw new Error(`the offer ended ${result.outcome}`);
  return result;
}

describe('offering', () => {
  it('offering: sequence 1 out, sequence 2 in, asks allowDial, dials that address, sends Accept, resolves a link', async () => {
    const asked: PeerAddress[] = [];
    allow = (address) => {
      asked.push(address);
      return true;
    };
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    await flush();
    expect(sent).toEqual([{ to: 'Bob', cookie: COOKIE, type: 'propose', sequence: 1, reason: null, ips: ['0.0.0.0', '0.0.0.0'], port: 5190 }]);
    r.heard(counter());
    const link = linked(await result);
    expect(asked).toEqual([RELAY]);
    expect(dials.map(({ host, port }) => ({ host, port }))).toEqual([{ host: RELAY.ip, port: RELAY.port }]);
    expect(order).toEqual(['propose', 'allow', 'open', 'accept']);
    expect(sent[1]).toMatchObject({ to: 'Bob', cookie: COOKIE, type: 'accept' });
    expect(link.closed).toBe(false);
  });

  it('the rule hears the service of each offer, offering and receiving', async () => {
    const asked: [PeerAddress, RendezvousService][] = [];
    allow = (address, service) => {
      asked.push([address, service]);
      return true;
    };
    const mine = r.offer('Bob', COOKIE, 'direct-im', null);
    await flush();
    r.heard(counter({ service: 'direct-im' }));
    linked(await mine);
    linked(await r.accept(proposal({ cookie: 2n })));
    linked(await r.accept(proposal({ cookie: 3n, service: 'direct-im', file: null })));
    expect(asked).toEqual([[RELAY, 'direct-im'], [RELAY, 'send-file'], [RELAY, 'direct-im']]);
  });

  it('no answer for OFFER_ACCEPT_MS sends a timeout cancel and ends timed-out', async () => {
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    await timers.advance(OFFER_ACCEPT_MS - 1);
    expect(sent.map((s) => s.type)).toEqual(['propose']);
    await timers.advance(1);
    expect(ended(await result)).toEqual({ outcome: 'timed-out', by: 'self' });
    expect(sent[1]).toMatchObject({ to: 'Bob', type: 'cancel', reason: RDV_CANCEL_TIMEOUT });
    expect(timers.pending()).toEqual([]);
  });

  it('a sequence 2 the rule refuses sends a cancel and ends refused-address without opening a socket', async () => {
    allow = () => false;
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    r.heard(counter());
    expect(ended(await result)).toEqual({ outcome: 'refused-address', by: 'self' });
    expect(sent.map((s) => s.type)).toEqual(['propose', 'cancel']);
    expect(dials).toEqual([]);
  });

  it('ignores a sequence 2 from another name and one with another cookie', async () => {
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    r.heard(counter({ from: 'carol', fromDisplay: 'Carol' }));
    r.heard(counter({ cookie: COOKIE + 1n }));
    await flush();
    expect(order).toEqual(['propose']);
    r.heard(counter());
    linked(await result);
  });

  it('a sequence 2 with no address sends a cancel and ends failed by the peer', async () => {
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    r.heard(counter({ address: null }));
    expect(ended(await result)).toEqual({ outcome: 'failed', by: 'peer' });
    expect(sent.map((s) => s.type)).toEqual(['propose', 'cancel']);
    expect(dials).toEqual([]);
  });

  it('a dial that does not open sends a cancel and ends failed by the server', async () => {
    auto = false;
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    r.heard(counter());
    await flush();
    dials[0]?.reject(new PeerClosedError());
    expect(ended(await result)).toEqual({ outcome: 'failed', by: 'server' });
    expect(sent.map((s) => s.type)).toEqual(['propose', 'cancel']);
  });

  it('a proposal the link refuses ends failed by the server and leaves no timer', async () => {
    sendFails = true;
    expect(ended(await r.offer('Bob', COOKIE, 'send-file', FILE))).toEqual({ outcome: 'failed', by: 'server' });
    expect(timers.pending()).toEqual([]);
  });

  it('a second offer with a cookie in use fails and leaves the first one alone', async () => {
    const first = r.offer('Bob', COOKIE, 'send-file', FILE);
    expect(ended(await r.offer('Carol', COOKIE, 'send-file', FILE))).toEqual({ outcome: 'failed', by: 'self' });
    r.heard(counter());
    linked(await first);
  });

  it('offer(direct-im, null) sends the proposal with the placeholder address 0.0.0.0:5190', async () => {
    const result = r.offer('Bob', COOKIE, 'direct-im', null);
    await flush();
    expect(sent).toEqual([{ to: 'Bob', cookie: COOKIE, type: 'propose', sequence: 1, reason: null, ips: ['0.0.0.0', '0.0.0.0'], port: 5190 }]);
    expect(services).toEqual(['direct-im']);
    expect(hadFile).toEqual([false]);
    r.heard(counter({ service: 'direct-im' }));
    linked(await result);
    expect(order).toEqual(['propose', 'allow', 'open', 'accept']);
    expect(services).toEqual(['direct-im', 'direct-im']);
  });

  it('offer rejects RangeError for send-file with null and for direct-im with a file', async () => {
    await expect(r.offer('Bob', COOKIE, 'send-file', null)).rejects.toBeInstanceOf(RangeError);
    await expect(r.offer('Bob', COOKIE, 'direct-im', FILE)).rejects.toBeInstanceOf(RangeError);
    expect(sent).toEqual([]);
    expect(timers.pending()).toEqual([]);
    linked(await offerAndMeet());
  });

  it('offer(get-file, null) sends the proposal with the placeholder address 0.0.0.0:5190', async () => {
    const result = r.offer('Bob', COOKIE, 'get-file', null);
    await flush();
    expect(sent).toEqual([{ to: 'Bob', cookie: COOKIE, type: 'propose', sequence: 1, reason: null, ips: ['0.0.0.0', '0.0.0.0'], port: 5190 }]);
    expect(services).toEqual(['get-file']);
    // A Get File proposal carries tag 0x2711, as a file proposal does.
    expect(hadFile).toEqual([true]);
    r.heard(counter({ service: 'get-file' }));
    linked(await result);
    expect(order).toEqual(['propose', 'allow', 'open', 'accept']);
    expect(services).toEqual(['get-file', 'get-file']);
  });

  it('offer rejects RangeError for get-file with a file', async () => {
    await expect(r.offer('Bob', COOKIE, 'get-file', FILE)).rejects.toBeInstanceOf(RangeError);
    expect(sent).toEqual([]);
    expect(timers.pending()).toEqual([]);
    linked(await offerAndMeet());
  });

  it('cancel sends a cancel to the peer and ends cancelled by self', async () => {
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    await r.cancel(COOKIE);
    expect(ended(await result)).toEqual({ outcome: 'cancelled', by: 'self' });
    expect(sent[1]).toMatchObject({ to: 'Bob', type: 'cancel', reason: RDV_CANCEL_DECLINED });
    await r.cancel(COOKIE);
    expect(sent).toHaveLength(2);
    expect(timers.pending()).toEqual([]);
  });
});

describe('receiving', () => {
  it('receiving: sends Accept before it opens the socket', async () => {
    const link = linked(await r.accept(proposal()));
    expect(order).toEqual(['allow', 'accept', 'open']);
    expect(order.filter((step) => step !== 'allow')).toEqual(['accept', 'open']);
    expect(sent).toEqual([{ to: 'Alice', cookie: COOKIE, type: 'accept', sequence: null, reason: null, ips: [], port: null }]);
    expect(dials.map(({ host, port }) => ({ host, port }))).toEqual([{ host: RELAY.ip, port: RELAY.port }]);
    expect(link.closed).toBe(false);
  });

  it('receiving: allowDial false sends a cancel and ends refused-address without opening a socket', async () => {
    allow = () => false;
    expect(ended(await r.accept(proposal()))).toEqual({ outcome: 'refused-address', by: 'self' });
    expect(sent).toEqual([{ to: 'Alice', cookie: COOKIE, type: 'cancel', sequence: null, reason: RDV_CANCEL_DECLINED, ips: [], port: null }]);
    expect(dials).toEqual([]);
  });

  it('a rule that throws counts as a no', async () => {
    allow = () => {
      throw new Error('no lookup');
    };
    expect(ended(await r.accept(proposal()))).toEqual({ outcome: 'refused-address', by: 'self' });
    expect(dials).toEqual([]);
  });

  it('an Accept the link refuses ends failed by the server without opening a socket', async () => {
    sendFails = true;
    expect(ended(await r.accept(proposal()))).toEqual({ outcome: 'failed', by: 'server' });
    expect(dials).toEqual([]);
  });

  it('two accepts at once open one socket at a time', async () => {
    auto = false;
    const first = r.accept(proposal());
    const second = r.accept(proposal({ cookie: COOKIE + 1n, from: 'carol', fromDisplay: 'Carol' }));
    await flush();
    // The relay gives a connection to the oldest offer that has an Accept. The second Accept waits for its turn.
    expect(sent.map((s) => s.type)).toEqual(['accept']);
    expect(dials).toHaveLength(1);
    dials[0]?.resolve(fakeLink('one'));
    expect((linked(await first) as FakeLink).name).toBe('one');
    await flush();
    expect(sent.map((s) => [s.type, s.to])).toEqual([['accept', 'Alice'], ['accept', 'Carol']]);
    expect(dials).toHaveLength(2);
    dials[1]?.resolve(fakeLink('two'));
    expect((linked(await second) as FakeLink).name).toBe('two');
  });

  it('receiving: the next Accept and dial wait until the caller says that the peer of the first showed the cookie', async () => {
    let paired: () => void = () => {};
    const first = r.accept(proposal(), new Promise<void>((resolve) => (paired = resolve)));
    const second = r.accept(proposal({ cookie: COOKIE + 1n }));
    expect(linked(await first)).toBeDefined();
    await flush();
    expect(sent.map((s) => s.type)).toEqual(['accept']);
    expect(dials).toHaveLength(1);
    paired();
    expect(linked(await second)).toBeDefined();
    expect(sent.map((s) => s.type)).toEqual(['accept', 'accept']);
    expect(dials).toHaveLength(2);
  });

  it('receiving: a peer that never shows the cookie holds the next meeting for the wait of the relay and no longer', async () => {
    const first = r.accept(proposal(), new Promise<void>(() => {}));
    const second = r.accept(proposal({ cookie: COOKIE + 1n }));
    await first;
    await flush();
    expect(dials).toHaveLength(1);
    await timers.advance(COUNTER_DIAL_MS);
    expect(linked(await second)).toBeDefined();
    expect(dials).toHaveLength(2);
  });

  it('receiving: an offer that ends before its turn sends no Accept', async () => {
    auto = false;
    const first = r.accept(proposal());
    const second = r.accept(proposal({ cookie: COOKIE + 1n }));
    await flush();
    await r.cancel(COOKIE + 1n);
    expect(ended(await second)).toEqual({ outcome: 'cancelled', by: 'self' });
    dials[0]?.resolve(fakeLink('one'));
    await first;
    await flush();
    expect(sent.map((s) => s.type)).toEqual(['accept', 'cancel']);
    expect(dials).toHaveLength(1);
  });

  it('a dial that fails lets the next one start', async () => {
    auto = false;
    const first = r.accept(proposal());
    const second = r.accept(proposal({ cookie: COOKIE + 1n }));
    await flush();
    dials[0]?.reject(new PeerClosedError());
    expect(ended(await first)).toEqual({ outcome: 'failed', by: 'server' });
    await flush();
    dials[1]?.resolve(fakeLink('two'));
    linked(await second);
  });

  it('decline sends a cancel with the declined reason and holds no offer', async () => {
    await r.decline(proposal());
    expect(sent).toEqual([{ to: 'Alice', cookie: COOKIE, type: 'cancel', sequence: null, reason: RDV_CANCEL_DECLINED, ips: [], port: null }]);
    r.heard(message('cancel', { from: 'alice', fromDisplay: 'Alice' }));
    expect(sent).toHaveLength(1);
  });
});

describe('the end of an offer', () => {
  it('a cancel from the peer ends cancelled by peer; a client error ends declined by peer', async () => {
    auto = false;
    const receiving = r.accept(proposal());
    await flush();
    r.heard(message('cancel', { from: 'alice', fromDisplay: 'Alice', cancelReason: RDV_CANCEL_DECLINED }));
    expect(ended(await receiving)).toEqual({ outcome: 'cancelled', by: 'peer' });
    // The socket of an offer that ended is closed when it opens.
    const late = fakeLink('late');
    dials[0]?.resolve(late);
    await flush();
    expect(late.closed).toBe(true);

    const refused = r.offer('Bob', COOKIE + 1n, 'send-file', FILE);
    r.refused(COOKIE + 1n);
    expect(ended(await refused)).toEqual({ outcome: 'declined', by: 'peer' });

    const withdrawn = r.offer('Bob', COOKIE + 2n, 'send-file', FILE);
    r.heard(message('cancel', { cookie: COOKIE + 2n, cancelReason: null }));
    expect(ended(await withdrawn)).toEqual({ outcome: 'cancelled', by: 'peer' });
    expect(timers.pending()).toEqual([]);
  });

  it('a cancel with the declined reason ends an offer declined by peer, and one with the timeout reason ends it timed-out', async () => {
    const declined = r.offer('Bob', COOKIE, 'send-file', FILE);
    r.heard(message('cancel', { cancelReason: RDV_CANCEL_DECLINED }));
    expect(ended(await declined)).toEqual({ outcome: 'declined', by: 'peer' });
    const timedOut = r.offer('Bob', COOKIE + 1n, 'send-file', FILE);
    r.heard(message('cancel', { cookie: COOKIE + 1n, cancelReason: RDV_CANCEL_TIMEOUT }));
    expect(ended(await timedOut)).toEqual({ outcome: 'timed-out', by: 'peer' });
  });

  it('ignores a cancel from another name', async () => {
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    r.heard(message('cancel', { from: 'carol', fromDisplay: 'Carol', cancelReason: RDV_CANCEL_DECLINED }));
    r.heard(counter());
    linked(await result);
  });

  it('a message for an offer that met the peer changes nothing', async () => {
    const result = r.offer('Bob', COOKIE, 'send-file', FILE);
    r.heard(counter());
    const link = linked(await result);
    r.heard(message('cancel', { cancelReason: RDV_CANCEL_DECLINED }));
    r.refused(COOKIE);
    await r.cancel(COOKIE);
    expect(link.closed).toBe(false);
    expect(sent.map((s) => s.type)).toEqual(['propose', 'accept']);
  });

  it('reset ends every offer and closes every socket', async () => {
    const met = r.offer('Bob', COOKIE, 'send-file', FILE);
    r.heard(counter());
    const link = linked(await met);
    auto = false;
    const waiting = r.offer('Bob', COOKIE + 1n, 'send-file', FILE);
    const dialing = r.accept(proposal({ cookie: COOKIE + 2n }));
    const queued = r.accept(proposal({ cookie: COOKIE + 3n }));
    await flush();
    const before = sent.length;
    r.reset();
    for (const result of [waiting, dialing, queued]) expect(ended(await result)).toEqual({ outcome: 'cancelled', by: 'self' });
    expect(link.closed).toBe(true);
    const late = fakeLink('late');
    dials.at(-1)?.resolve(late);
    await flush();
    await tick();
    expect(late.closed).toBe(true);
    // The queued dial never starts, and sign-off writes nothing.
    expect(dials).toHaveLength(2);
    expect(sent).toHaveLength(before);
    expect(timers.pending()).toEqual([]);
  });
});
