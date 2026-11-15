import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RejoinPolicy, Siblings } from '../../src/client/rejoin.js';
import { ROOM_CLOSE_SETTLE_MS } from '../../src/client/rooms.js';
import { roomConversationId } from '../../src/model/room.js';
import type { RoomId, RoomState, RoomStatus } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

type ClosedInput = Parameters<RejoinPolicy['afterRoomClosed']>[0];
type ReconnectInput = Parameters<RejoinPolicy['afterReconnect']>[0];

// Records what it is asked and answers what it was told to.
class Recording implements RejoinPolicy {
  readonly closed: ClosedInput[] = [];
  readonly reconnected: ReconnectInput[] = [];
  answer: 'rejoin' | 'stay' = 'stay';
  keep: (rooms: readonly RoomStatus[]) => readonly string[] = () => [];
  wait: Promise<void> = Promise.resolve();

  async afterRoomClosed(input: ClosedInput): Promise<'rejoin' | 'stay'> {
    this.closed.push(input);
    await this.wait;
    return this.answer;
  }

  async afterReconnect(input: ReconnectInput): Promise<readonly string[]> {
    this.reconnected.push(input);
    return this.keep(input.rooms);
  }
}

const LOBBY: RoomId = { exchange: 4, name: 'Lobby' };
const ANNEX: RoomId = { exchange: 4, name: 'Annex' };
const lobbyId = roomConversationId(LOBBY);
const annexId = roomConversationId(ANNEX);

let timers: ManualTimers;
let fake: FakeOscarServer;
let policy: Recording;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  policy = new Recording();
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

async function seated(over: Parameters<typeof makeClient>[1] = {}): Promise<ClientHarness> {
  const h = makeClient(fake, { timers, ...over });
  await h.signOn();
  await h.client.joinRoom(LOBBY);
  return h;
}

const statesOf = (h: ClientHarness, id: string): RoomState[] => h.rooms.filter((r) => r.id === id).map((r) => r.state);
const joins = (): SnacRecord[] => fake.snacsFrom('alice').filter((s) => s.family === 0x0d && s.subtype === 0x08);
const selfInfoQueries = (): number => fake.snacsFrom('alice').filter((s) => s.family === 0x01 && s.subtype === 0x0e && s.conn === 'bos').length;
const reaches = (h: ClientHarness, id: string, state: RoomState): Promise<void> =>
  waitFor(() => h.rooms.filter((r) => r.id === id).at(-1)?.state === state, `the room to be ${state}`);

// The hold is the only timer of that length and the clock has not moved since the close: the client has read a room close.
const closeRead = (): Promise<void> => waitFor(() => timers.pending().includes(ROOM_CLOSE_SETTLE_MS), 'the client to read the room close');

async function closedAndSettled(): Promise<void> {
  await closeRead();
  await timers.advance(ROOM_CLOSE_SETTLE_MS);
  await waitFor(() => policy.closed.length === 1, 'the hook');
}

// The first retry is due 2 s after the drop, 20 % either way.
async function dropped(h: ClientHarness): Promise<void> {
  fake.dropSocket('Alice');
  await waitFor(() => h.client.state === 'reconnecting', 'the client to be reconnecting');
}

async function back(h: ClientHarness): Promise<void> {
  await timers.advance(2_400);
  await waitFor(() => h.client.state === 'online', 'the client to be online again');
}

