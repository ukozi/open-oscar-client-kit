import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignOnError } from '../../src/client/errors.js';
import type { GuardSite } from '../../src/client/guard.js';
import { memoryIconStore } from '../../src/client/icons.js';
import type { DropEvidence, ReconnectDecision, ReconnectPolicy } from '../../src/client/reconnect.js';
import { bucpTicketSource, storedTicketSource } from '../../src/client/tickets.js';
import type { IssuedTicket, TicketSource } from '../../src/client/tickets.js';
import type { RoomId } from '../../src/model/room.js';
import { roomConversationId } from '../../src/model/room.js';
import { ByteWriter } from '../../src/wire/bytes.js';
import { BACKOFF_BASE_MS } from '../../src/wire/constants.js';
import { tlv } from '../../src/wire/tlv.js';
import type { Logger } from '../../src/wire/types.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, captureLog, settle, tick, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';
import { md5Hex, pngImage } from '../support/png.js';

type PolicyInput = Parameters<ReconnectPolicy['next']>[0];

const RETRY_MS = 1_000;
const PNG = pngImage(8, 8);
const ICON_HASH = md5Hex(PNG);

let timers: ManualTimers;
let fake: FakeOscarServer;
let bob: FakePeer;
let h: ClientHarness;

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });
const ticketFor = (name: string, password: string): Promise<IssuedTicket> =>
  bucpTicketSource({
    log: captureLog().log,
    now: timers.now,
    timers: timers.api,
    budget: { take: async () => {} },
    credentials: { screenName: name, password },
    server: here(),
  }).ticket({ reconnect: false, track: () => {} });

// u64 cookie | u16 2 | str8 name and nothing more: the warning level and TLV block are missing.
const truncatedInvite = (name: string): Uint8Array => new ByteWriter().u64(0x0102030405060708n).u16(2).str8(name).toBytes();

const probes = (): number => fake.snacsFrom('alice').filter((s) => s.conn === 'bos' && s.family === 1 && s.subtype === 0x0e).length;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  fake.addUser('Carol', 'carolpw1');
  fake.setFeedbag('alice', withTypingPref([]));
  bob = fake.peer('Bob');
  bob.watch('alice');
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe('skipped SNACs', () => {
  it('skips and counts malformed IMs, typing and invitations per sender, and stays online', async () => {
    h = makeClient(fake, { timers });
    await h.signOn();
    const bad = [tlv.bytes(0x02, Uint8Array.of(0x05, 0x01, 0x00, 0x09))]; // a fragment length past its end
    for (let i = 0; i < 3; i++) bob.sendRaw('Alice', 1, bad);
    fake.sendSnac('alice', 4, 0x14, Uint8Array.of(1, 2, 3)); // typing cut short: no sender to read
    fake.sendSnac('alice', 4, 0x07, truncatedInvite('Mallory')); // channel 2 whose rendezvous block ends early
    await waitFor(() => h.client.skippedSnacs().get('bob') === 3, 'three skips');
    await waitFor(() => h.client.skippedSnacs().size === 3, 'the other two skips');
    expect([h.client.skippedSnacs().get(''), h.client.skippedSnacs().get('mallory')]).toEqual([1, 1]);
    expect([h.client.state, h.states.filter((s) => s.state === 'reconnecting')]).toEqual(['online', []]);
  });

  it('keeps counting through a reconnect', async () => {
    h = makeClient(fake, { timers, random: () => 0 });
    await h.signOn();
    bob.sendRaw('Alice', 1, [tlv.bytes(0x02, Uint8Array.of(0x05, 0x01, 0x00, 0x09))]);
    await waitFor(() => h.client.skippedSnacs().get('bob') === 1, 'the first skip');
    fake.dropSocket('alice');
    await waitFor(() => h.client.state === 'reconnecting', 'the drop');
    await timers.advance(BACKOFF_BASE_MS);
    await waitFor(() => h.client.state === 'online', 'the client to be online again');
    bob.sendRaw('Alice', 1, [tlv.bytes(0x02, Uint8Array.of(0x05, 0x01, 0x00, 0x09))]);
    await waitFor(() => h.client.skippedSnacs().get('bob') === 2, 'the second skip');
  });
});

describe('dropConnection', () => {
  it('reconnects from the stored ticket as a local drop', async () => {
    const issued = await ticketFor('Alice', 'alicepw1');
    const inputs: PolicyInput[] = [];
    const policy: ReconnectPolicy = {
      next(input): ReconnectDecision {
        inputs.push(input);
        return { retry: true, delayMs: RETRY_MS };
      },
    };
    h = makeClient(fake, { timers, reconnect: policy });
    await h.client.signOnWith(storedTicketSource(issued), here());
    const logins = fake.authSignons.length;
    h.client.dropConnection();
    await waitFor(() => inputs.length === 1, 'the drop');
    expect(inputs[0]?.phase).toBe('drop');
    expect(inputs[0]?.evidence).toEqual<DropEvidence>({ kind: 'local' });
    expect(h.client.state).toBe('reconnecting');
    await timers.advance(RETRY_MS);
    await waitFor(() => h.client.state === 'online', 'the client to be online again');
    expect(fake.authSignons.length).toBe(logins);
  });

  it('does nothing unless the client is online', async () => {
    h = makeClient(fake, { timers });
    h.client.dropConnection();
    expect([h.client.state, h.states]).toEqual(['offline', []]);
    await h.signOn();
    await h.client.signOff();
    h.client.dropConnection();
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'offline']);
  });
});

