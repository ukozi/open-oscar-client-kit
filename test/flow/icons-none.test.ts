import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryIconStore } from '../../src/client/icons.js';
import type { IconsFrom } from '../../src/client/icons.js';
import { ByteReader } from '../../src/wire/bytes.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';
import { md5Hex, pngImage } from '../support/png.js';

const PNG = pngImage(8, 8);
const HEX = md5Hex(PNG);
const P2 = pngImage(9, 9);
const BART_FOOD_GROUP = 0x0010;
// The server's default host online without the icon service, so that an icon needs a service request.
const HOST_ONLINE_WITHOUT_ICONS = [0x0018, 0x0003, 0x0013, 0x0004, 0x0015, 0x0002, 0x0001, 0x0009, 0x000a, 0x0006, 0x0008, 0x000b];

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
  fake.setFeedbag('Alice', buddies(['bob', 'carol']));
  fake.peer('Bob').setIcon(PNG);
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

function start(iconsFrom?: IconsFrom): void {
  h = makeClient(fake, { timers, iconStore: memoryIconStore(), ...(iconsFrom ? { iconsFrom } : {}) });
}

const iconServiceRequests = (): SnacRecord[] =>
  fake.snacsFrom('Alice').filter((s) => s.family === 0x01 && s.subtype === 0x04 && new ByteReader(s.body).u16() === BART_FOOD_GROUP);
const bartSnacs = (): SnacRecord[] => fake.snacsFrom('Alice').filter((s) => s.family === BART_FOOD_GROUP);

describe("iconsFrom 'none'", () => {
  it('an arrival that names an icon asks for no icon service and iconOf is null', async () => {
    start('none');
    await h.signOn();
    await waitFor(() => h.presence.some((p) => p.screenName === 'Bob' && p.online), 'the arrival of Bob');
    fake.peer('Carol').setIcon(P2);
    await waitFor(() => h.presence.some((p) => p.screenName === 'Carol' && p.online), 'the arrival of Carol');
    fake.peer('Bob').sendIm('Alice', 'hello');
    await waitFor(() => h.ims.length === 1, 'the IM of Bob');
    await settle(fake.port);
    expect(iconServiceRequests()).toEqual([]);
    expect(bartSnacs()).toEqual([]);
    expect(h.client.iconOf('bob')).toBeNull();
    expect(h.client.iconOf('carol')).toBeNull();
    expect(h.icons).toEqual([]);
  });

  it("setIconsFrom('none') stops the client learning icons, and iconOf is then null", async () => {
    start();
    await h.signOn();
    await waitFor(() => h.client.iconOf('bob') === HEX, 'the icon of bob');
    const requests = iconServiceRequests().length;
    const downloads = bartSnacs().filter((s) => s.subtype === 0x04).length;
    h.client.setIconsFrom('none');
    expect(h.client.iconOf('bob')).toBeNull();
    fake.peer('Carol').setIcon(P2);
    await waitFor(() => h.presence.some((p) => p.screenName === 'Carol' && p.online), 'the arrival of Carol');
    await settle(fake.port);
    expect(iconServiceRequests()).toHaveLength(requests);
    expect(bartSnacs().filter((s) => s.subtype === 0x04)).toHaveLength(downloads);
    expect(h.client.iconOf('carol')).toBeNull();
  });

  it('the default still asks for it', async () => {
    start();
    await h.signOn();
    await waitFor(() => h.client.iconOf('bob') === HEX, 'the icon of bob');
    expect(iconServiceRequests()).toHaveLength(1);
    expect(bartSnacs().filter((s) => s.subtype === 0x04)).toHaveLength(1);
    expect(h.icons).toContainEqual({ screenName: 'Bob', hash: HEX });
  });
});
