import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { BosLink } from '../../src/client/bos-link.js';
import { PeerClosedError } from '../../src/client/peer-link.js';
import type { PeerLink } from '../../src/client/peer-link.js';
import { COUNTER_DIAL_MS, OFFER_ACCEPT_MS, Rendezvous, rendezvousEnded } from '../../src/client/rendezvous.js';
import type { RendezvousEnd } from '../../src/client/rendezvous.js';
import { ByteWriter } from '../../src/wire/bytes.js';
import { FAMILY_ICBM, ICBM_CHANNEL_RENDEZVOUS, ICBM_CLIENT_ERR, ICBM_MSG_TO_CLIENT, ICBM_MSG_TO_HOST } from '../../src/wire/constants.js';
import { decodeClientError, encodeFileProposal, parseRendezvous } from '../../src/wire/rendezvous.js';
import type { FileDescription, PeerAddress, RendezvousMessage } from '../../src/wire/rendezvous.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { RELAY_SILENCE_MS } from '../fake/oscar-relay.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const COOKIE = 0x0a0b0c0d0e0f1011n;
const FILE: FileDescription = { multiple: false, count: 1, totalBytes: 1024, name: 'notes.txt' };

type Party = {
  h: ClientHarness;
  r: Rendezvous;
  /** Every sequence 1 proposal this client heard. */
  proposals: RendezvousMessage[];
  /** Every other rendezvous message this client heard. */
  heard: RendezvousMessage[];
  /** The addresses the rule was asked about. */
  asked: PeerAddress[];
  send(subtype: number, body: Uint8Array): Promise<void>;
};

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: Party;
let bob: Party;
const links: PeerLink[] = [];

// A signed-on client with one Rendezvous on its BOS link. `deaf` leaves the offers with the test.
// File transfer is off, so the client leaves each offer to that Rendezvous.
async function party(name: string, password: string, opts: { allow?: boolean; deaf?: boolean } = {}): Promise<Party> {
  const h = makeClient(fake, { timers });
  await h.signOn(name, password);
  const link = (h.client as unknown as { link: BosLink }).link;
  const asked: PeerAddress[] = [];
  const r = new Rendezvous({
    log: h.logs.log,
    timers: timers.api,
    now: timers.now,
    send: (body) => link.send(FAMILY_ICBM, ICBM_MSG_TO_HOST, body),
    allowDial: async (address) => {
      asked.push(address);
      return opts.allow ?? true;
    },
  });
  const one: Party = { h, r, proposals: [], heard: [], asked, send: (subtype, body) => link.send(FAMILY_ICBM, subtype, body) };
  link.onSnac((snac) => {
    if (snac.family !== FAMILY_ICBM) return;
    if (snac.subtype === ICBM_CLIENT_ERR && !opts.deaf) r.refused(decodeClientError(snac.body).cookie);
    if (snac.subtype !== ICBM_MSG_TO_CLIENT) return;
    const message = parseRendezvous(snac.body);
    if (!message) return;
    if (message.type === 'propose' && message.sequence === 1) one.proposals.push(message);
    else {
      one.heard.push(message);
      if (!opts.deaf) r.heard(message);
    }
  });
  return one;
}

async function start(opts: { relay?: boolean; bob?: { allow?: boolean }; alice?: { deaf?: boolean } } = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, timers: timers.api, ...(opts.relay !== false && { relay: true as const }) });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw123');
  alice = await party('Alice', 'alicepw1', opts.alice);
  bob = await party('Bob', 'bobpw123', opts.bob);
}

afterEach(async () => {
  for (const link of links.splice(0)) link.close();
  alice.r.reset();
  bob.r.reset();
  await stopAllClients();
  await fake.stop();
});

function linked(result: PeerLink | RendezvousEnd): PeerLink {
  if (rendezvousEnded(result)) throw new Error(`the offer ended ${result.outcome} by ${result.by}`);
  links.push(result);
  return result;
}

function ended(result: PeerLink | RendezvousEnd): RendezvousEnd {
  if (!rendezvousEnded(result)) {
    result.close();
    throw new Error('the offer met the peer');
  }
  return result;
}

async function proposalAt(who: Party, count = 1): Promise<RendezvousMessage> {
  await waitFor(() => who.proposals.length >= count, 'the proposal');
  const proposal = who.proposals[count - 1];
  if (!proposal) throw new Error('no proposal');
  return proposal;
}

const relayAddress = (): PeerAddress => ({ ip: '127.0.0.1', port: fake.relayPort });
const block = (fill: number): Uint8Array => new Uint8Array(1024).fill(fill);

