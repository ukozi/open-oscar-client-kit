import { afterEach, describe, expect, it } from 'vitest';
import type { OscarError } from '../../src/client/errors.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { toHex } from '../../src/wire/bytes.js';
import { CAP_CHAT, CAP_UTF8_MESSAGES } from '../../src/wire/constants.js';
import { encodeFeedbagItems } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { encodeLocateInfo } from '../../src/wire/locate.js';
import { decodeTlvs } from '../../src/wire/tlv.js';
import type { RichText } from '../../src/model/rich-text.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord, StartOptions } from '../fake/oscar-server.js';

const MULTI_SESSION = 0x01;
const BUDDIES: FeedbagItem = { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] };
const BOB: FeedbagItem = { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] };
const CAROL: FeedbagItem = { name: 'carol', groupId: 1, itemId: 2, classId: 0, attrs: [] };

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;

async function start(over: Pick<OscarClientOptions, 'loginBudget' | 'systemIdleSeconds'> = {}, server: StartOptions = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ ...server, now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([BUDDIES, BOB]));
  bob = fake.peer('Bob');
  bob.watch('Alice');
  h = makeClient(fake, { timers, random: () => 0, ...over });
  await h.signOn();
  await waitFor(() => h.client.presenceOf('Bob')?.online === true && bob.sightings().length === 1, 'Alice and Bob to see each other');
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const text = (words: string): RichText => [{ text: words }];
const is = (family: number, subtype: number) => (snac: SnacRecord): boolean => snac.family === family && snac.subtype === subtype;
// What Alice wrote on each BOS connection, in the order the client made the connections: every one starts with 0x01/0x17.
function connections(): SnacRecord[][] {
  const all: SnacRecord[][] = [];
  for (const snac of fake.snacsFrom('alice').filter((s) => s.conn === 'bos')) {
    if (is(0x01, 0x17)(snac)) all.push([]);
    all.at(-1)?.push(snac);
  }
  return all;
}
const connection = (index: number): SnacRecord[] => connections()[index] ?? [];
const pairs = (snacs: SnacRecord[]): [number, number][] => snacs.map((s) => [s.family, s.subtype]);
const indexOf = (snacs: SnacRecord[], family: number, subtype: number): number => snacs.findIndex(is(family, subtype));

const state = (): ClientHarness['states'][number] | undefined => h.states.at(-1);
const reconnecting = (attempt = 1): Promise<void> =>
  waitFor(() => state()?.state === 'reconnecting' && state()?.reconnect?.attempt === attempt, `reconnecting, attempt ${attempt}`);
const online = (): Promise<void> => waitFor(() => h.client.state === 'online', 'the client to be online again');

async function drop(how: 'dropSocket' | 'emptySignoff' = 'dropSocket'): Promise<void> {
  fake[how]('Alice');
  await reconnecting();
}

// The delay of the first attempt, to the millisecond: manual time must not run past it while the attempt's sockets work.
async function reconnect(delay = 2_000): Promise<void> {
  await timers.advance(delay);
  await online();
}

const roundTrip = (): Promise<void> => imRoundTrip(fake, h);

async function infoOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: OscarError) => error.info,
  );
}

// The test server cuts off every login before its reply: the server is unreachable. A scripted close is used up by the SNAC it closes on.
function unreachable(): void {
  fake.onSnacHook = (snac) => {
    if (snac.conn === 'auth' && snac.family === 0x17 && snac.subtype === 0x06) fake.closeOn(0x17, 0x06, 'destroy');
  };
}

