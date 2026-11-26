import { afterEach, describe, expect, it } from 'vitest';
import { NOT_THERE_CLOSE_MS } from '../../src/client/get-file-session.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { OFFER_ACCEPT_MS } from '../../src/client/rendezvous.js';
import type { PeerAddress } from '../../src/wire/rendezvous.js';
import type { BrowseStatus, FileListing, ShareStatus, SharedSource } from '../../src/model/get-file.js';
import type { FileSink, IncomingFile, OutgoingFile, TransferStatus } from '../../src/model/transfer.js';
import { GET_FILE_MAX_SERVING } from '../../src/wire/constants.js';
import { OFT_CHECKSUM_START, OFT_LISTING_UNREAD } from '../../src/wire/oft.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';
import type { PeerFolderFile } from '../fake/peer-files.js';
import { PEER_SHARE_FOLDER, treeSource } from '../fake/peer-get-file.js';
import type { PeerBrowse, PeerClient, PeerShare } from '../fake/peer-get-file.js';

type Services = Pick<OscarClientOptions, 'getFile' | 'fileTransfer'>;
const MB = 1024 * 1024;
const BUDDIES: FeedbagItem = { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] };
const BOB: FeedbagItem = { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] };

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: FakePeer;

// Bob is a scripted peer on the list of Alice. Alice is a client.
async function start(services: Services = { getFile: {} }): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, timers: timers.api, relay: true });
  fake.addUser('Alice', 'alicepw1');
  bob = fake.peer('Bob');
  fake.setFeedbag('alice', withTypingPref([BUDDIES, BOB]));
  alice = makeClient(fake, { timers, ...services });
  await alice.signOn('Alice', 'alicepw1');
}

async function stop(): Promise<void> {
  await stopAllClients();
  await fake.stop();
}

afterEach(stop);

function content(bytes: number, seed = 7): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const TREE: PeerFolderFile[] = [
  { path: ['a.txt'], bytes: content(1000, 1) },
  { path: ['b.bin'], bytes: content(70_000, 2) },
  { path: ['c.dat'], bytes: content(3, 3) },
  { path: ['sub', 'd.txt'], bytes: content(20, 4) },
  { path: ['sub', 'deep', 'e.txt'], bytes: content(5, 5) },
];

type Saved = { file: IncomingFile; parts: Uint8Array[]; finished: boolean; aborted: boolean };

function memorySink(): { sink: FileSink; files: Saved[] } {
  const files: Saved[] = [];
  return {
    files,
    sink: {
      begin: async (file) => {
        const saved: Saved = { file, parts: [], finished: false, aborted: false };
        files.push(saved);
        return {
          write: async (chunk) => {
            saved.parts.push(chunk.slice());
          },
          finish: async () => {
            saved.finished = true;
          },
          abort: async () => {
            saved.aborted = true;
          },
        };
      },
    },
  };
}

// A sink that holds each write until `open` runs.
function heldSink(): { sink: FileSink; files: Saved[]; open: () => void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const into = memorySink();
  return {
    files: into.files,
    open,
    sink: {
      begin: async (file) => {
        const writer = await into.sink.begin(file);
        return { ...writer, write: (chunk) => gate.then(() => writer.write(chunk)) };
      },
    },
  };
}

const bytesOf = (saved: Saved | undefined): Buffer => Buffer.concat(saved?.parts ?? []);
const browseOf = (id: string): BrowseStatus[] => alice.browses.filter((status) => status.id === id);
const trail = (id: string): string[] => browseOf(id).map((status) => status.end ?? status.state);
const of = (id: string): TransferStatus[] => alice.transfers.filter((status) => status.id === id);
// One word for each change of a transfer: the failure, or the state.
const steps = (id: string): string[] => of(id).map((status) => status.failure ?? status.state).filter((step, i, all) => step !== all[i - 1]);
const shape = (listing: FileListing | undefined): [string, boolean, number][] =>
  (listing?.entries ?? []).map((entry) => [entry.path.join('/'), entry.folder, entry.bytes]);

// Real time for the bytes that are on their way through the relay.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

async function ended(id: string, end: BrowseStatus['end']): Promise<BrowseStatus> {
  await waitFor(() => browseOf(id).at(-1)?.state === 'closed', `the browse ends; it reads ${trail(id).join(', ')}`);
  expect(browseOf(id).at(-1)?.end).toBe(end);
  return browseOf(id).at(-1) as BrowseStatus;
}

async function transferEnded(id: string, state: TransferStatus['state']): Promise<TransferStatus> {
  const over = (): boolean => ['done', 'cancelled', 'failed', 'declined'].includes(of(id).at(-1)?.state ?? '');
  await waitFor(over, `the transfer ends; it reads ${steps(id).join(', ')}`);
  expect(of(id).at(-1)?.state).toBe(state);
  return of(id).at(-1) as TransferStatus;
}

// Bob shares, Alice browses, and the first listing came.
async function opened(tree: readonly PeerFolderFile[] = TREE, client: PeerClient = '5.1'): Promise<{ id: string; share: PeerShare }> {
  const share = bob.shareFiles(tree, 'serves', {}, client);
  const id = await alice.client.browseFiles('Bob');
  await waitFor(() => ['open', 'closed'].includes(browseOf(id).at(-1)?.state ?? ''), 'the browse opens');
  expect(trail(id)).toEqual(['waiting', 'connecting', 'open']);
  return { id, share };
}