describe('the rejoin hook after a room closes', () => {
  it('a seat taken by another instance asks with one sibling, and stay leaves it disconnected', async () => {
    const h = await seated({ oserviceVersion: 4, rejoin: policy });
    const desk = makeClient(fake, { timers, oserviceVersion: 4 });
    await desk.signOn();
    await desk.client.joinRoom(LOBBY);
    await closedAndSettled();
    expect(await policy.closed[0]?.siblings()).toEqual({ known: true, others: 1 });
    expect(policy.closed[0]?.close).toBe('signoff');
    expect(policy.closed[0]?.room.id).toBe(lobbyId);
    await waitFor(() => h.client.rooms()[0]?.state === 'disconnected', 'disconnected');
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'disconnected']);
  });

  it('alone, an overflow close answered rejoin rejoins once', async () => {
    const h = await seated({ oserviceVersion: 4, rejoin: policy });
    policy.answer = 'rejoin';
    const before = joins().length;
    fake.rooms.overflow('alice', LOBBY);
    await closedAndSettled();
    expect(await policy.closed[0]?.siblings()).toEqual({ known: true, others: 0 });
    await reaches(h, lobbyId, 'joined');
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
    expect(fake.rooms.occupants(LOBBY)).toContain('alice');
    await timers.advance(60_000);
    await settle(fake.port);
    expect(joins()).toHaveLength(before + 1);
    expect(policy.closed).toHaveLength(1);
  });

  it('a rejoin that fails leaves the room disconnected and is not tried again', async () => {
    const h = await seated({ rejoin: policy });
    policy.answer = 'rejoin';
    const before = joins().length;
    // The test server refuses each of the join's two tries at sign-on.
    fake.onSnacHook = (snac) => {
      if (snac.conn === 'bos' && snac.family === 0x01 && snac.subtype === 0x04 && Buffer.from(snac.body).readUInt16BE(0) === 0x000e) {
        fake.rooms.refuseNextChatTicket();
      }
    };
    fake.rooms.overflow('alice', LOBBY);
    await closedAndSettled();
    await reaches(h, lobbyId, 'disconnected');
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'rejoining', 'disconnected']);
    // The join resolves the room again once after its first refusal, so one rejoin is two ChatNav requests.
    expect(joins()).toHaveLength(before + 2);
    await timers.advance(60_000);
    await settle(fake.port);
    expect(joins()).toHaveLength(before + 2);
    expect(h.client.state).toBe('online');
  });

  it('below version 4 siblings are unknown', async () => {
    await seated({ rejoin: policy });
    const asked = selfInfoQueries();
    fake.rooms.evict('Alice', LOBBY);
    await closedAndSettled();
    const unknown: Siblings = { known: false };
    expect(await policy.closed[0]?.siblings()).toEqual(unknown);
    expect(selfInfoQueries()).toBe(asked);
  });

  it('siblings are unknown when the query fails', async () => {
    await seated({ oserviceVersion: 4, rejoin: policy });
    fake.rooms.evict('Alice', LOBBY);
    await closedAndSettled();
    fake.failNext(0x0001, 0x000e, { code: 0x0008 });
    expect(await policy.closed[0]?.siblings()).toEqual({ known: false });
  });

  it('the default rejoins no room after a close and writes no user info query for it', async () => {
    const h = await seated({ oserviceVersion: 4 });
    const asked = selfInfoQueries();
    const before = joins().length;
    fake.rooms.evict('Alice', LOBBY);
    await closeRead();
    await timers.advance(ROOM_CLOSE_SETTLE_MS);
    await reaches(h, lobbyId, 'disconnected');
    await timers.advance(60_000);
    await settle(fake.port);
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'disconnected']);
    expect(selfInfoQueries()).toBe(asked);
    expect(joins()).toHaveLength(before);
  });

  it('a policy that throws leaves the room disconnected and is logged without its message', async () => {
    const h = await seated({
      rejoin: {
        afterRoomClosed: () => {
          throw new Error('sibling-secret');
        },
        afterReconnect: () => Promise.resolve([]),
      },
    });
    fake.rooms.evict('Alice', LOBBY);
    await closeRead();
    await timers.advance(ROOM_CLOSE_SETTLE_MS);
    await reaches(h, lobbyId, 'disconnected');
    const failed = h.logs.lines.filter((l) => l.msg === 'the rejoin policy failed');
    expect(failed.map((l) => [l.level, l.fields?.hook])).toEqual([['warn', 'afterRoomClosed']]);
    expect(h.logs.text()).not.toContain('sibling-secret');
  });

  it('an answer that comes after the main connection was lost changes nothing', async () => {
    const h = await seated({ rejoin: policy });
    policy.answer = 'rejoin';
    policy.keep = (rooms) => rooms.map((r) => r.id);
    let answer = (): void => {};
    policy.wait = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const before = joins().length;
    fake.rooms.evict('Alice', LOBBY);
    await closedAndSettled();
    await dropped(h);
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'rejoining']);
    answer();
    await settle(fake.port);
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'rejoining']);
    await back(h);
    await reaches(h, lobbyId, 'joined');
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
    await settle(fake.port);
    expect(joins()).toHaveLength(before + 1);
  });
});