describe('an offer through the relay', () => {
  it('both sides get a link and 1 KB written by each arrives at the other', async () => {
    await start();
    const offering = alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    const proposal = await proposalAt(bob);
    expect(proposal).toMatchObject({ from: 'alice', cookie: COOKIE, service: 'send-file', sequence: 1, useProxy: false, file: FILE });
    expect(proposal.address).toEqual(relayAddress());
    const toBob = linked(await bob.r.accept(proposal));
    const toAlice = linked(await offering);
    expect(bob.asked).toEqual([relayAddress()]);
    expect(alice.asked).toEqual([relayAddress()]);
    // The server keeps the Accept of Bob. Alice hears only the counter-offer.
    expect(alice.heard.map((m) => [m.type, m.sequence, m.from])).toEqual([['propose', 2, 'bob']]);
    expect(alice.heard[0]?.address).toEqual(relayAddress());
    await Promise.all([toAlice.write(block(0xa1)), toBob.write(block(0xb2))]);
    expect(await toBob.read(1024)).toEqual(block(0xa1));
    expect(await toAlice.read(1024)).toEqual(block(0xb2));
    expect(fake.relayed()).toEqual([{ cookie: COOKIE, bytesToOfferer: 1024, bytesToRecipient: 1024 }]);
    toAlice.close();
    expect(await toBob.readSome(16)).toBeNull();
    await waitFor(() => fake.relaySessions().length === 0, 'the session ends');
    // The offerer sends its Accept after the dial. The server passes it on.
    await waitFor(() => bob.heard.length === 1, 'the Accept of Alice');
    expect(bob.heard.map((m) => [m.type, m.from])).toEqual([['accept', 'alice']]);
  });

  it('bytes the recipient writes before the offerer arrives are kept for the offerer', async () => {
    await start({ alice: { deaf: true } });
    void alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    const toBob = linked(await bob.r.accept(await proposalAt(bob)));
    await toBob.write(Uint8Array.of(1, 2, 3));
    await waitFor(() => alice.heard.length === 1, 'the counter-offer');
    alice.r.heard(alice.heard[0] as RendezvousMessage);
    await waitFor(() => fake.relayed().length === 1, 'the relay opens');
    await waitFor(() => fake.relayed()[0]?.bytesToOfferer === 3, 'the odd byte goes out after the wait');
  });

  it('Bob declines: Alice ends declined and the test server holds no session', async () => {
    await start();
    const offering = alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    const proposal = await proposalAt(bob);
    expect(fake.relaySessions()).toEqual([COOKIE]);
    await bob.r.decline(proposal);
    expect(ended(await offering)).toEqual({ outcome: 'declined', by: 'peer' });
    expect(fake.relaySessions()).toEqual([]);
    expect(fake.relayed()).toEqual([]);
  });

  it('a decline by client error ends the offer declined and drops the session', async () => {
    await start();
    const offering = alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    await proposalAt(bob);
    await bob.send(ICBM_CLIENT_ERR, new ByteWriter().u64(COOKIE).u16(ICBM_CHANNEL_RENDEZVOUS).str8('Alice').u16(3).u16(2).u16(1).toBytes());
    expect(ended(await offering)).toEqual({ outcome: 'declined', by: 'peer' });
    expect(fake.relaySessions()).toEqual([]);
  });

  it('Alice cancels: the test server drops the session and Bob hears the cancel', async () => {
    await start();
    const offering = alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    await proposalAt(bob);
    await alice.r.cancel(COOKIE);
    expect(ended(await offering)).toEqual({ outcome: 'cancelled', by: 'self' });
    await waitFor(() => bob.heard.length === 1, 'the cancel');
    expect(bob.heard[0]).toMatchObject({ type: 'cancel', from: 'alice', cookie: COOKIE });
    expect(fake.relaySessions()).toEqual([]);
  });

  it('the rule of Bob says no: Bob ends refused-address, Alice hears the cancel, nothing is dialled', async () => {
    await start({ bob: { allow: false } });
    const offering = alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    expect(ended(await bob.r.accept(await proposalAt(bob)))).toEqual({ outcome: 'refused-address', by: 'self' });
    expect(ended(await offering)).toEqual({ outcome: 'declined', by: 'peer' });
    expect(fake.relaySessions()).toEqual([]);
    expect(fake.relayed()).toEqual([]);
  });

  it('nobody answers: Alice sends the timeout cancel and the test server holds no session', async () => {
    await start();
    const offering = alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    await proposalAt(bob);
    await timers.advance(OFFER_ACCEPT_MS);
    expect(ended(await offering)).toEqual({ outcome: 'timed-out', by: 'self' });
    await waitFor(() => bob.heard.length === 1, 'the cancel');
    expect(bob.heard[0]).toMatchObject({ type: 'cancel', cancelReason: 2 });
    expect(fake.relaySessions()).toEqual([]);
  });

  // The relay pairs by address, and every client here has one address. So the second offer starts after the first pair met.
  it('a second offer after the first pair met: each link carries its own bytes, each way', async () => {
    await start();
    const first = alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    const bobOne = linked(await bob.r.accept(await proposalAt(bob, 1)));
    const aliceOne = linked(await first);
    const second = bob.r.offer('Alice', COOKIE + 1n, 'send-file', FILE);
    const aliceTwo = linked(await alice.r.accept(await proposalAt(alice, 1)));
    const bobTwo = linked(await second);
    await aliceOne.write(block(1));
    await aliceTwo.write(block(2));
    expect(await bobOne.read(1024)).toEqual(block(1));
    expect(await bobTwo.read(1024)).toEqual(block(2));
    expect(fake.relayed()).toEqual([
      { cookie: COOKIE, bytesToOfferer: 0, bytesToRecipient: 1024 },
      { cookie: COOKIE + 1n, bytesToOfferer: 1024, bytesToRecipient: 0 },
    ]);
  });
});