describe('Get File from a scripted holder', () => {
  it('Alice browses Bob: fileListing has Bob\'s root entries; the browse is open', async () => {
    await start();
    const { id } = await opened();
    expect(id).toMatch(/^bob:[0-9a-f]{16}$/);
    expect(browseOf(id)).toEqual([
      { id, peer: 'Bob', state: 'waiting' },
      { id, peer: 'Bob', state: 'connecting' },
      { id, peer: 'Bob', state: 'open' },
    ]);
    expect(alice.fileListings).toHaveLength(1);
    expect(alice.fileListings[0]).toMatchObject({ browseId: id, from: 'Bob', folder: [], truncated: false, damaged: false });
    // One listing holds each file of the whole shared folder, and no folder.
    expect(shape(alice.fileListings[0])).toEqual([
      ['a.txt', false, 1000], ['b.bin', false, 70_000], ['c.dat', false, 3], ['sub/d.txt', false, 20], ['sub/deep/e.txt', false, 5],
    ]);
    expect(fake.relayed()).toHaveLength(1);
    await alice.client.closeBrowse(id);
    expect(await ended(id, 'closed')).toMatchObject({ by: 'self' });
  });

  it('one fileListing comes for the browse, with each file of each folder, and no entry is a folder', async () => {
    await start();
    const { id } = await opened();
    await settle();
    expect(alice.fileListings).toHaveLength(1);
    expect(alice.fileListings[0]?.folder).toEqual([]);
    expect(alice.fileListings[0]?.entries.map((entry) => entry.path)).toEqual(TREE.map((file) => [...file.path]));
    expect(alice.fileListings[0]?.entries.every((entry) => !entry.folder)).toBe(true);
    expect(trail(id).at(-1)).toBe('open');
  });

  it('Alice takes a.txt into a sink: transfer goes connecting, transferring, done; the bytes are equal', async () => {
    await start();
    const { id, share } = await opened();
    const into = memorySink();
    const take = await alice.client.takeFile(id, ['a.txt'], into.sink);
    expect(take).toMatch(/^bob:[0-9a-f]{16}$/);
    expect(take).not.toBe(id);
    expect(await transferEnded(take, 'done')).toEqual({
      id: take, direction: 'in', peer: 'Bob', state: 'done', count: 1, index: 0, name: 'a.txt', bytesDone: 1000, bytesTotal: 1000,
    });
    expect(steps(take)).toEqual(['connecting', 'transferring', 'done']);
    expect(of(take).every((status) => status.bytesTotal === 1000 && status.count === 1 && status.direction === 'in')).toBe(true);
    expect(into.files.map((saved) => [saved.file.name, saved.file.bytes, saved.file.index, saved.file.count, saved.finished])).toEqual([['a.txt', 1000, 0, 1, true]]);
    expect(bytesOf(into.files[0]).equals(Buffer.from(TREE[0]?.bytes ?? []))).toBe(true);
    await waitFor(() => share.taken().length === 1, 'the record of Bob');
    expect(share.taken()).toEqual([{ path: ['a.txt'], bytes: 1000 }]);
    expect(trail(id).at(-1)).toBe('open');
  });

  it('Alice takes a file of a folder', async () => {
    await start();
    const { id } = await opened();
    const into = memorySink();
    const take = await alice.client.takeFile(id, ['sub', 'd.txt'], into.sink);
    expect(await transferEnded(take, 'done')).toMatchObject({ name: 'd.txt', bytesDone: 20, bytesTotal: 20 });
    expect(bytesOf(into.files[0]).equals(Buffer.from(TREE[3]?.bytes ?? []))).toBe(true);
  });

  it('Alice takes a file with a Latin-1 name', async () => {
    await start();
    const data = content(64, 6);
    const { id, share } = await opened([{ path: ['caf\u00e9.txt'], bytes: data }]);
    const into = memorySink();
    const take = await alice.client.takeFile(id, ['caf\u00e9.txt'], into.sink);
    expect(await transferEnded(take, 'done')).toMatchObject({ name: 'caf\u00e9.txt', bytesDone: 64, bytesTotal: 64 });
    expect(bytesOf(into.files[0]).equals(Buffer.from(data))).toBe(true);
    await waitFor(() => share.taken().length === 1, 'the record of Bob');
    expect(share.taken()).toEqual([{ path: ['caf\u00e9.txt'], bytes: 64 }]);
  });

  it('Alice takes three files: three transfers, done in order, on one link', async () => {
    await start();
    const { id } = await opened();
    const into = memorySink();
    const takes = await Promise.all(['a.txt', 'b.bin', 'c.dat'].map((name) => alice.client.takeFile(id, [name], into.sink)));
    for (const take of takes) await transferEnded(take, 'done');
    expect(new Set(takes).size).toBe(3);
    expect(alice.transfers.filter((status) => status.state === 'done').map((status) => status.id)).toEqual(takes);
    expect(into.files.map((saved) => saved.file.name)).toEqual(['a.txt', 'b.bin', 'c.dat']);
    expect(into.files.map((saved, i) => bytesOf(saved).equals(Buffer.from(TREE[i]?.bytes ?? [])))).toEqual([true, true, true]);
    expect(fake.relayed()).toHaveLength(1);
    expect(trail(id).at(-1)).toBe('open');
  });

  it('Bob asks first (form asks): the browse stays waiting; after allowShare it opens', async () => {
    await start();
    bob.shareFiles(TREE, 'asks');
    const id = await alice.client.browseFiles('Bob');
    await waitFor(() => fake.relaySessions().length === 1, 'the offer reaches the server');
    await imRoundTrip(fake, alice);
    await settle();
    expect(trail(id)).toEqual(['waiting']);
    expect(alice.fileListings).toEqual([]);
    bob.allowShare();
    await waitFor(() => browseOf(id).at(-1)?.state === 'open', 'the browse opens');
    expect(trail(id)).toEqual(['waiting', 'connecting', 'open']);
    expect(alice.fileListings).toHaveLength(1);
  });

  it('Bob refuses: the browse ends declined by peer', async () => {
    await start();
    bob.shareFiles(TREE, 'refuses');
    const id = await alice.client.browseFiles('Bob');
    expect(await ended(id, 'declined')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'declined', by: 'peer' });
    expect(trail(id)).toEqual(['waiting', 'declined']);
    expect(fake.relaySessions()).toEqual([]);
  });

  it('nobody answers: after OFFER_ACCEPT_MS the browse ends timed-out', async () => {
    await start();
    const id = await alice.client.browseFiles('Bob');
    await waitFor(() => fake.relaySessions().length === 1, 'the offer reaches the server');
    // A skip, then the due timers: in five minutes of probes, one late answer of the server closes the connection.
    timers.skip(OFFER_ACCEPT_MS - 1);
    await timers.advance(0);
    expect(trail(id)).toEqual(['waiting']);
    await timers.advance(1);
    await ended(id, 'timed-out');
    expect(fake.relaySessions()).toEqual([]);
  });

  it('allowDial false on Alice: the browse ends refused-address', async () => {
    await start({ getFile: { allowDial: () => false } });
    bob.shareFiles(TREE);
    const id = await alice.client.browseFiles('Bob');
    await ended(id, 'refused-address');
    expect(alice.fileListings).toEqual([]);
    expect(fake.relayed()).toEqual([]);
  });

  it('Bob closes midway through a file: the transfer fails peer-closed, the writer was aborted, the browse ends peer-closed', async () => {
    await start();
    const { id, share } = await opened([{ path: ['movie.mov'], bytes: content(8 * MB) }]);
    const into = heldSink();
    const take = await alice.client.takeFile(id, ['movie.mov'], into.sink);
    await waitFor(() => into.files.length === 1, 'the file begins');
    share.stop();
    into.open();
    expect(await transferEnded(take, 'failed')).toMatchObject({ failure: 'peer-closed' });
    expect(await ended(id, 'peer-closed')).toMatchObject({ by: 'peer' });
    await waitFor(() => into.files[0]?.aborted === true, 'the writer is aborted');
    expect(into.files[0]?.finished).toBe(false);
    expect(share.taken()).toEqual([]);
  });

  it('Alice cancels the moving take: cancelled by self, and the browse ends closed', async () => {
    await start();
    const { id, share } = await opened([{ path: ['movie.mov'], bytes: content(4 * MB) }, { path: ['a.txt'], bytes: content(10) }]);
    const into = heldSink();
    const take = await alice.client.takeFile(id, ['movie.mov'], into.sink);
    const next = await alice.client.takeFile(id, ['a.txt'], into.sink);
    await waitFor(() => into.files.length === 1, 'the file begins');
    await alice.client.cancelTransfer(take);
    expect(await transferEnded(take, 'cancelled')).toMatchObject({ by: 'self' });
    expect(await transferEnded(next, 'cancelled')).toMatchObject({ by: 'self' });
    expect(await ended(id, 'closed')).toMatchObject({ by: 'self' });
    into.open();
    await waitFor(() => into.files[0]?.aborted === true, 'the writer is aborted');
    expect(into.files).toHaveLength(1);
    await settle();
    expect(share.taken()).toEqual([]);
  });

  it('Alice cancels a take that waits its turn: the other file still arrives and the browse stays open', async () => {
    await start();
    const { id } = await opened([{ path: ['movie.mov'], bytes: content(2 * MB) }, { path: ['a.txt'], bytes: content(10) }]);
    const into = heldSink();
    const take = await alice.client.takeFile(id, ['movie.mov'], into.sink);
    const next = await alice.client.takeFile(id, ['a.txt'], into.sink);
    await waitFor(() => into.files.length === 1, 'the file begins');
    await alice.client.cancelTransfer(next);
    expect(await transferEnded(next, 'cancelled')).toMatchObject({ by: 'self' });
    into.open();
    await transferEnded(take, 'done');
    await settle();
    expect(into.files).toHaveLength(1);
    expect(trail(id).at(-1)).toBe('open');
  });

  it('take of ["nope.txt"], which no listing named: failed file-problem, and no request was written', async () => {
    await start();
    const { id } = await opened();
    await settle();
    const before = fake.relayed()[0]?.bytesToRecipient;
    const into = memorySink();
    const take = await alice.client.takeFile(id, ['nope.txt'], into.sink);
    expect(of(take)).toEqual([
      { id: take, direction: 'in', peer: 'Bob', state: 'failed', failure: 'file-problem', count: 1, index: 0, name: 'nope.txt', bytesDone: 0, bytesTotal: 0 },
    ]);
    // A folder is not a file.
    const folder = await alice.client.takeFile(id, ['sub'], into.sink);
    expect(steps(folder)).toEqual(['file-problem']);
    await settle();
    expect(fake.relayed()[0]?.bytesToRecipient).toBe(before);
    expect(into.files).toEqual([]);
    expect(trail(id).at(-1)).toBe('open');
    await expect(alice.client.takeFile('bob:0000000000000001', ['a.txt'], into.sink)).rejects.toMatchObject({ info: { kind: 'local', code: 'invalid-argument' } });
  });

  it('Bob sends a first header with another cookie: the browse ends bad-cookie and no fileListing is emitted', async () => {
    await start();
    bob.shareFiles(TREE, 'serves', { firstCookie: 0x0102030405060708n });
    const id = await alice.client.browseFiles('Bob');
    expect(await ended(id, 'bad-cookie')).toMatchObject({ by: 'peer' });
    await settle();
    expect(alice.fileListings).toEqual([]);
    expect(trail(id)).toEqual(['waiting', 'connecting', 'bad-cookie']);
    // The listing follows the answer of Alice, and Alice gave none.
    expect(fake.relayed()[0]?.bytesToRecipient).toBe(0);
  });

  it('the folder of Alice fails: failed folder-problem, the take that waits fails the same way, and the browse ends closed', async () => {
    await start();
    const { id } = await opened();
    const broken: FileSink = { begin: async () => { throw new Error('the folder is gone'); } };
    const take = await alice.client.takeFile(id, ['a.txt'], broken);
    const next = await alice.client.takeFile(id, ['c.dat'], broken);
    expect(await transferEnded(take, 'failed')).toMatchObject({ failure: 'folder-problem' });
    expect(await transferEnded(next, 'failed')).toMatchObject({ failure: 'folder-problem' });
    expect(await ended(id, 'closed')).toMatchObject({ by: 'self' });
  });

  it('Alice offers a file to Carol and browses Bob at once: both meetings run, one after the other', async () => {
    await start({ getFile: {}, fileTransfer: {} });
    const carol = fake.peer('Carol');
    const kept = memorySink();
    carol.acceptOffers(kept.sink);
    // The relay of the test pairs by address, and each side has one address. Thus Bob answers after the file moved.
    bob.shareFiles(TREE, 'asks');
    const file = content(5000, 3);
    const source: OutgoingFile = {
      name: 'notes.bin', bytes: file.length, modifiedAt: 0,
      async *read() {
        yield file;
      },
    };
    const sending = alice.client.sendFiles('Carol', [source]);
    const browsing = alice.client.browseFiles('Bob');
    const transferId = await sending;
    const id = await browsing;
    const sent = (): boolean => of(transferId).at(-1)?.state === 'done';
    // The link to the server paces messages that follow each other closely. The clock moves for them.
    for (let second = 0; second < 10 && !(sent() && fake.relaySessions().length === 1); second++) await timers.advance(1000);
    await waitFor(() => sent() && fake.relaySessions().length === 1, `the file at Carol; it reads ${steps(transferId).join(', ')}`);
    expect(trail(id)).toEqual(['waiting']);
    bob.allowShare();
    for (let second = 0; second < 10 && browseOf(id).at(-1)?.state !== 'open'; second++) await timers.advance(1000);
    await waitFor(() => browseOf(id).at(-1)?.state === 'open', `the listing of Bob; the browse reads ${trail(id).join(', ')}`);
    expect(bytesOf(kept.files[0]).equals(Buffer.from(file))).toBe(true);
    expect(shape(alice.fileListings[0])).toHaveLength(5);
    expect(fake.relayed()).toHaveLength(2);
    expect(new Set(fake.relayed().map((pair) => pair.cookie)).size).toBe(2);
    const into = memorySink();
    await transferEnded(await alice.client.takeFile(id, ['c.dat'], into.sink), 'done');
  });

  it('getFile.allowDial is asked for the Get File dial; with only fileTransfer.allowDial, that rule is asked', async () => {
    const asked: string[] = [];
    const rule = (name: string) => (address: PeerAddress): boolean => {
      asked.push(`${name} ${address.ip}:${address.port}`);
      return true;
    };
    const sink = memorySink().sink;
    const both = async (): Promise<void> => {
      const sent = bob.offerFile('Alice', 'notes.txt', content(10));
      await waitFor(() => alice.fileOffers.length === 1, 'the file offer');
      await alice.client.acceptFileOffer(alice.fileOffers[0]?.id ?? '', sink);
      expect((await sent).outcome).toBe('done');
      await opened();
    };
    await start({ getFile: { allowDial: rule('get-file') }, fileTransfer: { allowDial: rule('file') } });
    await both();
    const relay = `127.0.0.1:${fake.relayPort}`;
    expect(asked).toEqual([`file ${relay}`, `get-file ${relay}`]);
    await stop();
    asked.length = 0;
    await start({ getFile: {}, fileTransfer: { allowDial: rule('file') } });
    await both();
    expect(asked).toEqual([`file 127.0.0.1:${fake.relayPort}`, `file 127.0.0.1:${fake.relayPort}`]);
  });

  it('Alice signs off with a take moving: the transfer fails signed-off and the browse ends signed-off', async () => {
    await start();
    const { id } = await opened([{ path: ['movie.mov'], bytes: content(4 * MB) }, { path: ['a.txt'], bytes: content(10) }]);
    const into = heldSink();
    const take = await alice.client.takeFile(id, ['movie.mov'], into.sink);
    const next = await alice.client.takeFile(id, ['a.txt'], into.sink);
    await waitFor(() => into.files.length === 1, 'the file begins');
    await alice.client.signOff();
    expect(await transferEnded(take, 'failed')).toMatchObject({ failure: 'signed-off' });
    expect(await transferEnded(next, 'failed')).toMatchObject({ failure: 'signed-off' });
    expect(await ended(id, 'signed-off')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'signed-off' });
    into.open();
    await waitFor(() => into.files[0]?.aborted === true, 'the writer is aborted');
    expect(into.files).toHaveLength(1);
  });

  it('a client without getFile refuses each call', async () => {
    await start({ fileTransfer: {} });
    const invalid = { name: 'OscarError', info: { kind: 'local', code: 'invalid-argument' } };
    await expect(alice.client.browseFiles('Bob')).rejects.toMatchObject(invalid);
    await expect(alice.client.takeFile('bob:0000000000000001', ['a.txt'], memorySink().sink)).rejects.toMatchObject(invalid);
    await alice.client.closeBrowse('bob:0000000000000001');
    expect(alice.browses).toEqual([]);
  });
});