describe('the rejoin hook after a reconnect', () => {
  it('it passes the absence and rejoins only the rooms returned', async () => {
    let gate: Promise<void> = Promise.resolve();
    const h = await seated({ oserviceVersion: 4, rejoin: policy, loginBudget: { take: () => gate } });
    await h.client.joinRoom(ANNEX);
    policy.keep = () => [lobbyId];

    // The reconnect waits for the login budget while the clock moves on.
    let open = (): void => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await dropped(h);
    await timers.advance(30_000);
    open();
    await waitFor(() => h.client.state === 'online', 'the client to be online again');
    await reaches(h, lobbyId, 'joined');
    await reaches(h, annexId, 'disconnected');

    expect(policy.reconnected).toHaveLength(1);
    const [asked] = policy.reconnected;
    expect(asked?.rooms.map((r) => [r.id, r.state]).sort()).toEqual([[annexId, 'rejoining'], [lobbyId, 'rejoining']]);
    expect(asked?.absentMs).toBeGreaterThanOrEqual(30_000);
    expect(await asked?.siblings()).toEqual({ known: true, others: 0 });
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
    expect(statesOf(h, annexId)).toEqual(['joined', 'rejoining', 'disconnected']);
    expect(fake.rooms.occupants(LOBBY)).toContain('alice');
    expect(fake.rooms.occupants(ANNEX)).not.toContain('alice');
    await timers.advance(60_000);
    await settle(fake.port);
    expect(statesOf(h, annexId)).toEqual(['joined', 'rejoining', 'disconnected']);
  });

  it('a room the hook leaves out is not asked about again after a later reconnect', async () => {
    const h = await seated({ rejoin: policy });
    await dropped(h);
    await back(h);
    await reaches(h, lobbyId, 'disconnected');
    await dropped(h);
    await back(h);
    await settle(fake.port);
    expect(policy.reconnected).toHaveLength(1);
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'rejoining', 'disconnected']);
  });

  it('the default rejoins every lost room once', async () => {
    const h = await seated({ oserviceVersion: 4 });
    await h.client.joinRoom(ANNEX);
    const before = joins().length;
    await dropped(h);
    await back(h);
    await reaches(h, lobbyId, 'joined');
    await reaches(h, annexId, 'joined');
    await settle(fake.port);
    expect(joins()).toHaveLength(before + 2);
    expect(statesOf(h, lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
    expect(statesOf(h, annexId)).toEqual(['joined', 'rejoining', 'joined']);
  });

  it('a policy that rejects has every lost room rejoined', async () => {
    const h = await seated({
      rejoin: { afterRoomClosed: () => Promise.resolve('stay'), afterReconnect: () => Promise.reject(new Error('sibling-secret')) },
    });
    await dropped(h);
    await back(h);
    await reaches(h, lobbyId, 'joined');
    const failed = h.logs.lines.filter((l) => l.msg === 'the rejoin policy failed');
    expect(failed.map((l) => [l.level, l.fields?.hook])).toEqual([['warn', 'afterReconnect']]);
    expect(h.logs.text()).not.toContain('sibling-secret');
  });

  it('is not asked when no room was lost', async () => {
    const h = makeClient(fake, { timers, rejoin: policy });
    await h.signOn();
    await dropped(h);
    await back(h);
    await settle(fake.port);
    expect(policy.reconnected).toEqual([]);
  });
});
