import { describe, expect, it } from 'vitest';
import { GetFile } from '../../../src/client/get-file.js';
import type { GetFileDeps } from '../../../src/client/get-file.js';
import { OscarClient } from '../../../src/client/oscar-client.js';
import { MAX_WAITING_OFFERS } from '../../../src/client/transfers.js';
import { PeerClosedError } from '../../../src/client/peer-link.js';
import type { PeerLink } from '../../../src/client/peer-link.js';
import { OFFER_ACCEPT_MS, Rendezvous } from '../../../src/client/rendezvous.js';
import { ByteReader, ByteWriter } from '../../../src/wire/bytes.js';
import {
  FAMILY_ICBM, GET_FILE_MAX_ENTRIES, GET_FILE_MAX_LISTING_BYTES, GET_FILE_MAX_SERVING, ICBM_CHANNEL_RENDEZVOUS, ICBM_CLIENT_ERR, ICBM_MSG_TO_CLIENT,
  RDV_CANCEL_DECLINED,
} from '../../../src/wire/constants.js';
import { decodeLst1Listing, encodeListing, listingAck, listingDone, listingFrame, listingHeader, readListing } from '../../../src/wire/listing.js';
import type { ListingEntry } from '../../../src/wire/listing.js';
import { OFT_CHECKSUM_START, OFT_DONE, OFT_FILE_REQUEST, OFT_PROMPT, decodeOftFrame, decodeOftHeader, encodeOftHeader, oftChecksum } from '../../../src/wire/oft.js';
import type { OftHeader } from '../../../src/wire/oft.js';
import { encodeGetFileProposal, encodeRendezvousCancel, getFileProposalNumber } from '../../../src/wire/rendezvous.js';
import type { PeerAddress } from '../../../src/wire/rendezvous.js';
import type { Snac } from '../../../src/wire/snac.js';
import { decodeTlvs, encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import type { Tlv } from '../../../src/wire/tlv.js';
import { toHex } from '../../../src/wire/bytes.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';
import type { BrowseStatus, FileListing, ShareRequest, ShareStatus, ShareTaken, SharedSource } from '../../../src/model/get-file.js';
import type { FileSink, TransferStatus } from '../../../src/model/transfer.js';
import { ManualTimers, captureLog, tick, waitFor } from '../../fake/oscar-client.js';
import { PeerGetFile } from '../../fake/peer-get-file.js';

const ID = 'bob:0000000000000001';
const SINK: FileSink = { begin: async () => { throw new Error('no file comes'); } };

describe('Get File calls on a client that never signed on', () => {
  const calls: [string, (client: OscarClient) => Promise<unknown>][] = [
    ['browseFiles', (client) => client.browseFiles('Bob')],
    ['takeFile', (client) => client.takeFile(ID, ['a.txt'], SINK)],
    ['closeBrowse', (client) => client.closeBrowse(ID)],
    ['shareFiles', (client) => client.shareFiles(null)],
    ['allowShare', (client) => client.allowShare(ID)],
    ['refuseShare', (client) => client.refuseShare(ID)],
  ];

  it.each(calls)('%s rejects not-signed-on', async (_name, call) => {
    const client = new OscarClient({ getFile: {} });
    await expect(call(client)).rejects.toMatchObject({ name: 'OscarError', info: { kind: 'not-signed-on' } });
  });
});

const COOKIE = 0x0102030405060708n;
const BROWSE = 'bob:0102030405060708';
const ADDRESS: PeerAddress = { ip: '192.0.2.7', port: 5190 };
const INVALID = { name: 'OscarError', info: { kind: 'local', code: 'invalid-argument' } };
const MINUTE = Math.trunc(new Date(2020, 0, 2, 3, 4).getTime() / 1000);

// A connection that gives the bytes the test feeds it.
class ScriptLink implements PeerLink {
  readonly written: Uint8Array[] = [];
  closed = false;
  private held = new Uint8Array(0);
  private wake: (() => void) | null = null;

  feed(bytes: Uint8Array): void {
    this.held = Uint8Array.from([...this.held, ...bytes]);
    this.wake?.();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new PeerClosedError();
    this.written.push(bytes.slice());
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.held.length < n) {
      if (this.closed) throw new PeerClosedError();
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

  /** The type of each header that this end wrote. */
  types(): number[] {
    return this.written.filter((bytes) => bytes.length >= 256).map((bytes) => decodeOftHeader(bytes).type);
  }
}

type Rig = {
  g: GetFile;
  rendezvous: Rendezvous;
  timers: ManualTimers;
  logs: ReturnType<typeof captureLog>;
  sent: Uint8Array[];
  listings: FileListing[];
  browses: BrowseStatus[];
  transfers: TransferStatus[];
  requests: ShareRequest[];
  shares: ShareStatus[];
  taken: ShareTaken[];
  link: ScriptLink;
  opened: number;
};

function rig(over: Partial<GetFileDeps> = {}): Rig {
  const timers = new ManualTimers();
  const logs = captureLog();
  const send = async (body: Uint8Array): Promise<void> => {
    one.sent.push(body);
  };
  const rendezvous = new Rendezvous({
    log: logs.log,
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
    g: undefined as unknown as GetFile, rendezvous, timers, logs, sent: [], listings: [], browses: [], transfers: [], requests: [], shares: [], taken: [],
    link: new ScriptLink(), opened: 0,
  };
  one.g = new GetFile({
    log: logs.log,
    now: timers.now,
    timers: timers.api,
    enabled: true,
    rendezvous,
    send,
    isBlocked: () => false,
    maxListingBytes: GET_FILE_MAX_LISTING_BYTES,
    maxEntries: GET_FILE_MAX_ENTRIES,
    maxServing: GET_FILE_MAX_SERVING,
    emitListing: (listing) => one.listings.push(listing),
    emitBrowse: (status) => one.browses.push(status),
    emitTransfer: (status) => one.transfers.push(status),
    emitRequest: (request) => one.requests.push(request),
    emitShare: (status) => one.shares.push(status),
    emitTaken: (taken) => one.taken.push(taken),
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

const proposal = (sequence: 1 | 2, from = 'Bob', cookie = COOKIE): Snac =>
  toClient(encodeGetFileProposal(cookie, 'Alice', { sequence, address: ADDRESS }), from);
const cancelFrom = (from: string, reason: number): Snac => toClient(encodeRendezvousCancel(COOKIE, 'Alice', 'get-file', reason), from);
const clientError = (from: string, cookie = COOKIE): Snac => ({
  family: FAMILY_ICBM, subtype: ICBM_CLIENT_ERR, flags: 0, requestId: 0,
  body: new ByteWriter().u64(cookie).u16(ICBM_CHANNEL_RENDEZVOUS).str8(from).u16(3).toBytes(),
});
const trail = (r: Rig): string[] => r.browses.map((s) => s.end ?? s.state);
const of = (r: Rig, id: string): TransferStatus[] => r.transfers.filter((status) => status.id === id);

// One listing holds each file of the whole shared folder.
const ROOT: ListingEntry[] = [
  { path: ['a.txt'], bytes: 10, modifiedAt: MINUTE },
  { path: ['b.txt'], bytes: 10, modifiedAt: MINUTE },
  { path: ['sub', 'c.txt'], bytes: 10, modifiedAt: MINUTE },
];

// The holder accepted, the connection is open and the first listing came.
async function open(r: Rig, entries: readonly ListingEntry[] = ROOT): Promise<string> {
  const id = r.g.browse('Bob');
  await tick();
  expect(r.g.handle(proposal(2))).toBe(true);
  await tick();
  expect(r.opened).toBe(1);
  const listing = encodeListing(entries);
  r.link.feed(encodeOftHeader(listingHeader(COOKIE, listing, MINUTE)));
  r.link.feed(listing.bytes);
  await waitFor(() => r.listings.length === 1, 'the first listing');
  expect(trail(r)).toEqual(['waiting', 'connecting', 'open']);
  return id;
}

function prompt(data: Uint8Array, name: string, checksum = oftChecksum(data)): OftHeader {
  return {
    type: OFT_PROMPT, cookie: COOKIE, totalFiles: 1, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: data.length, bytes: data.length,
    modifiedAt: MINUTE, checksum, received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: 0, name,
  };
}

function memorySink(): { sink: FileSink; begun: number; aborted: number; finished: number } {
  const out = {
    begun: 0,
    aborted: 0,
    finished: 0,
    sink: {
      begin: async () => {
        out.begun++;
        return {
          write: async () => {},
          finish: async () => {
            out.finished++;
          },
          abort: async () => {
            out.aborted++;
          },
        };
      },
    } as FileSink,
  };
  return out;
}

describe('the Get File part', () => {
  it('a client without getFile ignores a Get File proposal and sends nothing back', async () => {
    const r = rig({ enabled: false });
    expect(r.g.handle(proposal(1))).toBe(false);
    expect(r.g.handle(clientError('Bob'))).toBe(false);
    await tick();
    expect(r.sent).toEqual([]);
    expect(() => r.g.browse('Bob')).toThrowError(expect.objectContaining(INVALID));
    expect(r.browses).toEqual([]);
  });

  it('browse for a peer with a live browse returns the same id and sends no second proposal', async () => {
    const r = rig();
    const id = r.g.browse('Bob');
    expect(id).toBe(BROWSE);
    await tick();
    expect(r.g.browse('b o b')).toBe(id);
    await tick();
    expect(r.sent).toEqual([encodeGetFileProposal(COOKIE, 'Bob', { sequence: 1, address: { ip: '0.0.0.0', port: 5190 } })]);
    expect(r.browses).toEqual([{ id, peer: 'Bob', state: 'waiting' }]);
  });

  it('the client error of the peer while the browse waits: declined by peer', async () => {
    const r = rig();
    r.g.browse('Bob');
    await tick();
    expect(r.g.handle(clientError('Carol'))).toBe(false);
    expect(r.g.handle(clientError('Bob', COOKIE ^ 1n))).toBe(false);
    expect(r.g.handle(clientError('Bob'))).toBe(true);
    await tick();
    expect(r.browses.at(-1)).toEqual({ id: BROWSE, peer: 'Bob', state: 'closed', end: 'declined', by: 'peer' });
  });

  it('a cancel with the declined reason while the browse waits: declined by peer', async () => {
    const r = rig();
    r.g.browse('Bob');
    await tick();
    expect(r.g.handle(cancelFrom('Bob', RDV_CANCEL_DECLINED))).toBe(true);
    await tick();
    expect(trail(r)).toEqual(['waiting', 'declined']);
    expect(r.browses.at(-1)?.by).toBe('peer');
    // The cookie is free, thus a new browse makes a new offer.
    r.g.browse('Bob');
    await tick();
    expect(r.sent).toHaveLength(2);
  });

  it('a proposal of a peer gets a cancel and no connection while no files are shared', async () => {
    const r = rig();
    expect(r.g.handle(proposal(1, 'Carol'))).toBe(true);
    await tick();
    expect(r.sent).toEqual([encodeRendezvousCancel(COOKIE, 'Carol', 'get-file', RDV_CANCEL_DECLINED)]);
    expect(r.opened).toBe(0);
  });

  it('close while the browse waits: closed by self, and the peer gets a cancel', async () => {
    const r = rig();
    const id = r.g.browse('Bob');
    await tick();
    await r.g.close(id);
    expect(r.browses.at(-1)).toEqual({ id, peer: 'Bob', state: 'closed', end: 'closed', by: 'self' });
    expect(r.sent.at(-1)).toEqual(encodeRendezvousCancel(COOKIE, 'Bob', 'get-file', RDV_CANCEL_DECLINED));
    await r.g.close(id);
    expect(r.sent).toHaveLength(2);
  });

  it('take for an id that is not live is refused; cancelTransfer gives false', async () => {
    const r = rig();
    expect(() => r.g.take(BROWSE, ['a.txt'], SINK)).toThrowError(expect.objectContaining(INVALID));
    expect(r.g.cancelTransfer(BROWSE)).toBe(false);
  });

  it('one listing comes for a browse: each file of the whole shared folder, and the part has no call that asks for a folder', async () => {
    const r = rig();
    const id = await open(r);
    expect(r.listings).toHaveLength(1);
    expect(r.listings[0]).toMatchObject({ browseId: id, from: 'Bob', folder: [], truncated: false, damaged: false });
    expect(r.listings[0]?.entries).toEqual(ROOT.map((entry) => ({ ...entry, folder: false })));
    expect('list' in r.g).toBe(false);
  });

  it('the holder closes in answer to a request: failed file-problem, the browse ends not-there, and the take that waits fails peer-closed', async () => {
    const r = rig();
    const id = await open(r);
    const into = memorySink();
    const first = r.g.take(id, ['a.txt'], into.sink);
    const second = r.g.take(id, ['b.txt'], into.sink);
    await waitFor(() => r.link.types().includes(OFT_FILE_REQUEST), 'the request');
    r.link.close();
    await waitFor(() => trail(r).at(-1) === 'not-there', 'the browse ends');
    expect(of(r, first).map((s) => s.failure ?? s.state)).toEqual(['connecting', 'file-problem']);
    expect(of(r, second).map((s) => s.failure ?? s.state)).toEqual(['connecting', 'peer-closed']);
    expect(r.browses.at(-1)).toEqual({ id, peer: 'Bob', state: 'closed', end: 'not-there', by: 'peer' });
    expect(into.begun).toBe(0);
  });

  it('the holder closes while no request runs: the browse ends peer-closed by peer, and the next browse sends a new proposal', async () => {
    const r = rig();
    const id = await open(r);
    const proposals = r.sent.length;
    expect(r.g.browse('Bob')).toBe(id);
    r.link.close();
    await waitFor(() => trail(r).at(-1) === 'peer-closed', 'the browse ends');
    expect(r.browses.at(-1)).toEqual({ id, peer: 'Bob', state: 'closed', end: 'peer-closed', by: 'peer' });
    r.g.browse('Bob');
    await tick();
    expect(r.sent).toHaveLength(proposals + 1);
    expect(trail(r).at(-1)).toBe('waiting');
  });

  it('two files on one connection: the answer after each file has bit 0, and the second request is made from the first answer', async () => {
    const r = rig();
    const id = await open(r);
    const into = memorySink();
    const data = new Uint8Array(10).fill(3);
    const first = r.g.take(id, ['a.txt'], into.sink);
    r.link.feed(encodeOftHeader(prompt(data, 'a.txt')));
    r.link.feed(data);
    await waitFor(() => of(r, first).at(-1)?.state === 'done', 'the first take ends');
    const second = r.g.take(id, ['b.txt'], into.sink);
    r.link.feed(encodeOftHeader(prompt(data, 'b.txt')));
    r.link.feed(data);
    await waitFor(() => of(r, second).at(-1)?.state === 'done', 'the second take ends');
    const frames = r.link.written.filter((bytes) => bytes.length >= 256).map((bytes) => decodeOftFrame(bytes));
    const dones = frames.filter((frame) => frame.header.type === OFT_DONE);
    const requests = frames.filter((frame) => frame.header.type === OFT_FILE_REQUEST);
    expect(dones.map((frame) => frame.flags & 0x01)).toEqual([1, 1]);
    expect(requests[1]?.header.received).toBe(10);
    expect(trail(r).at(-1)).toBe('open');
  });

  it('a file of a folder is taken by its path from the one listing', async () => {
    const r = rig();
    const id = await open(r);
    const into = memorySink();
    const take = r.g.take(id, ['sub', 'c.txt'], into.sink);
    const data = new Uint8Array(10).fill(3);
    r.link.feed(encodeOftHeader(prompt(data, 'sub\u0001c.txt')));
    r.link.feed(data);
    await waitFor(() => of(r, take).at(-1)?.state === 'done', 'the take ends');
    expect(into).toMatchObject({ begun: 1, finished: 1 });
  });

  it('the holder answers a request with a header that is not a file: failed file-problem, and the browse stays open', async () => {
    const r = rig();
    const id = await open(r);
    const into = memorySink();
    const take = r.g.take(id, ['a.txt'], into.sink);
    r.link.feed(encodeOftHeader({ ...prompt(new Uint8Array(0), 'a.txt'), type: OFT_DONE }));
    await waitFor(() => of(r, take).at(-1)?.state === 'failed', 'the take fails');
    expect(of(r, take).map((s) => [s.state, s.failure])).toEqual([['connecting', undefined], ['failed', 'file-problem']]);
    expect(into.begun).toBe(0);
    expect(trail(r).at(-1)).toBe('open');
    expect(r.link.closed).toBe(false);
  });

  it('a file with a wrong checksum: failed file-problem, the browse ends bad-frame, and the take that waits fails peer-closed', async () => {
    const r = rig();
    const id = await open(r);
    const into = memorySink();
    const first = r.g.take(id, ['a.txt'], into.sink);
    const second = r.g.take(id, ['b.txt'], into.sink);
    const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    r.link.feed(encodeOftHeader(prompt(data, 'a.txt', (oftChecksum(data) ^ 0x10000) >>> 0)));
    r.link.feed(data);
    await waitFor(() => trail(r).at(-1) === 'bad-frame', 'the browse ends');
    expect(of(r, first).map((s) => s.failure ?? s.state)).toEqual(['connecting', 'transferring', 'file-problem']);
    expect(of(r, second).map((s) => s.failure ?? s.state)).toEqual(['connecting', 'peer-closed']);
    expect(r.browses.at(-1)).toEqual({ id, peer: 'Bob', state: 'closed', end: 'bad-frame', by: 'peer' });
    expect(into).toMatchObject({ begun: 1, aborted: 1, finished: 0 });
    expect(r.link.closed).toBe(true);
    expect(r.link.types().filter((type) => type === OFT_FILE_REQUEST)).toHaveLength(1);
  });

  it('a path that the listing has two times keeps its first size: a PROMPT of the second size is a size mismatch, and the sink is not asked', async () => {
    const r = rig();
    const twice: ListingEntry[] = [{ path: ['a.txt'], bytes: 10, modifiedAt: MINUTE }, { path: ['a.txt'], bytes: 5000, modifiedAt: MINUTE }];
    const id = await open(r, twice);
    const into = memorySink();
    const take = r.g.take(id, ['a.txt'], into.sink);
    r.link.feed(encodeOftHeader(prompt(new Uint8Array(5000), 'a.txt')));
    await waitFor(() => trail(r).at(-1) === 'bad-frame', 'the browse ends');
    expect(of(r, take).map((s) => s.failure ?? s.state)).toEqual(['connecting', 'file-problem']);
    expect(of(r, take).at(-1)?.bytesTotal).toBe(10);
    expect(into.begun).toBe(0);
  });

  it('cancelTransfer on a take that waits its turn removes it, and the browse stays open', async () => {
    const r = rig();
    const id = await open(r);
    const into = memorySink();
    const first = r.g.take(id, ['a.txt'], into.sink);
    const second = r.g.take(id, ['b.txt'], into.sink);
    await tick();
    expect(r.g.cancelTransfer(second)).toBe(true);
    expect(of(r, second).at(-1)).toMatchObject({ state: 'cancelled', by: 'self', direction: 'in', count: 1, name: 'b.txt', bytesTotal: 10 });
    expect(r.g.cancelTransfer(second)).toBe(false);
    const data = new Uint8Array(10).fill(7);
    r.link.feed(encodeOftHeader(prompt(data, 'a.txt')));
    r.link.feed(data);
    await waitFor(() => of(r, first).at(-1)?.state === 'done', 'the first take ends');
    await tick();
    expect(trail(r).at(-1)).toBe('open');
    expect(r.link.types().filter((type) => type === OFT_FILE_REQUEST)).toHaveLength(1);
  });

  it('no name of a file is in a log line at info or above', async () => {
    const r = rig();
    const id = await open(r);
    const take = r.g.take(id, ['a.txt'], memorySink().sink);
    const data = new Uint8Array(10).fill(7);
    r.link.feed(encodeOftHeader(prompt(data, 'a.txt')));
    r.link.feed(data);
    await waitFor(() => of(r, take).at(-1)?.state === 'done', 'the take ends');
    await r.g.close(id);
    const loud = r.logs.lines.filter((line) => line.level !== 'debug').map((line) => `${line.msg} ${JSON.stringify(line.fields ?? {})}`).join('\n');
    expect(loud).toContain('a get file take ended');
    expect(loud).not.toContain('a.txt');
    expect(loud.toLowerCase()).not.toContain('bob');
  });
});

const SOURCE: SharedSource = { list: async () => [], open: async () => null };
const SHARE = BROWSE;
const cancelTo = (to: string, cookie = COOKIE): Uint8Array => encodeRendezvousCancel(cookie, to, 'get-file', RDV_CANCEL_DECLINED);
const shareTrail = (r: Rig, id = SHARE): string[] => r.shares.filter((s) => s.id === id).map((s) => s.end ?? s.state);

describe('the Get File part as the holder', () => {
  it('with no source a proposal gets a cancel at once, and no request shows', async () => {
    const r = rig();
    expect(r.g.handle(proposal(1))).toBe(true);
    await tick();
    expect(r.sent).toEqual([cancelTo('Bob')]);
    expect(r.requests).toEqual([]);
    expect(r.shares).toEqual([]);
  });

  it('a proposal with a source: shareRequest and the status asked, and nothing is sent', async () => {
    const r = rig();
    r.g.share(SOURCE);
    expect(r.g.sharing).toBe(true);
    expect(r.g.handle(proposal(1))).toBe(true);
    await tick();
    expect(r.requests).toEqual([{ id: SHARE, from: 'Bob', at: r.timers.now() }]);
    expect(r.shares).toEqual([{ id: SHARE, peer: 'Bob', state: 'asked' }]);
    expect(r.sent).toEqual([]);
    expect(r.opened).toBe(0);
  });

  it('a proposal from a blocked name emits nothing and sends nothing', async () => {
    const r = rig({ isBlocked: (name) => name === 'Bob' });
    r.g.share(SOURCE);
    expect(r.g.handle(proposal(1))).toBe(true);
    await tick();
    expect(r.requests).toEqual([]);
    expect(r.shares).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it('a proposal from a blocked name with no source sends nothing', async () => {
    const r = rig({ isBlocked: (name) => name === 'Bob' });
    expect(r.g.handle(proposal(1))).toBe(true);
    await tick();
    expect(r.sent).toEqual([]);
  });

  it('a proposal of sequence 2 for no browse gets a cancel', async () => {
    const r = rig();
    r.g.share(SOURCE);
    expect(r.g.handle(proposal(2))).toBe(true);
    await tick();
    expect(r.sent).toEqual([cancelTo('Bob')]);
    expect(r.requests).toEqual([]);
  });

  it('a second proposal of a peer that has a request waiting gets a cancel', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    r.g.handle(proposal(1, 'b o b', 9n));
    await tick();
    expect(r.sent).toEqual([cancelTo('b o b', 9n)]);
    expect(r.requests).toHaveLength(1);
  });

  it('a request past MAX_WAITING_OFFERS gets a cancel', async () => {
    const r = rig();
    r.g.share(SOURCE);
    for (let i = 0; i < MAX_WAITING_OFFERS; i++) r.g.handle(proposal(1, `peer${i}`, BigInt(i + 1)));
    await tick();
    expect(r.sent).toEqual([]);
    r.g.handle(proposal(1, 'late', 99n));
    await tick();
    expect(r.sent).toEqual([cancelTo('late', 99n)]);
    // The host hears the request first, then its end.
    expect(r.requests).toHaveLength(MAX_WAITING_OFFERS + 1);
    expect(r.shares.at(-1)).toEqual({ id: 'late:0000000000000063', peer: 'late', state: 'closed', end: 'cancelled', by: 'self' });
    expect(shareTrail(r, 'late:0000000000000063')).toEqual(['cancelled']);
  });

  it('a host that allows a request in the event lets it in past MAX_WAITING_OFFERS requests that wait', async () => {
    const r: Rig = rig({
      emitRequest: (request) => {
        r.requests.push(request);
        if (request.from === 'Friend') r.g.allow(request.id);
      },
    });
    r.g.share(SOURCE);
    for (let i = 0; i < MAX_WAITING_OFFERS; i++) r.g.handle(proposal(1, `peer${i}`, BigInt(i + 1)));
    r.g.handle(proposal(1, 'Friend', 99n));
    await tick();
    expect(shareTrail(r, 'friend:0000000000000063').at(-1)).toBe('connecting');
    expect(r.sent.some((body) => toHex(body) === toHex(cancelTo('Friend', 99n)))).toBe(false);
    expect(r.opened).toBe(1);
  });

  it('a request that nobody answers ends timed-out after OFFER_ACCEPT_MS, and nothing is sent', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    await r.timers.advance(OFFER_ACCEPT_MS - 1);
    expect(shareTrail(r)).toEqual(['asked']);
    await r.timers.advance(1);
    expect(r.shares.at(-1)).toEqual({ id: SHARE, peer: 'Bob', state: 'closed', end: 'timed-out' });
    expect(r.sent).toEqual([]);
    expect(() => r.g.allow(SHARE)).toThrowError(expect.objectContaining(INVALID));
  });

  it('the peer cancels a request that waits: cancelled by peer', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    expect(r.g.handle(cancelFrom('Bob', RDV_CANCEL_DECLINED))).toBe(true);
    expect(r.shares.at(-1)).toEqual({ id: SHARE, peer: 'Bob', state: 'closed', end: 'cancelled', by: 'peer' });
    await tick();
    expect(r.sent).toEqual([]);
  });

  it('the client error of the peer about a request that waits: cancelled by peer', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    expect(r.g.handle(clientError('Carol'))).toBe(false);
    expect(r.g.handle(clientError('Bob'))).toBe(true);
    expect(r.shares.at(-1)).toEqual({ id: SHARE, peer: 'Bob', state: 'closed', end: 'cancelled', by: 'peer' });
  });

  it('allow sends the accept and dials; the status is connecting', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    r.g.allow(SHARE);
    await tick();
    expect(shareTrail(r)).toEqual(['asked', 'connecting']);
    expect(r.opened).toBe(1);
    expect(r.sent).toHaveLength(1);
    await waitFor(() => r.link.types().length === 1, 'the first header');
    expect(r.link.types()).toEqual([0x1108]);
    expect(() => r.g.allow(SHARE)).toThrowError(expect.objectContaining(INVALID));
    expect(() => r.g.allow('bob:0000000000000009')).toThrowError(expect.objectContaining(INVALID));
  });

  it('allow past maxServing ends the request cancelled by self and sends a cancel', async () => {
    const r = rig({ maxServing: 1 });
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    r.g.handle(proposal(1, 'Carol', 2n));
    r.g.allow(SHARE);
    await tick();
    r.g.allow('carol:0000000000000002');
    await tick();
    expect(r.shares.at(-1)).toEqual({ id: 'carol:0000000000000002', peer: 'Carol', state: 'closed', end: 'cancelled', by: 'self' });
    expect(r.sent.at(-1)).toEqual(cancelTo('Carol', 2n));
    expect(r.opened).toBe(1);
  });

  it('a proposal past maxServing shares that are open gets a cancel', async () => {
    const r = rig({ maxServing: 1 });
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    r.g.allow(SHARE);
    await tick();
    r.g.handle(proposal(1, 'Carol', 2n));
    await tick();
    expect(r.sent.at(-1)).toEqual(cancelTo('Carol', 2n));
    expect(r.requests).toHaveLength(1);
  });

  it('share(null) answers each request that waits with a cancel and ends it cancelled by self', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    r.g.share(null);
    await tick();
    expect(r.g.sharing).toBe(false);
    expect(r.sent).toEqual([cancelTo('Bob')]);
    expect(r.shares.at(-1)).toEqual({ id: SHARE, peer: 'Bob', state: 'closed', end: 'cancelled', by: 'self' });
  });

  it('share(another source) keeps a request that waits and closes a share that is open', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    r.g.handle(proposal(1, 'Carol', 2n));
    r.g.allow(SHARE);
    await tick();
    r.g.share({ ...SOURCE });
    expect(r.shares.at(-1)).toEqual({ id: SHARE, peer: 'Bob', state: 'closed', end: 'closed', by: 'self' });
    expect(shareTrail(r, 'carol:0000000000000002')).toEqual(['asked']);
    expect(r.link.closed).toBe(true);
  });

  it('share(null) and share(another source) for a request that was allowed and has no connection: no accept, no dial, and the peer gets a cancel', async () => {
    for (const next of [null, { ...SOURCE }]) {
      const r = rig();
      r.g.share(SOURCE);
      r.g.handle(proposal(1));
      r.g.allow(SHARE);
      r.g.share(next);
      await tick();
      await tick();
      expect(r.shares.at(-1)).toEqual({ id: SHARE, peer: 'Bob', state: 'closed', end: 'closed', by: 'self' });
      expect(r.opened).toBe(0);
      expect(r.sent).toEqual([cancelTo('Bob')]);
    }
  });

  it('refuse of a request that waits sends the cancel and ends it declined by self; another id is ignored', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    await r.g.refuse('bob:0000000000000009');
    expect(r.sent).toEqual([]);
    await r.g.refuse(SHARE);
    expect(r.sent).toEqual([cancelTo('Bob')]);
    expect(r.shares.at(-1)).toEqual({ id: SHARE, peer: 'Bob', state: 'closed', end: 'declined', by: 'self' });
  });

  it('reset ends each share signed-off and keeps the source; forget drops the source', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1));
    r.g.reset();
    expect(r.shares.at(-1)).toEqual({ id: SHARE, peer: 'Bob', state: 'closed', end: 'signed-off' });
    expect(r.g.sharing).toBe(true);
    r.g.handle(proposal(1, 'Bob', 2n));
    expect(r.requests).toHaveLength(2);
    r.g.forget();
    expect(r.g.sharing).toBe(false);
    expect(r.shares.at(-1)).toMatchObject({ state: 'closed', end: 'signed-off' });
    r.g.handle(proposal(1, 'Bob', 3n));
    await tick();
    expect(r.requests).toHaveLength(2);
    expect(r.sent).toEqual([cancelTo('Bob', 3n)]);
  });

  it('a part that is off refuses share, allow and refuse', async () => {
    const r = rig({ enabled: false });
    expect(() => r.g.share(SOURCE)).toThrowError(expect.objectContaining(INVALID));
    expect(() => r.g.allow(SHARE)).toThrowError(expect.objectContaining(INVALID));
    await r.g.refuse(SHARE);
    expect(r.g.sharing).toBe(false);
  });

  it('the log has no name of a peer at info or above', async () => {
    const r = rig();
    r.g.share(SOURCE);
    r.g.handle(proposal(1, 'SecretName'));
    await r.g.refuse('secretname:0102030405060708');
    expect(r.logs.text()).not.toContain('SecretName');
    expect(r.logs.text().toLowerCase()).not.toContain('secretname');
  });
});