// A logger that throws once armed stands for a bug in the client's own code.
function brokenLog(when: { armed: boolean }, message: string, level: keyof Logger): Logger {
  const log = captureLog().log;
  return {
    ...log,
    [level]: (msg: string, fields?: Record<string, unknown>) => {
      if (when.armed && msg === message) throw new Error('the logger broke');
      log[level](msg, fields);
    },
  };
}

describe('the guard', () => {
  it('a throwing listener reaches the guard', async () => {
    const seen: [unknown, GuardSite][] = [];
    h = makeClient(fake, { timers, guard: (error, site) => seen.push([error, site]) });
    await h.signOn();
    const broke = new Error('x');
    h.client.on('im', () => {
      throw broke;
    });
    bob.sendIm('alice', 'hello');
    await waitFor(() => seen.length === 1, 'the guard');
    expect(seen).toEqual([[broke, { kind: 'listener', event: 'im' }]]);
    expect(h.client.state).toBe('online');
  });

  it('logs a throwing listener by its class when no guard is given', async () => {
    h = makeClient(fake, { timers });
    await h.signOn();
    h.client.on('im', () => {
      throw new TypeError('hello is the text of the message');
    });
    bob.sendIm('alice', 'hello');
    await waitFor(() => h.logs.lines.some((line) => line.msg === 'a listener threw'), 'the log line');
    const line = h.logs.lines.find((l) => l.msg === 'a listener threw');
    expect([line?.level, line?.fields]).toEqual(['warn', { event: 'im', error: 'TypeError' }]);
    expect(h.logs.text()).not.toContain('text of the message');
  });

  it('a failure the client does not expect reaches the guard as a sign-on site, and the sign-on still fails', async () => {
    const seen: [unknown, GuardSite][] = [];
    h = makeClient(fake, { timers, guard: (error, site) => seen.push([error, site]) });
    const broke = new TypeError('broken');
    const source: TicketSource = {
      ticket: async () => {
        throw broke;
      },
    };
    const error = await h.client.signOnWith(source, here()).catch((e: unknown) => e);
    expect([error instanceof SignOnError, (error as SignOnError).failure]).toEqual([true, { kind: 'unreachable' }]);
    expect(seen).toEqual([[broke, { kind: 'sign-on' }]]);
    expect(h.client.state).toBe('offline');
  });

  it('does not take a refused password for one, and the default does nothing for the site', async () => {
    const seen: GuardSite[] = [];
    h = makeClient(fake, { timers, guard: (_error, site) => seen.push(site) });
    const refused = await h.signOn('Alice', 'wrong-password').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SignOnError);
    expect(seen).toEqual([]);
    const plain = makeClient(fake, { timers });
    const broke = await plain.client.signOnWith({ ticket: async () => Promise.reject(new TypeError('broken')) }, here()).catch((e: unknown) => e);
    expect(broke).toBeInstanceOf(SignOnError);
  });

  it('a throw in a reconnect attempt reaches the guard as a task', async () => {
    const seen: [unknown, GuardSite][] = [];
    const when = { armed: false };
    h = makeClient(fake, {
      timers,
      random: () => 0,
      log: brokenLog(when, 'reconnect attempt failed', 'warn'),
      guard: (error, site) => seen.push([error, site]),
    });
    await h.signOn();
    when.armed = true;
    await fake.shutdown();
    await waitFor(() => h.client.state === 'reconnecting', 'the drop');
    await timers.advance(BACKOFF_BASE_MS);
    await waitFor(() => seen.length === 1, 'the guard');
    expect(seen.map(([error, site]) => [(error as Error).message, site])).toEqual([['the logger broke', { kind: 'task', task: 'reconnect' }]]);
  });

  it('a throw in a timer callback reaches the guard as a timer', async () => {
    const seen: [unknown, GuardSite][] = [];
    const when = { armed: false };
    h = makeClient(fake, {
      timers,
      log: brokenLog(when, 'oscar connection closed', 'debug'),
      guard: (error, site) => seen.push([error, site]),
    });
    await h.signOn();
    when.armed = true;
    // The test server holds back the probe's reply, so its deadline closes the connection from a timer.
    fake.withhold(1, 0x0f);
    await timers.advance(110_000);
    expect(seen.map(([, site]) => site)).toEqual([{ kind: 'timer' }]);
  });

  it('lets a timer throw escape as it did before when no guard is given', async () => {
    const when = { armed: false };
    h = makeClient(fake, { timers, log: brokenLog(when, 'oscar connection closed', 'debug') });
    await h.signOn();
    when.armed = true;
    fake.withhold(1, 0x0f);
    await expect(timers.advance(110_000)).rejects.toThrow('the logger broke');
  });
});

