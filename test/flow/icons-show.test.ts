import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ICON_REQUEST_TIMEOUT_MS, memoryIconStore } from '../../src/client/icons.js';
import type { IconChange, IconStore } from '../../src/client/icons.js';
import { encodeBartDownload, encodeBartInfo, encodeBartUpload } from '../../src/wire/bart.js';
import { ByteReader, fromHex } from '../../src/wire/bytes.js';
import { BART_ICON_ITEM_NAME, FEEDBAG_ATTR_BART_INFO, FEEDBAG_CLASS_BART, encodeFeedbagItems } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { encodeUserInfo } from '../../src/wire/snac.js';
import { tlv } from '../../src/wire/tlv.js';
import { normalizeScreenName } from '../../src/model/screen-name.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, settle, waitFor } from '../fake/oscar-client.js';
import type { LogLine } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';
import { gifHeader } from '../support/images.js';
import { md5Hex, pngImage } from '../support/png.js';

const PNG = pngImage(8, 8);
const HEX = md5Hex(PNG);
const P2 = pngImage(9, 9);
const HEX2 = md5Hex(P2);
const CLEAR_HEX = '0201d20472';
const MULTI_SESSION = 0x01;
const BART_FOOD_GROUP = 0x0010;
const RECONNECT_DELAY_MS = 2_000;
const FAILURE = 'an icon download failed';

type CountedStore = IconStore & { gets: string[]; puts: string[]; removes: string[] };

function counted(inner: IconStore): CountedStore {
  const gets: string[] = [];
  const puts: string[] = [];
  const removes: string[] = [];
  return {
    gets,
    puts,
    removes,
    get: (hash) => {
      gets.push(hash);
      return inner.get(hash);
    },
    put: (hash, bytes) => {
      puts.push(hash);
      return inner.put(hash, bytes);
    },
    remove: (hash) => {
      removes.push(hash);
      return inner.remove(hash);
    },
  };
}

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let held: IconStore;
let store: CountedStore;
const raws: RawClient[] = [];

const buddies = (names: string[]): FeedbagItem[] =>
  withTypingPref([
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    ...names.map((name, i): FeedbagItem => ({ name, groupId: 1, itemId: i + 1, classId: 0, attrs: [] })),
  ]);

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
  fake.addUser('Carol', 'carolpw1');
  fake.setFeedbag('Alice', buddies(['bob', 'carol']));
  held = memoryIconStore();
  store = counted(held);
  h = makeClient(fake, { timers, random: () => 0, iconStore: store });
});

afterEach(async () => {
  for (const raw of raws.splice(0)) raw.close();
  await stopAllClients();
  await fake.stop();
});

const fromAlice = (family: number, subtype: number): SnacRecord[] =>
  fake.snacsFrom('Alice').filter((s) => s.family === family && s.subtype === subtype);
const downloads = (): SnacRecord[] => fromAlice(0x10, 0x04);
const iconEvents = (name: string): IconChange[] => h.icons.filter((change) => normalizeScreenName(change.screenName) === normalizeScreenName(name));
const failures = (): LogLine[] => h.logs.lines.filter((line) => line.level === 'warn' && line.msg === FAILURE);
const arrivals = (name: string): number => h.presence.filter((p) => normalizeScreenName(p.screenName) === name && p.online).length;

const shows = (name: string, hash: string | null): Promise<void> =>
  waitFor(() => h.client.iconOf(name) === hash, `${name} to show ${hash ?? 'no icon'}`);
const downloadCount = (count: number): Promise<void> => waitFor(() => downloads().length >= count, `download ${count}`);
const failureCount = (count: number): Promise<void> => waitFor(() => failures().length >= count, `failed download ${count}`);
const arrivalCount = (name: string, count: number): Promise<void> => waitFor(() => arrivals(name) >= count, `arrival ${count} of ${name}`);

async function signOn(...online: string[]): Promise<void> {
  await h.signOn();
  await waitFor(() => online.every((name) => h.client.presenceOf(name)?.online === true), 'the buddies to arrive');
}

