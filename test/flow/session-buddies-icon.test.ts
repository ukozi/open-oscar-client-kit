import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ListWriteError, OscarError } from '../../src/client/errors.js';
import { ICON_REQUEST_TIMEOUT_MS, memoryIconStore } from '../../src/client/icons.js';
import type { IconStore } from '../../src/client/icons.js';
import { BART_CLEAR_HASH, encodeBartInfo, encodeBartUpload } from '../../src/wire/bart.js';
import { fromHex } from '../../src/wire/bytes.js';
import { BART_ICON_ITEM_NAME, FEEDBAG_ATTR_BART_INFO, FEEDBAG_CLASS_BART, encodeFeedbagItems } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { findTlv, tlv } from '../../src/wire/tlv.js';
import { imRoundTrip, makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';
import { OWN_ICON_JPEG, withJpegComment } from '../support/images.js';
import { md5Hex } from '../support/png.js';

const JPEG = OWN_ICON_JPEG;
const HEX = md5Hex(JPEG);
const J2 = withJpegComment(JPEG, 'two');
const HEX2 = md5Hex(J2);
const CLEAR_HEX = '0201d20472';
const MULTI_SESSION = 0x01;
const RECONNECT_DELAY_MS = 2_000;
const QUERY = 0x04;
const INSERT = 0x08;
const UPDATE = 0x09;
const RAW_ID = 0x7fff_0000;

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let held: IconStore;
const raws: RawClient[] = [];

// A list that another client of the account wrote. The client under test must leave each item as it is.
const stored = (extra: FeedbagItem[] = []): FeedbagItem[] => [
  { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
  { name: 'zed', groupId: 1, itemId: 1, classId: 0, attrs: [] },
  { name: 'yan', groupId: 1, itemId: 2, classId: 0, attrs: [] },
  ...extra,
];

const iconItem = (itemId: number, flags: number, hash: Uint8Array): FeedbagItem => ({
  name: BART_ICON_ITEM_NAME,
  groupId: 0,
  itemId,
  classId: FEEDBAG_CLASS_BART,
  attrs: [tlv.bytes(FEEDBAG_ATTR_BART_INFO, encodeBartInfo(flags, hash))],
});

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  fake.setFeedbag('Alice', stored());
  fake.peer('Bob').watch('Alice');
  held = memoryIconStore();
  h = makeClient(fake, { timers, random: () => 0, iconStore: held, sessionBuddies: () => ['Bob'] });
});

afterEach(async () => {
  for (const raw of raws.splice(0)) raw.close();
  await stopAllClients();
  await fake.stop();
});

const fromAlice = (family: number, subtype: number): SnacRecord[] =>
  fake.snacsFrom('Alice').filter((s) => s.family === family && s.subtype === subtype);
// The list SNACs of the account, without the writes of the raw session.
const listSnacs = (): number[] =>
  fake
    .snacsFrom('Alice')
    .filter((s) => s.family === 0x13 && s.requestId < RAW_ID)
    .map((s) => s.subtype);
const uploads = (): SnacRecord[] => fromAlice(0x10, 0x02);
const iconItems = (): FeedbagItem[] => fake.feedbagOf('Alice').filter((item) => item.classId === FEEDBAG_CLASS_BART);
const otherItems = (): FeedbagItem[] => fake.feedbagOf('Alice').filter((item) => item.classId !== FEEDBAG_CLASS_BART);
const bartInfo = (item: FeedbagItem | undefined): Uint8Array | undefined => (item ? findTlv(item.attrs, FEEDBAG_ATTR_BART_INFO) : undefined);
const lastSighting = (): unknown => fake.peer('Bob').sightings().at(-1);

async function signOn(): Promise<void> {
  await h.signOn();
  await waitFor(() => h.client.presenceOf('bob')?.online === true, 'Bob to arrive');
}

async function quiet(): Promise<void> {
  await imRoundTrip(fake, h);
  await settle(fake.port);
}

