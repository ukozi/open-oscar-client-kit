import { afterEach, describe, expect, it } from 'vitest';
import { COUNTER_DIAL_MS, OFFER_ACCEPT_MS } from '../../src/client/rendezvous.js';
import { MAX_WAITING_OFFERS, PEER_CANCEL_WAIT_MS } from '../../src/client/transfers.js';
import type { FileTransferOptions } from '../../src/client/oscar-client.js';
import type { FileOfferNotice, FileSink, IncomingFile, OutgoingFile, TransferState, TransferStatus } from '../../src/model/transfer.js';
import { imRoundTrip, makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { RELAY_SILENCE_MS } from '../fake/oscar-relay.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const MB = 1024 * 1024;
const INVALID = { name: 'OscarError', info: { kind: 'local', code: 'invalid-argument' } };

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: ClientHarness;
const gates: (() => void)[] = [];

async function join(name: string, password: string, fileTransfer?: FileTransferOptions): Promise<ClientHarness> {
  const h = makeClient(fake, { timers, ...(fileTransfer && { fileTransfer }) });
  await h.signOn(name, password);
  return h;
}

async function start(opts: { bob?: FileTransferOptions | null } = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, timers: timers.api, relay: true });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw123');
  alice = await join('Alice', 'alicepw1', {});
  bob = await join('Bob', 'bobpw123', opts.bob === null ? undefined : (opts.bob ?? {}));
}

afterEach(async () => {
  for (const open of gates.splice(0)) open();
  await stopAllClients();
  await fake.stop();
});

function content(bytes: number, seed = 7): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

// A file in memory. `fail` makes the second read throw.
function source(name: string, data: Uint8Array, fail = false): OutgoingFile {
  let passes = 0;
  return {
    name,
    bytes: data.length,
    modifiedAt: 1_700_000_000,
    read: async function* () {
      passes++;
      if (fail && passes > 1) throw new Error('the file is gone');
      for (let at = 0; at < data.length; at += 16 * 1024) yield data.subarray(at, at + 16 * 1024);
    },
  };
}

type Saved = { file: IncomingFile; parts: Uint8Array[]; finished: boolean; aborted: boolean };
type MemorySink = { sink: FileSink; files: Saved[]; writing: boolean; release(): void };

