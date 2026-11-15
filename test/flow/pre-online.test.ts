import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreOnlineContext } from '../../src/client/oscar-client.js';
import { bucpTicketSource, storedTicketSource } from '../../src/client/tickets.js';
import type { IssuedTicket } from '../../src/client/tickets.js';
import { CAP_CHAT, CAP_MOBILE_CLIENT, CAP_UTF8_MESSAGES } from '../../src/wire/constants.js';
import { decodeTlvs, tlvStr } from '../../src/wire/tlv.js';
import type { AwayRecord } from '../../src/model/away.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, captureLog, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord } from '../fake/oscar-server.js';

const PHONE_CAPS = [CAP_UTF8_MESSAGES, CAP_CHAT, CAP_MOBILE_CLIENT];
const BRB: AwayRecord = { seq: 1, writer: 1, away: true, text: 'brb', source: 'phone', paused: false, setAt: 1_800_000_000_000 };
const BROADCASTS = ['1/17', '19/8', '19/9', '19/10', '16/2'];

let timers: ManualTimers;
let fake: FakeOscarServer;
let bob: FakePeer;
let issued: IssuedTicket;

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });
const order = (snacs: SnacRecord[]): string[] => snacs.filter((s) => s.conn === 'bos').map((s) => `${s.family}/${s.subtype}`);
// Alice's BOS SNACs per connection, in the order the client made the connections: each starts with 0x01/0x17.
function connections(): string[][] {
  const all: string[][] = [];
  for (const snac of order(fake.snacsFrom('alice'))) {
    if (snac === '1/23') all.push([]);
    all.at(-1)?.push(snac);
  }
  return all;
}
const arrivals = (from: number) => bob.sightings().slice(from).filter((s) => s.event === 'arrived');
const phone = (over: Parameters<typeof makeClient>[1] = {}): ClientHarness =>
  makeClient(fake, { timers, random: () => 0, oserviceVersion: 4, capabilities: PHONE_CAPS, systemIdleSeconds: () => 4000, ...over });