const SHARED: PeerFolderFile[] = [
  { path: ['a.txt'], bytes: content(1000, 1) },
  { path: ['b.bin'], bytes: content(70_000, 2) },
  { path: ['sub', 'c.txt'], bytes: content(20, 3) },
];
const shareOf = (id: string): ShareStatus[] => alice.shares.filter((status) => status.id === id);
const shareTrail = (id: string): string[] => shareOf(id).map((status) => status.end ?? status.state);
const names = (entries: readonly { path: readonly string[]; bytes: number }[]): [string, number][] =>
  entries.map((entry) => [entry.path.join('/'), entry.bytes]);
// Each rendezvous message that Alice sent to the server.
const sentByAlice = (): number =>
  fake.snacsFrom('alice').filter((snac) => snac.conn === 'bos' && snac.family === 4 && snac.subtype === 0x06 && snac.body[9] === 2).length;

async function shareEnded(id: string, end: ShareStatus['end']): Promise<ShareStatus> {
  await waitFor(() => shareOf(id).at(-1)?.state === 'closed', `the share ends; it reads ${shareTrail(id).join(', ')}`);
  expect(shareOf(id).at(-1)?.end).toBe(end);
  return shareOf(id).at(-1) as ShareStatus;
}

// Alice shares the source. Bob is a scripted requester.
async function sharing(source: SharedSource = treeSource(SHARED), services: Services = { getFile: {} }): Promise<void> {
  await start(services);
  await alice.client.shareFiles(source);
}

