import { afterEach, describe, expect, it } from 'vitest';
import type { FileSink, IncomingFile, OutgoingFile, TransferState } from '../../src/model/transfer.js';
import { SEND_FILE_CAPABILITY } from '../../src/model/buddy-list.js';
import type { BuddyPresence } from '../../src/model/buddy-list.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';

const MB = 1024 * 1024;

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: FakePeer;

const BUDDIES: FeedbagItem = { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] };

// Bob is a scripted peer. Alice is a client with each name of `buddies` on her list.
async function start(buddies: readonly string[] = []): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, timers: timers.api, relay: true });
  fake.addUser('Alice', 'alicepw1');
  bob = fake.peer('Bob');
  for (const name of buddies) fake.peer(name);
  const items = buddies.map((name, i): FeedbagItem => ({ name: name.toLowerCase(), groupId: 1, itemId: i + 1, classId: 0, attrs: [] }));
  fake.setFeedbag('alice', withTypingPref([BUDDIES, ...items]));
  alice = makeClient(fake, { timers, fileTransfer: {} });
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

function source(name: string, data: Uint8Array): OutgoingFile {
  return {
    name,
    bytes: data.length,
    modifiedAt: 1_700_000_000,
    read: async function* () {
      for (let at = 0; at < data.length; at += 16 * 1024) yield data.subarray(at, at + 16 * 1024);
    },
  };
}

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

const bytesOf = (saved: Saved | undefined): Buffer => Buffer.concat(saved?.parts ?? []);
const stateOf = (h: ClientHarness, id: string): TransferState | undefined => h.transfers.filter((status) => status.id === id).at(-1)?.state;

