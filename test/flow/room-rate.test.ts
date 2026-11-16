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

describe('the paceMarginMs option', () => {
  const imsRead = (): number => server.snacsFrom('alice').filter((s) => s.family === 0x04 && s.subtype === 0x06).length;

  // Class 3 of BOS has a window of 20 and an alert level of 5000. Three IMs leave 5144, and the wait is 20 * (5000 + margin) - 19 * 5144.
  it.each([
    ['no option', 2924, {}],
    ['0 ms', 2664, { paceMarginMs: 0 }],
    ['1000 ms', 3664, { paceMarginMs: 1000 }],
  ])('with %s the fourth IM of a burst waits %i ms', async (_name, wait, opts) => {
    server.peer('Bob');
    const h = await signedOn(opts);
    for (let i = 0; i < 4; i++) void h.client.sendIm('Bob', [{ text: `message ${i}` }]).catch(() => {});
    await waitFor(() => imsRead() === 3, 'the first three IMs');
    await timers.advance(wait - 1);
    await settle(server.port);
    expect(imsRead()).toBe(3);
    await timers.advance(1);
    await waitFor(() => imsRead() === 4, 'the fourth IM');
  });

  // The room class has a window of 80 and a clear level of 3000. The limit notice has level 1499, and the wait is 80 * (3000 + margin) - 79 * 1499.
  it.each([
    ['no option', 128_299, {}],
    ['0 ms', 127_979, { paceMarginMs: 0 }],
    ['1000 ms', 129_019, { paceMarginMs: 1000 }],
  ])('with %s a room message after a limit notice waits %i ms', async (_name, wait, opts) => {
    const h = await signedOn(opts);
    const rates: RoomRate[] = [];
    h.client.on('roomRate', (rate) => rates.push(rate));
    await h.client.joinRoom(ROOM);
    server.rooms.setRoomRate('Alice', ROOM, 'limited');
    await waitFor(() => rates.length === 1, 'the limited notice');
    const before = timers.pending();
    void h.client.sendRoomMessage(ROOM_ID, [{ text: 'held' }]).catch(() => {});
    await waitFor(() => timers.pending().length > before.length, 'the wait of the room');
    expect(timers.pending().filter((ms) => !before.includes(ms))).toEqual([wait]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('paceMarginMs %s throws a RangeError', (paceMarginMs) => {
    expect(() => new OscarClient({ paceMarginMs })).toThrow(RangeError);
  });

  it('paceMarginMs 0 is taken', () => {
    expect(() => new OscarClient({ paceMarginMs: 0 })).not.toThrow();
  });
});