// One peer asks, and the request reached Alice. `count` is the count of requests that Alice has then.
async function asks(peer: FakePeer = bob, count = alice.shareRequests.length + 1, client: PeerClient = '5.1'): Promise<{ id: string; asking: Promise<PeerBrowse> }> {
  const asking = peer.browseFiles('Alice', {}, client);
  await waitFor(() => alice.shareRequests.length === count, 'the request reaches Alice');
  return { id: alice.shareRequests[count - 1]?.id ?? '', asking };
}

// One peer asked, Alice allowed, and the peer has the first listing.
async function served(peer: FakePeer = bob, client: PeerClient = '5.1'): Promise<{ id: string; browse: PeerBrowse }> {
  const { id, asking } = await asks(peer, undefined, client);
  await alice.client.allowShare(id);
  const browse = await asking;
  expect(browse.outcome).toBe('open');
  await waitFor(() => shareOf(id).at(-1)?.state === 'open', 'the share opens');
  return { id, browse };
}

// Alice keeps the link open for a time after a request for a name that she does not have. The clock moves for that wait.
async function closedAfterTheWait(request: Promise<unknown>): Promise<void> {
  let end = '';
  void request.then(() => (end = 'answered'), () => (end = 'closed'));
  await settle();
  expect(end).toBe('');
  for (let second = 0; second < 10 && end === ''; second++) {
    await timers.advance(NOT_THERE_CLOSE_MS);
    await settle();
  }
  expect(end).toBe('closed');
}

