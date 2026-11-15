import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ListWriteError, OscarError } from '../../src/client/errors.js';
import { ICON_REQUEST_TIMEOUT_MS, memoryIconStore } from '../../src/client/icons.js';
import type { IconChange, IconStore } from '../../src/client/icons.js';
import { BART_CLEAR_HASH, encodeBartId, encodeBartInfo, encodeBartUpload } from '../../src/wire/bart.js';
import { ByteReader, fromHex } from '../../src/wire/bytes.js';
import { BART_ICON_ITEM_NAME, FEEDBAG_ATTR_BART_INFO, FEEDBAG_CLASS_BART, encodeFeedbagItems, readFeedbagItem } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { findTlv, tlv } from '../../src/wire/tlv.js';
import { normalizeScreenName } from '../../src/model/screen-name.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';
import { OWN_ICON_JPEG, animatedGif, gifHeader, jpegHeader, paddedGif, withJpegComment } from '../support/images.js';
import { md5Hex, pngImage } from '../support/png.js';
import { bytesOf, loadVectors } from '../support/vectors.js';

const JPEG = OWN_ICON_JPEG;
const HEX = md5Hex(JPEG);
const J2 = withJpegComment(JPEG, 'two');
const HEX2 = md5Hex(J2);
const CLEAR_HEX = '0201d20472';
const MULTI_SESSION = 0x01;
const RECONNECT_DELAY_MS = 2_000;
const WRITES = [0x08, 0x09, 0x0a];

type CountedStore = IconStore & { puts: string[]; holdPuts(): () => void };

// A write counts once it is done; `holdPuts` keeps writes from finishing until the test calls the function it returns.
function counted(inner: IconStore): CountedStore {
  const puts: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  return {
    puts,
    holdPuts: () => {
      let open = (): void => {};
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return open;
    },
    get: (hash) => inner.get(hash),
    put: async (hash, bytes) => {
      await gate;
      await inner.put(hash, bytes);
      puts.push(hash);
    },
    remove: (hash) => inner.remove(hash),
  };
}

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let held: IconStore;
let store: CountedStore;
const raws: RawClient[] = [];

// The typing preference under an id of its own: the icon item of the vectors is item 9 of group 0.
const typingPref = (): FeedbagItem => {
  const pref = withTypingPref([])[0];
  if (!pref) throw new Error('no preference item');
  return { ...pref, itemId: 20 };
};

