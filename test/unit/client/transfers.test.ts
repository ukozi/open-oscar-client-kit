import { describe, expect, it } from 'vitest';
import { OscarClient } from '../../../src/client/oscar-client.js';
import { PeerClosedError } from '../../../src/client/peer-link.js';
import type { PeerLink, openPeerLink } from '../../../src/client/peer-link.js';
import { Rendezvous } from '../../../src/client/rendezvous.js';
import { MAX_OFFER_BYTES, MAX_WAITING_OFFERS, Transfers } from '../../../src/client/transfers.js';
import type { TransfersDeps } from '../../../src/client/transfers.js';
import { ByteReader, ByteWriter } from '../../../src/wire/bytes.js';
import {
  CAP_SEND_FILE, FAMILY_ICBM, ICBM_MSG_TO_CLIENT, ICBM_TLV_RENDEZVOUS, RDV_CANCEL_DECLINED, RDV_TLV_SEQUENCE, RDV_TLV_USE_PROXY,
  RDV_TYPE_PROPOSE,
} from '../../../src/wire/constants.js';
import { encodeRendezvousToHost, rendezvousHead } from '../../../src/wire/icbm.js';
import { OFT_ACK, OFT_CHECKSUM_START, OFT_DONE, OFT_PROMPT, decodeOftHeader, encodeOftHeader } from '../../../src/wire/oft.js';
import { encodeFileProposal, encodeRendezvousAccept, encodeRendezvousCancel, offeredFolder, parseRendezvous } from '../../../src/wire/rendezvous.js';
import type { FileDescription, PeerAddress } from '../../../src/wire/rendezvous.js';
import type { Snac } from '../../../src/wire/snac.js';
import { encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import type { FileOfferNotice, FileSink, IncomingFile, OutgoingFile, TransferStatus } from '../../../src/model/transfer.js';
import { ManualTimers, captureLog, tick } from '../../fake/oscar-client.js';

const file: OutgoingFile = { name: 'notes.txt', bytes: 0, modifiedAt: 0, read: async function* () {} };
const sink: FileSink = { begin: async () => ({ write: async () => {}, finish: async () => {}, abort: async () => {} }) };

describe('file transfer calls on a client that never signed on', () => {
  const calls: [string, (client: OscarClient) => Promise<unknown>][] = [
    ['sendFiles', (client) => client.sendFiles('Bob', [file])],
    ['acceptFileOffer', (client) => client.acceptFileOffer('bob:0000000000000001', sink)],
    ['declineFileOffer', (client) => client.declineFileOffer('bob:0000000000000001')],
    ['cancelTransfer', (client) => client.cancelTransfer('bob:0000000000000001')],
  ];

  it.each(calls)('%s rejects not-signed-on', async (_name, call) => {
    const client = new OscarClient({ fileTransfer: {} });
    await expect(call(client)).rejects.toMatchObject({ name: 'OscarError', info: { kind: 'not-signed-on' } });
  });
});

const COOKIE = 0x0102030405060708n;
const ID = 'alice:0102030405060708';
const ADDRESS: PeerAddress = { ip: '192.0.2.7', port: 5190 };
const ONE: FileDescription = { multiple: false, count: 1, totalBytes: 10, name: 'notes.txt' };
const INVALID = { name: 'OscarError', info: { kind: 'local', code: 'invalid-argument' } };

// A connection that gives the bytes the test feeds it, also after it closed.
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
    this.written.push(bytes.slice());
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.held.length < n) {
      if (this.ended) throw new PeerClosedError();
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
  }
}

type Rig = {
  t: Transfers;
  rendezvous: Rendezvous;
  /** Sign-off, as the client does it: the transfers first, then the offers. */
  reset(): void;
  timers: ManualTimers;
  sent: Uint8Array[];
  offers: FileOfferNotice[];
  statuses: TransferStatus[];
  asked: PeerAddress[];
  link: ScriptLink;
  opened: number;
  blocked: Set<string>;
};

