import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryIconStore } from '../../src/client/icons.js';
import type { IconChange, IconsFrom } from '../../src/client/icons.js';
import { BART_FLAG_CUSTOM, BART_TYPE_BUDDY_ICON, encodeBartId } from '../../src/wire/bart.js';
import { ByteWriter, fromHex } from '../../src/wire/bytes.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { encodeUserInfo } from '../../src/wire/snac.js';
import { tlv } from '../../src/wire/tlv.js';
import type { RoomRef } from '../../src/wire/types.js';
import { normalizeScreenName } from '../../src/model/screen-name.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { OWN_ICON_JPEG } from '../support/images.js';
import { md5Hex, pngImage } from '../support/png.js';

const PNG = pngImage(8, 8);
const HEX = md5Hex(PNG);
const P2 = pngImage(9, 9);
const HEX2 = md5Hex(P2);
const OWN_HEX = md5Hex(OWN_ICON_JPEG);
const RECONNECT_DELAY_MS = 2_000;
const ROOM: RoomRef = { exchange: 4, name: 'Lobby' };

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
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('Alice', buddies(['bob']));
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

async function start(iconsFrom?: IconsFrom): Promise<void> {
  h = makeClient(fake, { timers, random: () => 0, iconStore: memoryIconStore(), ...(iconsFrom ? { iconsFrom } : {}) });
  await h.signOn();
}

const downloads = (): number => fake.snacsFrom('Alice').filter((s) => s.family === 0x10 && s.subtype === 0x04).length;
const iconEvents = (name: string): IconChange[] => h.icons.filter((change) => normalizeScreenName(change.screenName) === name);
const shows = (name: string, hash: string): Promise<void> => waitFor(() => h.client.iconOf(name) === hash, `${name} to show ${hash}`);

