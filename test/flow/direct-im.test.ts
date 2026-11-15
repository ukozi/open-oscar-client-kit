import { afterEach, describe, expect, it } from 'vitest';
import type { BosLink } from '../../src/client/bos-link.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { CANCEL_AFTER_CLOSE_MS, CROSSED_OFFER_MS } from '../../src/client/direct-im.js';
import { OFFER_ACCEPT_MS } from '../../src/client/rendezvous.js';
import { FAMILY_ICBM, ICBM_MSG_TO_HOST } from '../../src/wire/constants.js';
import { encodeDirectImProposal } from '../../src/wire/rendezvous.js';
import type { DirectImOffer, DirectImStatus, OutgoingDirectMessage } from '../../src/model/direct-im.js';
import type { FileSink, OutgoingFile, TransferStatus } from '../../src/model/transfer.js';
import { imRoundTrip, makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

type Services = Pick<OscarClientOptions, 'directIm' | 'fileTransfer'>;
const INVALID = { name: 'OscarError', info: { kind: 'local', code: 'invalid-argument' } };

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: ClientHarness;

async function join(name: string, password: string, services: Services = { directIm: {} }): Promise<ClientHarness> {
  const h = makeClient(fake, { timers, ...services });
  await h.signOn(name, password);
  return h;
}

async function start(opts: { alice?: Services; bob?: Services } = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, timers: timers.api, relay: true });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw123');
  alice = await join('Alice', 'alicepw1', opts.alice);
  bob = await join('Bob', 'bobpw123', opts.bob);
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

const picture = (bytes: Uint8Array, name = 'a.png'): OutgoingDirectMessage => ({ pictures: [{ name, bytes, width: 3, height: 2 }] });

async function offerAt(h: ClientHarness, count = 1): Promise<DirectImOffer> {
  await waitFor(() => h.directImOffers.length >= count, 'the offer');
  return h.directImOffers[count - 1] as DirectImOffer;
}

const of = (h: ClientHarness, id: string): DirectImStatus[] => h.directIms.filter((status) => status.id === id);
const last = (h: ClientHarness, id: string): DirectImStatus | undefined => of(h, id).at(-1);
// One word for each status: the end, or the state with a mark for the cookie.
const trail = (h: ClientHarness, id: string): string[] => of(h, id).map((s) => s.end ?? (s.verified ? `${s.state}+cookie` : s.state));

async function verified(h: ClientHarness, id: string): Promise<void> {
  await waitFor(() => last(h, id)?.verified === true || last(h, id)?.state === 'closed', 'the cookie of the peer');
  expect(trail(h, id).at(-1)).toBe('open+cookie');
}

async function ended(h: ClientHarness, id: string, end: DirectImStatus['end']): Promise<DirectImStatus> {
  await waitFor(() => last(h, id)?.state === 'closed', `the session ends; it reads ${trail(h, id).join(', ')}`);
  expect(last(h, id)?.end).toBe(end);
  return last(h, id) as DirectImStatus;
}