function rig(over: Partial<TransfersDeps> & { open?: typeof openPeerLink } = {}): Rig {
  const timers = new ManualTimers();
  const { open, ...deps } = over;
  const log = captureLog().log;
  const send = async (body: Uint8Array): Promise<void> => {
    one.sent.push(body);
  };
  const rendezvous = new Rendezvous({
    log,
    now: timers.now,
    timers: timers.api,
    send,
    allowDial: async (address) => {
      one.asked.push(address);
      return true;
    },
    open:
      open ??
      (async () => {
        one.opened++;
        return one.link;
      }),
  });
  const one: Rig = {
    t: undefined as unknown as Transfers, rendezvous, timers, sent: [], offers: [], statuses: [], asked: [], link: new ScriptLink(), opened: 0,
    blocked: new Set(),
    reset: () => {
      one.t.reset();
      rendezvous.reset();
    },
  };
  one.t = new Transfers({
    log,
    now: timers.now,
    timers: timers.api,
    enabled: true,
    rendezvous,
    send,
    isBlocked: (name) => one.blocked.has(name.toLowerCase()),
    emitOffer: (offer) => one.offers.push(offer),
    emitTransfer: (status) => one.statuses.push(status),
    cookie: () => COOKIE,
    ...deps,
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

function proposal(over: { cookie?: bigint; from?: string; sequence?: 1 | 2; address?: PeerAddress; file?: FileDescription } = {}): Snac {
  const body = encodeFileProposal(over.cookie ?? COOKIE, 'Bob', { sequence: over.sequence ?? 1, address: over.address ?? ADDRESS, file: over.file ?? ONE });
  return toClient(body, over.from ?? 'Alice');
}

function prompt(bytes: number, totalFiles = 1): Uint8Array {
  return encodeOftHeader({
    type: OFT_PROMPT, cookie: COOKIE, totalFiles, filesLeft: totalFiles, totalParts: 1, partsLeft: 1, totalBytes: bytes, bytes, modifiedAt: 0,
    checksum: OFT_CHECKSUM_START, received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: 0, name: 'notes.txt',
  });
}

function countingSink(): { sink: FileSink; begun: IncomingFile[] } {
  const begun: IncomingFile[] = [];
  return {
    begun,
    sink: {
      begin: async (incoming) => {
        begun.push(incoming);
        return { write: async () => {}, finish: async () => {}, abort: async () => {} };
      },
    },
  };
}

const sized = (bytes: number): OutgoingFile => ({ ...file, bytes });
const cancelTo = (to: string, cookie = COOKIE): Uint8Array => encodeRendezvousCancel(cookie, to, 'send-file', RDV_CANCEL_DECLINED);
const last = (r: Rig): TransferStatus | undefined => r.statuses.at(-1);

// The offer is accepted and the connection is open.
async function accepted(r: Rig, into: FileSink): Promise<void> {
  expect(r.t.handle(proposal())).toBe(true);
  r.t.accept(ID, into);
  await tick();
  expect(r.opened).toBe(1);
  // The bar starts when the peer shows the cookie.
  expect(last(r)).toMatchObject({ id: ID, state: 'connecting' });
}

// The offer of this client is accepted and the connection is open.
async function offering(r: Rig): Promise<string> {
  const four: OutgoingFile = { ...sized(4), read: async function* () { yield new Uint8Array(4); } };
  const id = r.t.sendFiles('Bob', [four]);
  await tick();
  expect(r.t.handle(proposal({ from: 'Bob', sequence: 2 }))).toBe(true);
  await tick();
  expect(r.opened).toBe(1);
  expect(last(r)).toMatchObject({ id, direction: 'out', state: 'transferring' });
  return id;
}

// The first bytes of the sign-on service: a FLAP frame on channel 1 with the version.
const HELLO = Uint8Array.from([0x2a, 0x01, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01]);

describe('what the client refuses to offer', () => {
  it('sendFiles rejects a file of 0x1_0000_0000 bytes and three files of 2 GB each, before any SNAC is sent', async () => {
    const r = rig();
    expect(MAX_OFFER_BYTES).toBe(0xffff_ffff);
    expect(() => r.t.sendFiles('Bob', [sized(0x1_0000_0000)])).toThrow(expect.objectContaining(INVALID));
    const twoGb = 2 * 1024 * 1024 * 1024;
    expect(() => r.t.sendFiles('Bob', [sized(twoGb), sized(twoGb), sized(twoGb)])).toThrow(expect.objectContaining(INVALID));
    await tick();
    expect(r.sent).toEqual([]);
    expect(r.statuses).toEqual([]);
  });

  it('sendFiles rejects no files, a size that is no whole number, and a name with no text or with a NUL', async () => {
    const r = rig();
    for (const files of [[], [sized(-1)], [sized(1.5)], [{ ...file, name: '' }], [{ ...file, name: 'a\0b' }]]) {
      expect(() => r.t.sendFiles('Bob', files)).toThrow(expect.objectContaining(INVALID));
    }
    await tick();
    expect(r.sent).toEqual([]);
  });

  it('the first status of an offer, waiting, comes before sendFiles gives the id', () => {
    const r = rig();
    const id = r.t.sendFiles('Bob', [file]);
    expect(r.statuses).toEqual([expect.objectContaining({ id, direction: 'out', peer: 'Bob', state: 'waiting', count: 1, name: file.name, bytesTotal: file.bytes })]);
  });

  it('an offer of several loose files carries no name, so that no client reads a folder in it', async () => {
    const r = rig();
    r.t.sendFiles('Bob', [file, { ...file, name: 'more.txt' }]);
    await tick();
    const heard = parseRendezvous(toClient(r.sent[0] as Uint8Array, 'Alice').body);
    expect(heard?.file).toEqual({ multiple: true, count: 2, totalBytes: 0, name: '' });
    expect(offeredFolder(heard?.file ?? null)).toBeNull();
    expect(r.statuses[0]).toMatchObject({ count: 2, name: 'notes.txt' });
  });

  it('a file of the largest size goes out as an offer', async () => {
    const r = rig();
    expect(r.t.sendFiles('Bob', [sized(MAX_OFFER_BYTES)])).toBe('bob:0102030405060708');
    await tick();
    expect(r.sent).toHaveLength(1);
    expect(r.statuses).toEqual([
      { id: 'bob:0102030405060708', direction: 'out', peer: 'Bob', state: 'waiting', count: 1, index: 0, name: 'notes.txt', bytesDone: 0, bytesTotal: MAX_OFFER_BYTES },
    ]);
  });

  it('with file transfer off, each command is refused and each message is left alone', async () => {
    const r = rig({ enabled: false });
    expect(() => r.t.sendFiles('Bob', [file])).toThrow(expect.objectContaining(INVALID));
    expect(r.t.handle(proposal())).toBe(false);
    expect(() => r.t.accept(ID, sink)).toThrow(expect.objectContaining(INVALID));
    await tick();
    expect(r.sent).toEqual([]);
    expect(r.offers).toEqual([]);
  });
});

describe('a proposal the client hears', () => {
  it('a proposal from a blocked name emits nothing and sends nothing', async () => {
    const r = rig();
    r.blocked.add('alice');
    expect(r.t.handle(proposal())).toBe(true);
    expect(r.t.handle(proposal({ cookie: 9n, address: { ip: '0.0.0.0', port: 5190 } }))).toBe(true);
    await tick();
    expect(r.offers).toEqual([]);
    expect(r.statuses).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(() => r.t.accept(ID, sink)).toThrow(expect.objectContaining(INVALID));
  });

  it('a proposal with a file block and an address becomes an offer', () => {
    const r = rig();
    expect(r.t.handle(proposal())).toBe(true);
    expect(r.offers).toEqual([{ id: ID, from: 'Alice', count: 1, totalBytes: 10, name: 'notes.txt', folder: null, at: r.timers.now() }]);
    expect(r.statuses).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it('a proposal of the "several" kind is an offer of a folder, with or without the backslash and the star', () => {
    const r = rig();
    r.t.handle(proposal({ cookie: 1n, file: { multiple: true, count: 3, totalBytes: 30, name: 'Plans\\*' } }));
    r.t.handle(proposal({ cookie: 2n, file: { multiple: true, count: 16, totalBytes: 40, name: 'Plans' } }));
    expect(r.offers.map(({ count, name, folder }) => [count, name, folder])).toEqual([[3, 'Plans\\*', 'Plans'], [16, 'Plans', 'Plans']]);
  });

  it('the same proposal a second time adds no offer', () => {
    const r = rig();
    r.t.handle(proposal());
    r.t.handle(proposal());
    expect(r.offers).toHaveLength(1);
    expect(r.sent).toEqual([]);
  });

  it('a proposal with no address, with sequence 2, with the proxy mark or with no file block gets a cancel and no offer', async () => {
    const withInner = (inner: Parameters<typeof encodeTlvs>[0]): Snac => {
      const fragment = rendezvousHead(RDV_TYPE_PROPOSE, COOKIE, CAP_SEND_FILE).bytes(encodeTlvs(inner)).toBytes();
      return toClient(encodeRendezvousToHost(COOKIE, 'Bob', [tlv.bytes(ICBM_TLV_RENDEZVOUS, fragment)]), 'Alice');
    };
    const odd: [string, Snac][] = [
      ['no address', proposal({ address: { ip: '0.0.0.0', port: 5190 } })],
      ['sequence 2', proposal({ sequence: 2 })],
      ['no file block', withInner([tlv.u16(RDV_TLV_SEQUENCE, 1)])],
      ['the proxy mark', withInner([tlv.u16(RDV_TLV_SEQUENCE, 1), tlv.empty(RDV_TLV_USE_PROXY)])],
    ];
    for (const [what, snac] of odd) {
      const r = rig();
      expect(r.t.handle(snac), what).toBe(true);
      await tick();
      expect(r.offers, what).toEqual([]);
      expect(r.statuses, what).toEqual([]);
      expect(r.sent, what).toEqual([cancelTo('Alice')]);
    }
  });

  it('a 17th waiting offer is cancelled back', async () => {
    const r = rig();
    for (let i = 1; i <= MAX_WAITING_OFFERS + 1; i++) r.t.handle(proposal({ cookie: BigInt(i) }));
    await tick();
    expect(r.offers).toHaveLength(MAX_WAITING_OFFERS);
    expect(r.sent).toEqual([cancelTo('Alice', BigInt(MAX_WAITING_OFFERS + 1))]);
    // An answer makes room for the next offer.
    await r.t.decline(r.offers[0]?.id ?? '');
    r.t.handle(proposal({ cookie: 99n }));
    expect(r.offers).toHaveLength(MAX_WAITING_OFFERS + 1);
  });

  it('an accept or a cancel for no transfer is taken and gets no answer', async () => {
    const r = rig();
    expect(r.t.handle(toClient(encodeRendezvousAccept(COOKIE, 'Bob', 'send-file'), 'Alice'))).toBe(true);
    expect(r.t.handle(toClient(cancelTo('Bob'), 'Alice'))).toBe(true);
    await tick();
    expect(r.sent).toEqual([]);
    expect(r.statuses).toEqual([]);
  });

  it('an offer nobody answers ends failed timed-out when the wait of the offerer runs out', async () => {
    const r = rig();
    r.t.handle(proposal());
    await r.timers.advance(300_000 - 1);
    expect(r.statuses).toEqual([]);
    await r.timers.advance(1);
    expect(r.statuses).toEqual([expect.objectContaining({ id: ID, direction: 'in', state: 'failed', failure: 'timed-out' })]);
    expect(r.sent).toEqual([]);
  });
});

describe('the sink of the user', () => {
  it('begin is never called after a cancel, also when the connection still gives the header', async () => {
    const r = rig();
    const into = countingSink();
    await accepted(r, into.sink);
    await r.t.cancel(ID);
    expect(last(r)).toMatchObject({ state: 'cancelled', by: 'self' });
    expect(r.link.closed).toBe(true);
    r.link.feed(prompt(10));
    await tick();
    expect(into.begun).toEqual([]);
    expect(last(r)).toMatchObject({ state: 'cancelled', by: 'self' });
    expect(r.sent.at(-1)).toEqual(cancelTo('Alice'));
  });

  it('begin is never called after a reset', async () => {
    const r = rig();
    const into = countingSink();
    await accepted(r, into.sink);
    const sentBefore = r.sent.length;
    r.reset();
    expect(last(r)).toMatchObject({ state: 'failed', failure: 'signed-off' });
    r.link.feed(prompt(10));
    await tick();
    expect(into.begun).toEqual([]);
    expect(last(r)).toMatchObject({ state: 'failed', failure: 'signed-off' });
    expect(r.sent).toHaveLength(sentBefore);
  });

  it('begin is never called after the cancel of the peer', async () => {
    const r = rig();
    const into = countingSink();
    await accepted(r, into.sink);
    r.t.handle(toClient(cancelTo('Bob'), 'Alice'));
    expect(last(r)).toMatchObject({ state: 'cancelled', by: 'peer' });
    r.link.feed(prompt(10));
    await tick();
    expect(into.begun).toEqual([]);
  });

  it('begin is never called for a file past the offer: the transfer ends failed file-problem and the peer gets a cancel', async () => {
    for (const header of [prompt(11), prompt(5, 2)]) {
      const r = rig();
      const into = countingSink();
      await accepted(r, into.sink);
      r.link.feed(header);
      await tick();
      expect(into.begun).toEqual([]);
      expect(last(r)).toMatchObject({ state: 'failed', failure: 'file-problem' });
      expect(r.link.closed).toBe(true);
      expect(r.sent.at(-1)).toEqual(cancelTo('Alice'));
    }
  });

  it('a header that names a larger total than the offer: each status keeps the count and the total inside the offer', async () => {
    const r = rig();
    const into = countingSink();
    await accepted(r, into.sink);
    const header = encodeOftHeader({
      type: OFT_PROMPT, cookie: COOKIE, totalFiles: 1, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: 0xffff_ffff, bytes: 4, modifiedAt: 0,
      checksum: OFT_CHECKSUM_START, received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: 0, name: 'notes.txt',
    });
    r.link.feed(header);
    r.link.feed(new Uint8Array(4));
    await tick();
    expect(into.begun.map((incoming) => incoming.bytes)).toEqual([4]);
    const moved = r.statuses.filter((status) => status.bytesDone > 0);
    expect(moved.length).toBeGreaterThan(0);
    for (const status of r.statuses) {
      expect(status.bytesTotal).toBeLessThanOrEqual(ONE.totalBytes);
      expect(status.count).toBeLessThanOrEqual(ONE.count);
      expect(status.bytesDone).toBeLessThanOrEqual(status.bytesTotal);
    }
  });

  it('a sink that fails ends the transfer failed folder-problem and the peer gets a cancel', async () => {
    const r = rig();
    await accepted(r, { begin: async () => Promise.reject(new Error('no room')) });
    r.link.feed(prompt(10));
    await tick();
    expect(last(r)).toMatchObject({ state: 'failed', failure: 'folder-problem' });
    expect(r.sent.at(-1)).toEqual(cancelTo('Alice'));
  });

  it('a peer that closes before its first header: peer-closed after the wait, or cancelled when its cancel comes first', async () => {
    const waited = rig();
    await accepted(waited, sink);
    waited.link.end();
    await tick();
    expect(last(waited)).toMatchObject({ state: 'connecting' });
    await waited.timers.advance(1000);
    expect(last(waited)).toMatchObject({ state: 'failed', failure: 'peer-closed' });
    expect(waited.statuses.map((status) => status.state)).toEqual(['connecting', 'failed']);

    const told = rig();
    await accepted(told, sink);
    told.link.end();
    await tick();
    told.t.handle(toClient(cancelTo('Bob'), 'Alice'));
    expect(last(told)).toMatchObject({ state: 'cancelled', by: 'peer' });
    await told.timers.advance(1000);
    expect(last(told)).toMatchObject({ state: 'cancelled', by: 'peer' });
  });

  it('the first header moves the transfer to transferring', async () => {
    const r = rig();
    const into = countingSink();
    await accepted(r, into.sink);
    r.link.feed(prompt(10));
    await tick();
    expect(into.begun).toHaveLength(1);
    expect(r.statuses.map((status) => status.state)).toEqual(['connecting', 'transferring']);
  });

  it('a connection that does not open ends failed peer-closed', async () => {
    const r = rig({ open: async () => Promise.reject(new Error('no route')) });
    r.t.handle(proposal());
    r.t.accept(ID, sink);
    await tick();
    expect(r.statuses.map((status) => [status.state, status.failure])).toEqual([['connecting', undefined], ['failed', 'peer-closed']]);
  });
});

describe('a name that is signed in two times', () => {
  it('the hello of the sign-on service in place of a header: taken-elsewhere, and the offerer gets no cancel', async () => {
    const r = rig();
    const into = countingSink();
    await accepted(r, into.sink);
    const sentBefore = r.sent.length;
    r.link.feed(HELLO);
    await tick();
    expect(last(r)).toMatchObject({ state: 'failed', failure: 'taken-elsewhere' });
    expect(r.link.closed).toBe(true);
    expect(r.sent).toHaveLength(sentBefore);
    expect(into.begun).toEqual([]);
  });

  it('a header with a wrong cookie ends failed file-problem and the offerer gets a cancel', async () => {
    const r = rig();
    await accepted(r, sink);
    r.link.feed(encodeOftHeader({
      type: OFT_PROMPT, cookie: 9n, totalFiles: 1, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: 10, bytes: 10, modifiedAt: 0,
      checksum: OFT_CHECKSUM_START, received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: 0, name: 'notes.txt',
    }));
    await tick();
    expect(last(r)).toMatchObject({ state: 'failed', failure: 'file-problem' });
    expect(r.sent.at(-1)).toEqual(cancelTo('Alice'));
  });

  it('a cancel on the BOS link does not end an offer that moves; the close of the connection ends it cancelled by peer', async () => {
    const r = rig();
    const id = await offering(r);
    const count = r.statuses.length;
    r.t.handle(toClient(cancelTo('Alice'), 'Bob'));
    await tick();
    expect(r.statuses).toHaveLength(count);
    expect(r.link.closed).toBe(false);
    r.link.end();
    await tick();
    expect(last(r)).toMatchObject({ id, state: 'cancelled', by: 'peer' });
  });

  it('a cancel on the BOS link that no close follows is forgotten: a later close ends the offer failed peer-closed', async () => {
    const r = rig();
    const id = await offering(r);
    r.t.handle(toClient(cancelTo('Alice'), 'Bob'));
    await r.timers.advance(1000);
    expect(last(r)).toMatchObject({ id, state: 'transferring' });
    r.link.end();
    await tick();
    await r.timers.advance(1000);
    expect(last(r)).toMatchObject({ id, state: 'failed', failure: 'peer-closed' });
  });

  it('an offer that moves ends done after a cancel on the BOS link when the peer takes the file', async () => {
    const r = rig();
    const id = await offering(r);
    r.t.handle(toClient(cancelTo('Alice'), 'Bob'));
    const header = decodeOftHeader(r.link.written[0] as Uint8Array);
    r.link.feed(encodeOftHeader({ ...header, type: OFT_ACK }));
    r.link.feed(encodeOftHeader({ ...header, type: OFT_DONE }));
    await tick();
    expect(last(r)).toMatchObject({ id, state: 'done' });
  });
});

describe('reset', () => {
  it('ends a transfer that waits for the peer failed signed-off and an offer with no answer cancelled, and sends nothing', async () => {
    const r = rig();
    const out = r.t.sendFiles('Bob', [sized(4)]);
    r.t.handle(proposal({ cookie: 5n }));
    await tick();
    const sentBefore = r.sent.length;
    r.reset();
    await tick();
    expect(r.statuses.slice(1)).toEqual([
      expect.objectContaining({ id: out, direction: 'out', state: 'failed', failure: 'signed-off' }),
      expect.objectContaining({ id: 'alice:0000000000000005', direction: 'in', state: 'cancelled', by: 'self' }),
    ]);
    expect(r.sent).toHaveLength(sentBefore);
    expect(() => r.t.accept('alice:0000000000000005', sink)).toThrow(expect.objectContaining(INVALID));
    r.reset();
    expect(r.statuses).toHaveLength(3);
  });

  it('leaves the offers of the Rendezvous to its owner', async () => {
    const r = rig();
    const out = r.t.sendFiles('Bob', [sized(4)]);
    await tick();
    r.t.reset();
    expect(last(r)).toMatchObject({ id: out, state: 'failed', failure: 'signed-off' });
    // The offer still holds its cookie: a second offer with it is refused.
    expect(await r.rendezvous.offer('Bob', COOKIE, 'send-file', ONE)).toEqual({ outcome: 'failed', by: 'self' });
    r.rendezvous.reset();
    await tick();
    expect(r.statuses).toHaveLength(2);
  });
});
