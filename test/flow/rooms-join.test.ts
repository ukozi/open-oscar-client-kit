import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OscarError, RoomJoinError } from '../../src/client/errors.js';
import { ROOM_TLV_NAME, SERVICE_TLV_ROOM_INFO } from '../../src/wire/constants.js';
import { decodeTlvBlock, decodeTlvs, findTlv } from '../../src/wire/tlv.js';
import type { RoomId } from '../../src/model/room.js';
import { roomConversationId } from '../../src/model/room.js';
import type { RoomJoinFailure, RoomStatus } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;

const LOBBY: RoomId = { exchange: 5, name: 'chimr-lobby' };
const LOBBY_ID = roomConversationId(LOBBY);
const DEV: RoomId = { exchange: 4, name: 'Dev Room' };

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
  server.rooms.addRoom(LOBBY);
  h = makeClient(server, { timers });
});

afterEach(async () => {
  server.onSnacHook = null;
  await stopAllClients();
  await server.stop();
});

const fromAlice = (): SnacRecord[] => server.snacsFrom('alice');
const serviceRequests = (): SnacRecord[] => fromAlice().filter((s) => s.conn === 'bos' && s.family === 0x01 && s.subtype === 0x04);
const navRequests = (): SnacRecord[] => fromAlice().filter((s) => s.family === 0x0d && s.subtype === 0x08);
const foodGroup = (request: SnacRecord): number => Buffer.from(request.body).readUInt16BE(0);
const chatRequests = (): SnacRecord[] => serviceRequests().filter((s) => foodGroup(s) === 0x000e);
const isNavRequest = (snac: SnacRecord): boolean => snac.family === 0x0d && snac.subtype === 0x08;

// The name TLV of a 0x0D/0x08 body: exchange, the cookie "create", instance, detail level, then the block.
function requestedName(request: SnacRecord): string {
  const cookieLength = request.body[2] ?? 0;
  const name = findTlv(decodeTlvBlock(request.body, 3 + cookieLength + 3).tlvs, ROOM_TLV_NAME);
  return Buffer.from(name ?? []).toString('utf8');
}

// The room cookie in TLV 0x0001 of a chat service request: exchange, the cookie with a one-byte length, instance.
function requestedCookie(request: SnacRecord): string {
  const info = findTlv(decodeTlvs(request.body.subarray(2)), SERVICE_TLV_ROOM_INFO);
  if (!info) throw new Error('the service request carries no room');
  return Buffer.from(info).toString('utf8', 3, 3 + (info[2] ?? 0));
}

type Outcome = { done: boolean; value?: RoomStatus; error?: unknown };
function track(promise: Promise<RoomStatus>): Outcome {
  const outcome: Outcome = { done: false };
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

const settled = (outcome: Outcome, what: string): Promise<void> => waitFor(() => outcome.done, what);

async function failureOf(promise: Promise<unknown>): Promise<RoomJoinFailure | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RoomJoinError);
  return (error as RoomJoinError).reason;
}

// The resolve step sleeps before its next attempt; the keepalive, the liveness probe and every request timeout are 10 s or more.
const retryDue = (within: number): boolean => timers.pending().some((ms) => ms <= within);
const retrySleep = (within: number): Promise<void> => waitFor(() => retryDue(within), `a retry delay of at most ${within} ms`);

const closesOf = (label: string): unknown[] =>
  h.logs.lines.filter((l) => l.msg === 'oscar connection closed' && l.fields?.conn === label).map((l) => l.fields?.kind);