// A source whose file `name` stops after its first part of the second read, until `open` runs.
function slowSource(name: string, bytes: Uint8Array): { source: SharedSource; open: () => void; started: () => boolean } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let reads = 0;
  let started = false;
  const part = 64 * 1024;
  return {
    open,
    started: () => started,
    source: {
      list: async (folder) => (folder.length === 0 ? [{ path: [name], folder: false, bytes: bytes.length, modifiedAt: 0 }] : null),
      open: async (path) => {
        if (path.length !== 1 || path[0] !== name) return null;
        return {
          name, bytes: bytes.length, modifiedAt: 0,
          read: async function* () {
            const second = ++reads % 2 === 0;
            for (let at = 0; at < bytes.length; at += part) {
              if (second && at > 0) {
                started = true;
                await gate;
              }
              yield bytes.subarray(at, at + part);
            }
          },
        };
      },
    },
  };
}

describe('Get File to a scripted requester', () => {
  it('Bob asks: Alice hears shareRequest; allowShare; Bob reads Alice\'s root listing', async () => {
    await sharing();
    const { id, asking } = await asks();
    expect(id).toMatch(/^bob:[0-9a-f]{16}$/);
    expect(alice.shareRequests).toEqual([{ id, from: 'Bob', at: timers.now() }]);
    expect(shareOf(id)).toEqual([{ id, peer: 'Bob', state: 'asked' }]);
    await settle();
    expect(fake.relayed()).toEqual([]);
    await alice.client.allowShare(id);
    const browse = await asking;
    expect(browse.outcome).toBe('open');
    expect(names(browse.root)).toEqual([['a.txt', 1000], ['b.bin', 70_000], ['sub/c.txt', 20]]);
    await waitFor(() => shareOf(id).at(-1)?.state === 'open', 'the share opens');
    expect(shareTrail(id)).toEqual(['asked', 'connecting', 'open']);
    await expect(alice.client.allowShare(id)).rejects.toMatchObject({ info: { kind: 'local', code: 'invalid-argument' } });
  });

  it('Bob takes a.txt: equal bytes; Alice hears shareTaken with the path and the size', async () => {
    await sharing();
    const { id, browse } = await served();
    const got = await browse.take(['a.txt']);
    expect(Buffer.from(got as Uint8Array).equals(Buffer.from(content(1000, 1)))).toBe(true);
    await waitFor(() => alice.sharesTaken.length === 1, 'the file was taken');
    expect(alice.sharesTaken).toEqual([{ id, peer: 'Bob', path: ['a.txt'], bytes: 1000, at: timers.now() }]);
    expect(shareTrail(id)).toEqual(['asked', 'connecting', 'open']);
  });

  it('Bob takes sub/c.txt', async () => {
    await sharing();
    const { browse } = await served();
    const got = await browse.take(['sub', 'c.txt']);
    expect(Buffer.from(got as Uint8Array).equals(Buffer.from(content(20, 3)))).toBe(true);
    await waitFor(() => alice.sharesTaken.length === 1, 'the file was taken');
    expect(alice.sharesTaken[0]).toMatchObject({ path: ['sub', 'c.txt'], bytes: 20 });
    const big = await browse.take(['b.bin']);
    expect(Buffer.from(big as Uint8Array).equals(Buffer.from(content(70_000, 2)))).toBe(true);
  });

  it('refuseShare of a waiting request: Bob ends declined; no session', async () => {
    await sharing();
    const { id, asking } = await asks();
    await alice.client.refuseShare(id);
    expect((await asking).outcome).toBe('declined');
    expect(await shareEnded(id, 'declined')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'declined', by: 'self' });
    expect(shareTrail(id)).toEqual(['asked', 'declined']);
    expect(fake.relayed()).toEqual([]);
    await alice.client.refuseShare(id);
    await alice.client.refuseShare('bob:0000000000000001');
  });

  it('refuseShare of an open share: Bob ends peer-closed, Alice\'s share ends closed by self', async () => {
    await sharing();
    const { id, browse } = await served();
    await alice.client.refuseShare(id);
    expect(await shareEnded(id, 'closed')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'closed', by: 'self' });
    await expect(browse.take(['a.txt'])).rejects.toThrow();
    expect(browse.ended()).toBe(true);
    expect(alice.sharesTaken).toEqual([]);
  });

  it('nobody answers the request: after OFFER_ACCEPT_MS the share ends timed-out', async () => {
    await sharing();
    const { id, asking } = await asks();
    // A skip, then the due timers: in five minutes of probes, one late answer of the server closes the connection.
    timers.skip(OFFER_ACCEPT_MS - 1);
    await timers.advance(0);
    expect(shareTrail(id)).toEqual(['asked']);
    await timers.advance(1);
    expect(await shareEnded(id, 'timed-out')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'timed-out' });
    expect((await asking).outcome).toBe('timed-out');
    await expect(alice.client.allowShare(id)).rejects.toMatchObject({ info: { kind: 'local', code: 'invalid-argument' } });
  });

  it('with no source set a Get File proposal is declined at once: no request, no share, no listing', async () => {
    await start();
    const before = sentByAlice();
    const browse = await bob.browseFiles('Alice');
    expect(browse.outcome).toBe('declined');
    expect(alice.shareRequests).toEqual([]);
    expect(alice.shares).toEqual([]);
    expect(alice.sharesTaken).toEqual([]);
    expect(sentByAlice()).toBe(before + 1);
  });

  it('after shareFiles(null) the next proposal is declined at once', async () => {
    await sharing();
    await alice.client.shareFiles(null);
    expect((await bob.browseFiles('Alice')).outcome).toBe('declined');
    expect(alice.shareRequests).toEqual([]);
  });

  it('Bob is blocked while his share is open: his next request gets no byte and the link closes', async () => {
    await sharing();
    const { id, browse } = await served();
    await alice.client.block('Bob');
    await expect(browse.take(['a.txt'])).rejects.toThrow();
    expect(browse.ended()).toBe(true);
    expect(await shareEnded(id, 'closed')).toMatchObject({ by: 'self' });
    expect(alice.sharesTaken).toEqual([]);
  });

  it('a fifth requester with maxServing 4 gets a cancel', async () => {
    await sharing();
    expect(GET_FILE_MAX_SERVING).toBe(4);
    for (const name of ['Bob', 'Carol', 'Dave', 'Erin']) {
      const { id, asking } = await asks(fake.peer(name));
      await alice.client.allowShare(id);
      // The link to the server paces messages that follow each other closely. The clock moves for them.
      for (let second = 0; second < 10 && shareOf(id).at(-1)?.state !== 'open'; second++) {
        await settle();
        await timers.advance(1000);
      }
      expect((await asking).outcome).toBe('open');
      expect(shareOf(id).at(-1)?.state).toBe('open');
    }
    const fifth = fake.peer('Frank').browseFiles('Alice');
    for (let second = 0; second < 10 && sentByAlice() < 5; second++) {
      await settle();
      await timers.advance(1000);
    }
    expect((await fifth).outcome).toBe('declined');
    expect(alice.shareRequests).toHaveLength(4);
    expect(alice.shares.filter((status) => status.state === 'closed')).toEqual([]);
  });

  it('Bob never sends 0x1209: no listing byte was written', async () => {
    await sharing();
    const asking = bob.browseFiles('Alice', { ack: 'none' });
    await waitFor(() => alice.shareRequests.length === 1, 'the request reaches Alice');
    const id = alice.shareRequests[0]?.id ?? '';
    await alice.client.allowShare(id);
    const browse = await asking;
    expect(browse.outcome).toBe('open');
    await settle();
    expect(browse.stray()).toBe(0);
    expect(browse.ended()).toBe(false);
    expect(shareTrail(id)).toEqual(['asked', 'connecting']);
  });

  it('Bob answers 0x1209 with another cookie: the share ends bad-cookie and no listing byte was written', async () => {
    await sharing();
    const asking = bob.browseFiles('Alice', { ack: 0x1112131415161718n });
    await waitFor(() => alice.shareRequests.length === 1, 'the request reaches Alice');
    const id = alice.shareRequests[0]?.id ?? '';
    await alice.client.allowShare(id);
    const browse = await asking;
    expect(await shareEnded(id, 'bad-cookie')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'bad-cookie', by: 'peer' });
    await waitFor(() => browse.ended(), 'the connection of Bob ends');
    expect(browse.stray()).toBe(0);
    expect(shareTrail(id)).toEqual(['asked', 'connecting', 'bad-cookie']);
  });

  it('Bob requests "..\\u0001secret.txt", "/etc/passwd" and "": each closes the link after the wait, and source.open was not called', async () => {
    const opened: string[][] = [];
    const inner = treeSource(SHARED);
    await sharing({
      list: inner.list,
      open: async (path) => {
        opened.push([...path]);
        return inner.open(path);
      },
    });
    // The link to the server paces messages that follow each other closely. The clock moves for them.
    const paced = async (): Promise<{ id: string; browse: PeerBrowse }> => {
      const { id, asking } = await asks();
      await alice.client.allowShare(id);
      for (let second = 0; second < 10 && shareOf(id).at(-1)?.state !== 'open'; second++) {
        await settle();
        await timers.advance(1000);
      }
      return { id, browse: await asking };
    };
    for (const name of ['..\u0001secret.txt', '/etc/passwd', '']) {
      const { id, browse } = await paced();
      await closedAfterTheWait(browse.ask(name));
      expect(browse.ended()).toBe(true);
      expect(await shareEnded(id, 'closed')).toMatchObject({ by: 'self' });
    }
    expect(opened).toEqual([]);
    const { browse } = await paced();
    const got = await browse.take(['a.txt']);
    expect(Buffer.from(got as Uint8Array).equals(Buffer.from(content(1000, 1)))).toBe(true);
    expect(opened).toEqual([['a.txt']]);
  });

  it('Bob requests a name that is not in the listing, and a folder: each closes the link after the wait, and nothing is sent', async () => {
    await sharing();
    for (const path of [['nope.txt'], ['sub']]) {
      const { id, browse } = await served();
      await closedAfterTheWait(browse.take(path));
      expect(browse.ended()).toBe(true);
      expect(await shareEnded(id, 'closed')).toMatchObject({ by: 'self' });
    }
    expect(alice.sharesTaken).toEqual([]);
  });

  it('the source yields fewer bytes than it listed: the link closes and no shareTaken is emitted', async () => {
    const inner = treeSource(SHARED);
    await sharing({
      list: inner.list,
      open: async (path) => {
        const file = await inner.open(path);
        return file && { ...file, bytes: file.bytes + 10 };
      },
    });
    const { id, browse } = await served();
    await expect(browse.take(['a.txt'])).rejects.toThrow();
    expect(await shareEnded(id, 'closed')).toMatchObject({ by: 'self' });
    expect(browse.ended()).toBe(true);
    expect(alice.sharesTaken).toEqual([]);
  });

  it('Bob answers the PROMPT with DONE: no file byte is sent and no shareTaken is emitted', async () => {
    await sharing();
    const { id, browse } = await served();
    await browse.have(['b.bin']);
    // The next header that comes is the answer to the next request, thus no byte of the file came.
    expect((await browse.take(['a.txt'])) instanceof Uint8Array).toBe(true);
    await waitFor(() => alice.sharesTaken.length === 1, 'the second file was taken');
    expect(alice.sharesTaken).toEqual([{ id, peer: 'Bob', path: ['a.txt'], bytes: 1000, at: timers.now() }]);
  });

  it('shareFiles(null) while Bob takes a 5 MB file: Bob ends peer-closed, Alice\'s share ends closed by self', async () => {
    const slow = slowSource('movie.mov', content(5 * MB));
    await sharing(slow.source);
    const { id, browse } = await served();
    const taking = browse.take(['movie.mov']);
    taking.catch(() => {});
    await waitFor(slow.started, 'the file is on its way');
    await alice.client.shareFiles(null);
    expect(await shareEnded(id, 'closed')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'closed', by: 'self' });
    slow.open();
    await expect(taking).rejects.toThrow();
    expect(browse.ended()).toBe(true);
    expect(alice.sharesTaken).toEqual([]);
  });

  it('shareFiles(null) answers a request that waits with a cancel', async () => {
    await sharing();
    const { id, asking } = await asks();
    await alice.client.shareFiles(null);
    expect((await asking).outcome).toBe('declined');
    expect(await shareEnded(id, 'cancelled')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'cancelled', by: 'self' });
  });

  it('shareFiles(another source) while Bob is connected: Bob ends peer-closed, and his next browse lists the new source', async () => {
    await sharing();
    const { id, browse } = await served();
    await alice.client.shareFiles(treeSource([{ path: ['new.txt'], bytes: content(7) }]));
    expect(await shareEnded(id, 'closed')).toMatchObject({ by: 'self' });
    await expect(browse.take(['a.txt'])).rejects.toThrow();
    expect(browse.ended()).toBe(true);
    const again = await served();
    expect(again.id).not.toBe(id);
    expect(names(again.browse.root)).toEqual([['new.txt', 7]]);
  });

  it('shareFiles with the source that is set closes nothing', async () => {
    const source = treeSource(SHARED);
    await sharing(source);
    const { id, browse } = await served();
    await alice.client.shareFiles(source);
    expect((await browse.take(['a.txt'])) instanceof Uint8Array).toBe(true);
    expect(shareTrail(id)).toEqual(['asked', 'connecting', 'open']);
  });

  it('a second request of Bob while his share is open gets a cancel', async () => {
    await sharing();
    const { id } = await served();
    expect((await bob.browseFiles('Alice')).outcome).toBe('declined');
    expect(alice.shareRequests).toHaveLength(1);
    expect(shareTrail(id)).toEqual(['asked', 'connecting', 'open']);
  });

  it('Bob closes: the share ends peer-closed by peer', async () => {
    await sharing();
    const { id, browse } = await served();
    browse.close();
    expect(await shareEnded(id, 'peer-closed')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'peer-closed', by: 'peer' });
  });

  it('Alice signs off: the share ends signed-off and the link of Bob closes', async () => {
    await sharing();
    const { id, browse } = await served();
    await alice.client.signOff();
    expect(await shareEnded(id, 'signed-off')).toEqual({ id, peer: 'Bob', state: 'closed', end: 'signed-off' });
    await expect(browse.take(['a.txt'])).rejects.toThrow();
  });

  it('a client without getFile refuses shareFiles', async () => {
    await start({ fileTransfer: {} });
    await expect(alice.client.shareFiles(treeSource(SHARED))).rejects.toMatchObject({ info: { kind: 'local', code: 'invalid-argument' } });
    await expect(alice.client.allowShare('bob:0000000000000001')).rejects.toMatchObject({ info: { kind: 'local', code: 'invalid-argument' } });
  });
});