describe('rejoining rooms under the guard', () => {
  const LOBBY: RoomId = { exchange: 5, name: 'chimr-lobby' };
  const lobbyId = roomConversationId(LOBBY);
  const stateOf = (): string | undefined => h.rooms.filter((r) => r.id === lobbyId).at(-1)?.state;

  async function lostRoom(): Promise<void> {
    await h.client.joinRoom(LOBBY);
    fake.dropSocket('alice');
    await waitFor(() => h.client.state === 'reconnecting', 'the drop');
    fake.rooms.removeRoom(LOBBY);
    await timers.advance(BACKOFF_BASE_MS);
    await waitFor(() => h.client.state === 'online', 'the client to be online again');
  }

  it('a rejoin that fails as a join fails does not reach the guard', async () => {
    const seen: GuardSite[] = [];
    fake.rooms.addRoom(LOBBY);
    h = makeClient(fake, { timers, random: () => 0, guard: (_error, site) => seen.push(site) });
    await h.signOn();
    await lostRoom();
    await waitFor(() => stateOf() === 'notAvailable', 'the room to be gone');
    await settle(fake.port);
    expect(seen).toEqual([]);
  });

  it('a throw out of the rejoin itself reaches the guard as a task', async () => {
    const seen: [unknown, GuardSite][] = [];
    const when = { armed: false };
    fake.rooms.addRoom(LOBBY);
    h = makeClient(fake, {
      timers,
      random: () => 0,
      log: brokenLog(when, 'a room join failed', 'warn'),
      guard: (error, site) => seen.push([error, site]),
    });
    await h.signOn();
    when.armed = true;
    await lostRoom();
    await waitFor(() => seen.length === 1, 'the guard');
    expect(seen.map(([error, site]) => [(error as Error).message, site])).toEqual([['the logger broke', { kind: 'task', task: 'rejoin' }]]);
    expect(h.client.state).toBe('online');
  });
});

describe('probing under a rate alert', () => {
  async function alert(client: ClientHarness): Promise<number> {
    await client.signOn();
    fake.spend('alice', 1, 80); // class 1 into alert, short of the limit: the test server sends the notice
    expect(classOneNotices()).toEqual([2]);
    await settle(fake.port);
    await tick();
    return probes();
  }

  const classOneNotices = (): number[] =>
    fake
      .rateNotices('alice')
      .filter((notice) => notice.classId === 1)
      .map((notice) => notice.code);

  it('sends no probe while the probe class is held, and probes again once it clears', async () => {
    h = makeClient(fake, { timers, limits: { skipProbeWhileRateHeld: true } });
    const before = await alert(h);
    await timers.advance(90_000);
    expect(probes()).toBe(before);
    await timers.advance(60_000);
    fake.rateTick('alice'); // clear
    expect(classOneNotices()).toEqual([2, 4]);
    await settle(fake.port);
    await timers.advance(90_000);
    expect(probes()).toBe(before + 1);
    expect(h.client.state).toBe('online');
  });

  it('keeps probing while held without the option', async () => {
    h = makeClient(fake, { timers });
    const before = await alert(h);
    await timers.advance(90_000);
    await waitFor(() => probes() === before + 1, 'a probe');
  });
});

describe('lastHeardAt', () => {
  it('follows the last inbound SNAC and is null unless online', async () => {
    h = makeClient(fake, { timers });
    expect(h.client.lastHeardAt).toBeNull();
    await h.signOn();
    expect(h.client.lastHeardAt).not.toBeNull();
    await timers.advance(5_000);
    bob.sendIm('alice', 'hello');
    await waitFor(() => h.ims.length === 1, 'the IM');
    const at = timers.now();
    expect(h.client.lastHeardAt).toBe(at);
    await timers.advance(5_000);
    expect(h.client.lastHeardAt).toBe(at);
    fake.dropSocket('alice');
    await waitFor(() => h.client.state === 'reconnecting', 'the drop');
    expect(h.client.lastHeardAt).toBeNull();
  });
});

describe('a shared icon store', () => {
  it('two clients sharing an icon store download a hash once', async () => {
    const store = memoryIconStore();
    fake.setFeedbag('alice', withTypingPref([{ name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] }, { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] }]));
    fake.setFeedbag('carol', withTypingPref([{ name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] }, { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] }]));
    const alice = makeClient(fake, { timers, iconStore: store });
    const carol = makeClient(fake, { timers, iconStore: store });
    bob.setIcon(PNG);
    await alice.signOn('Alice', 'alicepw1');
    await waitFor(() => alice.client.iconOf('Bob') === ICON_HASH, 'alice to show the icon');
    await carol.signOn('Carol', 'carolpw1');
    await waitFor(() => carol.client.iconOf('Bob') === ICON_HASH, 'carol to show the icon');
    const downloads = (name: string) => fake.snacsFrom(name).filter((s) => s.family === 0x10 && s.subtype === 0x04);
    expect([downloads('alice').length, downloads('carol').length]).toEqual([1, 0]);
  });
});