async function bobShown(): Promise<void> {
  fake.peer('Bob').setIcon(PNG);
  await signOn('bob');
  await shows('bob', HEX);
}

async function quiet(): Promise<void> {
  await imRoundTrip(fake, h);
  await settle(fake.port);
}

async function reconnect(): Promise<void> {
  fake.dropSocket('Alice');
  await waitFor(() => h.client.state === 'reconnecting', 'the drop to be noticed');
  await timers.advance(RECONNECT_DELAY_MS);
  await waitFor(() => h.client.state === 'online', 'the client to be online again');
}

// An arrival of Bob in the form the server sends, with that value in TLV 0x1D.
function arrivalWith(bart: Uint8Array): Uint8Array {
  return encodeUserInfo({ name: 'Bob', warning: 0, tlvs: [tlv.u16(0x01, 0x0010), tlv.bytes(0x1d, bart)] });
}

const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

describe('showing icons', () => {
  it("downloads a buddy's icon once, caches it under its hash and reports it", async () => {
    await bobShown();
    await settle(fake.port);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: HEX });
    expect(h.client.iconOf('bob')).toBe(HEX);
    expect(await held.get(HEX)).toEqual(PNG);
    expect(downloads()).toHaveLength(1);
    expect(downloads()[0]?.conn).toBe('bos');
    expect(downloads()[0]?.body).toEqual(encodeBartDownload('Bob', { type: 1, flags: 0x01, hash: fromHex(HEX) }));
    // The server offers the icon service on the BOS connection: the client asks for no other connection.
    expect(fromAlice(0x01, 0x04).filter((s) => new ByteReader(s.body).u16() === BART_FOOD_GROUP)).toEqual([]);
  });

  it('uses the cached file and asks the server for nothing', async () => {
    await held.put(HEX, PNG);
    await bobShown();
    await quiet();
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: HEX });
    expect(downloads()).toEqual([]);
  });

  it('two buddies with one icon cost one download', async () => {
    fake.peer('Bob').setIcon(PNG);
    fake.peer('Carol').setIcon(PNG);
    await signOn('bob', 'carol');
    await shows('bob', HEX);
    await shows('carol', HEX);
    await quiet();
    expect(iconEvents('bob')).toEqual([{ screenName: 'Bob', hash: HEX }]);
    expect(iconEvents('carol')).toEqual([{ screenName: 'Carol', hash: HEX }]);
    expect(downloads()).toHaveLength(1);
  });

  it('never requests or caches the cleared hash, and a buddy who clears loses the icon', async () => {
    await bobShown();
    fake.peer('Bob').clearIcon();
    await shows('bob', null);
    await quiet();
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: null });
    expect(downloads()).toHaveLength(1);
    expect(store.gets).not.toContain(CLEAR_HEX);
    expect(store.puts).toEqual([HEX]);
    expect(await held.get(CLEAR_HEX)).toBeNull();
  });

  it('does not request an icon the server marks as not yet uploaded, and keeps what was shown', async () => {
    await bobShown();
    const events = h.icons.length;
    const before = arrivals('bob');
    fake.peer('Bob').setIconId({ flags: 0x01, hash: new Uint8Array(16).fill(0x77) });
    fake.peer('Bob').setIdle(3);
    await arrivalCount('bob', before + 1);
    await quiet();
    expect(h.client.iconOf('bob')).toBe(HEX);
    expect(downloads()).toHaveLength(1);
    expect(h.icons).toHaveLength(events);
  });

  it.each<[string, () => void]>([
    ['markup that is called an icon', () => fake.peer('Bob').setIcon(svg)],
    ['a PNG wider than 256 pixels', () => fake.peer('Bob').setIcon(pngImage(257, 2))],
    ['a GIF whose first frame is larger than its screen', () => fake.peer('Bob').setIcon(gifHeader(1, 1, { width: 400, height: 400 }))],
    [
      'a hash the server holds nothing under',
      () => {
        fake.setFeedbag('Bob', [iconItem(1, 0x01, new Uint8Array(16).fill(0xee))]);
        fake.peer('Bob');
      },
    ],
  ])('discards %s and caches nothing', async (_what, give) => {
    give();
    await signOn('bob');
    await downloadCount(1);
    await failureCount(1);
    await quiet();
    expect(downloads()).toHaveLength(1);
    expect(h.client.iconOf('bob')).toBeNull();
    expect(store.puts).toEqual([]);
    expect(iconEvents('bob').filter((change) => change.hash !== null)).toEqual([]);
  });

  it('asks again only when the hash changes or at the next sign-on', async () => {
    fake.peer('Bob').setIcon(svg);
    await signOn('bob');
    await failureCount(1);
    const before = arrivals('bob');
    fake.peer('Bob').setIdle(3);
    fake.peer('Bob').setIdle(null);
    await arrivalCount('bob', before + 2);
    await quiet();
    expect(downloads()).toHaveLength(1);

    await reconnect();
    await downloadCount(2);
    await failureCount(2);
    await quiet();
    expect(downloads()).toHaveLength(2);
    expect(h.client.iconOf('bob')).toBeNull();

    fake.peer('Bob').setIcon(PNG);
    await shows('bob', HEX);
    expect(downloads()).toHaveLength(3);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: HEX });
  });

  it('a download with no reply in 10 s fails, and the buddy shows no icon', async () => {
    fake.withhold(0x10, 0x05);
    fake.peer('Bob').setIcon(PNG);
    await signOn('bob');
    await downloadCount(1);
    expect(ICON_REQUEST_TIMEOUT_MS).toBe(10_000);
    await timers.advance(9_999);
    expect(iconEvents('bob')).toEqual([]);
    expect(h.client.iconOf('bob')).toBeNull();
    expect(failures()).toEqual([]);

    await timers.advance(1);
    expect(h.client.iconOf('bob')).toBeNull();
    expect(h.logs.lines.filter((line) => line.level === 'warn' && line.fields?.kind === 'timeout')).toEqual([
      { level: 'warn', msg: FAILURE, fields: { kind: 'timeout', bytes: 0 } },
    ]);

    const before = arrivals('bob');
    fake.peer('Bob').setIdle(3);
    await arrivalCount('bob', before + 1);
    await quiet();
    expect(downloads()).toHaveLength(1);
    expect(store.puts).toEqual([]);
  });

  it('keeps the icon shown while a new one downloads, and drops it when the new one fails', async () => {
    await bobShown();
    fake.withhold(0x10, 0x05);
    fake.peer('Bob').setIcon(P2);
    await downloadCount(2);
    expect(h.client.iconOf('bob')).toBe(HEX);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: HEX });

    await timers.advance(ICON_REQUEST_TIMEOUT_MS);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: null });
    expect(h.client.iconOf('bob')).toBeNull();
  });

  it('a download that finishes after the hash changed again shows nothing of the old one', async () => {
    const release = fake.withhold(0x10, 0x05);
    fake.peer('Bob').setIcon(PNG);
    await signOn('bob');
    await downloadCount(1);
    fake.peer('Bob').setIcon(P2);
    await downloadCount(2);
    release();
    await shows('bob', HEX2);
    await quiet();
    // The client read the first reply before the second: the old icon had its chance to show.
    expect(store.puts).toEqual([HEX, HEX2]);
    expect(h.icons).toEqual([{ screenName: 'Bob', hash: HEX2 }]);
  });

  async function aliceSetsIconElsewhere(): Promise<void> {
    await signOn();
    const raw = await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
    raws.push(raw);
    raw.snac(0x10, 0x02, 0x200, encodeBartUpload(1, PNG));
    raw.snac(0x13, 0x08, 0x201, encodeFeedbagItems([iconItem(50, 0x01, fromHex(HEX))]));
    await shows('alice', HEX);
  }

  it("the user's own icon comes from self info, also when another session sets it", async () => {
    await aliceSetsIconElsewhere();
    await settle(fake.port);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Alice', hash: HEX });
    expect(downloads()).toHaveLength(1);
    expect(downloads()[0]?.body).toEqual(encodeBartDownload('Alice', { type: 1, flags: 0x01, hash: fromHex(HEX) }));
  });

  it('a liveness reply that repeats the own icon asks for nothing', async () => {
    await aliceSetsIconElsewhere();
    const events = h.icons.length;
    fake.sendSelfInfo('Alice');
    fake.sendSelfInfo('Alice');
    fake.sendSelfInfo('Alice');
    await quiet();
    expect(downloads()).toHaveLength(1);
    expect(h.icons).toHaveLength(events);
    expect(store.gets).toEqual([HEX]);
  });

  it('a malformed icon list does not hide the arrival that carried it', async () => {
    fake.peer('Bob').signOff();
    await signOn();
    expect(h.client.presenceOf('bob')?.online ?? false).toBe(false);
    // An id that declares 16 hash bytes and holds one.
    fake.sendSnac('Alice', 0x03, 0x0b, arrivalWith(Uint8Array.of(0x00, 0x01, 0x01, 0x10, 0xaa)));
    await arrivalCount('bob', 1);
    await quiet();
    expect(h.presence.at(-1)).toMatchObject({ screenName: 'Bob', online: true });
    expect(h.client.iconOf('bob')).toBeNull();
    expect(downloads()).toEqual([]);
    expect(store.gets).toEqual([]);
    expect(h.logs.text()).not.toContain('skipped a SNAC');
  });

  it('ignores an icon whose hash is not 16 bytes', async () => {
    fake.peer('Bob').signOff();
    await signOn();
    const id = (hash: Uint8Array): Uint8Array => Uint8Array.of(0x00, 0x01, 0x01, hash.length, ...hash);
    fake.sendSnac('Alice', 0x03, 0x0b, arrivalWith(id(new Uint8Array(20).fill(0xab))));
    fake.sendSnac('Alice', 0x03, 0x0b, arrivalWith(id(Uint8Array.of(1, 2, 3, 4, 5))));
    await arrivalCount('bob', 2);
    await quiet();
    expect(h.client.iconOf('bob')).toBeNull();
    expect(downloads()).toEqual([]);
    expect(store.gets).toEqual([]);
    expect(h.icons).toEqual([]);
  });

  it('a cached file that no longer passes the checks is fetched again', async () => {
    await held.put(HEX, new TextEncoder().encode('not an image'));
    await bobShown();
    await settle(fake.port);
    expect(downloads()).toHaveLength(1);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: HEX });
    expect(await held.get(HEX)).toEqual(PNG);
  });

  it('an icon stays known for a buddy who signs off, and through a reconnect', async () => {
    await bobShown();
    const events = h.icons.length;
    fake.peer('Bob').signOff();
    await waitFor(() => h.client.presenceOf('bob')?.online === false, 'Bob to leave');
    await quiet();
    expect(h.client.iconOf('bob')).toBe(HEX);
    expect(h.icons).toHaveLength(events);

    fake.peer('Bob').signOn();
    await waitFor(() => h.client.presenceOf('bob')?.online === true, 'Bob to come back');
    fake.dropSocket('Alice');
    await waitFor(() => h.client.state === 'reconnecting', 'the drop to be noticed');
    expect(h.client.iconOf('bob')).toBe(HEX);
    await timers.advance(RECONNECT_DELAY_MS);
    await waitFor(() => h.client.state === 'online' && h.client.presenceOf('bob')?.online === true, 'Bob to arrive on the new connection');
    await quiet();
    expect(h.client.iconOf('bob')).toBe(HEX);
    expect(downloads()).toHaveLength(1);
    expect(h.icons).toHaveLength(events);
  });

  it('icons are forgotten when the session ends, and a download that finishes afterwards reports nothing', async () => {
    const release = fake.withhold(0x10, 0x05);
    fake.peer('Bob').setIcon(PNG);
    await signOn('bob');
    await downloadCount(1);
    await h.client.signOff();
    release();
    await settle(fake.port);
    expect(h.icons).toEqual([]);
    expect(h.client.iconOf('bob')).toBeNull();
    expect(store.puts).toEqual([]);

    await signOn('bob');
    await shows('bob', HEX);
    await h.client.signOff();
    expect(h.client.iconOf('bob')).toBeNull();
    // Forgotten, not cleared: the end of a session takes no icon off anybody.
    expect(h.icons).toEqual([{ screenName: 'Bob', hash: HEX }]);
  });

  it('an icon that could not be decoded is taken out of the cache and off the buddies, and is not asked for again', async () => {
    fake.peer('Bob').setIcon(PNG);
    fake.peer('Carol').setIcon(PNG);
    await signOn('bob', 'carol');
    await shows('bob', HEX);
    await shows('carol', HEX);
    const events = h.icons.length;

    await h.client.discardIcon(HEX);
    expect(await held.get(HEX)).toBeNull();
    const gained = h.icons.slice(events);
    expect(gained).toHaveLength(2);
    expect(gained).toEqual(expect.arrayContaining([{ screenName: 'Bob', hash: null }, { screenName: 'Carol', hash: null }]));
    expect(h.client.iconOf('bob')).toBeNull();
    expect(h.client.iconOf('carol')).toBeNull();
    expect(h.logs.lines.filter((line) => line.fields?.hash === HEX)).toHaveLength(1);
    expect(h.logs.text()).not.toMatch(/bob|carol/i);

    const before = arrivals('bob');
    const reads = store.gets.length;
    fake.peer('Bob').setIdle(3);
    await arrivalCount('bob', before + 1);
    await reconnect();
    await waitFor(() => ['bob', 'carol'].every((name) => h.client.presenceOf(name)?.online === true), 'the buddies to arrive again');
    await quiet();
    expect(downloads()).toHaveLength(1);
    expect(store.puts).toEqual([HEX]);
    expect(store.gets).toHaveLength(reads);
    expect(h.icons.slice(events).filter((change) => change.hash === HEX)).toEqual([]);
    expect(await held.get(HEX)).toBeNull();

    fake.peer('Bob').setIcon(P2);
    await shows('bob', HEX2);
    expect(downloads()).toHaveLength(2);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Bob', hash: HEX2 });

    await expect(h.client.discardIcon('../x')).resolves.toBeUndefined();
    expect(store.removes).toEqual([HEX]);
  });

  it('an icon whose reply the server cannot frame costs two connections at most, then the session stays online without it', async () => {
    // foodgroup/bart.go stores any upload; the reply to its download is longer than a FLAP frame can say.
    const big = new Uint8Array(65_510);
    big.set(PNG);
    const hex = fake.peer('Bob').setIcon(big);
    // The client asks for the icon as Bob arrives, before it reads sign-on's last reply. Its reply waits until the connection is
    // online: read with that last reply, it ends the sign-on itself, as unreachable.
    let release = fake.withhold(0x10, 0x05);
    await h.signOn();
    await downloadCount(1);
    release();
    await waitFor(() => h.client.state === 'reconnecting', 'the first drop');
    expect(h.logs.lines.some((line) => line.msg === 'the connection dropped' && line.fields?.close === 'error')).toBe(true);

    release = fake.withhold(0x10, 0x05);
    await timers.advance(RECONNECT_DELAY_MS);
    await downloadCount(2);
    await waitFor(() => h.client.state === 'online', 'the second connection');
    release();
    await waitFor(() => h.client.state === 'reconnecting', 'the second drop');

    await timers.advance(RECONNECT_DELAY_MS);
    await waitFor(() => h.client.state === 'online' && h.client.presenceOf('bob')?.online === true, 'Bob to arrive on the third connection');
    await quiet();
    expect(downloads()).toHaveLength(2);
    expect(h.client.state).toBe('online');
    expect(h.client.iconOf('bob')).toBeNull();
    expect(iconEvents('bob')).toEqual([]);
    expect(store.puts).toEqual([]);
    expect(h.logs.lines.filter((line) => line.msg === 'an icon is left alone: connections were lost while it was asked for').map((line) => line.fields)).toEqual([{ hash: hex }]);

    fake.peer('Bob').setIcon(PNG);
    await shows('bob', HEX);
    expect(downloads()).toHaveLength(3);
  });
});
