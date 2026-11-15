import { afterEach, describe, expect, it } from 'vitest';
import { GET_FILE_CAPABILITY } from '../../src/model/buddy-list.js';
import type { BuddyPresence } from '../../src/model/buddy-list.js';
import type { BrowseStatus } from '../../src/model/get-file.js';
import type { FileSink } from '../../src/model/transfer.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';
import type { PeerFolderFile } from '../fake/peer-files.js';

const BUDDIES: FeedbagItem = { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] };

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: FakePeer;

// Bob is a scripted peer. Alice is a client with each name of `buddies` on her list.
async function start(buddies: readonly string[] = ['Bob']): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, timers: timers.api, relay: true });
  fake.addUser('Alice', 'alicepw1');
  bob = fake.peer('Bob');
  for (const name of buddies) fake.peer(name);
  const items = buddies.map((name, i): FeedbagItem => ({ name: name.toLowerCase(), groupId: 1, itemId: i + 1, classId: 0, attrs: [] }));
  fake.setFeedbag('alice', withTypingPref([BUDDIES, ...items]));
  alice = makeClient(fake, { timers, getFile: {} });
  await alice.signOn('Alice', 'alicepw1');
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

function content(bytes: number, seed = 7): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const TREE: PeerFolderFile[] = [
  { path: ['a.txt'], bytes: content(100, 1) },
  { path: ['sub', 'b.txt'], bytes: content(200, 2) },
];

const SINK: FileSink = { begin: async () => ({ write: async () => {}, finish: async () => {}, abort: async () => {} }) };
const last = (id: string): BrowseStatus | undefined => alice.browses.filter((status) => status.id === id).at(-1);
const seen = (name: string): BuddyPresence | undefined => alice.presence.filter((p) => p.screenName.toLowerCase() === name).at(-1);
const shows = (name: string): boolean => (seen(name)?.capabilities ?? []).includes(GET_FILE_CAPABILITY);
const done = (id: string): boolean => alice.transfers.some((status) => status.id === id && status.state === 'done');

async function open(): Promise<string> {
  const id = await alice.client.browseFiles('Bob');
  await waitFor(() => last(id)?.state === 'open' || last(id)?.state === 'closed', 'the browse opens');
  expect(last(id)?.state).toBe('open');
  return id;
}

describe('a scripted peer shares files', () => {
  it('a peer that shares shows the Get File capability; a peer that does not shows none; stop takes it away', async () => {
    await start(['Bob', 'Carol']);
    await waitFor(() => seen('bob')?.online === true && seen('carol')?.online === true, 'the two arrivals');
    expect(shows('bob')).toBe(false);
    const share = bob.shareFiles(TREE);
    await waitFor(() => shows('bob'), 'the capability of the peer');
    expect(shows('carol')).toBe(false);
    share.stop();
    await waitFor(() => !shows('bob'), 'the capability goes');
  });

  it.each(['asks', 'refuses'] as const)('a peer of the form %s shows the capability too', async (form) => {
    await start();
    bob.shareFiles(TREE, form);
    await waitFor(() => shows('bob'), 'the capability of the peer');
  });

  it('taken gives each file that went out whole, in order, with its path and size', async () => {
    await start();
    const share = bob.shareFiles(TREE);
    const id = await open();
    const first = await alice.client.takeFile(id, ['sub', 'b.txt'], SINK);
    const second = await alice.client.takeFile(id, ['a.txt'], SINK);
    await waitFor(() => done(first) && done(second), 'the two files');
    await waitFor(() => share.taken().length === 2, 'the record of the peer');
    expect(share.taken()).toEqual([{ path: ['sub', 'b.txt'], bytes: 200 }, { path: ['a.txt'], bytes: 100 }]);
  });

  it('a peer that shares nothing leaves a request alone', async () => {
    await start();
    const id = await alice.client.browseFiles('Bob');
    await waitFor(() => fake.relaySessions().length === 1, 'the session of the relay');
    await imRoundTrip(fake, alice);
    expect(last(id)?.state).toBe('waiting');
    expect(fake.relaySessions()).toHaveLength(1);
    await alice.client.closeBrowse(id);
  });

  // A browse with no request in progress reads nothing, thus it sees the close at its next request.
  it('stop closes each connection: the browse ends with no request, and a take after it is refused', async () => {
    await start();
    const share = bob.shareFiles(TREE);
    const id = await open();
    share.stop();
    // The close comes through the relay while no request runs.
    await waitFor(() => last(id)?.state === 'closed', 'the browse ends');
    expect(last(id)).toMatchObject({ state: 'closed', end: 'peer-closed', by: 'peer' });
    await expect(alice.client.takeFile(id, ['a.txt'], SINK)).rejects.toMatchObject({ info: { kind: 'local', code: 'invalid-argument' } });
    const again = await alice.client.browseFiles('Bob');
    expect(again).not.toBe(id);
    // The link to the server paces messages that follow each other closely. The clock moves for them.
    for (let second = 0; second < 10 && fake.relaySessions().length === 0; second++) await timers.advance(1000);
    await waitFor(() => fake.relaySessions().length === 1, 'the session of the relay');
    await timers.advance(1000);
    expect(last(again)?.state).toBe('waiting');
  });

  it('allowShare with no request that waits does nothing; a request that came before it is accepted one time', async () => {
    await start();
    bob.shareFiles(TREE, 'asks');
    bob.allowShare();
    const id = await alice.client.browseFiles('Bob');
    await waitFor(() => fake.relaySessions().length === 1, 'the session of the relay');
    await imRoundTrip(fake, alice);
    expect(last(id)?.state).toBe('waiting');
    bob.allowShare();
    await waitFor(() => last(id)?.state === 'open', 'the browse opens');
    expect(alice.fileListings).toHaveLength(1);
  });

  it('the peer signs off: the connection closes', async () => {
    await start();
    bob.shareFiles(TREE);
    const id = await open();
    bob.signOff();
    await waitFor(() => last(id)?.state === 'closed', 'the browse ends');
    expect(last(id)?.end).toBe('peer-closed');
  });
});