describe('what the relay of the test server does', () => {
  it('closes a recipient left alone for COUNTER_DIAL_MS', async () => {
    await start({ alice: { deaf: true } });
    void alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    const toBob = linked(await bob.r.accept(await proposalAt(bob)));
    await waitFor(() => alice.heard.length === 1, 'the counter-offer');
    const reading = toBob.read(1).then(
      () => null,
      (error: unknown) => error,
    );
    await timers.advance(COUNTER_DIAL_MS - 1);
    expect(toBob.closed).toBe(false);
    expect(fake.relaySessions()).toEqual([COOKIE]);
    await timers.advance(1);
    expect(await reading).toBeInstanceOf(PeerClosedError);
    expect(fake.relaySessions()).toEqual([]);
    expect(fake.relayed()).toEqual([]);
  });

  it('gives a silent connection whose owner did not accept to the sign-on service, after the silence wait', async () => {
    await start();
    void alice.r.offer('Bob', COOKIE, 'send-file', FILE);
    await proposalAt(bob);
    const socket = net.connect({ host: '127.0.0.1', port: fake.relayPort });
    const got: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => got.push(chunk));
    socket.on('error', () => {});
    await new Promise((resolve) => socket.once('connect', resolve));
    await waitFor(() => timers.pending().includes(RELAY_SILENCE_MS), 'the relay takes the connection');
    await timers.advance(RELAY_SILENCE_MS - 1);
    expect(got).toEqual([]);
    expect(alice.heard).toEqual([]);
    await timers.advance(1);
    await waitFor(() => got.length > 0, 'the hello');
    // A FLAP frame on channel 1 that holds the version.
    expect([...Buffer.concat(got)]).toEqual([0x2a, 0x01, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01]);
    expect(socket.destroyed).toBe(false);
    socket.destroy();
    expect(alice.heard).toEqual([]);
    expect(fake.relaySessions()).toEqual([COOKIE]);
  });

  it('closes a connection that no session waits for', async () => {
    await start();
    const socket = net.connect({ host: '127.0.0.1', port: fake.relayPort });
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });
    socket.on('error', () => {});
    socket.write(Uint8Array.of(0x4f, 0x46, 0x54, 0x32));
    await waitFor(() => closed, 'the close');
  });

  it('drops a session nobody dialled when the accept wait runs out', async () => {
    await start({ alice: { deaf: true } });
    await alice.send(ICBM_MSG_TO_HOST, encodeFileProposal(COOKIE, 'Bob', { sequence: 1, address: { ip: '0.0.0.0', port: 5190 }, file: FILE }));
    await proposalAt(bob);
    expect(fake.relaySessions()).toEqual([COOKIE]);
    await timers.advance(OFFER_ACCEPT_MS);
    expect(fake.relaySessions()).toEqual([]);
  });

  it('passes a sequence 1 proposal on as written when the relay is off', async () => {
    await start({ relay: false });
    const address = { ip: '198.51.100.9', port: 4443 };
    await alice.send(ICBM_MSG_TO_HOST, encodeFileProposal(COOKIE, 'Bob', { sequence: 1, address, file: FILE }));
    expect((await proposalAt(bob)).address).toEqual(address);
    expect(fake.relaySessions()).toEqual([]);
    expect(() => fake.relayPort).toThrow();
  });
});
