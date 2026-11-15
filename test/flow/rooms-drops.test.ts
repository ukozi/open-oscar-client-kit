import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OscarError, RoomJoinError } from '../../src/client/errors.js';
import { ROOM_CLOSE_SETTLE_MS, roomFailureReason } from '../../src/client/rooms.js';
import type { RoomId } from '../../src/model/room.js';
import type { RichText } from '../../src/model/rich-text.js';
import { roomConversationId } from '../../src/model/room.js';
import type { RoomState, RoomStatus } from '../../src/model/room.js';
import type { SessionState } from '../../src/model/session.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;

const MULTI_SESSION = 0x01;
const LOBBY: RoomId = { exchange: 5, name: 'chimr-lobby' };
const CHAT: RoomId = { exchange: 4, name: 'Dev Room' };
const lobbyId = roomConversationId(LOBBY);
const chatId = roomConversationId(CHAT);

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
  server.rooms.addRoom(LOBBY);
  h = makeClient(server, { timers });
  await h.signOn();
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const text = (words: string): RichText => [{ text: words }];
const joins = (): SnacRecord[] => server.snacsFrom('alice').filter((s) => s.family === 0x0d && s.subtype === 0x08);
// The user-info queries Alice wrote on her BOS connection: the liveness question.
const selfInfoQueries = (): number => server.snacsFrom('alice').filter((s) => s.family === 0x01 && s.subtype === 0x0e && s.conn === 'bos').length;
const roomSends = (): SnacRecord[] => server.snacsFrom('alice').filter((s) => s.family === 0x0e && s.subtype === 0x05);
const stateOf = (id: string): RoomStatus | undefined => h.rooms.filter((r) => r.id === id).at(-1);
const statesOf = (id: string): RoomState[] => h.rooms.filter((r) => r.id === id).map((r) => r.state);
const held = (id: string): RoomStatus | undefined => h.client.rooms().find((r) => r.id === id);
const sorted = (names: readonly string[] | undefined): string[] => [...(names ?? [])].sort();

// The hold is the only timer of that length and the clock has not moved since the close: the client has read a room close.
const closeRead = (): Promise<void> => waitFor(() => timers.pending().includes(ROOM_CLOSE_SETTLE_MS), 'the client to read the room close');

// No test advances the clock between a room close and the BOS close by accident: the client takes in the loss first.
async function lost(): Promise<void> {
  server.dropSocket('Alice');
  await waitFor(() => h.client.state === 'reconnecting', 'the client to be reconnecting');
}

// The first retry is due 2 s after the drop, 20 % either way.
async function back(): Promise<void> {
  await timers.advance(2_400);
  await waitFor(() => h.client.state === 'online', 'the client to be online again');
}

const reaches = (id: string, state: RoomState): Promise<void> => waitFor(() => stateOf(id)?.state === state, `the room to be ${state}`);

// A probe goes out every 90 s and its reply is due 20 s later, so the clock moves in steps shorter than that.
async function idle(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 15_000) {
    await timers.advance(Math.min(left, 15_000));
    await settle(server.port);
  }
}

// The resolve step sleeps before its next attempt; nothing else of a session at rest is due that soon.
const retrySleep = (within: number): Promise<void> =>
  waitFor(() => timers.pending().some((ms) => ms <= within), `a retry delay of at most ${within} ms`);

type Outcome<T> = { done: boolean; value?: T; error?: unknown };
function track<T>(promise: Promise<T>): Outcome<T> {
  const outcome: Outcome<T> = { done: false };
  promise.then(
    (value) => {
      outcome.done = true;
      outcome.value = value;
    },
    (error: unknown) => {
      outcome.done = true;
      outcome.error = error;
    },
  );
  return outcome;
}

const settled = (outcome: Outcome<unknown>, what: string): Promise<void> => waitFor(() => outcome.done, what);

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

const joinFailure = (error: unknown): unknown => (error instanceof RoomJoinError ? error.reason : error);
const infoOf = (error: unknown): unknown => (error instanceof OscarError ? error.info : error);