async function dropAndReconnect(h: ClientHarness): Promise<void> {
  fake.dropSocket('alice');
  await waitFor(() => h.client.state === 'reconnecting', 'the client to notice the drop');
  await timers.advance(2_000);
  await waitFor(() => h.client.state === 'online', 'the client to be online again');
}

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, preOnlineStatus: 'silent' });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([]));
  bob = fake.peer('Bob');
  bob.watch('Alice');
  issued = await bucpTicketSource({
    log: captureLog().log,
    now: timers.now,
    timers: timers.api,
    budget: { take: async () => {} },
    credentials: { screenName: 'Alice', password: 'alicepw1' },
    server: here(),
  }).ticket({ reconnect: false, track: () => {} });
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe('the pre-online sequence of a client', () => {
  it('a first sign-on puts back invisible and idle in the pre-online order, and Bob sees nothing', async () => {
    const h = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS, systemIdleSeconds: () => 4000 });
    h.client.setIdleAfter(1);
    const seen = bob.sightings().length;
    await h.client.signOnWith(storedTicketSource(issued), here(), { resume: { origin: 'restore', invisible: true, away: null, answered: [], reportIdle: true } });
    const o = order(fake.snacsFrom('alice'));
    expect(o.indexOf('1/14')).toBeGreaterThan(o.indexOf('19/7'));
    expect(o.indexOf('1/14')).toBeLessThan(o.indexOf('1/30'));
    expect(o.indexOf('1/30')).toBeLessThan(o.indexOf('1/17'));
    expect(o.indexOf('1/17')).toBeLessThan(o.indexOf('1/2'));
    expect(arrivals(seen)).toEqual([]);
    expect(h.client.self?.invisible).toBe(true);
  });

  it('the held away rides in the first Locate write and shows only at client online', async () => {
    const h = phone();
    const seen = bob.sightings().length;
    await h.client.signOnWith(storedTicketSource(issued), here(), { resume: { origin: 'restore', invisible: false, away: BRB, answered: [], reportIdle: false } });
    const locate = fake.snacsFrom('alice').find((s) => s.conn === 'bos' && s.family === 2 && s.subtype === 4);
    expect(tlvStr(decodeTlvs(locate?.body ?? new Uint8Array(0)), 0x04)).toBe('brb');
    await waitFor(() => bob.sightings().length > seen, "Bob to see Alice");
    expect(bob.sightings()[seen]).toMatchObject({ event: 'arrived', away: true });
    expect(h.client.awayMessage).toEqual([{ text: 'brb' }]);
  });

  it('a sign-on that starts a session starts available whatever away it is given', async () => {
    const h = phone();
    await h.client.signOnWith(storedTicketSource(issued), here(), { resume: { origin: 'start', invisible: false, away: BRB, answered: ['bob'], reportIdle: false } });
    const locate = fake.snacsFrom('alice').find((s) => s.conn === 'bos' && s.family === 2 && s.subtype === 4);
    expect(tlvStr(decodeTlvs(locate?.body ?? new Uint8Array(0)), 0x04)).toBeUndefined();
    expect([h.client.awayMessage, h.client.answeredSenders()]).toEqual([null, []]);
  });

  it('beside an invisible desktop, a hook that mirrors it reveals nothing', async () => {
    const desk = makeClient(fake, { timers });
    await desk.signOn();
    await desk.client.setInvisible(true);
    const seen = bob.sightings().length;
    const h = phone({ preOnline: ({ userInfo }) => ({ invisible: userInfo?.instances.some((i) => i.invisible) ?? false, reportIdle: true }) });
    h.client.setIdleAfter(1);
    await h.client.signOnWith(storedTicketSource(issued), here());
    expect(order(fake.snacsFrom('alice'))).toContain('1/17');
    expect(h.client.self?.invisible).toBe(true);
    expect(arrivals(seen)).toEqual([]);
  });

  it('without the mirror, the idle report reveals the invisible user (the test server models the reveal)', async () => {
    const desk = makeClient(fake, { timers });
    await desk.signOn();
    await desk.client.setInvisible(true);
    const seen = bob.sightings().length;
    const h = phone({ preOnline: () => ({ invisible: false, reportIdle: true }) });
    h.client.setIdleAfter(1);
    // The phone's client online ends its connection unread, so only what came before it can reveal.
    fake.closeOn(0x01, 0x02, 'destroy');
    await expect(h.client.signOnWith(storedTicketSource(issued), here())).rejects.toThrow();
    expect(arrivals(seen)).toHaveLength(1);
  });

  it('nothing that broadcasts leaves before the invisible write, first sign-on or reconnect', async () => {
    const h = phone();
    h.client.setIdleAfter(1);
    await h.client.signOnWith(storedTicketSource(issued), here(), { resume: { origin: 'restore', invisible: true, away: null, answered: [], reportIdle: true } });
    await dropAndReconnect(h);
    const all = connections();
    expect(all).toHaveLength(2);
    for (const snacs of all) {
      const write = snacs.indexOf('1/30');
      expect(write).toBeGreaterThan(0);
      expect(snacs.slice(0, write).filter((s) => BROADCASTS.includes(s))).toEqual([]);
      expect(snacs.slice(write)).toContain('1/17');
    }
  });

  it('the hook hears every reconnect', async () => {
    const contexts: PreOnlineContext[] = [];
    const h = phone({
      preOnline: (ctx) => {
        contexts.push(ctx);
        return ctx.held;
      },
    });
    await h.client.signOnWith(storedTicketSource(issued), here());
    await dropAndReconnect(h);
    expect(contexts.map((ctx) => [ctx.reconnect, ctx.held])).toEqual([
      [false, { invisible: false, reportIdle: false }],
      [true, { invisible: false, reportIdle: false }],
    ]);
    expect(contexts[1]?.userInfo?.instances.length).toBeGreaterThan(0);
  });

  it('the restored answered senders get no second auto-response', async () => {
    const carol = fake.peer('Carol');
    const h = phone();
    await h.client.signOnWith(storedTicketSource(issued), here(), { resume: { origin: 'restore', invisible: false, away: BRB, answered: ['bob'], reportIdle: false } });
    expect(h.client.answeredSenders()).toEqual(['bob']);
    bob.sendIm('Alice', 'hi');
    carol.sendIm('Alice', 'hi');
    await waitFor(() => h.ims.length === 2, 'both IMs');
    expect(h.autoResponses.map((sent) => sent.to)).toEqual(['Carol']);
  });
});