async function imFrom(name: string, icon?: Uint8Array): Promise<void> {
  const peer = fake.peer(name);
  if (icon) peer.setIcon(icon);
  const before = h.ims.length;
  peer.sendIm('Alice', 'hello');
  await waitFor(() => h.ims.length > before, `an IM from ${name}`);
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

describe('icons from everyone', () => {
  it('learns the icon of a sender not on the list from an IM', async () => {
    await start('everyone');
    await imFrom('carol', PNG);
    await shows('carol', HEX);
    await settle(fake.port);
    expect(h.icons).toEqual([{ screenName: 'carol', hash: HEX }]);
    expect(downloads()).toBe(1);
    expect(h.client.iconOf('carol')).toBe(HEX);
  });

  it('learns the icon of someone not on the list from Get Info', async () => {
    await start('everyone');
    fake.peer('carol').setIcon(PNG);
    await h.client.getInfo('carol');
    await shows('carol', HEX);
    await settle(fake.port);
    expect(h.icons).toEqual([{ screenName: 'carol', hash: HEX }]);
    expect(downloads()).toBe(1);
  });

  it('by default, neither an IM nor Get Info teaches an icon', async () => {
    await start();
    await imFrom('carol', PNG);
    await h.client.getInfo('carol');
    await quiet();
    expect(downloads()).toBe(0);
    expect(iconEvents('carol')).toEqual([]);
    expect(h.client.iconOf('carol')).toBeNull();
  });

  it('can change while online and stops new downloads at once', async () => {
    await start();
    h.client.setIconsFrom('everyone');
    await imFrom('carol', PNG);
    await shows('carol', HEX);
    h.client.setIconsFrom('buddies');
    await imFrom('dave', P2);
    await quiet();
    expect(downloads()).toBe(1);
    expect(iconEvents('dave')).toEqual([]);
    expect(h.client.iconOf('dave')).toBeNull();
  });

  it('holds a choice made while online across a reconnect', async () => {
    await start();
    h.client.setIconsFrom('everyone');
    await reconnect();
    await imFrom('carol', PNG);
    await shows('carol', HEX);
    expect(iconEvents('carol')).toEqual([{ screenName: 'carol', hash: HEX }]);
  });

  it('holds the option across a reconnect', async () => {
    await start('everyone');
    await reconnect();
    await imFrom('carol', PNG);
    await shows('carol', HEX);
  });

  it.each<IconsFrom>(['buddies', 'everyone'])("a buddy's icon and the user's own work as before with %s", async (from) => {
    fake.peer('bob').setIcon(PNG);
    await start(from);
    await shows('bob', HEX);
    await h.client.setOwnIcon(OWN_ICON_JPEG);
    await shows('alice', OWN_HEX);
    await imFrom('bob');
    await quiet();
    expect(h.client.iconOf('bob')).toBe(HEX);
    expect(h.client.iconOf('alice')).toBe(OWN_HEX);
  });

  it('a stored IM, whose sender block is bare, keeps the icon known for its sender', async () => {
    fake.peer('bob').setIcon(PNG);
    fake.storeOffline('Alice', 'bob', 'while you were out', 1_790_000_000);
    await start('everyone');
    await shows('bob', HEX);
    await waitFor(() => h.ims.some((im) => im.offline), 'the stored IM');
    await quiet();
    expect(h.client.iconOf('bob')).toBe(HEX);
    expect(iconEvents('bob')).toEqual([{ screenName: 'bob', hash: HEX }]);
  });

  it('a live IM with no icon id drops the icon known for its sender', async () => {
    await start('everyone');
    await imFrom('carol', PNG);
    await shows('carol', HEX);
    const sender = encodeUserInfo({ name: 'carol', warning: 0, tlvs: [tlv.u16(0x01, 0x0010)] });
    fake.sendSnac('Alice', 0x04, 0x07, new ByteWriter().u64(1n).u16(1).bytes(sender).toBytes());
    await waitFor(() => h.client.iconOf('carol') === null, 'the icon to go');
  });
});

describe('icons from room user info', () => {
  const idOf = (hex: string): Uint8Array => encodeBartId({ type: BART_TYPE_BUDDY_ICON, flags: BART_FLAG_CUSTOM, hash: fromHex(hex) });

  it("learns an occupant's icon from the first roster and from a later join", async () => {
    fake.peer('carol').setIcon(PNG);
    fake.rooms.setChatIcon('carol', idOf(HEX));
    fake.rooms.peerJoin('carol', ROOM);
    await start('everyone');
    await h.client.joinRoom(ROOM);
    await shows('carol', HEX);
    fake.peer('dave').setIcon(P2);
    fake.rooms.setChatIcon('dave', idOf(HEX2));
    fake.rooms.peerJoin('dave', ROOM);
    await shows('dave', HEX2);
  });

  it("learns the icon of a line's sender", async () => {
    fake.peer('carol').setIcon(PNG);
    fake.rooms.peerJoin('carol', ROOM);
    await start('everyone');
    await h.client.joinRoom(ROOM);
    await settle(fake.port);
    expect(h.client.iconOf('carol')).toBeNull();
    fake.rooms.setChatIcon('carol', idOf(HEX));
    fake.rooms.peerSay('carol', ROOM, 'hello');
    await shows('carol', HEX);
  });

  it('teaches nothing by default', async () => {
    fake.peer('carol').setIcon(PNG);
    fake.rooms.setChatIcon('carol', idOf(HEX));
    fake.rooms.peerJoin('carol', ROOM);
    await start();
    await h.client.joinRoom(ROOM);
    fake.rooms.peerSay('carol', ROOM, 'hello');
    await quiet();
    expect(downloads()).toBe(0);
    expect(iconEvents('carol')).toEqual([]);
  });

  it('an occupant with no icon id keeps the icon known from an IM', async () => {
    await start('everyone');
    await imFrom('carol', PNG);
    await shows('carol', HEX);
    await h.client.joinRoom(ROOM);
    fake.rooms.peerJoin('carol', ROOM);
    fake.rooms.peerSay('carol', ROOM, 'hello');
    await quiet();
    await settle(fake.port);
    expect(h.client.iconOf('carol')).toBe(HEX);
    expect(iconEvents('carol')).toEqual([{ screenName: 'carol', hash: HEX }]);
  });

  it("skips the user's own name: the own icon keeps its own path", async () => {
    await start('everyone');
    fake.peer('carol').setIcon(PNG);
    fake.rooms.setChatIcon('Alice', idOf(HEX));
    await h.client.joinRoom(ROOM);
    await quiet();
    expect(downloads()).toBe(0);
    expect(h.client.iconOf('alice')).toBeNull();
  });
});