const PROPOSALS = loadVectors('aim-rendezvous.json');
const NAMED: SharedSource = {
  name: 'My Files',
  list: async (folder) => (folder.length === 0 ? [{ path: ['a.txt'], folder: false, bytes: 10, modifiedAt: MINUTE }] : null),
  open: async () => null,
};

// A proposal that the server delivers, made from the fragment of a client. `tags` changes the tags of the fragment.
function delivered(fragment: Uint8Array, from: string, tags: (inner: Tlv[]) => Tlv[] = (inner) => inner): { snac: Snac; id: string } {
  const head = fragment.subarray(0, 26);
  const changed = new ByteWriter().bytes(head).bytes(encodeTlvs(tags(decodeTlvs(fragment.subarray(26))))).toBytes();
  const cookie = new ByteReader(head.subarray(2)).u64();
  const body = new ByteWriter().u64(cookie).u16(ICBM_CHANNEL_RENDEZVOUS).str8(from).u16(0).u16(0).bytes(encodeTlvs([tlv.bytes(0x0005, changed)])).toBytes();
  return { snac: { family: FAMILY_ICBM, subtype: ICBM_MSG_TO_CLIENT, flags: 0, requestId: 0, body }, id: `${from.toLowerCase()}:${cookie.toString(16).padStart(16, '0')}` };
}