describe('reconnect', () => {
  it.each(['dropSocket', 'emptySignoff'] as const)('reconnects about 2 s after a drop, through the full sequence (%s)', async (how) => {
    await start();
    const now = timers.now();
    const lists = h.lists.length;
    await drop(how);
    expect(state()).toEqual({ state: 'reconnecting', reconnect: { attempt: 1, nextRetryAt: now + 2_000 } });
    expect(h.client.state).toBe('reconnecting');

    await timers.advance(1_999);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(1);
    await reconnect(1);
    expect(state()).toStrictEqual({ state: 'online' });
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'reconnecting', 'online']);
    expect(fake.authSignons).toHaveLength(2);
    expect(fake.instancesOf('Alice')).toBe(1);
    expect(h.lists.length).toBeGreaterThan(lists);
    expect(h.client.buddyList().groups.map((g) => g.buddies.map((b) => b.screenName))).toEqual([['bob']]);
    expect(h.client.self?.screenName).toBe('Alice');
    await waitFor(() => indexOf(connection(1), 0x04, 0x10) >= 0, 'the request for stored messages');
    expect(pairs(connection(1))).toEqual([
      [0x01, 0x17], [0x01, 0x06], [0x01, 0x08], [0x02, 0x02], [0x02, 0x04], [0x04, 0x04],
      [0x13, 0x02], [0x13, 0x04], [0x13, 0x07], [0x01, 0x02], [0x01, 0x0e], [0x04, 0x10],
    ]);
  });

  it('a liveness probe with no answer starts reconnect', async () => {
    await start();
    const now = timers.now();
    fake.withhold(0x01, 0x0f);
    // The probe goes out at 90 s and its reply is due 20 s later.
    await timers.advance(110_000);
    await reconnecting();
    expect(state()).toEqual({ state: 'reconnecting', reconnect: { attempt: 1, nextRetryAt: now + 112_000 } });
  });

  it('a sign-off with a disconnect reason ends the session and is not retried', async () => {
    await start();
    fake.kick('Alice');
    await waitFor(() => h.client.state === 'offline', 'the client to go offline');
    expect(state()).toEqual({ state: 'offline', reason: { kind: 'signed-off-by-server' } });
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'offline']);
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(1);
  });

  it('reconnects after a drop and restores away before any buddy sees an arrival', async () => {
    await start();
    await h.client.setAway(text('out to lunch'));
    await waitFor(() => bob.sightings().at(-1)?.away === true, 'Bob to see Alice away');
    await drop();
    expect(bob.sightings().at(-1)?.event).toBe('departed');
    const n = bob.sightings().length;
    await reconnect();
    await roundTrip();

    const locate = connection(1).filter(is(0x02, 0x04));
    expect(decodeTlvs(locate[0]?.body ?? new Uint8Array(0)).map((t) => t.tag)).toEqual([0x05, 0x01, 0x02, 0x03, 0x04]);
    expect(locate[0]?.body).toEqual(encodeLocateInfo({ capabilities: [CAP_UTF8_MESSAGES, CAP_CHAT], profile: '', away: 'out to lunch' }));
    const after = bob.sightings().slice(n);
    expect(after.length).toBeGreaterThan(0);
    expect(after.map((s) => [s.event, s.away])).toEqual(after.map(() => ['arrived', true]));
    expect(h.client.awayMessage).toEqual(text('out to lunch'));
  });

  it('a watcher sees no arrival when the client reconnects while invisible', async () => {
    await start();
    await h.client.setInvisible(true);
    expect(bob.sightings().at(-1)?.event).toBe('departed');
    await drop();
    const n = bob.sightings().length;
    await reconnect();
    await roundTrip();

    // Restoring invisible sends the watchers a departure, as the server does.
    const after = bob.sightings().slice(n);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((s) => s.event === 'departed')).toBe(true);
    const second = connection(1);
    expect(indexOf(second, 0x01, 0x1e)).toBeGreaterThan(indexOf(second, 0x13, 0x07));
    expect(indexOf(second, 0x01, 0x1e)).toBeLessThan(indexOf(second, 0x01, 0x02));
    expect(indexOf(second, 0x13, 0x07)).toBeGreaterThan(0);
    expect(h.client.self?.invisible).toBe(true);
  });

  it('a reconnect of a visible session writes no status and its watcher sees it arrive', async () => {
    await start();
    await drop();
    const n = bob.sightings().length;
    await reconnect();
    await roundTrip();
    expect(indexOf(connection(1), 0x01, 0x1e)).toBe(-1);
    expect(bob.sightings().slice(n).map((s) => [s.event, s.away])).toEqual([['arrived', false]]);
  });

  it('an invisible restore that is not confirmed fails the attempt and client online is never sent', async () => {
    await start();
    await h.client.setInvisible(true);
    await drop();
    const release = fake.withhold(0x01, 0x0f);
    await timers.advance(2_000);
    await waitFor(() => indexOf(connection(1), 0x01, 0x1e) >= 0, 'the status write of the attempt');
    await settle(fake.port);
    const now = timers.now();
    await timers.advance(19_999);
    expect(state()?.reconnect?.attempt).toBe(1);
    await timers.advance(1);
    await reconnecting(2);
    expect(state()).toEqual({ state: 'reconnecting', reconnect: { attempt: 2, nextRetryAt: now + 20_000 + 4_000 } });
    await waitFor(() => fake.instancesOf('Alice') === 0, "the attempt's connection to be closed");
    expect(connections()).toHaveLength(2);
    expect(indexOf(connection(1), 0x01, 0x02)).toBe(-1);
    release();
  });

  it('restores idle only while the system is still idle, with the current seconds', async () => {
    let systemIdle = 900;
    await start({ systemIdleSeconds: () => systemIdle });
    await h.client.reportIdle(600);

    await drop();
    await reconnect();
    const second = connection(1);
    expect(second.filter(is(0x01, 0x11)).map((s) => toHex(s.body))).toEqual(['00000384']);
    expect(indexOf(second, 0x01, 0x11)).toBeGreaterThan(indexOf(second, 0x13, 0x07));
    expect(indexOf(second, 0x01, 0x11)).toBeLessThan(indexOf(second, 0x01, 0x02));

    systemIdle = 600;
    await drop();
    await reconnect();
    expect(connection(2).filter(is(0x01, 0x11)).map((s) => toHex(s.body))).toEqual(['00000258']);

    systemIdle = 599;
    await drop();
    await reconnect();
    expect(indexOf(connection(3), 0x01, 0x02)).toBeGreaterThan(0);
    expect(connection(3).filter(is(0x01, 0x11))).toEqual([]);

    systemIdle = 900;
    await drop();
    await reconnect();
    expect(connections()).toHaveLength(5);
    expect(connection(4).filter(is(0x01, 0x11))).toEqual([]);
  });

  it('a session that never reported idle restores none, however long the system has been idle', async () => {
    await start({ systemIdleSeconds: () => 900 });
    await drop();
    await reconnect();
    expect(connection(1).filter(is(0x01, 0x11))).toEqual([]);
  });

  it('restores idle against the time setIdleAfter gave: at 5 minutes, 300 s is restored and 299 s is not', async () => {
    let systemIdle = 300;
    await start({ systemIdleSeconds: () => systemIdle });
    h.client.setIdleAfter(300);
    await h.client.reportIdle(300);

    await drop();
    await reconnect();
    expect(connection(1).filter(is(0x01, 0x11)).map((s) => toHex(s.body))).toEqual(['0000012c']);

    systemIdle = 299;
    await drop();
    await reconnect();
    expect(indexOf(connection(2), 0x01, 0x02)).toBeGreaterThan(0);
    expect(connection(2).filter(is(0x01, 0x11))).toEqual([]);
  });

  it('restores no idle after setIdleAfter(null), Never, however long the system has been idle', async () => {
    await start({ systemIdleSeconds: () => 900 });
    await h.client.reportIdle(900);
    h.client.setIdleAfter(null);
    await drop();
    await reconnect();
    expect(indexOf(connection(1), 0x01, 0x02)).toBeGreaterThan(0);
    expect(connection(1).filter(is(0x01, 0x11))).toEqual([]);
  });

  it('keeps trying on the schedule while the server cannot be reached', async () => {
    await start();
    unreachable();
    const now = timers.now();
    await drop();
    expect(state()?.reconnect).toEqual({ attempt: 1, nextRetryAt: now + 2_000 });
    await timers.advance(2_000);
    await reconnecting(2);
    expect(state()?.reconnect).toEqual({ attempt: 2, nextRetryAt: now + 2_000 + 4_000 });
    await timers.advance(4_000);
    await reconnecting(3);
    expect(state()?.reconnect).toEqual({ attempt: 3, nextRetryAt: now + 6_000 + 60_000 });
    expect(fake.authSignons).toHaveLength(3);

    await timers.advance(300_000);
    await waitFor(() => (state()?.reconnect?.attempt ?? 0) >= 4, 'a fourth failure');
    expect(h.client.state).toBe('reconnecting');
    expect(h.states.slice(2).every((s) => s.state === 'reconnecting')).toBe(true);
    expect(fake.instancesOf('Alice')).toBe(0);
  });

  it('a successful reconnect starts the count again', async () => {
    await start();
    fake.closeOn(0x17, 0x06, 'destroy');
    await drop();
    await timers.advance(2_000);
    await reconnecting(2);
    await reconnect(4_000);

    const now = timers.now();
    await drop();
    expect(state()).toEqual({ state: 'reconnecting', reconnect: { attempt: 1, nextRetryAt: now + 2_000 } });
  });

  it('a refused login during reconnect ends the session with that reason', async () => {
    await start();
    await drop();
    fake.addUser('Alice', 'changed-pw');
    await timers.advance(2_000);
    await waitFor(() => h.client.state === 'offline', 'the client to go offline');
    expect(state()).toEqual({ state: 'offline', reason: { kind: 'wrong-password' } });
    expect(h.client.self).toBeNull();
    expect(h.client.buddyList().groups).toEqual([]);
    expect(fake.authSignons).toHaveLength(2);
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(2);
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'reconnecting', 'offline']);
  });

  it('a sign-on step the server refuses during reconnect ends the session as refused, with its code, and is not retried', async () => {
    await start();
    await drop();
    fake.failNext(0x13, 0x04, { code: 0x0d });
    await timers.advance(2_000);
    await waitFor(() => h.client.state === 'offline', 'the client to go offline');
    expect(state()).toEqual({ state: 'offline', reason: { kind: 'refused', code: 0x0d } });
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'reconnecting', 'offline']);
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(2);
  });

  it('the session cap on the BOS connection during reconnect ends the session with that reason', async () => {
    await start({}, { sixthSession: 'bos-signoff' });
    await drop();
    for (let i = 0; i < 5; i++) await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
    await timers.advance(2_000);
    await waitFor(() => h.client.state === 'offline', 'the client to go offline');
    expect(state()).toEqual({ state: 'offline', reason: { kind: 'too-many-sessions' } });
    expect(fake.instancesOf('Alice')).toBe(5);
    const logins = fake.authSignons.length;
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(logins);
  });

  const kicks: [string, number, number][] = [
    ['at the feedbag step', 0x13, 0x02],
    ['in place of the last sign-on reply', 0x01, 0x0e],
  ];
  it.each(kicks)('a sign-off with a disconnect reason %s of a reconnect attempt ends the session as signed off, and is not retried', async (_when, family, subtype) => {
    await start();
    await drop();
    fake.closeOn(family, subtype, 'kick');
    await timers.advance(2_000);
    await waitFor(() => h.client.state === 'offline', 'the client to go offline');
    expect(state()).toEqual({ state: 'offline', reason: { kind: 'signed-off-by-server' } });
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'reconnecting', 'offline']);
    expect(h.client.self).toBeNull();
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(2);
  });

  // The test server writes the last reply and the sign-off together: they reach the client in one read, which fails the attempt, or in two.
  it('a sign-off that arrives with the last sign-on reply of a reconnect ends the session, with no retry', async () => {
    await start();
    await drop();
    const release = fake.withhold(0x01, 0x0f);
    await timers.advance(2_000);
    await waitFor(() => indexOf(connection(1), 0x01, 0x0e) >= 0, 'the last sign-on request of the attempt');
    release();
    fake.kick('Alice');
    await waitFor(() => h.client.state === 'offline', 'the client to go offline');
    expect(state()).toEqual({ state: 'offline', reason: { kind: 'signed-off-by-server' } });
    expect(h.states.map((s) => s.state).filter((s) => s === 'reconnecting')).toHaveLength(1);
    expect(h.client.self).toBeNull();
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(2);
  });

  it('sign off while reconnecting stops the attempts', async () => {
    await start();
    await drop();
    await h.client.signOff();
    expect(state()).toStrictEqual({ state: 'offline' });
    expect(h.client.awayMessage).toBeNull();
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(1);
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'reconnecting', 'offline']);
  });

  it.each(['rate', 'room'] as const)('a listener that signs off when the connection drops ends the session (%s)', async (event) => {
    await start();
    if (event === 'rate') {
      fake.spend('alice', 3, 8);
      await waitFor(() => h.rates.at(-1)?.limited === true, 'the limited notice');
    } else {
      await h.client.joinRoom({ exchange: 4, name: 'Dev Room' });
    }
    // The client emits both while it takes in the drop: `rate` as the limit ends with its connection, `room` as it loses the room.
    let heard = 0;
    h.client.on(event, () => {
      heard++;
      void h.client.signOff();
    });
    fake.dropSocket('Alice');
    await waitFor(() => heard > 0, `the ${event} event of the drop`);
    await settle(fake.port);
    expect(h.client.state).toBe('offline');
    expect(state()).toStrictEqual({ state: 'offline' });
    // The client counts down no retry: 2 s, 4 s and the 60 s floor are the delays a retry can have.
    expect(timers.pending().filter((ms) => ms === 2_000 || ms === 4_000 || ms === 60_000)).toEqual([]);
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(1);
    expect(h.client.state).toBe('offline');
  });

  it('sign off during an attempt closes its connection and nothing follows', async () => {
    await start();
    await drop();
    fake.withhold(0x01, 0x07);
    await timers.advance(2_000);
    await waitFor(() => indexOf(connection(1), 0x01, 0x06) >= 0, "the attempt's rate query");
    await h.client.signOff();
    expect(state()).toStrictEqual({ state: 'offline' });
    await waitFor(() => fake.instancesOf('Alice') === 0, "the attempt's connection to be closed");
    await timers.advance(300_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(2);
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'reconnecting', 'offline']);
  });

  it('every attempt takes from the sign-on budget', async () => {
    let taken = 0;
    await start({
      loginBudget: {
        take: async () => {
          taken++;
        },
      },
    });
    expect(taken).toBe(1);
    fake.closeOn(0x17, 0x06, 'destroy');
    await drop();
    await timers.advance(2_000);
    await reconnecting(2);
    expect(taken).toBe(2);
    await reconnect(4_000);
    expect(taken).toBe(3);
  });

  it('an attempt waits for the sign-on budget and may start later than planned', async () => {
    let grant = (): void => {};
    let first = true;
    await start({
      loginBudget: {
        take: () => {
          if (first) {
            first = false;
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => (grant = resolve));
        },
      },
    });
    await drop();
    await timers.advance(2_000);
    await settle(fake.port);
    expect(fake.authSignons).toHaveLength(1);
    expect(h.client.state).toBe('reconnecting');
    grant();
    await online();
    expect(fake.authSignons).toHaveLength(2);
  });

  it('queued and unacknowledged IMs fail when the connection drops and are not replayed', async () => {
    await start();
    fake.withhold(0x04, 0x0c);
    const sends = Array.from({ length: 5 }, (_, i) => infoOf(h.client.sendIm('Bob', text(`message ${i}`))));
    // The client writes three at once, and they wait for their acknowledgement; the governor holds the other two in the queue.
    await waitFor(() => connection(0).filter(is(0x04, 0x06)).length === 3, 'the first three IMs to reach the test server');
    await drop();
    expect(await Promise.all(sends)).toEqual(sends.map(() => ({ kind: 'connection-lost' })));
    const taken = bob.ims().length;
    expect(taken).toBe(3);

    await reconnect();
    await timers.advance(60_000);
    await settle(fake.port);
    expect(bob.ims()).toHaveLength(taken);
    expect(connection(1).filter(is(0x04, 0x06))).toEqual([]);
    expect(connection(0).filter(is(0x04, 0x06))).toHaveLength(3);
  });

  it('a command while reconnecting is refused', async () => {
    await start();
    await drop();
    const refused = { kind: 'not-signed-on' };
    expect(await infoOf(h.client.sendIm('Bob', text('hi')))).toEqual(refused);
    expect(await infoOf(h.client.addBuddy({ screenName: 'Carol', groupId: 1, alias: null }))).toEqual(refused);
    expect(await infoOf(h.client.setAway(text('away')))).toEqual(refused);
    expect(await infoOf(h.client.getInfo('Bob'))).toEqual(refused);
    expect(h.client.awayMessage).toBeNull();
  });

  it('the away period continues across a reconnect', async () => {
    await start();
    await h.client.setAway(text('out to lunch'));
    bob.sendIm('Alice', 'are you there');
    await waitFor(() => bob.ims().length === 1, 'the auto-response to reach Bob');
    await drop();
    await reconnect();

    bob.sendIm('Alice', 'and now');
    await waitFor(() => h.ims.filter((im) => im.from === 'Bob').length === 2, "Bob's second IM");
    await roundTrip();
    expect(h.autoResponses).toHaveLength(1);
    expect(bob.ims().map((im) => im.html)).toEqual(['out to lunch']);
    expect(connection(1).filter(is(0x04, 0x06))).toHaveLength(1);   // the round trip's ping
  });

  it('presence is forgotten at the drop without an event, and arrives again after', async () => {
    await start();
    const order: string[] = [];
    h.client.on('presence', (presence) => order.push(`${presence.screenName} ${presence.online ? 'arrived' : 'departed'}`));
    h.client.on('state', (event) => order.push(event.state));
    const n = h.presence.length;
    await drop();
    expect(h.client.presenceOf('Bob')).toBeUndefined();
    expect(h.presence).toHaveLength(n);

    await reconnect();
    expect(h.presence.slice(n)).toMatchObject([{ screenName: 'Bob', online: true }]);
    expect(h.client.presenceOf('Bob')?.online).toBe(true);
    expect(order).toEqual(['reconnecting', 'Bob arrived', 'online']);
  });

  it('an attempt that fails after arrivals were read forgets them without an event', async () => {
    await start();
    await drop();
    // The attempt gets as far as client online, hears of Bob, and never gets its self info.
    const release = fake.withhold(0x01, 0x0f);
    const n = h.presence.length;
    await timers.advance(2_000);
    await waitFor(() => h.presence.length === n + 1, "Bob's arrival on the attempt's connection");
    await waitFor(() => indexOf(connection(1), 0x01, 0x0e) >= 0, 'the self info query of the attempt');
    await settle(fake.port);
    expect(h.client.presenceOf('Bob')?.online).toBe(true);
    await timers.advance(20_000);
    await reconnecting(2);
    expect(h.client.presenceOf('Bob')).toBeUndefined();
    expect(h.presence).toHaveLength(n + 1);
    release();
  });

  it('the reconnect sends the profile the session last set', async () => {
    await start();
    await h.client.setProfile(text('new me'));
    await drop();
    await reconnect();
    const locate = connection(1).filter(is(0x02, 0x04));
    expect(locate[0]?.body).toEqual(encodeLocateInfo({ capabilities: [CAP_UTF8_MESSAGES, CAP_CHAT], profile: 'new me' }));
  });

  it('a cluster another session left open when the connection dropped does not hold back later changes', async () => {
    await start();
    const other = await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
    other.snac(0x13, 0x11, 9);
    await settle(fake.port);
    await roundTrip();
    await drop();
    await reconnect();

    const again = await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
    again.snac(0x13, 0x08, 10, encodeFeedbagItems([CAROL]));
    await waitFor(() => h.client.buddyList().groups[0]?.buddies.length === 2, 'the change the other session made');
    expect(h.client.buddyList().groups[0]?.buddies.map((b) => b.screenName)).toEqual(['bob', 'carol']);
  });
});