const closesOf = (label: string): unknown[] =>
  h.logs.lines.filter((l) => l.msg === 'oscar connection closed' && l.fields?.conn === label).map((l) => l.fields?.kind);

async function joinBoth(): Promise<void> {
  await h.client.joinRoom(LOBBY);
  await h.client.joinRoom(CHAT);
}

async function evictedAndSettled(room: RoomId): Promise<void> {
  server.rooms.evict('Alice', room);
  await closeRead();
  await timers.advance(ROOM_CLOSE_SETTLE_MS);
  expect(stateOf(roomConversationId(room))?.state).toBe('disconnected');
}

// A second BOS session of Alice's: the test server keeps an instance of hers when the client's drops, so it does not end her rooms.
const otherSession = (): Promise<RawClient> => RawClient.signOn(server.port, 'Alice', 'alicepw1', MULTI_SESSION);

describe('rooms across drops', () => {
  it('a room connection the server closes is not rejoined', { timeout: 20_000 }, async () => {
    await joinBoth();
    const events = h.rooms.length;
    server.rooms.evict('Alice', LOBBY);
    await closeRead();
    expect(h.rooms).toHaveLength(events);
    expect(held(lobbyId)?.state).toBe('joined');

    await timers.advance(ROOM_CLOSE_SETTLE_MS);
    expect(stateOf(lobbyId)?.state).toBe('disconnected');
    expect(held(lobbyId)?.state).toBe('disconnected');

    await idle(600_000);
    expect(joins()).toHaveLength(2);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected']);
    expect(held(chatId)?.state).toBe('joined');
    expect(server.rooms.occupants(CHAT)).toContain('alice');
    expect(h.client.state).toBe('online');
  });

  it('a room connection that drops without a sign-off goes to Disconnected too', async () => {
    await h.client.joinRoom(LOBBY);
    server.rooms.dropChat('Alice', LOBBY);
    await closeRead();
    expect(statesOf(lobbyId)).toEqual(['joined']);
    await timers.advance(ROOM_CLOSE_SETTLE_MS);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected']);
    expect(closesOf('chat')).toEqual(['eof']);
  });

  it('a room connection that fails its liveness probe goes to Disconnected once the main connection answers, and is not rejoined', { timeout: 20_000 }, async () => {
    await joinBoth();
    server.rooms.silence('Alice', LOBBY);
    await timers.advance(90_000);
    await settle(server.port);
    expect(statesOf(lobbyId)).toEqual(['joined']);
    const asked = selfInfoQueries();
    await timers.advance(20_000);
    await reaches(lobbyId, 'disconnected');
    expect(selfInfoQueries()).toBe(asked + 1);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected']);
    expect(closesOf('chat')).toEqual(['probe-timeout']);
    expect(timers.pending()).not.toContain(ROOM_CLOSE_SETTLE_MS);
    expect(h.client.state).toBe('online');
    expect(held(chatId)?.state).toBe('joined');

    await idle(300_000);
    expect(joins()).toHaveLength(2);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected']);
    expect(h.client.state).toBe('online');
    expect(held(chatId)?.state).toBe('joined');
  });

  it('a room that goes silent just before the main connection does is lost with it and rejoined once', { timeout: 20_000 }, async () => {
    await h.client.joinRoom(LOBBY);
    const before = joins().length;
    server.rooms.silence('Alice', LOBBY);
    await timers.advance(90_000);
    await settle(server.port);
    // From here the server answers nothing on the main connection either: the network is gone, with no close.
    const release = server.withhold(0x0001, 0x000f);
    try {
      await timers.advance(20_000);
      await settle(server.port);
      expect(closesOf('chat')).toEqual(['probe-timeout']);
      expect(statesOf(lobbyId)).toEqual(['joined']);
      expect(held(lobbyId)?.state).toBe('joined');
      expect(h.client.state).toBe('online');

      await timers.advance(20_000);
      await waitFor(() => h.client.state === 'reconnecting', 'the client to be reconnecting');
      expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining']);
    } finally {
      release();
    }
    await back();
    await reaches(lobbyId, 'joined');
    expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
    await settle(server.port);
    expect(joins()).toHaveLength(before + 1);
    expect(server.rooms.occupants(LOBBY)).toContain('alice');
  });

  it('a room connection that ends with a socket error waits for the main connection to answer, not for the hold', async () => {
    await joinBoth();
    server.rooms.resetChat('Alice', LOBBY);
    await reaches(lobbyId, 'disconnected');
    expect(closesOf('chat')).toEqual(['error']);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected']);
    expect(h.client.state).toBe('online');
    expect(held(chatId)?.state).toBe('joined');
    await lost();
    await back();
    await reaches(chatId, 'joined');
    await settle(server.port);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected']);
  });

  it('a room connection that ends with a socket error while the main connection is silent is lost with it', { timeout: 20_000 }, async () => {
    await h.client.joinRoom(LOBBY);
    const release = server.withhold(0x0001, 0x000f);
    try {
      server.rooms.resetChat('Alice', LOBBY);
      await waitFor(() => closesOf('chat').length === 1, 'the client to read the room close');
      expect(closesOf('chat')).toEqual(['error']);
      await timers.advance(ROOM_CLOSE_SETTLE_MS + 1);
      await settle(server.port);
      expect(statesOf(lobbyId)).toEqual(['joined']);
      await timers.advance(20_000);
      await waitFor(() => h.client.state === 'reconnecting', 'the client to be reconnecting');
      expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining']);
    } finally {
      release();
    }
    await back();
    await reaches(lobbyId, 'joined');
    expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
  });

  it('Rejoin runs a new join and seeds the roster without a line', async () => {
    await joinBoth();
    await evictedAndSettled(LOBBY);
    server.rooms.peerJoin('Bob', LOBBY);

    const status = await h.client.joinRoom(LOBBY);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected', 'joining', 'joined']);
    expect(sorted(stateOf(lobbyId)?.occupants)).toEqual(['Alice', 'Bob']);
    expect(sorted(status.occupants)).toEqual(['Alice', 'Bob']);
    expect(h.occupantChanges).toEqual([]);
    expect(joins()).toHaveLength(3);
  });

  it('a Rejoin that finds the public room gone leaves it Not available, and any other failure leaves it Disconnected', async () => {
    await joinBoth();
    await evictedAndSettled(LOBBY);
    server.rooms.removeRoom(LOBBY);
    expect(joinFailure(await errorOf(h.client.joinRoom(LOBBY)))).toBe('no-such-room');
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected', 'joining', 'notAvailable']);

    await evictedAndSettled(CHAT);
    server.failNext(0x000d, 0x0008, { code: 0x0008 });
    expect(joinFailure(await errorOf(h.client.joinRoom(CHAT)))).toBe('unavailable');
    expect(statesOf(chatId)).toEqual(['joined', 'disconnected', 'joining', 'disconnected']);
    expect(h.client.state).toBe('online');
  });

  it('closes every room connection and the ChatNav connection itself when BOS is lost, without waiting for the server', async () => {
    const other = await otherSession();
    await joinBoth();
    const release = server.withhold(0x000d, 0x0009);
    try {
      const third = track(h.client.joinRoom({ exchange: 4, name: 'Third' }));
      await waitFor(() => joins().length === 3, 'the third join to reach ChatNav');
      expect(server.openConnections('Alice')).toEqual(['bos', 'bos', 'chat', 'chat', 'chatnav']);
      const heard: { id: string; state: RoomState; session: SessionState }[] = [];
      h.client.on('room', (room) => heard.push({ id: room.id, state: room.state, session: h.client.state }));

      server.dropInstance('Alice', 0);
      await waitFor(() => heard.length === 2, 'both rooms to change');
      expect(heard).toEqual([
        { id: lobbyId, state: 'rejoining', session: 'reconnecting' },
        { id: chatId, state: 'rejoining', session: 'reconnecting' },
      ]);
      expect(h.client.rooms().map((r) => [r.state, r.occupants])).toEqual([
        ['rejoining', []],
        ['rejoining', []],
      ]);
      // Only the other session's connection is left: the client closed its room and ChatNav connections, the server ends none of them.
      await waitFor(() => server.openConnections('Alice').length === 1, 'the connections of the client to close');
      expect(server.openConnections('Alice')).toEqual(['bos']);
      expect(server.instancesOf('Alice')).toBe(1);
      expect(server.rooms.occupants(LOBBY)).not.toContain('alice');
      expect(server.rooms.occupants(CHAT)).not.toContain('alice');
      expect(closesOf('chat')).toEqual(['local', 'local']);
      expect(closesOf('chatnav').at(-1)).toBe('local');
      await settled(third, 'the third join');
      expect(joinFailure(third.error)).toBe('unavailable');
    } finally {
      release();
      other.close();
    }
  });

  it('rejoins each room once after a reconnect and never a second time', { timeout: 20_000 }, async () => {
    await joinBoth();
    server.rooms.peerJoin('Bob', CHAT);
    await waitFor(() => h.occupantChanges.length === 1, 'the arrival of Bob');
    const before = joins().length;
    const changes = h.occupantChanges.length;

    await lost();
    await back();
    await reaches(lobbyId, 'joined');
    await reaches(chatId, 'joined');
    // The test server signed the room connections off as it ended the session: the client lost the rooms with the session, and they never Disconnected.
    expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
    expect(statesOf(chatId)).toEqual(['joined', 'rejoining', 'joined']);
    expect(sorted(stateOf(chatId)?.occupants)).toEqual(['Alice', 'Bob']);
    expect(sorted(held(chatId)?.occupants)).toEqual(['Alice', 'Bob']);
    await settle(server.port);
    expect(joins()).toHaveLength(before + 2);
    expect(h.occupantChanges).toHaveLength(changes);
    expect(server.rooms.occupants(LOBBY)).toContain('alice');

    server.rooms.evict('Alice', CHAT);
    await closeRead();
    await timers.advance(ROOM_CLOSE_SETTLE_MS);
    expect(stateOf(chatId)?.state).toBe('disconnected');
    await idle(600_000);
    expect(joins()).toHaveLength(before + 2);
    expect(statesOf(chatId)).toEqual(['joined', 'rejoining', 'joined', 'disconnected']);
  });

  it('a room whose rejoin fails is not tried again', { timeout: 30_000 }, async () => {
    await h.client.joinRoom(LOBBY);
    await lost();
    server.rooms.removeRoom(LOBBY);
    await back();
    await reaches(lobbyId, 'notAvailable');
    expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining', 'notAvailable']);
    expect(h.client.state).toBe('online');
    await settle(server.port);
    expect(joins()).toHaveLength(2);
    await idle(600_000);
    expect(joins()).toHaveLength(2);
    expect(h.client.state).toBe('online');

    await h.client.leaveRoom(lobbyId);
    await h.client.joinRoom(CHAT);
    expect(joins()).toHaveLength(3);
    await lost();
    server.rooms.dropCreates(3);
    await back();
    await retrySleep(600);
    await timers.advance(600);
    await retrySleep(1_800);
    await timers.advance(1_800);
    await reaches(chatId, 'disconnected');
    expect(statesOf(chatId)).toEqual(['joined', 'rejoining', 'disconnected']);
    expect(h.client.state).toBe('online');
    await settle(server.port);
    expect(joins()).toHaveLength(6);
    await idle(600_000);
    expect(joins()).toHaveLength(6);
    expect(h.client.state).toBe('online');
  });

  it('a room that was Disconnected before the drop is not rejoined', async () => {
    await joinBoth();
    server.rooms.evict('Alice', LOBBY);
    await closeRead();
    await timers.advance(ROOM_CLOSE_SETTLE_MS + 1);
    expect(stateOf(lobbyId)?.state).toBe('disconnected');
    const before = joins().length;

    await lost();
    await back();
    await reaches(chatId, 'joined');
    await settle(server.port);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected']);
    expect(held(lobbyId)?.state).toBe('disconnected');
    expect(statesOf(chatId)).toEqual(['joined', 'rejoining', 'joined']);
    expect(joins()).toHaveLength(before + 1);
  });

  it('a room close read just before the BOS close is part of that loss: rejoining, no disconnected event', { timeout: 20_000 }, async () => {
    await h.client.joinRoom(LOBBY);
    server.rooms.dropChat('Alice', LOBBY);
    await closeRead();
    await timers.advance(ROOM_CLOSE_SETTLE_MS - 1);
    expect(statesOf(lobbyId)).toEqual(['joined']);

    await lost();
    expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining']);
    await back();
    await reaches(lobbyId, 'joined');
    expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
    await idle(600_000);
    expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
    expect(server.rooms.occupants(LOBBY)).toContain('alice');
  });

  it('a room that failed its liveness probe while the main connection still answered is not rejoined after a later BOS loss', async () => {
    await joinBoth();
    server.rooms.silence('Alice', LOBBY);
    await timers.advance(90_000);
    await settle(server.port);
    await timers.advance(20_000);
    await reaches(lobbyId, 'disconnected');
    const before = joins().length;
    await timers.advance(500);

    await lost();
    await back();
    await reaches(chatId, 'joined');
    await settle(server.port);
    expect(statesOf(lobbyId)).toEqual(['joined', 'disconnected']);
    expect(held(lobbyId)?.state).toBe('disconnected');
    expect(joins()).toHaveLength(before + 1);
  });

  it('the close of a superseded room connection changes nothing', async () => {
    const other = await otherSession();
    try {
      await h.client.joinRoom(LOBBY);
      server.dropInstance('Alice', 0);
      await waitFor(() => h.client.state === 'reconnecting', 'the client to be reconnecting');
      await back();
      await reaches(lobbyId, 'joined');
      expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
      await timers.advance(ROOM_CLOSE_SETTLE_MS);
      await settle(server.port);
      expect(statesOf(lobbyId)).toEqual(['joined', 'rejoining', 'joined']);
      expect(held(lobbyId)?.state).toBe('joined');
      expect(closesOf('chat')).toEqual(['local']);
      expect(server.openConnections('Alice')).toEqual(['bos', 'bos', 'chat']);
    } finally {
      other.close();
    }
  });

  it('a rejoin cut short by a second BOS loss leaves the room disconnected and is not tried after the next reconnect', async () => {
    await h.client.joinRoom(CHAT);
    const before = joins().length;
    await lost();
    const release = server.withhold(0x000d, 0x0009);
    try {
      await back();
      await waitFor(() => joins().length === before + 1, "the rejoin's resolve to reach ChatNav");
      expect(statesOf(chatId)).toEqual(['joined', 'rejoining']);
      await lost();
      expect(statesOf(chatId)).toEqual(['joined', 'rejoining', 'disconnected']);
    } finally {
      release();
    }
    await back();
    await settle(server.port);
    await timers.advance(ROOM_CLOSE_SETTLE_MS);
    await settle(server.port);
    expect(statesOf(chatId)).toEqual(['joined', 'rejoining', 'disconnected']);
    expect(held(chatId)?.state).toBe('disconnected');
    expect(joins()).toHaveLength(before + 1);
  });

  it('a join of a room whose rejoin is running is that rejoin', async () => {
    await h.client.joinRoom(CHAT);
    const before = joins().length;
    await lost();
    const release = server.withhold(0x000d, 0x0009);
    let again: Outcome<RoomStatus>;
    try {
      await back();
      await waitFor(() => joins().length === before + 1, "the rejoin's resolve to reach ChatNav");
      again = track(h.client.joinRoom(CHAT));
      await settle(server.port);
      expect(again.done).toBe(false);
      expect(joins()).toHaveLength(before + 1);
    } finally {
      release();
    }
    await settled(again, 'the join');
    expect(again.value?.state).toBe('joined');
    expect(statesOf(chatId)).toEqual(['joined', 'rejoining', 'joined']);
    await settle(server.port);
    expect(joins()).toHaveLength(before + 1);
    expect(server.openConnections('Alice')).toEqual(['bos', 'chat']);
  });

  it('a send that fails with its old connection is not written on the rejoined room', async () => {
    server.rooms.peerJoin('Bob', CHAT);
    await h.client.joinRoom(CHAT);
    server.rooms.setRoomRate('Alice', CHAT, 'limited', true);
    const pending = track(h.client.sendRoomMessage(chatId, text('zq-pending')));
    await waitFor(() => roomSends().length === 1, 'the line to reach the test server');
    expect(pending.done).toBe(false);

    await lost();
    await settled(pending, 'the send');
    expect(roomFailureReason(pending.error)).toBe('notInRoom');

    await back();
    await reaches(chatId, 'joined');
    await timers.advance(15_000);
    await settle(server.port);
    expect(roomSends()).toHaveLength(1);
    expect(await h.client.sendRoomMessage(chatId, text('fresh'))).toEqual({ replacedBy: null, id: expect.stringMatching(/^[0-9a-f]+$/) });
    expect(roomSends()).toHaveLength(2);
    expect(server.rooms.peerLines('Bob', CHAT).map((line) => line.text)).toEqual(['fresh']);
  });

  it('a join that was running when BOS was lost fails as unavailable and holds nothing', async () => {
    const release = server.withhold(0x000d, 0x0009);
    try {
      const join = track(h.client.joinRoom(CHAT));
      await waitFor(() => joins().length === 1, 'the join to reach ChatNav');
      await lost();
      await settled(join, 'the join');
      expect(joinFailure(join.error)).toBe('unavailable');
    } finally {
      release();
    }
    await back();
    await settle(server.port);
    expect(h.client.rooms()).toEqual([]);
    expect(h.rooms).toEqual([]);
    expect(joins()).toHaveLength(1);
    expect(server.openConnections('Alice')).toEqual(['bos']);
  });

  it('refuses room commands while reconnecting', async () => {
    await h.client.joinRoom(LOBBY);
    await lost();
    const refused = { kind: 'not-signed-on' };
    expect(infoOf(await errorOf(h.client.joinRoom(CHAT)))).toEqual(refused);
    expect(infoOf(await errorOf(h.client.sendRoomMessage(lobbyId, text('hi'))))).toEqual(refused);
    expect(infoOf(await errorOf(h.client.inviteToRoom(lobbyId, 'Bob')))).toEqual(refused);
  });

  it('a session that ends while rooms are Rejoining forgets them without an event', async () => {
    await joinBoth();
    await lost();
    expect(h.client.rooms().map((r) => r.state)).toEqual(['rejoining', 'rejoining']);
    await h.client.signOff();
    expect(h.client.rooms()).toEqual([]);
    expect(h.rooms.map((r) => r.state)).toEqual(['joined', 'joined', 'rejoining', 'rejoining']);
  });

  it('logs a room that changes state by its exchange and the kind of close, never by its name', async () => {
    await joinBoth();
    await evictedAndSettled(CHAT);
    await lost();
    const changes = h.logs.lines.filter((l) => l.msg === 'a room changed state');
    expect(changes.map((l) => [l.fields?.exchange, l.fields?.state])).toEqual([
      [4, 'disconnected'],
      [5, 'rejoining'],
    ]);
    expect(changes[0]?.fields?.close).toBe('signoff');
    expect(h.logs.text().toLowerCase()).not.toContain('dev room');
    expect(h.logs.text().toLowerCase()).not.toContain('chimr-lobby');
  });
});