describe('joining and leaving rooms', () => {
  it('joins a public room and holds the roster the server sent, with itself in it', async () => {
    await h.signOn();
    server.rooms.peerJoin('Bob', LOBBY);
    const status = await h.client.joinRoom({ exchange: 5, name: 'Chimr-Lobby' });
    expect({ ...status, occupants: [...status.occupants].sort() }).toEqual({
      id: LOBBY_ID,
      exchange: 5,
      name: 'chimr-lobby',
      state: 'joined',
      occupants: ['Alice', 'Bob'],
      // What ChatNav said of the room: made when the operator added it, holding 100.
      createdAt: 1_800_000_000_000,
      maxOccupancy: 100,
    });
    expect(h.rooms).toEqual([status]);
    expect(h.client.rooms()).toEqual([status]);
    expect(h.occupantChanges).toEqual([]);
    expect(server.rooms.occupants(LOBBY)).toContain('alice');
  });

  it('creates a buddy chat by joining it and keeps the name as typed, trimmed', async () => {
    await h.signOn();
    const status = await h.client.joinRoom({ exchange: 4, name: '  Dev Room ' });
    expect(status.name).toBe('Dev Room');
    expect(navRequests().map(requestedName)).toEqual(['Dev Room']);
  });

  it('a public room that does not exist fails as no such room, and nothing is held', async () => {
    await h.signOn();
    expect(await failureOf(h.client.joinRoom({ exchange: 5, name: 'nowhere' }))).toBe('no-such-room');
    expect(h.client.rooms()).toEqual([]);
    expect(h.rooms).toEqual([]);
    expect(h.client.state).toBe('online');
    await settle(server.port);
    expect(navRequests()).toHaveLength(1);
    expect(chatRequests()).toEqual([]);
  });

  it('refuses a name outside the rule before anything is sent', async () => {
    await h.signOn();
    for (const name of ['', '   ', 'café', 'x'.repeat(101)]) {
      expect(await failureOf(h.client.joinRoom({ exchange: 4, name }))).toBe('invalid-name');
    }
    await settle(server.port);
    expect(serviceRequests()).toEqual([]);
  });

  it('the cookie in the chat service request is the one ChatNav returned in that join', async () => {
    await h.signOn();
    server.rooms.peerJoin('Bob', DEV);
    const status = await h.client.joinRoom({ exchange: 4, name: 'dev room' });
    expect(chatRequests().map(requestedCookie)).toEqual(['4-0-Dev Room']);
    expect(status.name).toBe('Dev Room');
  });

  it('never sends a ChatNav request on the BOS connection nor a service request on a room connection', async () => {
    await h.signOn();
    await h.client.joinRoom(LOBBY);
    await settle(server.port);
    const all = fromAlice();
    // The join did happen on its two connections, so the two absences below are of something that can be there.
    expect(all.filter((s) => s.conn === 'chatnav').map((s) => [s.family, s.subtype])).toContainEqual([0x0d, 0x08]);
    expect(all.filter((s) => s.conn === 'chat').length).toBeGreaterThan(0);
    expect(all.filter((s) => s.conn === 'bos' && s.family === 0x000d)).toEqual([]);
    expect(all.filter((s) => (s.conn === 'chatnav' || s.conn === 'chat') && s.family === 0x01 && s.subtype === 0x04)).toEqual([]);
  });

  it('opens a ChatNav connection for the join and closes it when the step ends', async () => {
    await h.signOn();
    const during: string[][] = [];
    server.onSnacHook = (snac) => {
      if (isNavRequest(snac)) during.push(server.openConnections('Alice'));
    };
    await h.client.joinRoom(LOBBY);
    expect(during).toEqual([['bos', 'chatnav']]);
    await settle(server.port);
    expect(server.openConnections('Alice')).toEqual(['bos', 'chat']);
  });

  it('closes the ChatNav connection of a join that fails, and opens no room connection', async () => {
    await h.signOn();
    expect(await failureOf(h.client.joinRoom({ exchange: 5, name: 'nowhere' }))).toBe('no-such-room');
    await settle(server.port);
    expect(server.openConnections('Alice')).toEqual(['bos']);
    expect(closesOf('chatnav')).toEqual(['local']);
  });

  it('joining a room that is already joined opens no second connection', async () => {
    await h.signOn();
    const first = await h.client.joinRoom(LOBBY);
    const second = await h.client.joinRoom({ exchange: 5, name: 'CHIMR-LOBBY' });
    expect(second).toEqual(first);
    await settle(server.port);
    expect(navRequests()).toHaveLength(1);
    expect(server.openConnections('Alice')).toEqual(['bos', 'chat']);
    expect(h.rooms).toHaveLength(1);
  });

  it('two joins of one room made together are one join', async () => {
    await h.signOn();
    const [a, b] = await Promise.all([h.client.joinRoom(LOBBY), h.client.joinRoom({ exchange: 5, name: 'Chimr-Lobby' })]);
    expect(a.state).toBe('joined');
    expect(b).toEqual(a);
    await settle(server.port);
    expect(navRequests()).toHaveLength(1);
    expect(chatRequests()).toHaveLength(1);
  });

  it('refuses an eleventh room before anything is sent', async () => {
    await h.signOn();
    for (let i = 0; i < 10; i++) await h.client.joinRoom({ exchange: 4, name: `r${i}` });
    expect(h.client.rooms().map((r) => r.state)).toEqual(Array.from({ length: 10 }, () => 'joined'));
    expect(await failureOf(h.client.joinRoom({ exchange: 4, name: 'r10' }))).toBe('room-limit');
    await settle(server.port);
    expect(navRequests()).toHaveLength(10);
    expect(serviceRequests()).toHaveLength(20);
  });

  it('refuses a join whose screen name and cookie pass 180 bytes before asking for the room connection', async () => {
    const room: RoomId = { exchange: 5, name: 'long' };
    server.rooms.addRoom(room);
    // 5 bytes of "Alice" and 176 of cookie: 181.
    server.rooms.lengthenCookie(room, 176);
    await h.signOn();
    expect(await failureOf(h.client.joinRoom(room))).toBe('name-too-long');
    await settle(server.port);
    expect(serviceRequests().map(foodGroup)).toEqual([0x000d]);
    expect(h.client.state).toBe('online');

    // 180 in all is allowed.
    server.rooms.lengthenCookie(room, 175);
    const status = await h.client.joinRoom(room);
    expect(status.state).toBe('joined');
    expect(Buffer.byteLength(chatRequests().map(requestedCookie)[0] ?? '')).toBe(175);
  });

  it('tries the resolve three times when ChatNav closes with no reply, then fails as unavailable', async () => {
    await h.signOn();
    server.rooms.dropCreates(3);
    const join = track(h.client.joinRoom(DEV));
    await retrySleep(600);
    expect(navRequests()).toHaveLength(1);
    await timers.advance(600);
    await retrySleep(1800);
    expect(navRequests()).toHaveLength(2);
    await timers.advance(1800);
    await settled(join, 'the join');
    expect((join.error as RoomJoinError).reason).toBe('unavailable');
    expect(navRequests()).toHaveLength(3);
    expect(h.client.state).toBe('online');
  });

  it('a resolve that is dropped once succeeds on the retry', async () => {
    await h.signOn();
    server.rooms.dropCreates(1);
    const join = track(h.client.joinRoom(DEV));
    await retrySleep(600);
    expect(join.done).toBe(false);
    await timers.advance(600);
    await settled(join, 'the join');
    expect(join.value?.state).toBe('joined');
    expect(navRequests()).toHaveLength(2);
  });

  it('any other ChatNav error fails as unavailable without a retry', async () => {
    await h.signOn();
    server.failNext(0x000d, 0x0008, { code: 0x0008 });
    expect(await failureOf(h.client.joinRoom(LOBBY))).toBe('unavailable');
    await settle(server.port);
    expect(navRequests()).toHaveLength(1);
    expect(retryDue(1800)).toBe(false);
  });

  it('a resolve that gets no reply waits 10 s for each of its three attempts, then fails as unavailable', async () => {
    await h.signOn();
    const release = server.withhold(0x000d, 0x0009);
    try {
      const join = track(h.client.joinRoom(LOBBY));
      await waitFor(() => navRequests().length === 1, 'the first ChatNav request');
      await timers.advance(9_999);
      expect(server.openConnections('Alice')).toEqual(['bos', 'chatnav']);
      await timers.advance(1);
      expect(join.done).toBe(false);
      expect(retryDue(600)).toBe(true);
      await timers.advance(600);
      await waitFor(() => navRequests().length === 2, 'the second ChatNav request');
      await timers.advance(10_000);
      expect(join.done).toBe(false);
      await timers.advance(1_800);
      await waitFor(() => navRequests().length === 3, 'the third ChatNav request');
      expect(join.done).toBe(false);
      await timers.advance(10_000);
      await settled(join, 'the join');
      expect((join.error as RoomJoinError).reason).toBe('unavailable');
      expect(navRequests()).toHaveLength(3);
    } finally {
      release();
    }
  });

  it('a refused service request fails as unavailable and the session stays online', async () => {
    await h.signOn();
    server.failNext(0x0001, 0x0004, { code: 0x0005 });
    expect(await failureOf(h.client.joinRoom(LOBBY))).toBe('unavailable');
    expect(h.client.state).toBe('online');
    await settle(server.port);
    expect(serviceRequests()).toHaveLength(1);
    expect(navRequests()).toEqual([]);
    expect((await h.client.joinRoom(LOBBY)).state).toBe('joined');
  });

  it('a room connection the server refuses at sign-on restarts the join from the resolve step, once', async () => {
    await h.signOn();
    server.rooms.refuseNextChatTicket();
    const status = await h.client.joinRoom(LOBBY);
    expect(status.state).toBe('joined');
    expect(navRequests()).toHaveLength(2);
    expect(chatRequests()).toHaveLength(2);
    await settle(server.port);
    expect(server.openConnections('Alice')).toEqual(['bos', 'chat']);
  });

  it('a room connection refused a second time fails the join as unavailable after exactly two tries', async () => {
    await h.signOn();
    server.onSnacHook = (snac) => {
      if (snac.conn === 'bos' && snac.family === 0x01 && snac.subtype === 0x04 && Buffer.from(snac.body).readUInt16BE(0) === 0x000e) {
        server.rooms.refuseNextChatTicket();
      }
    };
    expect(await failureOf(h.client.joinRoom(LOBBY))).toBe('unavailable');
    await settle(server.port);
    expect(navRequests()).toHaveLength(2);
    expect(chatRequests()).toHaveLength(2);
    expect(h.client.rooms()).toEqual([]);
    expect(server.openConnections('Alice')).toEqual(['bos']);
  });

  it('a room that is not ready in 15 s fails as unavailable', async () => {
    await h.signOn();
    const release = server.withhold(0x000e, 0x0003);
    try {
      const join = track(h.client.joinRoom(LOBBY));
      // Client online on the room connection: all that is missing now is the roster.
      await waitFor(() => fromAlice().some((s) => s.conn === 'chat' && s.family === 0x01 && s.subtype === 0x02), 'the room sign-on');
      await timers.advance(14_999);
      expect(join.done).toBe(false);
      await timers.advance(1);
      await settled(join, 'the join');
      expect((join.error as RoomJoinError).reason).toBe('unavailable');
    } finally {
      release();
    }
    await waitFor(() => !server.rooms.occupants(LOBBY).includes('alice'), 'the room connection to close');
    expect(closesOf('chat')).toEqual(['local']);
    expect(h.client.rooms()).toEqual([]);
    expect(h.rooms).toEqual([]);
    expect(navRequests()).toHaveLength(1);
  });

  it('a failed join leaves the session online and the other room joined', async () => {
    await h.signOn();
    const lobby = await h.client.joinRoom(LOBBY);
    server.failNext(0x000d, 0x0008, { code: 0x0008 });
    expect(await failureOf(h.client.joinRoom(DEV))).toBe('unavailable');
    expect(h.client.rooms()).toEqual([lobby]);
    expect(h.client.state).toBe('online');
    await settle(server.port);
    expect(server.rooms.occupants(LOBBY)).toContain('alice');
    expect(server.openConnections('Alice')).toEqual(['bos', 'chat']);
  });

  it('tells of each arrival and departure after the seed, with the roster as it stands', async () => {
    await h.signOn();
    await h.client.joinRoom(LOBBY);
    server.rooms.peerJoin('Carol', LOBBY);
    await waitFor(() => h.occupantChanges.length === 1, 'the arrival');
    expect(h.client.rooms().map((r) => r.occupants)).toEqual([['Alice', 'Carol']]);
    server.rooms.peerLeave('Carol', LOBBY);
    await waitFor(() => h.occupantChanges.length === 2, 'the departure');
    expect(h.occupantChanges).toEqual([
      { roomId: LOBBY_ID, screenName: 'Carol', change: 'joined', occupants: ['Alice', 'Carol'] },
      { roomId: LOBBY_ID, screenName: 'Carol', change: 'left', occupants: ['Alice'] },
    ]);
    expect(h.client.rooms().map((r) => r.occupants)).toEqual([['Alice']]);
    expect(h.rooms).toHaveLength(1);
  });

  it("leaving closes the room's connection and forgets the room", async () => {
    server.addUser('Bob', 'bobpw123');
    const bob = makeClient(server, { timers });
    await bob.signOn('Bob', 'bobpw123');
    await bob.client.joinRoom(LOBBY);
    await h.signOn();
    await h.client.joinRoom(LOBBY);
    await waitFor(() => bob.occupantChanges.length === 1, 'Bob to hear of Alice');
    const events = h.rooms.length;

    await h.client.leaveRoom(LOBBY_ID);
    expect(h.client.rooms()).toEqual([]);
    await waitFor(() => !server.rooms.occupants(LOBBY).includes('alice'), 'the room connection to close');
    await waitFor(() => bob.occupantChanges.length === 2, 'Bob to hear that Alice left');
    await settle(server.port);
    expect(server.openConnections('Alice')).toEqual(['bos']);
    expect(closesOf('chat')).toEqual(['local']);
    expect(h.rooms).toHaveLength(events);
    // The sign-off frame and the socket's end are one departure.
    expect(bob.occupantChanges).toEqual([
      { roomId: LOBBY_ID, screenName: 'Alice', change: 'joined', occupants: ['Bob', 'Alice'] },
      { roomId: LOBBY_ID, screenName: 'Alice', change: 'left', occupants: ['Bob'] },
    ]);
    await expect(h.client.leaveRoom(LOBBY_ID)).resolves.toBeUndefined();
    expect(h.client.state).toBe('online');
  });

  it('leaving a room whose join is still running abandons the join', async () => {
    await h.signOn();
    const release = server.withhold(0x000e, 0x0003);
    try {
      const join = track(h.client.joinRoom(LOBBY));
      await waitFor(() => fromAlice().some((s) => s.conn === 'chat' && s.family === 0x01 && s.subtype === 0x02), 'the room sign-on');
      await h.client.leaveRoom(LOBBY_ID);
      await settled(join, 'the join');
      expect((join.error as RoomJoinError).reason).toBe('unavailable');
    } finally {
      release();
    }
    await waitFor(() => server.openConnections('Alice').length === 1, 'the room connection to close');
    expect(h.client.rooms()).toEqual([]);
    expect(h.rooms).toEqual([]);
  });

  it('refuses to join while not signed on', async () => {
    const error = await h.client.joinRoom(LOBBY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OscarError);
    expect((error as OscarError).info).toEqual({ kind: 'not-signed-on' });
    await settle(server.port);
    expect(fromAlice()).toEqual([]);
  });

  it('signing off closes every room connection', async () => {
    await h.signOn();
    await h.client.joinRoom(LOBBY);
    await h.client.joinRoom(DEV);
    expect(server.rooms.occupants(LOBBY)).toContain('alice');
    expect(server.rooms.occupants(DEV)).toContain('alice');
    await h.client.signOff();
    expect(h.client.rooms()).toEqual([]);
    await waitFor(() => server.openConnections('Alice').length === 0, 'every connection to end');
    expect(server.rooms.occupants(LOBBY)).not.toContain('alice');
    expect(server.rooms.occupants(DEV)).not.toContain('alice');
    // The server ends room connections with the session; how each ended on the client's side shows the client closed them.
    expect(closesOf('chat')).toEqual(['local', 'local']);
    expect(h.rooms.map((r) => r.state)).toEqual(['joined', 'joined']);
  });

  it('never logs a room name', async () => {
    await h.signOn();
    await h.client.joinRoom({ exchange: 4, name: 'Dev Room' });
    server.failNext(0x000d, 0x0008, { code: 0x0008 });
    expect(await failureOf(h.client.joinRoom({ exchange: 4, name: 'Other Room' }))).toBe('unavailable');
    // The client logged the failure, with its reason and exchange, and neither name is anywhere in the log.
    expect(h.logs.lines.filter((l) => l.msg === 'a room join failed').map((l) => [l.fields?.reason, l.fields?.exchange])).toEqual([['unavailable', 4]]);
    expect(h.logs.text().toLowerCase()).not.toContain('dev room');
    expect(h.logs.text().toLowerCase()).not.toContain('other room');
  });
});