// The first header that the part writes to a requester with that proposal, and the entries of the listing after it.
async function listingFor(proposed: { snac: Snac; id: string }): Promise<{ flags: number; name: string; filesLeft: number; paths: string[] }> {
  const r = rig();
  r.g.share(NAMED);
  expect(r.g.handle(proposed.snac)).toBe(true);
  expect(r.requests.map((request) => request.id)).toEqual([proposed.id]);
  r.g.allow(proposed.id);
  await waitFor(() => r.link.written.length === 1, 'the header of the listing');
  const first = decodeOftFrame(r.link.written[0] as Uint8Array);
  r.link.feed(encodeOftHeader({ ...first.header, type: 0x1209 }));
  await waitFor(() => r.link.written.length === 2, 'the listing');
  const read = readListing(first, r.link.written[1] as Uint8Array, 100);
  return { flags: first.flags, name: first.header.name, filesLeft: first.header.filesLeft, paths: read.entries.map((entry) => entry.path.join('/')) };
}

describe('the number of a proposal decides the form of the listing', () => {
  const withBlock = (block: Uint8Array | null) => (inner: Tlv[]): Tlv[] => [
    ...inner.filter((one) => one.tag !== 0x2711), ...(block ? [tlv.bytes(0x2711, block)] : []),
  ];

  it('a proposal whose number is 2 gets the Lst1 listing, flags 0x30, the folder name first', async () => {
    const got = await listingFor(delivered(bytesOf(PROPOSALS, '5.9 get file proposal'), 'Bob'));
    expect(got).toEqual({ flags: 0x30, name: '', filesLeft: 1, paths: ['My Files/a.txt'] });
    const more = await listingFor(delivered(bytesOf(PROPOSALS, '5.1 get file proposal'), 'Bob', withBlock(Uint8Array.of(0, 0x12, 0, 3))));
    expect(more.flags).toBe(0x30);
  });

  it('a proposal whose number is 1 gets the text listing, no folder name', async () => {
    for (const name of ['5.1 get file proposal', '3.5 get file proposal']) {
      expect(await listingFor(delivered(bytesOf(PROPOSALS, name), 'Bob')), name).toEqual({ flags: 0x20, name: 'listing.txt', filesLeft: 1, paths: ['a.txt'] });
    }
    const zero = await listingFor(delivered(bytesOf(PROPOSALS, '5.1 get file proposal'), 'Bob', withBlock(Uint8Array.of(0, 0x12, 0, 0, 0, 0, 0, 0))));
    expect(zero.flags).toBe(0x20);
  });

  it('a proposal with no tag 0x2711, or a short one, gets the text listing', async () => {
    const fragment = bytesOf(PROPOSALS, '5.9 get file proposal');
    for (const block of [null, new Uint8Array(0), Uint8Array.of(0, 0x12, 0)]) {
      expect(await listingFor(delivered(fragment, 'Bob', withBlock(block)))).toEqual({ flags: 0x20, name: 'listing.txt', filesLeft: 1, paths: ['a.txt'] });
    }
  });

  it('the proposal of this part has the number 1, thus a holder of this kit answers it with the text listing', async () => {
    const got = await listingFor({ snac: proposal(1), id: SHARE });
    expect(got).toEqual({ flags: 0x20, name: 'listing.txt', filesLeft: 1, paths: ['a.txt'] });
  });

  it('the part has no setting for the form: two requesters at one time get the form of their own proposals', async () => {
    const timers = new ManualTimers();
    const links = [new ScriptLink(), new ScriptLink()];
    let next = 0;
    const rendezvous = new Rendezvous({
      log: captureLog().log, now: timers.now, timers: timers.api, send: async () => {}, allowDial: async () => true,
      open: async () => links[next++] as ScriptLink,
    });
    const part = rig({ rendezvous });
    part.g.share(NAMED);
    const later = delivered(bytesOf(PROPOSALS, '5.9 get file proposal'), 'Bob');
    const older = delivered(bytesOf(PROPOSALS, '5.1 get file proposal'), 'Carol');
    part.g.handle(later.snac);
    part.g.handle(older.snac);
    part.g.allow(later.id);
    await waitFor(() => (links[0] as ScriptLink).written.length === 1, 'the header for the first requester');
    const first = decodeOftFrame((links[0] as ScriptLink).written[0] as Uint8Array);
    (links[0] as ScriptLink).feed(encodeOftHeader({ ...first.header, type: 0x1209 }));
    await waitFor(() => (links[0] as ScriptLink).written.length === 2, 'the listing for the first requester');
    part.g.allow(older.id);
    await waitFor(() => (links[1] as ScriptLink).written.length === 1, 'the header for the second requester');
    const second = decodeOftFrame((links[1] as ScriptLink).written[0] as Uint8Array);
    expect([first.flags, second.flags]).toEqual([0x30, 0x20]);
    expect(decodeLst1Listing((links[0] as ScriptLink).written[1] as Uint8Array, 10).entries[0]?.path).toEqual(['My Files', 'a.txt']);
  });
});

