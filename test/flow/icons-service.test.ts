import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ICON_REQUEST_TIMEOUT_MS, memoryIconStore } from '../../src/client/icons.js';
import { ByteReader } from '../../src/wire/bytes.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import type { LogLine } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';
import { OWN_ICON_JPEG } from '../support/images.js';
import { md5Hex, pngImage } from '../support/png.js';

const PNG = pngImage(8, 8);
const HEX = md5Hex(PNG);
const P2 = pngImage(9, 9);
const HEX2 = md5Hex(P2);
const OWN_HEX = md5Hex(OWN_ICON_JPEG);
const BART_FOOD_GROUP = 0x0010;
// The server's default host online without the icon service.
const HOST_ONLINE_WITHOUT_ICONS = [0x0018, 0x0003, 0x0013, 0x0004, 0x0015, 0x0002, 0x0001, 0x0009, 0x000a, 0x0006, 0x0008, 0x000b];
const FAILURE = 'an icon download failed';
const NOT_OPENED = 'the icon connection could not be opened';

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

const buddies = (names: string[]): FeedbagItem[] =>
  withTypingPref([
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    ...names.map((name, i): FeedbagItem => ({ name, groupId: 1, itemId: i + 1, classId: 0, attrs: [] })),
  ]);

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, hostOnline: HOST_ONLINE_WITHOUT_ICONS });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  fake.addUser('Carol', 'carolpw1');
  fake.setFeedbag('Alice', buddies(['bob', 'carol']));
  h = makeClient(fake, { timers, random: () => 0, iconStore: memoryIconStore() });
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const is = (family: number, subtype: number) => (s: SnacRecord): boolean => s.family === family && s.subtype === subtype;
const bartSnacs = (): SnacRecord[] => fake.snacsFrom('Alice').filter((s) => s.family === 0x10);
const onBart = (): SnacRecord[] => fake.snacsFrom('Alice').filter((s) => s.conn === 'bart');
const downloads = (): SnacRecord[] => bartSnacs().filter(is(0x10, 0x04));
const iconServiceRequests = (): SnacRecord[] =>
  fake.snacsFrom('Alice').filter((s) => is(0x01, 0x04)(s) && new ByteReader(s.body).u16() === BART_FOOD_GROUP);
const warnings = (msg: string): LogLine[] => h.logs.lines.filter((line) => line.level === 'warn' && line.msg === msg);

function u16Groups(body: Uint8Array, size: number): number[][] {
  const r = new ByteReader(body);
  const groups: number[][] = [];
  while (r.remaining >= size * 2) groups.push(Array.from({ length: size }, () => r.u16()));
  expect(r.remaining).toBe(0);
  return groups;
}

const shows = (name: string, hash: string | null): Promise<void> =>
  waitFor(() => h.client.iconOf(name) === hash, `${name} to show ${hash ?? 'no icon'}`);

async function signOn(...online: string[]): Promise<void> {
  await h.signOn();
  await waitFor(() => online.every((name) => h.client.presenceOf(name)?.online === true), 'the buddies to arrive');
}