describe('Get File between two clients', () => {
  it('two real clients: Alice shares, Carol browses and takes a file with equal bytes', async () => {
    await sharing();
    fake.addUser('Carol', 'carolpw1');
    const carol = makeClient(fake, { timers, getFile: {} });
    await carol.signOn('Carol', 'carolpw1');
    const browseId = await carol.client.browseFiles('Alice');
    await waitFor(() => alice.shareRequests.length === 1, 'the request reaches Alice');
    const id = alice.shareRequests[0]?.id ?? '';
    expect(alice.shareRequests[0]?.from).toBe('Carol');
    await alice.client.allowShare(id);
    const state = (): string | undefined => carol.browses.filter((status) => status.id === browseId).at(-1)?.state;
    for (let second = 0; second < 10 && state() !== 'open'; second++) await timers.advance(1000);
    await waitFor(() => state() === 'open', 'the browse of Carol opens');
    expect(shape(carol.fileListings[0])).toEqual([['a.txt', false, 1000], ['b.bin', false, 70_000], ['sub/c.txt', false, 20]]);
    const into = memorySink();
    const take = await carol.client.takeFile(browseId, ['b.bin'], into.sink);
    const deep = await carol.client.takeFile(browseId, ['sub', 'c.txt'], into.sink);
    const over = (transfer: string): boolean => carol.transfers.some((status) => status.id === transfer && status.state === 'done');
    await waitFor(() => over(take) && over(deep), 'the files arrive');
    expect(bytesOf(into.files[0]).equals(Buffer.from(content(70_000, 2)))).toBe(true);
    expect(bytesOf(into.files[1]).equals(Buffer.from(content(20, 3)))).toBe(true);
    await waitFor(() => alice.sharesTaken.length === 2, 'Alice hears each file');
    expect(alice.sharesTaken.map((taken) => [taken.peer, taken.path.join('/'), taken.bytes])).toEqual([['Carol', 'b.bin', 70_000], ['Carol', 'sub/c.txt', 20]]);
    await carol.client.closeBrowse(browseId);
    expect(await shareEnded(id, 'peer-closed')).toMatchObject({ by: 'peer' });
  });
});