// Alice opened, Bob accepted, and each side saw the cookie of the other.
async function opened(): Promise<{ id: string; offer: DirectImOffer }> {
  const id = await alice.client.openDirectIm('Bob');
  const offer = await offerAt(bob);
  await bob.client.acceptDirectIm(offer.id);
  await verified(alice, id);
  await verified(bob, offer.id);
  return { id, offer };
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

function memorySink(): { sink: FileSink; parts: Uint8Array[]; finished: () => boolean } {
  const parts: Uint8Array[] = [];
  let finished = false;
  return {
    parts,
    finished: () => finished,
    sink: {
      begin: async () => ({
        write: async (chunk) => {
          parts.push(chunk.slice());
        },
        finish: async () => {
          finished = true;
        },
        abort: async () => {},
      }),
    },
  };
}

// The link to the server paces messages that follow each other closely. The clock moves for them.
async function paced(done: () => boolean): Promise<void> {
  for (let second = 0; second < 10 && !done(); second++) await timers.advance(1000);
}

const isVerified = (h: ClientHarness, id: string): boolean => last(h, id)?.verified === true;
const fileState = (h: ClientHarness, id: string): TransferStatus['state'] | undefined => h.transfers.filter((status) => status.id === id).at(-1)?.state;

async function fileDone(h: ClientHarness, id: string): Promise<void> {
  await waitFor(() => fileState(h, id) === 'done', `the transfer ends done; it reads ${fileState(h, id)}`);
}

describe('Direct IM between two clients', () => {
  it('Alice opens: Bob hears directImOffer, accepts, both reach open with verified true', async () => {
    await start();
    const id = await alice.client.openDirectIm('Bob');
    expect(id).toMatch(/^bob:[0-9a-f]{16}$/);
    const offer = await offerAt(bob);
    expect(offer).toEqual({ id: id.replace('bob:', 'alice:'), from: 'Alice', at: timers.now() });
    expect(bob.directIms).toEqual([]);
    expect(trail(alice, id)).toEqual(['waiting']);
    await bob.client.acceptDirectIm(offer.id);
    await verified(alice, id);
    await verified(bob, offer.id);
    const mine = { id, peer: 'Bob', role: 'offering' };
    expect(of(alice, id)).toEqual([
      { ...mine, state: 'waiting', verified: false },
      { ...mine, state: 'connecting', verified: false },
      { ...mine, state: 'open', verified: false },
      { ...mine, state: 'open', verified: true },
    ]);
    const his = { id: offer.id, peer: 'Alice', role: 'receiving' };
    expect(of(bob, offer.id)).toEqual([
      { ...his, state: 'connecting', verified: false },
      { ...his, state: 'open', verified: false },
      { ...his, state: 'open', verified: true },
    ]);
    expect(fake.relayed()).toHaveLength(1);
    // A second open for the same peer gives the session that is live.
    expect(await alice.client.openDirectIm('bob')).toBe(id);
    expect(await bob.client.openDirectIm('Alice')).toBe(offer.id);
    await imRoundTrip(fake, alice);
    expect(bob.directImOffers).toHaveLength(1);
    await expect(bob.client.acceptDirectIm(offer.id)).rejects.toMatchObject(INVALID);
  });

  it('Alice sends a 137-byte picture: Bob hears directMessage with equal bytes; Bob sends one back on the same session', async () => {
    await start();
    const { id, offer } = await opened();
    const data = content(137);
    await alice.client.sendDirectMessage(id, picture(data));
    await waitFor(() => bob.directMessages.length === 1, 'the picture at Bob');
    expect(bob.directMessages[0]).toEqual({
      id: offer.id, from: 'Alice', at: timers.now(), autoResponse: false, parts: [{ kind: 'attachment', index: 0 }],
      attachments: [{ id: 1, name: 'a.png', bytes: data }], unreferenced: 0, damaged: false,
    });
    const back = content(4096, 3);
    await bob.client.sendDirectMessage(offer.id, { body: [{ text: 'look' }], pictures: [{ name: 'b.gif', bytes: back, width: 0, height: 0 }] });
    await waitFor(() => alice.directMessages.length === 1, 'the picture at Alice');
    expect(alice.directMessages[0]).toMatchObject({
      id, from: 'Bob', parts: [{ kind: 'text', body: [{ text: 'look' }] }, { kind: 'attachment', index: 0 }],
      attachments: [{ id: 1, name: 'b.gif', bytes: back }], unreferenced: 0, damaged: false,
    });
    expect(fake.relayed()).toHaveLength(1);
    expect(trail(alice, id).at(-1)).toBe('open+cookie');
  });

  it('a message with more pictures than maxAttachments is refused, and nothing is written', async () => {
    await start({ alice: { directIm: { maxAttachments: 1 } } });
    const { id } = await opened();
    const two: OutgoingDirectMessage = { pictures: [...picture(content(10)).pictures, ...picture(content(11), 'b.png').pictures] };
    await expect(alice.client.sendDirectMessage(id, two)).rejects.toMatchObject(INVALID);
    await alice.client.sendDirectMessage(id, picture(content(12)));
    await waitFor(() => bob.directMessages.length === 1, 'the picture at Bob');
    expect(bob.directMessages[0]?.attachments.map((attachment) => attachment.bytes.length)).toEqual([12]);
  });

  it('Bob declines: Alice ends declined by peer; the test server holds no session', async () => {
    await start();
    const id = await alice.client.openDirectIm('Bob');
    const offer = await offerAt(bob);
    await bob.client.declineDirectIm(offer.id);
    expect(await ended(alice, id, 'declined')).toMatchObject({ by: 'peer', role: 'offering' });
    expect(trail(alice, id)).toEqual(['waiting', 'declined']);
    expect(bob.directIms).toEqual([{ id: offer.id, peer: 'Alice', role: 'receiving', state: 'closed', end: 'declined', by: 'self', verified: false }]);
    expect(fake.relaySessions()).toEqual([]);
    expect(fake.relayed()).toEqual([]);
    await expect(bob.client.acceptDirectIm(offer.id)).rejects.toMatchObject(INVALID);
    await expect(alice.client.sendDirectMessage(id, picture(content(1)))).rejects.toMatchObject(INVALID);
  });

  it('Alice closes while waiting: Bob ends cancelled by peer', async () => {
    await start();
    const id = await alice.client.openDirectIm('Bob');
    const offer = await offerAt(bob);
    await alice.client.closeDirectIm(id);
    expect(last(alice, id)).toMatchObject({ state: 'closed', end: 'closed', by: 'self' });
    expect(await ended(bob, offer.id, 'cancelled')).toMatchObject({ by: 'peer', peer: 'Alice' });
    expect(bob.directIms).toHaveLength(1);
    expect(fake.relaySessions()).toEqual([]);
    // A second close finds no session.
    await alice.client.closeDirectIm(id);
    expect(trail(alice, id)).toEqual(['waiting', 'closed']);
  });

  it('Alice closes an open session: Alice ends closed by self, Bob ends peer-closed', async () => {
    await start();
    const { id, offer } = await opened();
    await alice.client.closeDirectIm(id);
    expect(last(alice, id)).toMatchObject({ state: 'closed', end: 'closed', by: 'self', verified: true });
    expect(await ended(bob, offer.id, 'peer-closed')).toMatchObject({ by: 'peer' });
    await expect(bob.client.sendDirectMessage(offer.id, picture(content(1)))).rejects.toMatchObject(INVALID);
    // The next open makes a new session.
    const next = await alice.client.openDirectIm('Bob');
    expect(next).not.toBe(id);
    await offerAt(bob, 2);
  });

  it('nobody answers: after OFFER_ACCEPT_MS both end timed-out', async () => {
    await start();
    const id = await alice.client.openDirectIm('Bob');
    const offer = await offerAt(bob);
    await timers.advance(OFFER_ACCEPT_MS - 1);
    expect(trail(alice, id)).toEqual(['waiting']);
    expect(bob.directIms).toEqual([]);
    await timers.advance(1);
    await ended(alice, id, 'timed-out');
    await ended(bob, offer.id, 'timed-out');
    expect(fake.relaySessions()).toEqual([]);
  });

  it('Bob signs off with the session open: Alice ends peer-closed, Bob ends signed-off', async () => {
    await start();
    const { id, offer } = await opened();
    await bob.client.signOff();
    expect(last(bob, offer.id)).toMatchObject({ state: 'closed', end: 'signed-off' });
    await ended(alice, id, 'peer-closed');
  });

  it('a drop of the connection of Bob ends his session signed-off, and his offer that waits', async () => {
    await start();
    const { offer } = await opened();
    fake.addUser('Carol', 'carolpw1');
    const carol = await join('Carol', 'carolpw1');
    await carol.client.openDirectIm('Bob');
    const waiting = await offerAt(bob, 2);
    bob.client.dropConnection();
    await waitFor(() => bob.client.state === 'reconnecting', 'the drop');
    expect(last(bob, offer.id)).toMatchObject({ state: 'closed', end: 'signed-off' });
    expect(last(bob, waiting.id)).toMatchObject({ state: 'closed', end: 'signed-off' });
  });

  it('Bob returns after a drop and opens Direct IM to Carol, whose offer still waits: the session of Carol takes his offer', async () => {
    await start();
    fake.addUser('Carol', 'carolpw1');
    const carol = await join('Carol', 'carolpw1');
    const id = await carol.client.openDirectIm('Bob');
    const dead = await offerAt(bob);
    bob.client.dropConnection();
    await ended(bob, dead.id, 'signed-off');
    const back = await join('Bob', 'bobpw123');
    await timers.advance(CROSSED_OFFER_MS + 1);
    expect(trail(carol, id)).toEqual(['waiting']);
    const again = await back.client.openDirectIm('Carol');
    await paced(() => isVerified(back, again) && isVerified(carol, id));
    await verified(back, again);
    expect(trail(carol, id)).toEqual(['waiting', 'connecting', 'open', 'open+cookie']);
    expect(carol.directImOffers).toEqual([]);
    expect(await carol.client.openDirectIm('Bob')).toBe(id);
    const data = content(137);
    await carol.client.sendDirectMessage(id, picture(data));
    await waitFor(() => back.directMessages.length === 1, 'the picture of Carol');
    expect(back.directMessages[0]?.attachments[0]?.bytes).toEqual(data);
  });

  it('Alice and Bob open Direct IM to each other at one time: one session opens on each side, and no offer is shown', async () => {
    await start();
    const [a, b] = await Promise.all([alice.client.openDirectIm('Bob'), bob.client.openDirectIm('Alice')]);
    await paced(() => isVerified(alice, a) && isVerified(bob, b));
    await verified(alice, a);
    await verified(bob, b);
    expect(alice.directImOffers).toEqual([]);
    expect(bob.directImOffers).toEqual([]);
    // The offer of Alice stays, and the session of Bob takes it.
    expect(trail(alice, a)).toEqual(['waiting', 'connecting', 'open', 'open+cookie']);
    expect(trail(bob, b)).toEqual(['waiting', 'connecting', 'open', 'open+cookie']);
    const data = content(137);
    await bob.client.sendDirectMessage(b, picture(data));
    await alice.client.sendDirectMessage(a, picture(data, 'b.png'));
    await waitFor(() => alice.directMessages.length === 1 && bob.directMessages.length === 1, 'a picture on each side');
    expect(alice.directMessages[0]).toMatchObject({ id: a, from: 'Bob' });
    expect(bob.directMessages[0]).toMatchObject({ id: b, from: 'Alice' });
    // The cancel that each side sent for one of the two offers ends nothing.
    await timers.advance(CROSSED_OFFER_MS);
    expect(alice.directIms.concat(bob.directIms).some((status) => status.state === 'closed')).toBe(false);
  });

  it('an offer to a name that is not signed on ends peer-closed when the error of the server comes', async () => {
    await start();
    fake.addUser('Carol', 'carolpw1');
    const id = await alice.client.openDirectIm('Carol');
    await ended(alice, id, 'peer-closed');
    expect(trail(alice, id)).toEqual(['waiting', 'peer-closed']);
    const carol = await join('Carol', 'carolpw1');
    const again = await alice.client.openDirectIm('Carol');
    expect(again).not.toBe(id);
    await offerAt(carol);
  });

  it('allowDial false on Alice after Bob accepted: Bob ends cancelled by peer', async () => {
    await start({ alice: { directIm: { allowDial: () => false } } });
    const id = await alice.client.openDirectIm('Bob');
    const offer = await offerAt(bob);
    await bob.client.acceptDirectIm(offer.id);
    await ended(alice, id, 'refused-address');
    expect(await ended(bob, offer.id, 'cancelled')).toMatchObject({ by: 'peer' });
    await timers.advance(CANCEL_AFTER_CLOSE_MS);
    expect(trail(bob, offer.id)).toEqual(['connecting', 'open', 'cancelled']);
  });

  it('Bob is signed in twice: both hear the offer, the first accept opens, the second ends taken-elsewhere', async () => {
    await start();
    const second = await join('Bob', 'bobpw123');
    const id = await alice.client.openDirectIm('Bob');
    const offer = await offerAt(bob);
    expect(await offerAt(second)).toEqual(offer);
    await bob.client.acceptDirectIm(offer.id);
    await verified(alice, id);
    await verified(bob, offer.id);
    const heard = alice.directIms.length;
    await second.client.acceptDirectIm(offer.id);
    await waitFor(() => trail(second, offer.id).includes('open'), 'the connection of the second Bob');
    await paced(() => last(second, offer.id)?.state === 'closed');
    await ended(second, offer.id, 'taken-elsewhere');
    expect(trail(second, offer.id)).toEqual(['connecting', 'open', 'taken-elsewhere']);
    await imRoundTrip(fake, second);
    expect(alice.directIms).toHaveLength(heard);
    expect(trail(bob, offer.id).at(-1)).toBe('open+cookie');
    // The session of the first instance still carries a picture.
    await alice.client.sendDirectMessage(id, picture(content(137)));
    await waitFor(() => bob.directMessages.length === 1, 'the picture at Bob');
    expect(second.directMessages).toEqual([]);
  });

  it('allowDial false on Bob: Bob ends refused-address', async () => {
    const asked: unknown[] = [];
    await start({
      bob: {
        directIm: {
          allowDial: (...args) => {
            asked.push(args);
            return false;
          },
        },
      },
    });
    const id = await alice.client.openDirectIm('Bob');
    const offer = await offerAt(bob);
    await bob.client.acceptDirectIm(offer.id);
    await ended(bob, offer.id, 'refused-address');
    expect(trail(bob, offer.id)).toEqual(['connecting', 'refused-address']);
    await waitFor(() => last(alice, id)?.state === 'closed', 'the end at Alice');
    expect(last(alice, id)).toMatchObject({ by: 'peer' });
    expect(asked).toEqual([
      [{ ip: '127.0.0.1', port: fake.relayPort }, { server: { host: '127.0.0.1', port: fake.port }, bos: { host: '127.0.0.1', port: fake.port } }],
    ]);
    expect(fake.relayed()).toEqual([]);
  });

  it('a client without directIm ignores the proposal and sends nothing back', async () => {
    await start({ bob: { fileTransfer: {} } });
    const id = await alice.client.openDirectIm('Bob');
    await waitFor(() => fake.relaySessions().length === 1, 'the offer reaches the server');
    await imRoundTrip(fake, alice);
    await imRoundTrip(fake, bob);
    expect(bob.directImOffers).toEqual([]);
    expect(bob.directIms).toEqual([]);
    expect(bob.fileOffers).toEqual([]);
    // A cancel or a client error from Bob ends the session of the relay.
    expect(fake.relaySessions()).toHaveLength(1);
    expect(trail(alice, id)).toEqual(['waiting']);
    await expect(bob.client.openDirectIm('Alice')).rejects.toMatchObject(INVALID);
  });

  it('a second proposal from Alice while the first waits ends the first offer of Bob cancelled by peer, and the second opens', async () => {
    await start();
    const id = await alice.client.openDirectIm('Bob');
    const offer = await offerAt(bob);
    const link = (alice.client as unknown as { link: BosLink }).link;
    const other = 0x0102030405060708n;
    await link.send(FAMILY_ICBM, ICBM_MSG_TO_HOST, encodeDirectImProposal(other, 'Bob', { sequence: 1, address: { ip: '0.0.0.0', port: 5190 } }));
    const second = await offerAt(bob, 2);
    expect(await ended(bob, offer.id, 'cancelled')).toMatchObject({ by: 'peer' });
    expect(second.id).not.toBe(offer.id);
    // Bob sent a cancel for the first offer only, thus the relay holds the second.
    await paced(() => last(alice, id)?.state === 'closed');
    expect(await ended(alice, id, 'declined')).toMatchObject({ by: 'peer' });
    expect(fake.relaySessions()).toEqual([other]);
  });

  it('Alice offers a file and opens Direct IM at once: the two meetings run one after the other, and both connect', async () => {
    const both: Services = { directIm: {}, fileTransfer: {} };
    await start({ alice: both, bob: both });
    const data = content(70_001);
    const [fileId, id] = await Promise.all([alice.client.sendFiles('Bob', [source('notes.txt', data)]), alice.client.openDirectIm('Bob')]);
    await paced(() => bob.directImOffers.length === 1 && bob.fileOffers.length === 1);
    const offer = await offerAt(bob);
    await waitFor(() => bob.fileOffers.length === 1, 'the file offer');
    const into = memorySink();
    await Promise.all([bob.client.acceptDirectIm(offer.id), bob.client.acceptFileOffer(bob.fileOffers[0]?.id ?? '', into.sink)]);
    await paced(() => isVerified(alice, id) && fileState(alice, fileId) === 'done');
    await verified(alice, id);
    await verified(bob, offer.id);
    await fileDone(alice, fileId);
    await fileDone(bob, bob.fileOffers[0]?.id ?? '');
    expect(Buffer.concat(into.parts).equals(Buffer.from(data))).toBe(true);
    // The second meeting began when the first pair was joined.
    const cookies = fake.relayed().map((pair) => pair.cookie.toString(16).padStart(16, '0'));
    expect(cookies).toEqual([id.replace('bob:', ''), fileId.replace('bob:', '')]);
    await alice.client.sendDirectMessage(id, picture(content(137)));
    await waitFor(() => bob.directMessages.length === 1, 'the picture at Bob');
  });

  it('Bob accepts a file offer and a Direct IM offer from Alice at once: both connect, and each link carries its own cookie', async () => {
    const both: Services = { directIm: {}, fileTransfer: {} };
    await start({ alice: both, bob: both });
    const data = content(3000);
    const fileId = await alice.client.sendFiles('Bob', [source('notes.txt', data)]);
    const id = await alice.client.openDirectIm('Bob');
    await paced(() => bob.directImOffers.length === 1 && bob.fileOffers.length === 1);
    const offer = await offerAt(bob);
    await waitFor(() => bob.fileOffers.length === 1, 'the file offer');
    const into = memorySink();
    await Promise.all([bob.client.acceptFileOffer(bob.fileOffers[0]?.id ?? '', into.sink), bob.client.acceptDirectIm(offer.id)]);
    await paced(() => isVerified(alice, id) && fileState(alice, fileId) === 'done');
    await fileDone(alice, fileId);
    await fileDone(bob, bob.fileOffers[0]?.id ?? '');
    await verified(alice, id);
    await verified(bob, offer.id);
    expect(Buffer.concat(into.parts).equals(Buffer.from(data))).toBe(true);
    const cookies = fake.relayed().map((pair) => pair.cookie.toString(16).padStart(16, '0'));
    expect(cookies).toEqual([fileId.replace('bob:', ''), id.replace('bob:', '')]);
    await bob.client.sendDirectMessage(offer.id, picture(content(137)));
    await waitFor(() => alice.directMessages.length === 1, 'the picture at Alice');
    expect(alice.directMessages[0]?.attachments[0]?.bytes).toEqual(content(137));
  });
});