const list = (extra: FeedbagItem[] = []): FeedbagItem[] => [
  { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
  { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] },
  { name: 'carol', groupId: 1, itemId: 2, classId: 0, attrs: [] },
  typingPref(),
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
  fake.addUser('Carol', 'carolpw1');
  fake.setFeedbag('Alice', list());
  fake.peer('Bob').watch('Alice');
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
const uploads = (): SnacRecord[] => fromAlice(0x10, 0x02);
const downloads = (): SnacRecord[] => fromAlice(0x10, 0x04);
const listWrites = (): SnacRecord[] => fake.snacsFrom('Alice').filter((s) => s.family === 0x13 && WRITES.includes(s.subtype));
const iconItems = (): FeedbagItem[] => fake.feedbagOf('Alice').filter((item) => item.classId === FEEDBAG_CLASS_BART);
const iconEvents = (name: string): IconChange[] => h.icons.filter((change) => normalizeScreenName(change.screenName) === normalizeScreenName(name));
const bartInfo = (item: FeedbagItem | undefined): Uint8Array | undefined => (item ? findTlv(item.attrs, FEEDBAG_ATTR_BART_INFO) : undefined);
const lastSighting = (): unknown => fake.peer('Bob').sightings().at(-1);

function itemsOf(record: SnacRecord): FeedbagItem[] {
  const r = new ByteReader(record.body);
  const items: FeedbagItem[] = [];
  while (r.remaining > 0) items.push(readFeedbagItem(r));
  return items;
}

const iconWrites = (subtype: number): FeedbagItem[] =>
  fromAlice(0x13, subtype)
    .flatMap(itemsOf)
    .filter((item) => item.classId === FEEDBAG_CLASS_BART);

async function signOn(): Promise<void> {
  await h.signOn();
  await waitFor(() => h.client.presenceOf('bob')?.online === true, 'Bob to arrive');
}

async function quiet(): Promise<void> {
  await imRoundTrip(fake, h);
  await settle(fake.port);
}

async function iconSet(): Promise<void> {
  await signOn();
  await h.client.setOwnIcon(JPEG);
  await quiet();
}

// The server confirmed the item write of a running set, and the client read the confirmation and the self info that followed it.
async function writeConfirmed(lists: number, hex: string): Promise<void> {
  await waitFor(() => iconItems().some((item) => bartInfo(item)?.join() === encodeBartInfo(0x01, fromHex(hex)).join()), 'the icon item to be stored');
  await waitFor(() => h.lists.length > lists, 'the confirmation to be read');
  await quiet();
}

const outcomeOf = (pending: Promise<void>): Promise<unknown> =>
  pending.then(
    () => null,
    (error: unknown) => error,
  );

async function reconnect(): Promise<void> {
  fake.dropSocket('Alice');
  await waitFor(() => h.client.state === 'reconnecting', 'the drop to be noticed');
  await timers.advance(RECONNECT_DELAY_MS);
  await waitFor(() => h.client.state === 'online' && h.client.presenceOf('bob')?.online === true, 'the client to be online again');
}

const infoOf = (error: unknown): unknown => (error instanceof OscarError ? error.info : error);

describe('the own icon', () => {
  it('sets an icon the server lacks: cached first, then the item with its MD5, then the upload, reported once confirmed', async () => {
    await signOn();
    let cachedAtWrite: boolean | null = null;
    fake.onSnacHook = (snac) => {
      if (snac.family === 0x13 && snac.subtype === 0x08 && itemsOf(snac).some((item) => item.classId === FEEDBAG_CLASS_BART)) {
        cachedAtWrite = store.puts.includes(HEX);
      }
    };

    // While the file is not written yet, the item is not either.
    const finishPut = store.holdPuts();
    const pending = h.client.setOwnIcon(JPEG);
    await quiet();
    expect(listWrites()).toEqual([]);
    finishPut();
    await expect(pending).resolves.toBeUndefined();
    await quiet();

    expect(cachedAtWrite).toBe(true);
    expect(iconItems()).toHaveLength(1);
    expect(iconItems()[0]).toMatchObject({ name: '1', groupId: 0 });
    expect(bartInfo(iconItems()[0])).toEqual(Uint8Array.of(0x01, 0x10, ...fromHex(HEX)));
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0]?.body).toEqual(encodeBartUpload(1, JPEG));
    expect(fake.bartBlob(HEX)).toEqual(JPEG);
    expect(fake.iconOf('Alice')?.flags).toBe(0x01);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Alice', hash: HEX });
    expect(iconEvents('Alice')).toHaveLength(1);
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(lastSighting()).toMatchObject({ name: 'Alice', event: 'arrived', icon: HEX });
  });

  it('sets an animated GIF that fits byte for byte: the item carries its MD5, the server holds it and so does the cache', async () => {
    await signOn();
    const wave = animatedGif([220, 30, 30], [30, 30, 220], 10);
    const hex = md5Hex(wave);
    await expect(h.client.setOwnIcon(wave)).resolves.toBeUndefined();
    await quiet();

    expect(bartInfo(iconItems()[0])).toEqual(Uint8Array.of(0x01, 0x10, ...fromHex(hex)));
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0]?.body).toEqual(encodeBartUpload(1, wave));
    expect(fake.bartBlob(hex)).toEqual(wave);
    expect(await held.get(hex)).toEqual(wave);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Alice', hash: hex });
  });

  it('updates the item when the list holds one, keeping its id and its other attributes', async () => {
    const seeded = readFeedbagItem(
      new ByteReader(bytesOf(loadVectors('hand-icons.json'), 'feedbag item, icon item 9 with another attribute before the icon')),
    );
    fake.setFeedbag('Alice', list([seeded]));
    await signOn();

    await h.client.setOwnIcon(JPEG);

    expect(iconItems()).toHaveLength(1);
    expect(iconItems()[0]?.itemId).toBe(9);
    expect(iconItems()[0]?.attrs.map((attr) => attr.tag)).toEqual([0x0131, 0x00d5]);
    expect(iconItems()[0]?.attrs[0]).toEqual(seeded.attrs[0]);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x01, fromHex(HEX)));
    expect(iconWrites(0x09).map((item) => item.itemId)).toEqual([9]);
    expect(iconWrites(0x08)).toEqual([]);
    expect(fake.feedbagOf('Alice')).toHaveLength(list([seeded]).length);
  });

  it('the server already holds the icon: no upload, and the icon is set at the notice', async () => {
    fake.peer('Carol').setIcon(JPEG);
    await signOn();

    await h.client.setOwnIcon(JPEG);
    await quiet();

    expect(uploads()).toEqual([]);
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(fake.iconOf('Alice')).toEqual({ type: 1, flags: 0x01, hash: fromHex(HEX) });
  });

  it('the previous icon stays reported until the upload is confirmed', async () => {
    await iconSet();
    const events = h.icons.length;
    const lists = h.lists.length;
    const release = fake.withhold(0x01, 0x21);

    const pending = h.client.setOwnIcon(J2);
    await writeConfirmed(lists, HEX2);
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(h.icons).toHaveLength(events);
    expect(uploads()).toHaveLength(1);

    release();
    await pending;
    expect(h.client.iconOf('Alice')).toBe(HEX2);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Alice', hash: HEX2 });
    expect(fake.bartBlob(HEX2)).toEqual(J2);
  });

  it("the notice read before the write's confirmation still counts", async () => {
    await signOn();
    const lists = h.lists.length;
    const release = fake.withhold(0x13, 0x0e);

    const pending = h.client.setOwnIcon(JPEG);
    await waitFor(() => uploads().length === 1, 'the upload');
    await quiet();
    expect(h.lists).toHaveLength(lists);

    release();
    await pending;
    expect(uploads()).toHaveLength(1);
    expect(h.client.iconOf('Alice')).toBe(HEX);
  });

  it('fails as a timeout when the notice does not come within 10 s of the confirmed write', async () => {
    await signOn();
    const lists = h.lists.length;
    fake.withhold(0x01, 0x21);
    let settled = false;

    const pending = h.client.setOwnIcon(JPEG);
    const outcome = outcomeOf(pending).finally(() => {
      settled = true;
    });
    // The item write's own 10 s are over: what runs now is the wait for the notice.
    await writeConfirmed(lists, HEX);

    await timers.advance(ICON_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await timers.advance(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(OscarError);
    expect(error).not.toBeInstanceOf(ListWriteError);
    expect(infoOf(error)).toMatchObject({ kind: 'timeout' });
    expect(uploads()).toEqual([]);
    expect(h.client.iconOf('Alice')).toBeNull();
    expect(await held.get(HEX)).toBeNull();
  });

  it('fails when the upload is refused, and as a timeout when it gets no reply in 10 s', async () => {
    await signOn();

    fake.refuseNextUpload(4);
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(JPEG)))).toEqual({ kind: 'refused', code: 4 });
    await quiet();
    expect(uploads()).toHaveLength(1);
    expect(iconEvents('Alice')).toEqual([]);

    fake.failNext(0x10, 0x02, { code: 0x0e });
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(JPEG)))).toEqual({ kind: 'refused', code: 0x0e });
    await quiet();
    expect(uploads()).toHaveLength(2);
    expect(iconEvents('Alice')).toEqual([]);

    fake.withhold(0x10, 0x03);
    const outcome = outcomeOf(h.client.setOwnIcon(JPEG));
    await waitFor(() => uploads().length === 3, 'the third upload');
    await waitFor(() => h.client.iconOf('Alice') === HEX, 'the self info that names the icon');
    await timers.advance(ICON_REQUEST_TIMEOUT_MS - 1);
    await timers.advance(1);
    expect(infoOf(await outcome)).toMatchObject({ kind: 'timeout' });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(await held.get(HEX)).toEqual(JPEG);
  });

  it('a refused item write fails the set as a list write and nothing is uploaded', async () => {
    await signOn();
    fake.failNext(0x13, 0x08, { code: 0x0e });

    const error = await outcomeOf(h.client.setOwnIcon(JPEG));
    await quiet();

    expect(error).toBeInstanceOf(ListWriteError);
    expect(infoOf(error)).toEqual({ kind: 'refused', code: 0x0e });
    expect(iconItems()).toEqual([]);
    expect(uploads()).toEqual([]);
    expect(await held.get(HEX)).toBeNull();
  });

  it('a failed first upload leaves no cached file and no icon on the item, and a later sign-on asks for nothing', async () => {
    await signOn();
    fake.refuseNextUpload(4);
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(JPEG)))).toEqual({ kind: 'refused', code: 4 });
    expect(store.puts).toEqual([HEX]);
    expect(await held.get(HEX)).toBeNull();
    // The item the set made stays, and names no icon: the server was never given the bytes of the hash.
    expect(iconItems()).toHaveLength(1);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x00, BART_CLEAR_HASH));

    await reconnect();
    expect(fake.iconOf('Alice')).toEqual({ type: 1, flags: 0x00, hash: BART_CLEAR_HASH });
    await quiet();
    expect(downloads()).toEqual([]);
    expect(h.logs.lines.filter((line) => line.level === 'warn' && line.msg !== 'the connection dropped')).toEqual([]);
    expect(h.client.iconOf('Alice')).toBeNull();
    expect(iconEvents('Alice')).toEqual([]);
  });

  it('a refused upload restores the previous icon, for the user and for a buddy at the next sign-on', async () => {
    await iconSet();
    fake.refuseNextUpload(4);

    expect(infoOf(await outcomeOf(h.client.setOwnIcon(J2)))).toEqual({ kind: 'refused', code: 4 });
    await quiet();

    expect(uploads()).toHaveLength(2);
    expect(iconItems()).toHaveLength(1);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x01, fromHex(HEX)));
    // The server holds the bytes of the previous icon: it names it again and asks for no upload.
    expect(fake.iconOf('Alice')).toEqual({ type: 1, flags: 0x01, hash: fromHex(HEX) });
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: HEX });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(await held.get(HEX2)).toBeNull();

    await reconnect();
    await quiet();
    expect(fake.iconOf('Alice')).toEqual({ type: 1, flags: 0x01, hash: fromHex(HEX) });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: HEX });
    expect(downloads()).toEqual([]);
    expect(iconEvents('Alice').map((change) => change.hash)).toEqual([HEX]);
  });

  it('a set whose notice never comes writes the previous icon back to the item', async () => {
    await iconSet();
    const lists = h.lists.length;
    fake.withhold(0x01, 0x21);
    const outcome = outcomeOf(h.client.setOwnIcon(J2));
    await writeConfirmed(lists, HEX2);

    await timers.advance(ICON_REQUEST_TIMEOUT_MS);
    expect(infoOf(await outcome)).toMatchObject({ kind: 'timeout' });
    await quiet();

    expect(uploads()).toHaveLength(1);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x01, fromHex(HEX)));
    expect(fake.iconOf('Alice')).toEqual({ type: 1, flags: 0x01, hash: fromHex(HEX) });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(iconEvents('Alice').map((change) => change.hash)).toEqual([HEX]);
    // The write-back's own notice, when it comes, is nobody's: no set waits for it.
    expect(h.logs.lines.filter((line) => line.level === 'warn')).toEqual([]);
  });

  it('a set cut short by a lost connection is undone on the next connection: the previous icon stays shown and is written back', async () => {
    await iconSet();
    const lists = h.lists.length;
    const release = fake.withhold(0x01, 0x21);
    const outcome = outcomeOf(h.client.setOwnIcon(J2));
    await writeConfirmed(lists, HEX2);

    fake.dropSocket('Alice');
    expect(infoOf(await outcome)).toEqual({ kind: 'connection-lost' });
    release();
    await waitFor(() => h.client.state === 'reconnecting', 'the drop to be noticed');
    await timers.advance(RECONNECT_DELAY_MS);
    await waitFor(() => h.client.state === 'online', 'the client to be online again');
    await waitFor(() => bartInfo(iconItems()[0])?.join() === encodeBartInfo(0x01, fromHex(HEX)).join(), 'the previous icon to be written back');
    await quiet();

    expect(fake.iconOf('Alice')).toEqual({ type: 1, flags: 0x01, hash: fromHex(HEX) });
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: HEX });
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(downloads()).toEqual([]);
    expect(uploads()).toHaveLength(1);
    expect(iconEvents('Alice').map((change) => change.hash)).toEqual([HEX]);
  });

  it('a set that fails again after a lost connection still goes back to the icon before both', async () => {
    await iconSet();
    const lists = h.lists.length;
    const release = fake.withhold(0x01, 0x21);
    const outcome = outcomeOf(h.client.setOwnIcon(J2));
    await writeConfirmed(lists, HEX2);
    fake.dropSocket('Alice');
    expect(infoOf(await outcome)).toEqual({ kind: 'connection-lost' });
    release();
    await waitFor(() => h.client.state === 'reconnecting', 'the drop to be noticed');
    await timers.advance(RECONNECT_DELAY_MS);
    await waitFor(() => h.client.state === 'online', 'the client to be online again');

    fake.refuseNextUpload(4);
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(J2)))).toEqual({ kind: 'refused', code: 4 });
    await quiet();

    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x01, fromHex(HEX)));
    expect(h.client.iconOf('Alice')).toBe(HEX);
    expect(iconEvents('Alice').map((change) => change.hash)).toEqual([HEX]);
  });

  it('a file that was cached before a failed set stays cached', async () => {
    await held.put(HEX, JPEG);
    await signOn();
    fake.refuseNextUpload(4);

    expect(infoOf(await outcomeOf(h.client.setOwnIcon(JPEG)))).toEqual({ kind: 'refused', code: 4 });

    expect(await held.get(HEX)).toEqual(JPEG);
  });

  it('uploads when the server asks for a hash whose file is cached, also outside a set, and does nothing for one that is not', async () => {
    await held.put(HEX, JPEG);
    await signOn();
    const notice = (flags: number, hash: Uint8Array): void => fake.sendSnac('Alice', 0x01, 0x21, encodeBartId({ type: 1, flags, hash }));

    notice(0x41, fromHex(HEX));
    await waitFor(() => uploads().length === 1, 'the upload');
    await quiet();
    expect(uploads().map((upload) => upload.body)).toEqual([encodeBartUpload(1, JPEG)]);
    expect(fake.bartBlob(HEX)).toEqual(JPEG);

    notice(0x41, new Uint8Array(16).fill(0x55));
    await quiet();
    expect(uploads()).toHaveLength(1);

    notice(0x01, fromHex(HEX));
    await quiet();
    expect(uploads()).toHaveLength(1);
    expect(h.logs.lines.filter((line) => line.level === 'warn')).toEqual([]);
  });

  it('clears by updating the item to the cleared hash, never by deleting it', async () => {
    await iconSet();

    await h.client.clearOwnIcon();
    await quiet();

    expect(iconItems()).toHaveLength(1);
    expect(bartInfo(iconItems()[0])).toEqual(Uint8Array.of(0x00, 0x05, 0x02, 0x01, 0xd2, 0x04, 0x72));
    expect(fromAlice(0x13, 0x0a)).toEqual([]);
    expect(iconWrites(0x09)).toHaveLength(1);
    expect(uploads()).toHaveLength(1);
    expect(h.icons.at(-1)).toEqual({ screenName: 'Alice', hash: null });
    expect(iconEvents('Alice').map((change) => change.hash)).toEqual([HEX, null]);
    expect(h.client.iconOf('Alice')).toBeNull();
    expect(lastSighting()).toMatchObject({ name: 'Alice', icon: CLEAR_HEX });
    expect(await held.get(HEX)).toEqual(JPEG);
  });

  it('clearing with no icon item sends nothing and succeeds', async () => {
    await signOn();
    await quiet();
    const sent = fake.snacsFrom('Alice').length;

    await expect(h.client.clearOwnIcon()).resolves.toBeUndefined();
    await settle(fake.port);

    expect(listWrites()).toEqual([]);
    expect(fake.snacsFrom('Alice')).toHaveLength(sent);
    expect(iconItems()).toEqual([]);
    expect(h.icons).toEqual([]);
  });

  it.each<[string, () => Uint8Array]>([
    ['a PNG', () => pngImage(48, 48)],
    ['a JPEG of 64 by 64', () => jpegHeader(64, 64)],
    [
      'a JPEG of 7,169 bytes',
      () => {
        const bytes = new Uint8Array(7_169);
        bytes.set(jpegHeader(48, 48));
        return bytes;
      },
    ],
    ['an empty file', () => new Uint8Array(0)],
    ['an animated GIF of 7,169 bytes', () => paddedGif(animatedGif([220, 30, 30], [30, 30, 220], 10), 7_169)],
    ['a GIF of 65 × 64', () => gifHeader(65, 64, { width: 65, height: 64 })],
  ])('refuses %s before anything is cached or sent', async (_what, make) => {
    await signOn();
    await quiet();
    const sent = fake.snacsFrom('Alice').length;

    expect(infoOf(await outcomeOf(h.client.setOwnIcon(make())))).toEqual({ kind: 'local', code: 'invalid-argument' });
    await settle(fake.port);

    expect(store.puts).toEqual([]);
    expect(fake.snacsFrom('Alice')).toHaveLength(sent);
  });

  it('a second set or a clear while one is running is refused as busy', async () => {
    await signOn();
    const lists = h.lists.length;
    const release = fake.withhold(0x01, 0x21);
    const first = h.client.setOwnIcon(JPEG);
    await writeConfirmed(lists, HEX);

    expect(infoOf(await outcomeOf(h.client.setOwnIcon(J2)))).toEqual({ kind: 'local', code: 'busy' });
    expect(infoOf(await outcomeOf(h.client.clearOwnIcon()))).toEqual({ kind: 'local', code: 'busy' });
    expect(iconWrites(0x08)).toHaveLength(1);
    expect(iconWrites(0x09)).toEqual([]);

    release();
    await first;
    expect(h.client.iconOf('Alice')).toBe(HEX);
    await h.client.setOwnIcon(J2);
    expect(h.client.iconOf('Alice')).toBe(HEX2);
  });

  it('a set cut short by a lost connection fails and leaves no file', async () => {
    await signOn();
    const lists = h.lists.length;
    fake.withhold(0x01, 0x21);
    const outcome = outcomeOf(h.client.setOwnIcon(JPEG));
    await writeConfirmed(lists, HEX);
    expect(await held.get(HEX)).toEqual(JPEG);

    fake.dropSocket('Alice');

    const error = await outcome;
    expect(error).not.toBeInstanceOf(ListWriteError);
    expect(infoOf(error)).toEqual({ kind: 'connection-lost' });
    expect(await held.get(HEX)).toBeNull();
  });

  it('setOwnIcon and clearOwnIcon are refused when not signed on', async () => {
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(JPEG)))).toEqual({ kind: 'not-signed-on' });
    expect(infoOf(await outcomeOf(h.client.clearOwnIcon()))).toEqual({ kind: 'not-signed-on' });
    expect(store.puts).toEqual([]);

    await signOn();
    await h.client.signOff();
    expect(infoOf(await outcomeOf(h.client.setOwnIcon(JPEG)))).toEqual({ kind: 'not-signed-on' });
    expect(infoOf(await outcomeOf(h.client.clearOwnIcon()))).toEqual({ kind: 'not-signed-on' });
  });

  it('an icon another session sets or clears is applied to the list and shown', async () => {
    await signOn();
    const groups = h.client.buddyList().groups;
    const raw = await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
    raws.push(raw);

    raw.snac(0x10, 0x02, 0x200, encodeBartUpload(1, JPEG));
    raw.snac(0x13, 0x08, 0x201, encodeFeedbagItems([iconItem(50, 0x01, fromHex(HEX))]));
    await waitFor(() => h.client.iconOf('Alice') === HEX, 'the icon of the other session');
    raw.snac(0x13, 0x09, 0x202, encodeFeedbagItems([iconItem(50, 0x00, BART_CLEAR_HASH)]));
    await waitFor(() => h.client.iconOf('Alice') === null, 'the icon to be cleared');
    await quiet();

    expect(groups.map((group) => group.buddies.length)).toEqual([2]);
    expect(h.client.buddyList().groups).toEqual(groups);
    expect(iconEvents('Alice').map((change) => change.hash)).toEqual([HEX, null]);

    await h.client.setOwnIcon(J2);
    expect(iconItems()).toHaveLength(1);
    expect(iconItems()[0]?.itemId).toBe(50);
    expect(bartInfo(iconItems()[0])).toEqual(encodeBartInfo(0x01, fromHex(HEX2)));
    expect(iconWrites(0x08)).toHaveLength(1);
    expect(iconWrites(0x09).map((item) => [item.itemId, bartInfo(item)])).toEqual([
      [50, encodeBartInfo(0x00, BART_CLEAR_HASH)],
      [50, encodeBartInfo(0x01, fromHex(HEX2))],
    ]);
  });
});