const same = (got: Uint8Array | 'refused', data: Uint8Array): boolean => got !== 'refused' && Buffer.from(got).equals(Buffer.from(data));

// The files of SHARED as a source. `opens` holds each path that the client asked the source to open.
function watchedSource(name?: string): { source: SharedSource; opens: string[][] } {
  const opens: string[][] = [];
  const inner = treeSource(SHARED);
  const open: SharedSource['open'] = async (path) => {
    opens.push([...path]);
    return inner.open(path);
  };
  return { opens, source: { ...(name !== undefined && { name }), list: inner.list, open } };
}

describe('Get File from a holder of each kind', () => {
  it('a 5.9 holder: Alice reads the Lst1 listing, each path below the name of the folder, and takes two files with a request for each', async () => {
    await start();
    const { id, share } = await opened(TREE, '5.9');
    expect(alice.fileListings).toHaveLength(1);
    expect(alice.fileListings[0]).toMatchObject({ browseId: id, folder: [], truncated: false, damaged: false });
    expect(shape(alice.fileListings[0])).toEqual([
      ['share/a.txt', false, 1000], ['share/b.bin', false, 70_000], ['share/c.dat', false, 3], ['share/sub/d.txt', false, 20],
      ['share/sub/deep/e.txt', false, 5],
    ]);
    const into = memorySink();
    // A 5.9 holder answers no request after an answer that has bit 0x10. Thus a file that comes shows that the answers do not have it.
    const first = await alice.client.takeFile(id, [PEER_SHARE_FOLDER, 'a.txt'], into.sink);
    expect(await transferEnded(first, 'done')).toMatchObject({ name: 'a.txt', bytesDone: 1000, bytesTotal: 1000 });
    const second = await alice.client.takeFile(id, [PEER_SHARE_FOLDER, 'sub', 'deep', 'e.txt'], into.sink);
    expect(await transferEnded(second, 'done')).toMatchObject({ name: 'e.txt', bytesDone: 5, bytesTotal: 5 });
    expect(into.files.map((saved) => saved.file.name)).toEqual(['a.txt', 'e.txt']);
    expect(bytesOf(into.files[0]).equals(Buffer.from(TREE[0]?.bytes ?? []))).toBe(true);
    expect(bytesOf(into.files[1]).equals(Buffer.from(TREE[4]?.bytes ?? []))).toBe(true);
    await waitFor(() => share.taken().length === 2, 'the record of Bob');
    expect(share.taken()).toEqual([{ path: ['a.txt'], bytes: 1000 }, { path: ['sub', 'deep', 'e.txt'], bytes: 5 }]);
    expect(trail(id).at(-1)).toBe('open');
    expect(fake.relayed()).toHaveLength(1);
  });

  it('a 5.9 holder: a path without the name of the folder is not in the listing, thus no request is written', async () => {
    await start();
    const { id, share } = await opened(TREE, '5.9');
    const take = await alice.client.takeFile(id, ['a.txt'], memorySink().sink);
    expect(await transferEnded(take, 'failed')).toMatchObject({ failure: 'file-problem' });
    await settle();
    expect(share.taken()).toEqual([]);
    expect(trail(id).at(-1)).toBe('open');
  });
});

