import { afterEach, describe, expect, it } from 'vitest';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { concatBytes } from '../../src/wire/bytes.js';
import { DIRECT_IM_MAX_MESSAGE_BYTES, ODC_FLAG_TYPED, ODC_FLAG_TYPING, ODC_FLAG_TYPING_NOTICE } from '../../src/wire/constants.js';
import { encodeOdcHeader, encodeOdcMessage } from '../../src/wire/odc.js';
import type { PeerAddress } from '../../src/wire/rendezvous.js';
import { DIRECT_IM_CAPABILITY } from '../../src/model/buddy-list.js';
import type { DirectImOffer, DirectImStatus, OutgoingDirectMessage } from '../../src/model/direct-im.js';
import type { FileSink } from '../../src/model/transfer.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';
import type { PeerDirectIm } from '../fake/peer-direct-im.js';

type Services = Pick<OscarClientOptions, 'directIm' | 'fileTransfer'>;
const BUDDIES: FeedbagItem = { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] };
const BOB: FeedbagItem = { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] };

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: FakePeer;

// Bob is a scripted peer on the list of Alice. Alice is a client.
async function start(services: Services = { directIm: {} }): Promise<void> {
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

const picture = (bytes: Uint8Array): OutgoingDirectMessage => ({ pictures: [{ name: 'a.png', bytes, width: 3, height: 2 }] });
const of = (id: string): DirectImStatus[] => alice.directIms.filter((status) => status.id === id);
const last = (id: string): DirectImStatus | undefined => of(id).at(-1);

// Real time for the bytes that are on their way through the relay.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

async function inState(id: string, state: DirectImStatus['state']): Promise<DirectImStatus> {
  await waitFor(() => last(id)?.state === state || last(id)?.state === 'closed', `the session is ${state}`);
  expect(last(id)?.state).toBe(state);
  return last(id) as DirectImStatus;
}

async function ended(id: string, end: DirectImStatus['end']): Promise<DirectImStatus> {
  const status = await inState(id, 'closed');
  expect(status.end).toBe(end);
  return status;
}

// Bob offers, Alice accepts, and the connection is open at each side.
async function bobOpens(form: 'speaks' | 'silent' = 'speaks'): Promise<{ id: string; session: PeerDirectIm }> {
  const opening = bob.openDirectIm('Alice', form);
  await waitFor(() => alice.directImOffers.length === 1, 'the offer');
  const offer = alice.directImOffers[0] as DirectImOffer;
  await alice.client.acceptDirectIm(offer.id);
  const session = await opening;
  expect(session.outcome).toBe('open');
  await inState(offer.id, 'open');
  if (form === 'speaks') await waitFor(() => last(offer.id)?.verified === true, 'the cookie of Bob');
  return { id: offer.id, session };
}

// Alice offers, Bob accepts, and the connection is open at each side.
async function aliceOpens(form: 'speaks' | 'silent' = 'speaks'): Promise<{ id: string; session: PeerDirectIm }> {
  bob.acceptDirectIm(form);
  const id = await alice.client.openDirectIm('Bob');
  await inState(id, 'open');
  await waitFor(() => bob.directIms().length === 1, 'the session of Bob');
  const session = bob.directIms()[0] as PeerDirectIm;
  expect(session.outcome).toBe('open');
  if (form === 'speaks') await waitFor(() => last(id)?.verified === true, 'the cookie of Bob');
  return { id, session };
}

const header = (session: PeerDirectIm, flags: number, payloadBytes = 0, cookie = session.cookie): Uint8Array =>
  encodeOdcHeader({ cookie, payloadBytes, encoding: 0, flags, screenName: 'Bob' });

describe('Direct IM with a scripted peer', () => {
  it('a peer that accepts shows the Direct IM capability, and each side gets the picture of the other', async () => {
    await start();
    const { id, session } = await aliceOpens();
    expect(alice.client.presenceOf('Bob')?.capabilities).toContain(DIRECT_IM_CAPABILITY);
    const data = content(137);
    await alice.client.sendDirectMessage(id, picture(data));
    await waitFor(() => session.received().length === 1, 'the picture at Bob');
    expect(session.received()[0]).toMatchObject({ from: 'Alice', parts: [{ kind: 'attachment', index: 0 }], attachments: [{ id: 1, name: 'a.png', bytes: data }] });
    expect(session.frames()).toEqual(['hello', 'message']);
    await session.sendPicture('b.gif', content(300, 2), 'look');
    await waitFor(() => alice.directMessages.length === 1, 'the picture at Alice');
    expect(alice.directMessages[0]).toMatchObject({
      id, from: 'Bob', parts: [{ kind: 'text', body: [{ text: 'look' }] }, { kind: 'attachment', index: 0 }],
      attachments: [{ id: 1, name: 'b.gif', bytes: content(300, 2) }],
    });
    await session.sendText('<HTML><BODY>only text</BODY></HTML>');
    await waitFor(() => alice.directMessages.length === 2, 'the text at Alice');
    expect(alice.directMessages[1]).toMatchObject({ parts: [{ kind: 'text', body: [{ text: 'only text' }] }], attachments: [] });
  });

  it('a client declines: the offer of the scripted peer ends declined', async () => {
    await start();
    const opening = bob.openDirectIm('Alice');
    await waitFor(() => alice.directImOffers.length === 1, 'the offer');
    await alice.client.declineDirectIm(alice.directImOffers[0]?.id ?? '');
    expect((await opening).outcome).toBe('declined');
    await expect((await opening).sendText('late')).rejects.toThrow();
    expect(fake.relaySessions()).toEqual([]);
  });

  it('a peer that accepts no offers leaves an offer alone', async () => {
    await start();
    const id = await alice.client.openDirectIm('Bob');
    await waitFor(() => fake.relaySessions().length === 1, 'the offer reaches the server');
    await settle();
    expect(of(id).map((status) => status.state)).toEqual(['waiting']);
    expect(bob.directIms()).toEqual([]);
  });

  it('a silent peer opens: the session is open and not verified; its first picture verifies it and is delivered', async () => {
    await start();
    const { id, session } = await bobOpens('silent');
    await settle();
    expect(last(id)).toMatchObject({ state: 'open', verified: false, role: 'receiving' });
    expect(alice.directMessages).toEqual([]);
    const data = content(137);
    await session.sendPicture('a.png', data);
    await waitFor(() => alice.directMessages.length === 1, 'the picture');
    expect(alice.directMessages[0]).toMatchObject({ id, from: 'Bob', attachments: [{ bytes: data }] });
    expect(of(id).map((status) => [status.state, status.verified])).toEqual([['connecting', false], ['open', false], ['open', true]]);
  });

  it('sendUnverifiedAfterMs null: a picture to a silent peer is not sent, and is sent after the peer speaks', async () => {
    await start();
    const { id, session } = await aliceOpens('silent');
    let done = false;
    const sending = alice.client.sendDirectMessage(id, picture(content(137))).then(() => {
      done = true;
    });
    await timers.advance(60_000);
    await settle();
    expect(session.frames()).toEqual(['hello']);
    expect(done).toBe(false);
    expect(last(id)).toMatchObject({ state: 'open', verified: false });
    await session.sendText('hello');
    await sending;
    await waitFor(() => session.received().length === 1, 'the picture at Bob');
    expect(session.received()[0]?.attachments[0]?.bytes).toEqual(content(137));
    expect(last(id)).toMatchObject({ state: 'open', verified: true });
  });

  it('sendUnverifiedAfterMs 3000: a picture to a silent peer is not written at 2999 ms and is written at 3000 ms', async () => {
    await start({ directIm: { sendUnverifiedAfterMs: 3000 } });
    const { id, session } = await aliceOpens('silent');
    let done = false;
    const sending = alice.client.sendDirectMessage(id, picture(content(137))).then(() => {
      done = true;
    });
    await timers.advance(2999);
    await settle();
    expect(session.frames()).toEqual(['hello']);
    expect(done).toBe(false);
    await timers.advance(1);
    await sending;
    await waitFor(() => session.received().length === 1, 'the picture at Bob');
    expect(session.received()[0]?.attachments[0]?.bytes).toEqual(content(137));
    expect(last(id)).toMatchObject({ state: 'open', verified: false });
  });

  it('directIm.allowDial is asked for a Direct IM dial and fileTransfer.allowDial for a file dial; with only fileTransfer.allowDial, it is asked for both', async () => {
    const asked: string[] = [];
    const rule = (name: string) => (address: PeerAddress): boolean => {
      asked.push(`${name} ${address.ip}:${address.port}`);
      return true;
    };
    const sink: FileSink = { begin: async () => ({ write: async () => {}, finish: async () => {}, abort: async () => {} }) };
    const both = async (): Promise<void> => {
      const sent = bob.offerFile('Alice', 'notes.txt', content(10));
      await waitFor(() => alice.fileOffers.length === 1, 'the file offer');
      await alice.client.acceptFileOffer(alice.fileOffers[0]?.id ?? '', sink);
      expect((await sent).outcome).toBe('done');
      await bobOpens();
    };
    await start({ directIm: { allowDial: rule('direct-im') }, fileTransfer: { allowDial: rule('file') } });
    await both();
    const relay = `127.0.0.1:${fake.relayPort}`;
    expect(asked).toEqual([`file ${relay}`, `direct-im ${relay}`]);
    await stop();
    asked.length = 0;
    await start({ directIm: {}, fileTransfer: { allowDial: rule('file') } });
    await both();
    expect(asked).toEqual([`file 127.0.0.1:${fake.relayPort}`, `file 127.0.0.1:${fake.relayPort}`]);
  });

  it('a peer that sends a frame with another cookie: the session ends bad-cookie and no directMessage is emitted', async () => {
    await start();
    const { id, session } = await bobOpens('silent');
    const payload = encodeOdcMessage('', [{ id: 1, name: 'a.png', bytes: content(137), width: 0, height: 0 }]);
    await session.sendRaw(concatBytes([header(session, 0, payload.length, session.cookie ^ 1n), payload]));
    expect(await ended(id, 'bad-cookie')).toMatchObject({ by: 'peer', verified: false });
    await settle();
    expect(alice.directMessages).toEqual([]);
    await waitFor(() => session.ended(), 'the close at Bob');
  });

  it('a send that waits for the cookie rejects when the peer shows another cookie, and the picture is not written', async () => {
    await start();
    const { id, session } = await aliceOpens('silent');
    const sending = alice.client.sendDirectMessage(id, picture(content(137)));
    const refused = expect(sending).rejects.toMatchObject({ name: 'OdcError', failure: 'not-open' });
    await session.sendRaw(header(session, 0x0060, 0, session.cookie ^ 1n));
    await refused;
    await ended(id, 'bad-cookie');
    await waitFor(() => session.ended(), 'the close at Bob');
    expect(session.frames()).toEqual(['hello']);
  });

  it('a peer that declares a 16 MiB + 1 payload: the session ends too-large', async () => {
    await start();
    const { id, session } = await bobOpens();
    await session.sendRaw(header(session, 0, DIRECT_IM_MAX_MESSAGE_BYTES + 1));
    expect(await ended(id, 'too-large')).toMatchObject({ by: 'peer', verified: true });
    expect(alice.directMessages).toEqual([]);
  });

  it('the peer closes in the middle of a picture: the session ends peer-closed and no directMessage is emitted', async () => {
    await start();
    const { id, session } = await bobOpens();
    const payload = encodeOdcMessage('', [{ id: 1, name: 'a.png', bytes: content(50_000), width: 0, height: 0 }]);
    await session.sendRaw(concatBytes([header(session, 0, payload.length), payload.subarray(0, 20_000)]));
    await settle();
    session.close();
    await ended(id, 'peer-closed');
    expect(alice.directMessages).toEqual([]);
  });

  it('the peer signs off while a picture waits: the send rejects and the session ends peer-closed', async () => {
    await start();
    const { id } = await aliceOpens('silent');
    const sending = alice.client.sendDirectMessage(id, picture(content(137)));
    const refused = expect(sending).rejects.toMatchObject({ name: 'OdcError', failure: 'not-open' });
    bob.signOff();
    await refused;
    await ended(id, 'peer-closed');
  });

  it('a client offers Direct IM and a file in the same turn: the peer meets the relay for one offer at a time, and each connection carries its own service', async () => {
    await start({ directIm: {}, fileTransfer: {} });
    const kept: Uint8Array[] = [];
    let finished = false;
    bob.acceptOffers({
      begin: async () => ({
        write: async (chunk) => {
          kept.push(chunk.slice());
        },
        finish: async () => {
          finished = true;
        },
        abort: async () => {},
      }),
    });
    bob.acceptDirectIm();
    const file = content(5000, 3);
    const data = content(700, 5);
    const opening = alice.client.openDirectIm('Bob');
    const sending = alice.client.sendFiles('Bob', [{
      name: 'notes.bin', bytes: file.length, modifiedAt: 0,
      async *read() {
        yield file;
      },
    }]);
    const id = await opening;
    const transferId = await sending;
    const fileDone = (): boolean => alice.transfers.some((status) => status.id === transferId && status.state === 'done');
    // The link to the server paces messages that follow each other closely. The clock moves for them.
    for (let second = 0; second < 10 && !(last(id)?.verified === true && fileDone()); second++) await timers.advance(1000);
    await inState(id, 'open');
    await waitFor(() => last(id)?.verified === true, 'the cookie of Bob');
    await waitFor(fileDone, 'the file at Bob');
    await alice.client.sendDirectMessage(id, picture(data));
    await waitFor(() => bob.directIms()[0]?.received().length === 1, 'the picture at Bob');
    expect(bob.directIms()[0]?.received()[0]).toMatchObject({ attachments: [{ bytes: data }] });
    await waitFor(() => bob.fileTransfers().length === 1, 'the end of the file at Bob');
    expect(finished).toBe(true);
    expect(concatBytes(kept)).toEqual(file);
    expect(bob.fileTransfers().map((transfer) => transfer.outcome)).toEqual(['done']);
    expect(last(id)?.state).toBe('open');
  });

  it('a typing notice from the peer arrives as the typing event', async () => {
    await start();
    const { session } = await bobOpens();
    const before = alice.typings.length;
    await session.sendRaw(header(session, ODC_FLAG_TYPING_NOTICE | ODC_FLAG_TYPING));
    await waitFor(() => alice.typings.length === before + 1, 'typing');
    await session.sendRaw(header(session, ODC_FLAG_TYPING_NOTICE | ODC_FLAG_TYPED));
    await session.sendRaw(header(session, ODC_FLAG_TYPING_NOTICE));
    await waitFor(() => alice.typings.length === before + 3, 'the two notices that follow');
    expect(alice.typings.slice(before)).toEqual([{ from: 'Bob', typing: true }, { from: 'Bob', typing: false }, { from: 'Bob', typing: false }]);
    expect(alice.directMessages).toEqual([]);
  });
});