// A sink in memory. With `hold`, the first write waits for `release`.
function memorySink(hold = false): MemorySink {
  let open: () => void = () => {};
  const gate = hold ? new Promise<void>((resolve) => (open = resolve)) : Promise.resolve();
  gates.push(open);
  const one: MemorySink = {
    files: [],
    writing: false,
    release: open,
    sink: {
      begin: async (file) => {
        const saved: Saved = { file, parts: [], finished: false, aborted: false };
        one.files.push(saved);
        return {
          write: async (chunk) => {
            one.writing = true;
            await gate;
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
  return one;
}

function bytesOf(saved: Saved | undefined): Uint8Array {
  return Uint8Array.from((saved?.parts ?? []).flatMap((part) => [...part]));
}

async function offerAt(h: ClientHarness, count = 1): Promise<FileOfferNotice> {
  await waitFor(() => h.fileOffers.length >= count, 'the offer');
  return h.fileOffers[count - 1] as FileOfferNotice;
}

const of = (h: ClientHarness, id: string): TransferStatus[] => h.transfers.filter((status) => status.id === id);
const states = (h: ClientHarness, id: string): TransferState[] => of(h, id).map((status) => status.state);
const last = (h: ClientHarness, id: string): TransferStatus | undefined => of(h, id).at(-1);

async function ended(h: ClientHarness, id: string, state: TransferState): Promise<TransferStatus> {
  await waitFor(() => last(h, id)?.state === state, `the transfer ends ${state}; it reads ${states(h, id).join(', ')}`);
  return last(h, id) as TransferStatus;
}

// The connection of the peer closed, and the transfer waits for the reason.
async function afterCancelWait(): Promise<void> {
  await waitFor(() => timers.pending().includes(PEER_CANCEL_WAIT_MS), 'the wait for the cancel of the peer');
  await timers.advance(PEER_CANCEL_WAIT_MS);
}

// Bob accepted and his first write waits.
async function midway(bytes = 4 * MB): Promise<{ id: string; offer: FileOfferNotice; into: MemorySink }> {
  const id = await alice.client.sendFiles('Bob', [source('movie.mov', content(bytes))]);
  const offer = await offerAt(bob);
  const into = memorySink(true);
  await bob.client.acceptFileOffer(offer.id, into.sink);
  await waitFor(() => into.writing, 'the first write');
  return { id, offer, into };
}

describe('Send File between two clients', () => {
  it('Alice sends one file: Bob hears fileOffer {count 1, totalBytes, name}, accepts, both end done, bytes equal', async () => {
    await start();
    const data = content(70_001);
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', data)]);
    expect(id).toMatch(/^bob:[0-9a-f]{16}$/);
    const offer = await offerAt(bob);
    expect(offer).toEqual({ id: id.replace('bob:', 'alice:'), from: 'Alice', count: 1, totalBytes: data.length, name: 'notes.txt', folder: null, at: timers.now() });
    expect(bob.transfers).toEqual([]);
    const into = memorySink();
    await bob.client.acceptFileOffer(offer.id, into.sink);
    const sent = await ended(alice, id, 'done');
    const got = await ended(bob, offer.id, 'done');
    expect(sent).toEqual({ id, direction: 'out', peer: 'Bob', state: 'done', count: 1, index: 0, name: 'notes.txt', bytesDone: data.length, bytesTotal: data.length });
    expect(got).toEqual({ ...sent, id: offer.id, direction: 'in', peer: 'Alice' });
    // The clock stands still, so each file reports one time, at its end.
    expect(states(alice, id)).toEqual(['waiting', 'connecting', 'transferring', 'transferring', 'done']);
    expect(states(bob, offer.id)).toEqual(['connecting', 'transferring', 'transferring', 'done']);
    expect(into.files.map((saved) => [saved.file, saved.finished, saved.aborted])).toEqual([
      [{ name: 'notes.txt', bytes: data.length, modifiedAt: 1_700_000_000, index: 0, count: 1 }, true, false],
    ]);
    expect(bytesOf(into.files[0])).toEqual(data);
    await waitFor(() => fake.relaySessions().length === 0, 'the relay lets go');
  });

  it.each([
    ['in the order of the offers', [0, 1]],
    ['the newer offer first', [1, 0]],
  ] as const)('two offers that wait on one buddy and are accepted at once, %s: each ends done with its own bytes', async (_order, order) => {
    await start();
    const data = [content(MB + 1, 1), content(300_000, 2)];
    const ids = [
      await alice.client.sendFiles('Bob', [source('one.bin', data[0] as Uint8Array)]),
      await alice.client.sendFiles('Bob', [source('two.bin', data[1] as Uint8Array)]),
    ];
    await offerAt(bob, 2);
    const into = [memorySink(), memorySink()];
    // No wait between the two: the relay sees one address for all four connections.
    await Promise.all(order.map((at) => bob.client.acceptFileOffer(bob.fileOffers[at]?.id ?? '', (into[at] as MemorySink).sink)));
    // The link to the server paces the messages of the second offer. The clock moves for them.
    for (let second = 0; second < 10 && ids.some((id) => last(alice, id)?.state !== 'done'); second++) await timers.advance(1000);
    for (const at of [0, 1]) {
      expect(await ended(bob, bob.fileOffers[at]?.id ?? '', 'done')).toMatchObject({ count: 1, bytesDone: data[at]?.length });
      expect(await ended(alice, ids[at] as string, 'done')).toMatchObject({ count: 1, bytesDone: data[at]?.length });
      expect(into[at]?.files.map((saved) => [saved.file.name, saved.finished])).toEqual([[at === 0 ? 'one.bin' : 'two.bin', true]]);
      expect(bytesOf(into[at]?.files[0])).toEqual(data[at]);
    }
  });

  it('three files, 5 MB in total, arrive in order', async () => {
    await start();
    const data = [content(MB, 1), content(2.5 * MB, 2), content(1.5 * MB, 3)];
    const names = ['one.bin', 'two.bin', 'three.bin'];
    const id = await alice.client.sendFiles('Bob', data.map((bytes, i) => source(names[i] as string, bytes)));
    const offer = await offerAt(bob);
    expect(offer).toMatchObject({ count: 3, totalBytes: 5 * MB, name: '', folder: null });
    const into = memorySink();
    await bob.client.acceptFileOffer(offer.id, into.sink);
    expect(await ended(bob, offer.id, 'done')).toMatchObject({ count: 3, index: 2, name: 'three.bin', bytesDone: 5 * MB, bytesTotal: 5 * MB });
    expect(await ended(alice, id, 'done')).toMatchObject({ count: 3, index: 2, name: 'three.bin', bytesDone: 5 * MB, bytesTotal: 5 * MB });
    expect(into.files.map((saved) => [saved.file.name, saved.file.index, saved.file.count, saved.finished])).toEqual([
      ['one.bin', 0, 3, true],
      ['two.bin', 1, 3, true],
      ['three.bin', 2, 3, true],
    ]);
    for (const [i, bytes] of data.entries()) expect(Buffer.from(bytesOf(into.files[i])).equals(Buffer.from(bytes)), names[i]).toBe(true);
    for (const h of [alice, bob]) {
      const moved = h.transfers.filter((status) => status.state === 'transferring').map((status) => status.bytesDone);
      expect(moved).toEqual([0, MB, 3.5 * MB, 5 * MB]);
    }
  });

  it('a file of no bytes arrives as a file of no bytes', async () => {
    await start();
    const id = await alice.client.sendFiles('Bob', [source('empty.txt', new Uint8Array(0))]);
    const offer = await offerAt(bob);
    const into = memorySink();
    await bob.client.acceptFileOffer(offer.id, into.sink);
    await ended(alice, id, 'done');
    await ended(bob, offer.id, 'done');
    expect(into.files.map((saved) => [saved.file.bytes, saved.parts.length, saved.finished])).toEqual([[0, 0, true]]);
  });

  it('Bob declines: Alice ends declined by peer; Bob shows nothing further', async () => {
    await start();
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    const offer = await offerAt(bob);
    await bob.client.declineFileOffer(offer.id);
    expect(await ended(alice, id, 'declined')).toMatchObject({ by: 'peer', direction: 'out' });
    expect(states(alice, id)).toEqual(['waiting', 'declined']);
    await imRoundTrip(fake, bob);
    await timers.advance(OFFER_ACCEPT_MS);
    expect(bob.transfers).toEqual([expect.objectContaining({ id: offer.id, direction: 'in', state: 'declined', by: 'self' })]);
    expect(fake.relaySessions()).toEqual([]);
    await expect(bob.client.acceptFileOffer(offer.id, memorySink().sink)).rejects.toMatchObject(INVALID);
  });

  it('Alice cancels while waiting: Bob hears transfer cancelled by peer for that id', async () => {
    await start();
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    const offer = await offerAt(bob);
    await alice.client.cancelTransfer(id);
    expect(last(alice, id)).toMatchObject({ state: 'cancelled', by: 'self' });
    expect(await ended(bob, offer.id, 'cancelled')).toMatchObject({ id: offer.id, direction: 'in', peer: 'Alice', by: 'peer' });
    expect(bob.transfers).toHaveLength(1);
    expect(fake.relaySessions()).toEqual([]);
    await expect(bob.client.acceptFileOffer(offer.id, memorySink().sink)).rejects.toMatchObject(INVALID);
    // A second cancel finds no transfer.
    await alice.client.cancelTransfer(id);
    expect(states(alice, id)).toEqual(['waiting', 'cancelled']);
  });

  it('Alice cancels midway: Bob ends cancelled, his writer was aborted', async () => {
    await start();
    const { id, offer, into } = await midway();
    await alice.client.cancelTransfer(id);
    expect(last(alice, id)).toMatchObject({ state: 'cancelled', by: 'self' });
    expect(await ended(bob, offer.id, 'cancelled')).toMatchObject({ by: 'peer' });
    into.release();
    await waitFor(() => into.files[0]?.aborted === true, 'the abort');
    expect(into.files.map((saved) => saved.finished)).toEqual([false]);
    await timers.advance(PEER_CANCEL_WAIT_MS);
    expect(last(bob, offer.id)).toMatchObject({ state: 'cancelled', by: 'peer' });
    expect(last(alice, id)).toMatchObject({ state: 'cancelled', by: 'self' });
  });

  it('Bob cancels midway: Bob ends cancelled by self, Alice ends cancelled by peer', async () => {
    await start();
    const { id, offer, into } = await midway();
    await bob.client.cancelTransfer(offer.id);
    expect(last(bob, offer.id)).toMatchObject({ state: 'cancelled', by: 'self' });
    expect(await ended(alice, id, 'cancelled')).toMatchObject({ by: 'peer' });
    into.release();
    await waitFor(() => into.files[0]?.aborted === true, 'the abort');
    expect(into.files).toHaveLength(1);
  });

  it('Bob signs off midway: Alice ends failed peer-closed; Bob ends failed signed-off', async () => {
    await start();
    const { id, offer, into } = await midway();
    await bob.client.signOff();
    expect(last(bob, offer.id)).toMatchObject({ state: 'failed', failure: 'signed-off' });
    into.release();
    await waitFor(() => into.files[0]?.aborted === true, 'the abort');
    await afterCancelWait();
    expect(await ended(alice, id, 'failed')).toMatchObject({ failure: 'peer-closed' });
    expect(into.files.map((saved) => saved.finished)).toEqual([false]);
  });

  it('the connection of Bob drops midway: Bob ends failed signed-off and his writer was aborted', async () => {
    await start();
    const { offer, into } = await midway();
    bob.client.dropConnection();
    await waitFor(() => bob.client.state === 'reconnecting', 'the drop');
    expect(last(bob, offer.id)).toMatchObject({ state: 'failed', failure: 'signed-off' });
    into.release();
    await waitFor(() => into.files[0]?.aborted === true, 'the abort');
    expect(into.files).toHaveLength(1);
  });

  it('sign-off with an offer out and an offer in: failed signed-off and cancelled, and no sink is used after', async () => {
    await start();
    const out = await bob.client.sendFiles('Alice', [source('back.txt', content(10))]);
    await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    const offer = await offerAt(bob);
    await bob.client.signOff();
    expect(last(bob, out)).toMatchObject({ direction: 'out', state: 'failed', failure: 'signed-off' });
    expect(last(bob, offer.id)).toMatchObject({ direction: 'in', state: 'cancelled', by: 'self' });
    const count = bob.transfers.length;
    await timers.advance(OFFER_ACCEPT_MS);
    expect(bob.transfers).toHaveLength(count);
  });

  it('Bob signs off between his accept and the connection: begin is never called', async () => {
    await start();
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    const offer = await offerAt(bob);
    const into = memorySink();
    await bob.client.acceptFileOffer(offer.id, into.sink);
    await bob.client.signOff();
    expect(states(bob, offer.id)).toEqual(['connecting', 'failed']);
    expect(last(bob, offer.id)).toMatchObject({ failure: 'signed-off' });
    await timers.advance(OFFER_ACCEPT_MS);
    expect(into.files).toEqual([]);
    expect(last(alice, id)?.state).not.toBe('done');
  });

  it('nobody answers: after OFFER_ACCEPT_MS Alice ends failed timed-out', async () => {
    await start();
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    const offer = await offerAt(bob);
    await timers.advance(OFFER_ACCEPT_MS - 1);
    expect(states(alice, id)).toEqual(['waiting']);
    await timers.advance(1);
    expect(await ended(alice, id, 'failed')).toMatchObject({ failure: 'timed-out' });
    expect(await ended(bob, offer.id, 'failed')).toMatchObject({ failure: 'timed-out' });
    expect(fake.relaySessions()).toEqual([]);
  });

  it('Bob is signed in twice: both hear the offer, the first accept wins, the second ends failed taken-elsewhere', async () => {
    await start();
    const second = await join('Bob', 'bobpw123', {});
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(3000))]);
    const offer = await offerAt(bob);
    expect(await offerAt(second)).toEqual(offer);
    const into = memorySink();
    await bob.client.acceptFileOffer(offer.id, into.sink);
    await ended(bob, offer.id, 'done');
    await ended(alice, id, 'done');
    const late = memorySink();
    const heard = alice.transfers.length;
    await second.client.acceptFileOffer(offer.id, late.sink);
    await waitFor(() => timers.pending().includes(RELAY_SILENCE_MS), 'the relay takes the connection');
    await timers.advance(RELAY_SILENCE_MS);
    expect(await ended(second, offer.id, 'failed')).toMatchObject({ failure: 'taken-elsewhere' });
    expect(states(second, offer.id)).toEqual(['connecting', 'failed']);
    expect(late.files).toEqual([]);
    await imRoundTrip(fake, second);
    expect(alice.transfers).toHaveLength(heard);
  });

  it('the second instance of Bob accepts while the first receives: the file still arrives', async () => {
    await start();
    const second = await join('Bob', 'bobpw123', {});
    const data = content(4 * MB);
    const id = await alice.client.sendFiles('Bob', [source('movie.mov', data)]);
    const offer = await offerAt(bob);
    await offerAt(second);
    const into = memorySink(true);
    await bob.client.acceptFileOffer(offer.id, into.sink);
    await waitFor(() => into.writing, 'the first write');
    const late = memorySink();
    await second.client.acceptFileOffer(offer.id, late.sink);
    await waitFor(() => timers.pending().includes(RELAY_SILENCE_MS), 'the relay takes the connection');
    await timers.advance(RELAY_SILENCE_MS);
    expect(await ended(second, offer.id, 'failed')).toMatchObject({ failure: 'taken-elsewhere' });
    await imRoundTrip(fake, second);
    await timers.advance(PEER_CANCEL_WAIT_MS);
    into.release();
    await ended(bob, offer.id, 'done');
    await ended(alice, id, 'done');
    expect(Buffer.from(bytesOf(into.files[0])).equals(Buffer.from(data))).toBe(true);
    expect(late.files).toEqual([]);
  });

  it('the second instance of Bob declines while the first receives: the file still arrives', async () => {
    await start();
    const second = await join('Bob', 'bobpw123', {});
    const data = content(4 * MB);
    const id = await alice.client.sendFiles('Bob', [source('movie.mov', data)]);
    const offer = await offerAt(bob);
    await offerAt(second);
    const into = memorySink(true);
    await bob.client.acceptFileOffer(offer.id, into.sink);
    await waitFor(() => into.writing, 'the first write');
    await second.client.declineFileOffer(offer.id);
    await imRoundTrip(fake, second);
    await imRoundTrip(fake, alice);
    await timers.advance(PEER_CANCEL_WAIT_MS);
    expect(last(alice, id)?.state).toBe('transferring');
    into.release();
    await ended(bob, offer.id, 'done');
    await ended(alice, id, 'done');
    expect(Buffer.from(bytesOf(into.files[0])).equals(Buffer.from(data))).toBe(true);
  });

  it('Alice drops after her offer and Bob accepts: Bob waits at connecting and ends failed peer-closed', async () => {
    await start();
    await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    const offer = await offerAt(bob);
    alice.client.dropConnection();
    await waitFor(() => alice.client.state === 'reconnecting', 'the drop');
    await bob.client.acceptFileOffer(offer.id, memorySink().sink);
    await waitFor(() => timers.pending().includes(COUNTER_DIAL_MS), 'the relay waits for the offerer');
    expect(states(bob, offer.id)).toEqual(['connecting']);
    await timers.advance(COUNTER_DIAL_MS);
    await afterCancelWait();
    expect(await ended(bob, offer.id, 'failed')).toMatchObject({ failure: 'peer-closed' });
    expect(states(bob, offer.id)).toEqual(['connecting', 'failed']);
  });

  it('allowDial returns false on Bob: Bob ends failed refused-address, Alice ends declined or cancelled', async () => {
    const asked: Parameters<NonNullable<FileTransferOptions['allowDial']>>[] = [];
    await start({
      bob: {
        allowDial: (...args) => {
          asked.push(args);
          return false;
        },
      },
    });
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    const offer = await offerAt(bob);
    const into = memorySink();
    await bob.client.acceptFileOffer(offer.id, into.sink);
    expect(await ended(bob, offer.id, 'failed')).toMatchObject({ failure: 'refused-address' });
    await waitFor(() => ['declined', 'cancelled'].includes(last(alice, id)?.state ?? ''), 'the end at Alice');
    expect(last(alice, id)).toMatchObject({ by: 'peer' });
    expect(asked).toEqual([
      [{ ip: '127.0.0.1', port: fake.relayPort }, { server: { host: '127.0.0.1', port: fake.port }, bos: { host: '127.0.0.1', port: fake.port } }],
    ]);
    expect(fake.relayed()).toEqual([]);
    expect(into.files).toEqual([]);
  });

  it('a client without fileTransfer ignores the proposal and sends nothing back', async () => {
    await start({ bob: null });
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    await waitFor(() => fake.relaySessions().length === 1, 'the offer reaches the server');
    await imRoundTrip(fake, alice);
    await imRoundTrip(fake, bob);
    expect(bob.fileOffers).toEqual([]);
    expect(bob.transfers).toEqual([]);
    // A cancel or a client error from Bob ends the session of the relay.
    expect(fake.relaySessions()).toHaveLength(1);
    expect(states(alice, id)).toEqual(['waiting']);
    await expect(bob.client.sendFiles('Alice', [source('notes.txt', content(1))])).rejects.toMatchObject(INVALID);
  });

  it('a 17th waiting offer is cancelled back', async () => {
    await start();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_WAITING_OFFERS; i++) {
      ids.push(await alice.client.sendFiles('Bob', [source(`file-${i}.txt`, content(10))]));
      // The rate limit of the server holds a message that follows another too soon.
      await timers.advance(10_000);
    }
    const late = ids.at(-1) as string;
    expect(await ended(alice, late, 'declined')).toMatchObject({ by: 'peer' });
    expect(bob.fileOffers.map((offer) => offer.name)).toEqual(ids.slice(0, MAX_WAITING_OFFERS).map((_id, i) => `file-${i}.txt`));
    expect(ids.slice(0, MAX_WAITING_OFFERS).map((id) => states(alice, id))).toEqual(ids.slice(0, MAX_WAITING_OFFERS).map(() => ['waiting']));
    expect(bob.transfers).toEqual([]);
  });

  it('the folder of Bob fails: Bob ends failed folder-problem and Alice is told', async () => {
    await start();
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100_000))]);
    const offer = await offerAt(bob);
    await bob.client.acceptFileOffer(offer.id, { begin: async () => Promise.reject(new Error('the folder is read-only')) });
    expect(await ended(bob, offer.id, 'failed')).toMatchObject({ failure: 'folder-problem' });
    expect(await ended(alice, id, 'cancelled')).toMatchObject({ by: 'peer' });
  });

  it('the file of Alice is gone after the offer: Alice ends failed source-changed, Bob ends cancelled and keeps nothing', async () => {
    await start();
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100_000), true)]);
    const offer = await offerAt(bob);
    const into = memorySink();
    await bob.client.acceptFileOffer(offer.id, into.sink);
    expect(await ended(alice, id, 'failed')).toMatchObject({ failure: 'source-changed' });
    expect(await ended(bob, offer.id, 'cancelled')).toMatchObject({ by: 'peer' });
    await waitFor(() => into.files.every((saved) => saved.aborted), 'the abort');
    expect(into.files.map((saved) => saved.finished)).toEqual(into.files.map(() => false));
  });

  it('an accept or a cancel for an id that is not there', async () => {
    await start();
    await expect(alice.client.acceptFileOffer('bob:0000000000000001', memorySink().sink)).rejects.toMatchObject(INVALID);
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(10))]);
    await expect(alice.client.acceptFileOffer(id, memorySink().sink)).rejects.toMatchObject(INVALID);
    await alice.client.declineFileOffer(id);
    await alice.client.cancelTransfer('bob:0000000000000001');
    expect(states(alice, id)).toEqual(['waiting']);
    await expect(alice.client.sendFiles('', [source('notes.txt', content(10))])).rejects.toMatchObject({ info: { kind: 'local', code: 'invalid-screen-name' } });
  });
});