describe('the proposal of a scripted requester', () => {
  // A peer whose offers end at once. `sent` is the body of the proposal as the peer writes it.
  async function sent(client: '5.1' | '5.9' | '3.5'): Promise<Uint8Array> {
    const rendezvous = { offer: async () => ({ outcome: 'failed', by: 'server' }) } as unknown as Rendezvous;
    const peer = new PeerGetFile({ rendezvous, cookie: () => COOKIE, now: () => 0 });
    expect((await peer.browse('Alice', {}, client)).outcome).toBe('failed');
    return peer.outgoing(encodeGetFileProposal(COOKIE, 'Alice', { sequence: 1, address: ADDRESS }));
  }
  const block = (body: Uint8Array, tag: number): Uint8Array | undefined => {
    const fragment = decodeTlvs(toClient(body, 'Bob').body.subarray(8 + 2 + 1 + 3 + 4)).find((one) => one.tag === 0x0005)?.value ?? new Uint8Array(0);
    return decodeTlvs(fragment.subarray(26)).find((one) => one.tag === tag)?.value;
  };

  it('a 5.9 requester writes the number 2: the block of tag 0x2711 and the tag 0x2712 of AIM 5.9', async () => {
    const body = await sent('5.9');
    expect(getFileProposalNumber(toClient(body, 'Bob').body)).toBe(2);
    const theirs = decodeTlvs(bytesOf(PROPOSALS, '5.9 get file proposal').subarray(26));
    expect(block(body, 0x2711)).toEqual(theirs.find((one) => one.tag === 0x2711)?.value);
    expect(block(body, 0x2712)).toEqual(theirs.find((one) => one.tag === 0x2712)?.value);
    // The part reads it as a proposal for the shared files.
    const r = rig();
    r.g.share(NAMED);
    expect(r.g.handle(toClient(body, 'Bob'))).toBe(true);
    expect(r.requests.map((request) => request.id)).toEqual([SHARE]);
  });

  it('a 5.1 requester and a 3.5 requester write the number 1: the proposal of this kit, with no change', async () => {
    const plain = encodeGetFileProposal(COOKIE, 'Alice', { sequence: 1, address: ADDRESS });
    for (const client of ['5.1', '3.5'] as const) {
      const body = await sent(client);
      expect(body).toEqual(plain);
      expect(getFileProposalNumber(toClient(body, 'Bob').body)).toBe(1);
    }
  });

  it('a body that is not a Get File proposal goes out with no change', async () => {
    const rendezvous = { offer: async () => ({ outcome: 'failed', by: 'server' }) } as unknown as Rendezvous;
    const peer = new PeerGetFile({ rendezvous, cookie: () => COOKIE, now: () => 0 });
    await peer.browse('Alice', {}, '5.9');
    const cancel = encodeRendezvousCancel(COOKIE, 'Alice', 'get-file', RDV_CANCEL_DECLINED);
    expect(peer.outgoing(cancel)).toEqual(cancel);
    const other = encodeGetFileProposal(9n, 'Alice', { sequence: 1, address: ADDRESS });
    expect(peer.outgoing(other)).toEqual(other);
    expect(peer.outgoing(new Uint8Array(3))).toEqual(new Uint8Array(3));
  });
});