const outcomeOf = (pending: Promise<void>): Promise<unknown> =>
  pending.then(
    () => null,
    (error: unknown) => error,
  );
const infoOf = (error: unknown): unknown => (error instanceof OscarError ? error.info : error);

async function reconnect(): Promise<void> {
  fake.dropSocket('Alice');
  await waitFor(() => h.client.state === 'reconnecting', 'the drop to be noticed');
  await timers.advance(RECONNECT_DELAY_MS);
  await waitFor(() => h.client.state === 'online' && h.client.presenceOf('bob')?.online === true, 'the client to be online again');
}

// The client holds no list: one empty list event for each connect, an empty buddyList, and the items of other clients as they were.
function expectNoListState(connects = 1): void {
  expect(h.lists).toHaveLength(connects);
  expect(h.lists.flatMap((list) => list.groups)).toEqual([]);
  expect(h.client.buddyList().groups).toEqual([]);
  expect(h.client.buddyList().privacy).toMatchObject({ allow: [], block: [] });
  expect(otherItems()).toEqual(stored());
}

describe('the own icon with sessionBuddies', () => {
  it('sets an icon with one list query, one insert of the icon item and one upload, and a watcher sees the icon', async () => {
    await signOn();
    expect(listSnacs()).toEqual([]);

    await expect(h.client.setOwnIcon(JPEG)).resolves.toBeUndefined();
    await quiet();

    // No rights query (0x02) and no activation (0x07): the list stays out of use.
    expect(listSnacs()).toEqual([QUERY, INSERT]);
    expect(iconItems()).toHaveLength(1);
    expect(iconItems()[0]).toMatchObject({ name: '1', groupId: 0 });
    expect(bartInfo(iconItems()[0])).toEqual(Uint8Array.of(0x01, 0x10, ...fromHex(HEX)));
    // An id that no item of the list has, in any group: the server keys an item by group id and item id.
    expect(stored().map((item) => item.itemId)).not.toContain(iconItems()[0]?.itemId);
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0]?.body).toEqual(encodeBartUpload(1, JPEG));
    expect(fake.bartBlob(HEX)).toEqual(JPEG);
    expect(fake.iconOf('Alice')).toEqual({ type: 1, flags: 0x01, hash: fromHex(HEX) });
    expect(lastSighting()).toMatchObject({ name: 'Alice', event: 'arrived', icon: HEX });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(h.icons).toContainEqual({ screenName: 'Alice', hash: HEX });
    expect(await held.get(HEX)).toEqual(JPEG);
    expectNoListState();
    expect(fake.sessionBuddiesOf('alice')).toEqual(['bob']);
  });

  it('updates the icon item that the list holds, with its id', async () => {
    fake.setFeedbag('Alice', stored([iconItem(50, 0x01, fromHex(HEX2))]));
    await signOn();

    await h.client.setOwnIcon(JPEG);
    await quiet();

    expect(listSnacs()).toEqual([QUERY, UPDATE]);
    expect(iconItems()).toHaveLength(1);
    expect(iconItems()[0]?.itemId).toBe(50);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x01, fromHex(HEX)));
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: HEX });
    expectNoListState();
  });

  it('a second set with the same bytes costs one query and one update, with no upload', async () => {
    await signOn();
    await h.client.setOwnIcon(JPEG);
    await quiet();
    const events = h.icons.length;

    await expect(h.client.setOwnIcon(JPEG)).resolves.toBeUndefined();
    await quiet();

    expect(listSnacs()).toEqual([QUERY, INSERT, QUERY, UPDATE]);
    expect(uploads()).toHaveLength(1);
    expect(iconItems()).toHaveLength(1);
    expect(h.icons).toHaveLength(events);
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: HEX });
    expectNoListState();
  });

  it('clearOwnIcon updates the item to the cleared hash, and the watcher sees no icon', async () => {
    await signOn();
    await h.client.setOwnIcon(JPEG);
    await quiet();

    await expect(h.client.clearOwnIcon()).resolves.toBeUndefined();
    await quiet();

    expect(listSnacs()).toEqual([QUERY, INSERT, QUERY, UPDATE]);
    expect(iconItems()).toHaveLength(1);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x00, BART_CLEAR_HASH));
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: CLEAR_HEX });
    expect(h.client.iconOf('Alice')).toBeNull();
    expect(h.icons.at(-1)).toEqual({ screenName: 'Alice', hash: null });
    expectNoListState();
  });

  it('clearOwnIcon with no icon item sends the query and no write', async () => {
    await signOn();

    await expect(h.client.clearOwnIcon()).resolves.toBeUndefined();
    await quiet();

    expect(listSnacs()).toEqual([QUERY]);
    expect(iconItems()).toEqual([]);
    expect(h.icons).toEqual([]);
    expectNoListState();
  });

  it('bytes that are no icon reject invalid-argument, and a second set while one runs rejects busy, with no query for either', async () => {
    await signOn();
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(Uint8Array.of(1, 2, 3))))).toEqual({ kind: 'local', code: 'invalid-argument' });
    expect(listSnacs()).toEqual([]);

    const first = h.client.setOwnIcon(JPEG);
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(J2)))).toEqual({ kind: 'local', code: 'busy' });
    expect(infoOf(await outcomeOf(h.client.clearOwnIcon()))).toEqual({ kind: 'local', code: 'busy' });
    await first;
    await quiet();
    expect(listSnacs()).toEqual([QUERY, INSERT]);
  });

  it('a refused list query rejects the set, and nothing is written, uploaded or cached', async () => {
    await signOn();
    fake.failNext(0x13, QUERY, { code: 0x05 });

    expect(infoOf(await outcomeOf(h.client.setOwnIcon(JPEG)))).toEqual({ kind: 'refused', code: 0x05 });
    await quiet();

    expect(listSnacs()).toEqual([QUERY]);
    expect(iconItems()).toEqual([]);
    expect(uploads()).toEqual([]);
    expect(await held.get(HEX)).toBeNull();
    expect(h.client.iconOf('Alice')).toBeNull();

    // The next call asks again.
    await h.client.setOwnIcon(JPEG);
    expect(listSnacs()).toEqual([QUERY, QUERY, INSERT]);
  });

  it('a refused item write rejects the set as a list write, and nothing is uploaded', async () => {
    await signOn();
    fake.failNext(0x13, INSERT, { code: 0x0e });

    const error = await outcomeOf(h.client.setOwnIcon(JPEG));
    await quiet();

    expect(error).toBeInstanceOf(ListWriteError);
    expect(infoOf(error)).toEqual({ kind: 'refused', code: 0x0e });
    expect(iconItems()).toEqual([]);
    expect(uploads()).toEqual([]);
    expect(await held.get(HEX)).toBeNull();
    expectNoListState();
  });

  it('a refused upload writes the previous icon back to the item', async () => {
    await signOn();
    await h.client.setOwnIcon(JPEG);
    await quiet();
    fake.refuseNextUpload(4);

    expect(infoOf(await outcomeOf(h.client.setOwnIcon(J2)))).toEqual({ kind: 'refused', code: 4 });
    await quiet();

    // One query serves the write and the write back.
    expect(listSnacs()).toEqual([QUERY, INSERT, QUERY, UPDATE, UPDATE]);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x01, fromHex(HEX)));
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: HEX });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expectNoListState();
  });

  it('after a reconnect the server still shows the icon, and the client writes nothing to the list', async () => {
    await signOn();
    await h.client.setOwnIcon(JPEG);
    await quiet();
    const sent = listSnacs().length;
    const sentUploads = uploads().length;

    await reconnect();
    await quiet();

    expect(listSnacs()).toHaveLength(sent);
    expect(uploads()).toHaveLength(sentUploads);
    expect(fake.iconOf('Alice')).toEqual({ type: 1, flags: 0x01, hash: fromHex(HEX) });
    expect(lastSighting()).toMatchObject({ name: 'Alice', event: 'arrived', icon: HEX });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expectNoListState(2);
  });

  it('a set cut short by a lost connection is undone on the next connection with one more query', async () => {
    await signOn();
    await h.client.setOwnIcon(JPEG);
    await quiet();
    const release = fake.withhold(0x01, 0x21);
    const outcome = outcomeOf(h.client.setOwnIcon(J2));
    await waitFor(() => bartInfo(iconItems()[0])?.join() === encodeBartInfo(0x01, fromHex(HEX2)).join(), 'the icon item to be stored');
    await quiet();

    fake.dropSocket('Alice');
    expect(infoOf(await outcome)).toEqual({ kind: 'connection-lost' });
    release();
    await waitFor(() => h.client.state === 'reconnecting', 'the drop to be noticed');
    await timers.advance(RECONNECT_DELAY_MS);
    await waitFor(() => h.client.state === 'online', 'the client to be online again');
    await waitFor(() => bartInfo(iconItems()[0])?.join() === encodeBartInfo(0x01, fromHex(HEX)).join(), 'the previous icon to be written back');
    await quiet();

    expect(listSnacs()).toEqual([QUERY, INSERT, QUERY, UPDATE, QUERY, UPDATE]);
    expect(uploads()).toHaveLength(1);
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: HEX });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expectNoListState(2);
  });

  it('a set whose notice never comes leaves alone an icon that another session wrote in the meantime', async () => {
    await signOn();
    await h.client.setOwnIcon(JPEG);
    await quiet();
    const raw = await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
    raws.push(raw);
    const id = iconItems()[0]?.itemId ?? 0;
    const from = listSnacs().length;
    fake.withhold(0x01, 0x21);
    const outcome = outcomeOf(h.client.setOwnIcon(J2));
    await waitFor(() => bartInfo(iconItems()[0])?.join() === encodeBartInfo(0x01, fromHex(HEX2)).join(), 'the icon item to be stored');
    await quiet();

    raw.snac(0x13, UPDATE, RAW_ID, encodeFeedbagItems([iconItem(id, 0x00, BART_CLEAR_HASH)]));
    await waitFor(() => bartInfo(iconItems()[0])?.join() === encodeBartInfo(0x00, BART_CLEAR_HASH).join(), 'the write of the other session');
    await quiet();
    await timers.advance(ICON_REQUEST_TIMEOUT_MS);
    expect(infoOf(await outcome)).toMatchObject({ kind: 'timeout' });
    await quiet();

    // The copy of the list took the write of the other session: no write back went out.
    expect(listSnacs().slice(from)).toEqual([QUERY, UPDATE]);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x00, BART_CLEAR_HASH));
    expectNoListState();
  });

  it('setOwnIcon and clearOwnIcon reject not-signed-on while offline', async () => {
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(JPEG)))).toEqual({ kind: 'not-signed-on' });
    expect(infoOf(await outcomeOf(h.client.clearOwnIcon()))).toEqual({ kind: 'not-signed-on' });
  });

  it('the list item of another client that changes while no set runs changes nothing in the client', async () => {
    await signOn();
    const raw = await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
    raws.push(raw);
    raw.snac(0x13, INSERT, RAW_ID, encodeFeedbagItems([{ name: 'wes', groupId: 1, itemId: 7, classId: 0, attrs: [] }]));
    await waitFor(() => fake.feedbagOf('Alice').some((item) => item.name === 'wes'), 'the write of the other session');
    await quiet();

    expect(h.lists).toHaveLength(1);
    expect(h.client.buddyList().groups).toEqual([]);
    expect(listSnacs().filter((subtype) => subtype !== 0x07)).toEqual([]);
  });
});
