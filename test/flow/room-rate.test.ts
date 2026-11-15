import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomJoinError } from '../../src/client/errors.js';
import { OscarClient } from '../../src/client/oscar-client.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { roomConversationId } from '../../src/model/room.js';
import type { RoomId, RoomRate } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let timers: ManualTimers;
let server: FakeOscarServer;

const ROOM: RoomId = { exchange: 4, name: 'Lounge' };
const ROOM_ID = roomConversationId(ROOM);

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

async function signedOn(opts: Omit<Partial<OscarClientOptions>, 'now' | 'timers'> = {}): Promise<ClientHarness> {
  const h = makeClient(server, { ...opts, timers });
  await h.signOn();
  return h;
}

async function failureOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RoomJoinError);
  return error instanceof RoomJoinError ? error.reason : undefined;
}

describe('the roomRate event', () => {
  it('a limited notice on a room connection fires roomRate limited, and clear after', async () => {
    const h = await signedOn();
    const rates: RoomRate[] = [];
    h.client.on('roomRate', (rate) => rates.push(rate));
    await h.client.joinRoom(ROOM);
    server.rooms.setRoomRate('Alice', ROOM, 'limited');
    await waitFor(() => rates.length === 1, 'the limited notice');
    expect(rates).toEqual([{ roomId: ROOM_ID, status: 'limited' }]);
    server.rooms.setRoomRate('Alice', ROOM, 'clear');
    await waitFor(() => rates.length === 2, 'the clear notice');
    expect(rates).toEqual([
      { roomId: ROOM_ID, status: 'limited' },
      { roomId: ROOM_ID, status: 'clear' },
    ]);
  });

  it('a room rate change fires no BOS rate event', async () => {
    const h = await signedOn();
    const rates: RoomRate[] = [];
    h.client.on('roomRate', (rate) => rates.push(rate));
    await h.client.joinRoom(ROOM);
    server.rooms.setRoomRate('Alice', ROOM, 'limited');
    await waitFor(() => rates.length === 1, 'the limited notice');
    server.rooms.setRoomRate('Alice', ROOM, 'clear');
    await waitFor(() => rates.length === 2, 'the clear notice');
    await settle(server.port);
    expect(h.rates).toEqual([]);
  });

  it('a silent notice fires nothing', async () => {
    const h = await signedOn();
    const rates: RoomRate[] = [];
    h.client.on('roomRate', (rate) => rates.push(rate));
    await h.client.joinRoom(ROOM);
    server.rooms.setRoomRate('Alice', ROOM, 'limited', true);
    await settle(server.port);
    expect(rates).toEqual([]);
  });
});

describe('the maxRooms option', () => {
  const join = (h: ClientHarness, i: number): Promise<unknown> => h.client.joinRoom({ exchange: 4, name: `r${i}` });

  it('with maxRooms 12 the twelfth room joins and the thirteenth is refused room-limit', async () => {
    const h = await signedOn({ maxRooms: 12 });
    for (let i = 0; i < 12; i++) await join(h, i);
    expect(h.client.rooms().map((r) => r.state)).toEqual(Array.from({ length: 12 }, () => 'joined'));
    expect(await failureOf(join(h, 12))).toBe('room-limit');
  });

  it('with maxRooms 1 the second room is refused room-limit', async () => {
    const h = await signedOn({ maxRooms: 1 });
    await join(h, 0);
    expect(await failureOf(join(h, 1))).toBe('room-limit');
  });

  it('with no maxRooms the eleventh room is refused room-limit', async () => {
    const h = await signedOn();
    for (let i = 0; i < 10; i++) await join(h, i);
    expect(await failureOf(join(h, 10))).toBe('room-limit');
  });

  it.each([0, 2.5, -1, Number.NaN, Number.POSITIVE_INFINITY])('maxRooms %s throws a RangeError', (maxRooms) => {
    expect(() => new OscarClient({ maxRooms })).toThrow(RangeError);
  });
});