describe('Get File to a requester of each kind', () => {
  const NAMED: SharedSource = { ...treeSource(SHARED), name: 'My Files' };

  it('a 5.9 requester: the listing is Lst1 below the name of the folder, and a request with only a name gets the file', async () => {
    await sharing(NAMED);
    const { id, browse } = await served(bob, '5.9');
    expect(browse.flags).toBe(0x30);
    expect(names(browse.root)).toEqual([['My Files/a.txt', 1000], ['My Files/b.bin', 70_000], ['My Files/sub/c.txt', 20]]);
    expect(same(await browse.take(['My Files', 'a.txt']), content(1000, 1))).toBe(true);
    expect(same(await browse.take(['My Files', 'sub', 'c.txt']), content(20, 3))).toBe(true);
    expect(same(await browse.take(['My Files', 'b.bin']), content(70_000, 2))).toBe(true);
    await waitFor(() => alice.sharesTaken.length === 3, 'the files were taken');
    // The host gets each path without the name of the folder.
    expect(alice.sharesTaken.map((taken) => [taken.path.join('/'), taken.bytes])).toEqual([['a.txt', 1000], ['sub/c.txt', 20], ['b.bin', 70_000]]);
    expect(shareTrail(id)).toEqual(['asked', 'connecting', 'open']);
  });

  it('a 5.9 requester and a source with no name: each path is below the folder "shared"', async () => {
    await sharing();
    const { browse } = await served(bob, '5.9');
    expect(names(browse.root).map(([path]) => path)).toEqual(['shared/a.txt', 'shared/b.bin', 'shared/sub/c.txt']);
    expect(same(await browse.take(['shared', 'a.txt']), content(1000, 1))).toBe(true);
  });

  it('a 5.9 requester asks for a path without the name of the folder: the link closes after the wait, and source.open was not called', async () => {
    const { source, opens } = watchedSource('My Files');
    await sharing(source);
    const { browse } = await served(bob, '5.9');
    await closedAfterTheWait(browse.take(['a.txt']));
    expect(opens).toEqual([]);
    expect(alice.sharesTaken).toEqual([]);
  });

  it('a 5.1 requester: the listing is the text form with no name of a folder', async () => {
    await sharing(NAMED);
    const { browse } = await served(bob, '5.1');
    expect(browse.flags).toBe(0x20);
    expect(names(browse.root)).toEqual([['a.txt', 1000], ['b.bin', 70_000], ['sub/c.txt', 20]]);
    expect(same(await browse.take(['sub', 'c.txt']), content(20, 3))).toBe(true);
  });

  it('a 3.5 requester asks with a backslash between the parts and takes a file of a folder', async () => {
    await sharing(NAMED);
    const { id, browse } = await served(bob, '3.5');
    expect(browse.flags).toBe(0x20);
    expect(names(browse.root)).toEqual([['a.txt', 1000], ['b.bin', 70_000], ['sub/c.txt', 20]]);
    expect(same(await browse.take(['sub', 'c.txt']), content(20, 3))).toBe(true);
    expect(same(await browse.take(['a.txt']), content(1000, 1))).toBe(true);
    await waitFor(() => alice.sharesTaken.length === 2, 'the files were taken');
    expect(alice.sharesTaken.map((taken) => taken.path)).toEqual([['sub', 'c.txt'], ['a.txt']]);
    expect(shareTrail(id)).toEqual(['asked', 'connecting', 'open']);
  });

  it('a 3.5 requester asks for "..\\secret.txt": the link closes after the wait, and source.open was not called', async () => {
    const { source, opens } = watchedSource();
    await sharing(source);
    const { browse } = await served(bob, '3.5');
    await closedAfterTheWait(browse.take(['..', 'secret.txt']));
    expect(opens).toEqual([]);
  });

  it('the frame 0x120e from a requester gets no answer, and the next request gets its file', async () => {
    await sharing();
    const { id, browse } = await served();
    await browse.sendRaw({
      type: OFT_LISTING_UNREAD, cookie: browse.cookie, totalFiles: 0, filesLeft: 0, totalParts: 0, partsLeft: 0, totalBytes: 0, bytes: 0, modifiedAt: 0,
      checksum: 0, received: 0, receivedChecksum: OFT_CHECKSUM_START, nameEncoding: 0, name: '',
    });
    await settle();
    expect(browse.ended()).toBe(false);
    expect(shareTrail(id)).toEqual(['asked', 'connecting', 'open']);
    expect(same(await browse.take(['a.txt']), content(1000, 1))).toBe(true);
  });

  it('two requesters at one time, a 5.9 and a 5.1: each gets the form of its own proposal', async () => {
    await sharing(NAMED);
    const carol = fake.peer('Carol');
    const later = await served(bob, '5.9');
    const older = await served(carol, '5.1');
    expect([later.browse.flags, older.browse.flags]).toEqual([0x30, 0x20]);
    expect(same(await older.browse.take(['a.txt']), content(1000, 1))).toBe(true);
    expect(same(await later.browse.take(['My Files', 'a.txt']), content(1000, 1))).toBe(true);
  });
});