describe('icons over an icon service connection', () => {
  it('asks for an icon connection when BOS does not list the icon service, and downloads over it', async () => {
    fake.peer('Bob').setIcon(PNG);
    await signOn('bob');
    await shows('bob', HEX);
    await settle(fake.port);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: HEX });

    expect(downloads()).toHaveLength(1);
    expect(bartSnacs().map((s) => s.conn)).toEqual(['bart']);
    expect(iconServiceRequests().map((s) => s.conn)).toEqual(['bos']);
    expect(fake.openConnections('Alice')).toEqual(['bart', 'bos']);

    const announcedOnBos = fake.snacsFrom('Alice').filter((s) => s.conn === 'bos' && is(0x01, 0x17)(s));
    expect(announcedOnBos).toHaveLength(1);
    const bosPairs = u16Groups(announcedOnBos[0]?.body ?? new Uint8Array(0), 2);
    expect(bosPairs.length).toBeGreaterThan(0);
    expect(bosPairs.filter(([family]) => family === BART_FOOD_GROUP)).toEqual([]);

    // The client announces the icon connection before it uses it: versions, then online, then the download.
    const service = onBart();
    expect(service.map((s) => [s.family, s.subtype])).toEqual([
      [0x01, 0x17],
      [0x01, 0x02],
      [0x10, 0x04],
    ]);
    expect(u16Groups(service[0]?.body ?? new Uint8Array(0), 2)).toEqual([
      [0x0001, 1],
      [0x0010, 1],
    ]);
    const online = u16Groups(service[1]?.body ?? new Uint8Array(0), 4);
    expect(online.map(([family, version]) => [family, version])).toEqual([
      [0x0001, 1],
      [0x0010, 1],
    ]);
  });

  it('announces the negotiated OService version on an icon connection', async () => {
    h = makeClient(fake, { timers, random: () => 0, iconStore: memoryIconStore(), oserviceVersion: 4 });
    fake.peer('Bob').setIcon(PNG);
    await signOn('bob');
    await shows('bob', HEX);
    const versions = onBart().find(is(0x01, 0x17));
    expect(u16Groups(versions?.body ?? new Uint8Array(0), 2)).toEqual([
      [0x0001, 4],
      [0x0010, 1],
    ]);
    expect(fake.oserviceVersionOf('Alice', 0)).toBe(4);
  });

  it('opens one icon connection for many requests', async () => {
    fake.peer('Bob').setIcon(PNG);
    fake.peer('Carol').setIcon(P2);
    await signOn('bob', 'carol');
    await shows('bob', HEX);
    await shows('carol', HEX2);
    await settle(fake.port);
    expect(h.icons).toEqual(expect.arrayContaining([{ screenName: 'Bob', hash: HEX }, { screenName: 'Carol', hash: HEX2 }]));
    expect(downloads().map((s) => s.conn)).toEqual(['bart', 'bart']);
    expect(iconServiceRequests()).toHaveLength(1);
    expect(fake.openConnections('Alice')).toEqual(['bart', 'bos']);
  });

  it('sets the own icon over the icon connection while the notice arrives on BOS', async () => {
    await signOn();
    await expect(h.client.setOwnIcon(OWN_ICON_JPEG)).resolves.toBeUndefined();
    const uploads = fake.snacsFrom('Alice').filter(is(0x10, 0x02));
    expect(uploads.map((s) => s.conn)).toEqual(['bart']);
    expect(fake.bartBlob(OWN_HEX)).toEqual(OWN_ICON_JPEG);
    expect(h.client.iconOf('Alice')).toBe(OWN_HEX);
  });

  it('a sign-off on the icon connection fails what was pending and ends no session', async () => {
    const release = fake.withhold(0x10, 0x05);
    fake.peer('Bob').setIcon(PNG);
    await signOn('bob');
    await waitFor(() => downloads().length === 1, 'the download to be written');
    const states = h.states.length;

    fake.signOffBart('Alice');
    await waitFor(() => warnings(FAILURE).length === 1, 'the pending download to fail');
    await settle(fake.port);
    expect(warnings(FAILURE)[0]?.fields).toEqual({ kind: 'connection-lost', bytes: 0 });
    expect(h.client.state).toBe('online');
    expect(h.states).toHaveLength(states);
    expect(h.client.iconOf('bob')).toBeNull();
    expect(h.icons).toEqual([]);
    expect(fake.openConnections('Alice')).toEqual(['bos']);

    release();
    fake.peer('Bob').setIcon(P2);
    await shows('bob', HEX2);
    expect(h.icons).toEqual([{ screenName: 'Bob', hash: HEX2 }]);
    expect(iconServiceRequests()).toHaveLength(2);
    expect(downloads().map((s) => s.conn)).toEqual(['bart', 'bart']);
    expect(h.client.state).toBe('online');
    expect(h.states).toHaveLength(states);
  });

  it('a refused icon service request fails the download, and the next hash change asks again', async () => {
    fake.failNext(0x01, 0x04, { code: 0x05 });
    fake.peer('Bob').setIcon(PNG);
    await signOn('bob');
    await waitFor(() => warnings(FAILURE).length === 1, 'the download to fail');
    await settle(fake.port);
    expect(warnings(FAILURE)[0]?.fields).toEqual({ kind: 'connection-lost', bytes: 0 });
    expect(warnings(NOT_OPENED).map((line) => line.fields)).toEqual([{ kind: 'OscarRoomError', code: 'unavailable' }]);
    expect(h.client.iconOf('bob')).toBeNull();
    expect(bartSnacs()).toEqual([]);
    expect(iconServiceRequests()).toHaveLength(1);
    expect(h.client.state).toBe('online');

    fake.peer('Bob').setIcon(P2);
    await shows('bob', HEX2);
    expect(h.icons).toEqual([{ screenName: 'Bob', hash: HEX2 }]);
    expect(iconServiceRequests()).toHaveLength(2);
  });

  it('an icon connection that does not answer the announcement fails the download and is closed', async () => {
    fake.peer('Bob');
    await signOn('bob');
    fake.withhold(0x01, 0x18);
    fake.peer('Bob').setIcon(PNG);
    await waitFor(() => onBart().some(is(0x01, 0x17)), 'the announcement to be written');
    expect(fake.openConnections('Alice')).toEqual(['bart', 'bos']);
    await timers.advance(ICON_REQUEST_TIMEOUT_MS - 1);
    expect(warnings(FAILURE)).toEqual([]);

    await timers.advance(1);
    await waitFor(() => warnings(FAILURE).length === 1, 'the download to fail');
    await waitFor(() => fake.openConnections('Alice').length === 1, 'the icon connection to close');
    expect(warnings(NOT_OPENED).map((line) => line.fields)).toEqual([{ kind: 'RequestTimeoutError' }]);
    expect(h.client.iconOf('bob')).toBeNull();
    expect(bartSnacs()).toEqual([]);
    // Client online is never written on a connection whose versions were not answered.
    expect(onBart().map((s) => [s.family, s.subtype])).toEqual([[0x01, 0x17]]);
    expect(fake.openConnections('Alice')).toEqual(['bos']);
    expect(h.client.state).toBe('online');
  });
});