describe('the scripted peers of the 5.9 kind', () => {
  const LST1 = loadVectors('aim-get-file-lst1.json');
  const types = (link: ScriptLink): number[] => link.written.filter((bytes) => bytes.length === 256).map((bytes) => decodeOftHeader(bytes).type);

  // A peer that meets the other side on `link` at once.
  function peerOn(link: ScriptLink, cookie: bigint): PeerGetFile {
    const rendezvous = { offer: async () => link, accept: async () => link, heard: () => {} } as unknown as Rendezvous;
    return new PeerGetFile({ rendezvous, cookie: () => cookie, now: () => 0 });
  }

  it('the requester reads a Lst1 listing and writes the request of AIM 5.9, byte for byte', async () => {
    const link = new ScriptLink();
    const listing = decodeOftFrame(bytesOf(LST1, 'listing header that 5.9 answered'));
    link.feed(listing.bytes);
    link.feed(bytesOf(LST1, 'listing that 5.9 read'));
    const browse = await peerOn(link, listing.header.cookie).browse('Alice', {}, '5.9');
    expect([browse.outcome, browse.flags, browse.root.length]).toEqual(['open', 0x30, 207]);
    expect(link.written.map((bytes) => toHex(bytes))).toEqual([vector(LST1, '5.9 listing acknowledge').hex, vector(LST1, '5.9 listing done').hex]);
    void browse.take(['share', 'a.txt']).catch(() => {});
    await waitFor(() => link.written.length === 3, 'the request');
    expect(toHex(link.written[2] as Uint8Array)).toBe(vector(LST1, '5.9 request, a name at the top').hex);
    browse.close();
  });

  it('the requester shows a text listing as an empty list and writes the type 0x120e after its answers: the frame of AIM 5.9', async () => {
    const link = new ScriptLink();
    const unread = decodeOftFrame(bytesOf(LST1, '5.9 frame after a listing that it did not show'));
    const written = encodeListing(ROOT);
    link.feed(listingFrame(unread.header.cookie, written, MINUTE).bytes);
    link.feed(written.bytes);
    const browse = await peerOn(link, unread.header.cookie).browse('Alice', {}, '5.9');
    expect([browse.outcome, browse.flags, browse.root]).toEqual(['open', 0x20, []]);
    expect(types(link)).toEqual([0x1209, 0x120b, 0x120e]);
    expect(toHex(link.written[2] as Uint8Array)).toBe(toHex(unread.bytes));
    // The older kinds read the same listing.
    const older = new ScriptLink();
    older.feed(listingFrame(COOKIE, written, MINUTE).bytes);
    older.feed(written.bytes);
    expect((await peerOn(older, COOKIE).browse('Alice', {}, '3.5')).root).toHaveLength(3);
    expect(types(older)).toEqual([0x1209, 0x120b]);
  });

  it('the 3.5 requester writes a backslash between the parts of a request', async () => {
    const link = new ScriptLink();
    const written = encodeListing(ROOT);
    link.feed(listingFrame(COOKIE, written, MINUTE).bytes);
    link.feed(written.bytes);
    const browse = await peerOn(link, COOKIE).browse('Alice', {}, '3.5');
    void browse.take(['sub', 'c.txt']).catch(() => {});
    await waitFor(() => link.written.length === 3, 'the request');
    expect(decodeOftHeader(link.written[2] as Uint8Array)).toMatchObject({ type: OFT_FILE_REQUEST, name: 'sub\\c.txt' });
    browse.close();
  });

  // The holder of the 5.9 kind got a proposal, wrote its header, and has the two answers that the test gives.
  async function held(marked: boolean): Promise<{ link: ScriptLink; last: ReturnType<typeof listingDone> }> {
    const link = new ScriptLink();
    const proposed = delivered(bytesOf(PROPOSALS, '5.9 get file proposal'), 'Alice');
    const cookie = BigInt(`0x${proposed.id.split(':')[1]}`);
    const peer = peerOn(link, cookie);
    peer.share([{ path: ['a.txt'], bytes: new Uint8Array(10).fill(7) }], 'serves', {}, '5.9');
    peer.heard('Alice', decodeTlvs(proposed.snac.body.subarray(8 + 2 + 1 + 5 + 4)));
    await waitFor(() => link.written.length === 1, 'the header of the listing');
    const first = decodeOftFrame(link.written[0] as Uint8Array);
    expect(first.flags).toBe(0x30);
    // An answer that has bit 0x10 is the header sent back with no change of the flags.
    const keep = (bytes: Uint8Array): Uint8Array => {
      const out = bytes.slice();
      if (marked) out[100] = (out[100] ?? 0) | 0x10;
      return out;
    };
    link.feed(keep(listingAck(first).bytes));
    await waitFor(() => link.written.length === 2, 'the listing');
    const body = link.written[1] as Uint8Array;
    expect(decodeLst1Listing(body, 10).entries.map((entry) => entry.path)).toEqual([['share', 'a.txt']]);
    const last = listingDone(first, body);
    link.feed(keep(last.bytes));
    return { link, last };
  }

  it('the holder answers a request after answers that do not have bit 0x10', async () => {
    const { link, last } = await held(false);
    link.feed(encodeOftHeader({ ...last.header, type: OFT_FILE_REQUEST, name: 'share\u0001a.txt' }));
    await waitFor(() => link.written.length === 3, 'the header of the file');
    expect(decodeOftHeader(link.written[2] as Uint8Array)).toMatchObject({ type: OFT_PROMPT, name: 'share\u0001a.txt', bytes: 10 });
  });

  it('the holder answers no request after an answer that has bit 0x10, and it does not close', async () => {
    const { link, last } = await held(true);
    link.feed(encodeOftHeader({ ...last.header, type: OFT_FILE_REQUEST, name: 'share\u0001a.txt' }));
    link.feed(encodeOftHeader({ ...last.header, type: OFT_FILE_REQUEST, name: 'share\u0001a.txt' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(link.written).toHaveLength(2);
    expect(link.closed).toBe(false);
  });
});