// AIM 5.1 closed the connection in each of these cases at the probe. A flow test thus fails where that client hangs up.
describe('the scripted peers are as strict as AIM 5.1', () => {
  let carol: FakePeer;

  // Carol is a scripted holder and Bob is a scripted requester.
  async function two(odd: Parameters<FakePeer['shareFiles']>[2] = {}): Promise<void> {
    await start(['Bob', 'Carol']);
    carol = fake.peer('Carol');
    carol.shareFiles(TREE, 'serves', odd);
  }

  it('a requester that sends each header of the holder back takes two files on one connection', async () => {
    await two();
    const browse = await bob.browseFiles('Carol');
    expect(browse.outcome).toBe('open');
    expect(browse.root.map((entry) => entry.path)).toEqual([['a.txt'], ['sub', 'b.txt']]);
    expect(await browse.take(['sub', 'b.txt'])).toEqual(content(200, 2));
    expect(await browse.take(['a.txt'])).toEqual(content(100, 1));
    expect(browse.ended()).toBe(false);
    browse.close();
  });

  it('the holder closes when the answer after the listing has no bit 0', async () => {
    await two();
    const browse = await bob.browseFiles('Carol', { plain: 'listing-done' });
    await expect(browse.take(['a.txt'])).rejects.toThrow();
    expect(browse.ended()).toBe(true);
  });

  it('the holder closes when the answer after a file has no bit 0, and the next request is lost', async () => {
    await two();
    const browse = await bob.browseFiles('Carol', { plain: 'file-done' });
    expect(await browse.take(['a.txt'])).toEqual(content(100, 1));
    await expect(browse.take(['sub', 'b.txt'])).rejects.toThrow();
    expect(browse.ended()).toBe(true);
  });

  it.each(['listing-ack', 'file-ack'] as const)('the holder closes when the %s is a new header, not its own header sent back', async (fresh) => {
    await two();
    const browse = await bob.browseFiles('Carol', { fresh });
    if (fresh === 'listing-ack') expect(browse.outcome).toBe('failed');
    else await expect(browse.take(['a.txt'])).rejects.toThrow();
    expect(browse.ended()).toBe(true);
  });

  it('the holder closes for a name that it does not have, and sends nothing', async () => {
    await two();
    const browse = await bob.browseFiles('Carol');
    await expect(browse.take(['nope.txt'])).rejects.toThrow();
    expect(browse.ended()).toBe(true);
  });

  it.each(['count', 'checksum'] as const)('the requester refuses a listing with a wrong %s', async (wrong) => {
    await two({ listing: wrong });
    const browse = await bob.browseFiles('Carol');
    expect(browse.outcome).toBe('failed');
    expect(browse.root).toEqual([]);
    expect(browse.ended()).toBe(true);
  });

  it('a client takes three files from the holder on one connection', async () => {
    await start();
    const share = bob.shareFiles([...TREE, { path: ['c.bin'], bytes: content(70_000, 3) }]);
    const id = await open();
    const ids = [await alice.client.takeFile(id, ['a.txt'], SINK), await alice.client.takeFile(id, ['c.bin'], SINK), await alice.client.takeFile(id, ['sub', 'b.txt'], SINK)];
    await waitFor(() => ids.every(done), 'the three files');
    await waitFor(() => share.taken().length === 3, 'the record of the peer');
    expect(last(id)?.state).toBe('open');
  });

  it('a client asks for a name that the holder dropped: the transfer fails file-problem and the browse ends not-there', async () => {
    await start();
    const share = bob.shareFiles(TREE);
    const id = await open();
    share.drop(['a.txt']);
    const take = await alice.client.takeFile(id, ['a.txt'], SINK);
    await waitFor(() => last(id)?.state === 'closed', 'the browse ends');
    expect(last(id)).toMatchObject({ state: 'closed', end: 'not-there', by: 'peer' });
    expect(alice.transfers.filter((status) => status.id === take).at(-1)).toMatchObject({ state: 'failed', failure: 'file-problem' });
  });
});