describe('a scripted peer moves files', () => {
  it('a client receives the file that a scripted peer offers, bytes equal', async () => {
    await start();
    const data = content(MB + 3);
    const ended = bob.offerFile('Alice', 'budget.xls', data);
    await waitFor(() => alice.fileOffers.length === 1, 'the offer');
    const offer = alice.fileOffers[0];
    expect(offer).toMatchObject({ from: 'Bob', count: 1, totalBytes: data.length, name: 'budget.xls' });
    const into = memorySink();
    await alice.client.acceptFileOffer(offer?.id ?? '', into.sink);
    expect(await ended).toMatchObject({ peer: 'Alice', direction: 'out', outcome: 'done' });
    await waitFor(() => stateOf(alice, offer?.id ?? '') === 'done', 'the client ends done');
    expect(into.files.map((saved) => [saved.file.name, saved.file.bytes, saved.finished, saved.aborted])).toEqual([['budget.xls', data.length, true, false]]);
    expect(bytesOf(into.files[0]).equals(Buffer.from(data))).toBe(true);
    expect(fake.relayed()).toEqual([expect.objectContaining({ bytesToRecipient: expect.any(Number) })]);
    expect(bob.fileTransfers()).toEqual([await ended]);
  });

  it('a scripted peer receives the file that a client sends, bytes equal', async () => {
    await start();
    const into = memorySink();
    bob.acceptOffers(into.sink);
    const data = content(2 * MB + 1, 3);
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', data)]);
    await waitFor(() => stateOf(alice, id) === 'done', 'the client ends done');
    await waitFor(() => bob.fileTransfers().length === 1, 'the peer ends');
    expect(bob.fileTransfers()).toEqual([{ peer: 'Alice', cookie: BigInt(`0x${id.split(':')[1]}`), direction: 'in', outcome: 'done' }]);
    expect(into.files.map((saved) => [saved.file, saved.finished, saved.aborted])).toEqual([
      [{ name: 'notes.txt', bytes: data.length, modifiedAt: 1_700_000_000, index: 0, count: 1 }, true, false],
    ]);
    expect(bytesOf(into.files[0]).equals(Buffer.from(data))).toBe(true);
    await waitFor(() => fake.relaySessions().length === 0, 'the relay lets go');
  });

  it('a scripted peer takes two offers that a client sends with no wait between them', async () => {
    await start();
    const into = memorySink();
    bob.acceptOffers(into.sink);
    const data = [content(200_000, 4), content(300_001, 5)];
    const ids = [
      await alice.client.sendFiles('Bob', [source('one.txt', data[0] as Uint8Array)]),
      await alice.client.sendFiles('Bob', [source('two.bin', data[1] as Uint8Array)]),
    ];
    // The link to the server paces the messages of the second offer. The clock moves for them.
    for (let second = 0; second < 10 && ids.some((id) => stateOf(alice, id) !== 'done'); second++) await timers.advance(1000);
    for (const id of ids) await waitFor(() => stateOf(alice, id) === 'done', `the client ends done; it reads ${stateOf(alice, id)}`);
    await waitFor(() => bob.fileTransfers().length === 2, 'the peer ends');
    expect(bob.fileTransfers().map((transfer) => transfer.outcome)).toEqual(['done', 'done']);
    for (const [at, name] of ['one.txt', 'two.bin'].entries()) {
      const saved = into.files.find((each) => each.file.name === name);
      expect(saved?.finished).toBe(true);
      expect(bytesOf(saved).equals(Buffer.from(data[at] as Uint8Array))).toBe(true);
    }
  });

  it('a peer that accepts offers shows the Send File capability; a peer that does not shows none', async () => {
    await start(['Bob', 'Carol']);
    const last = (name: string): BuddyPresence | undefined => alice.presence.filter((p) => p.screenName.toLowerCase() === name).at(-1);
    const seen = (name: string): readonly string[] => last(name)?.capabilities ?? [];
    await waitFor(() => last('bob')?.online === true && last('carol')?.online === true, 'the two arrivals');
    expect(seen('bob')).not.toContain(SEND_FILE_CAPABILITY);
    bob.acceptOffers(memorySink().sink);
    await waitFor(() => seen('bob').includes(SEND_FILE_CAPABILITY), 'the capability of the peer');
    expect(seen('carol')).not.toContain(SEND_FILE_CAPABILITY);
  });

  it.each([
    ['a backslash and a star after the name', 'star', 'Plans\\*'],
    ['the name only', 'plain', 'Plans'],
  ] as const)('a scripted peer offers a folder, %s: the files arrive with their place in the folder', async (_form, form, offered) => {
    await start();
    const files = [
      { path: ['a.txt'], bytes: content(10, 1) },
      { path: ['drafts', 'a.txt'], bytes: content(20, 2) },
      { path: ['drafts', 'old', 'b.bin'], bytes: content(40 * 1024, 3) },
    ];
    const ended = bob.offerFolder('Alice', 'Plans', files, form);
    await waitFor(() => alice.fileOffers.length === 1, 'the offer');
    const offer = alice.fileOffers[0];
    expect(offer).toMatchObject({ from: 'Bob', count: 3, totalBytes: 30 + 40 * 1024, name: offered, folder: 'Plans' });
    const into = memorySink();
    await alice.client.acceptFileOffer(offer?.id ?? '', into.sink);
    expect(await ended).toMatchObject({ peer: 'Alice', direction: 'out', outcome: 'done' });
    await waitFor(() => stateOf(alice, offer?.id ?? '') === 'done', 'the client ends done');
    // The name of the folder is not in the name of a file.
    expect(into.files.map((saved) => [saved.file.name, saved.file.index, saved.file.count, saved.finished])).toEqual([
      ['a.txt', 0, 3, true],
      ['drafts\u0001a.txt', 1, 3, true],
      ['drafts\u0001old\u0001b.bin', 2, 3, true],
    ]);
    expect(into.files.map((saved) => bytesOf(saved).equals(Buffer.from(files[into.files.indexOf(saved)]?.bytes ?? [])))).toEqual([true, true, true]);
  });

  it('a client declines: the offer of the scripted peer ends declined by the peer', async () => {
    await start();
    const ended = bob.offerFile('Alice', 'budget.xls', content(100));
    await waitFor(() => alice.fileOffers.length === 1, 'the offer');
    await alice.client.declineFileOffer(alice.fileOffers[0]?.id ?? '');
    expect(await ended).toMatchObject({ direction: 'out', outcome: 'declined' });
    expect(fake.relaySessions()).toEqual([]);
  });

  it('a peer that accepts no offers leaves an offer alone', async () => {
    await start();
    const id = await alice.client.sendFiles('Bob', [source('notes.txt', content(100))]);
    await waitFor(() => fake.relaySessions().length === 1, 'the session of the relay');
    expect(stateOf(alice, id)).toBe('waiting');
    expect(bob.fileTransfers()).toEqual([]);
    await alice.client.cancelTransfer(id);
  });

  it('the peer signs off midway: the client does not end done and no file is finished', async () => {
    await start();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const into = memorySink();
    const held: FileSink = {
      begin: async (file) => {
        const writer = await into.sink.begin(file);
        return { ...writer, write: (chunk) => gate.then(() => writer.write(chunk)) };
      },
    };
    const ended = bob.offerFile('Alice', 'movie.mov', content(4 * MB));
    await waitFor(() => alice.fileOffers.length === 1, 'the offer');
    const id = alice.fileOffers[0]?.id ?? '';
    await alice.client.acceptFileOffer(id, held);
    await waitFor(() => into.files.length === 1, 'the first file begins');
    bob.signOff();
    open();
    expect((await ended).outcome).not.toBe('done');
    await waitFor(() => into.files[0]?.aborted === true, 'the writer is aborted');
    expect(into.files[0]?.finished).toBe(false);
    await alice.client.cancelTransfer(id);
    expect(stateOf(alice, id)).not.toBe('done');
  });
});
