import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryIconStore } from '../../src/client/icons.js';
import { SignOnError } from '../../src/client/errors.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { md5Hex, pngImage } from '../support/png.js';

const ICON = pngImage(8, 8);
const ICON_HASH = md5Hex(ICON);
const ADVERTISED = 'oscar.example.invalid:5190';
// BOS without the icon service, so icons need a connection of their own.
const HOST_ONLINE_WITHOUT_ICONS = [0x0018, 0x0003, 0x0013, 0x0004, 0x0015, 0x0002, 0x0001, 0x0009, 0x000a, 0x0006, 0x0008, 0x000b];

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

const buddies = (names: string[]): FeedbagItem[] =>
  withTypingPref([
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    ...names.map((name, i): FeedbagItem => ({ name, groupId: 1, itemId: i + 1, classId: 0, attrs: [] })),
  ]);

// A port nothing listens on: one a test server held and gave back.
async function closedPort(): Promise<number> {
  const gone = await FakeOscarServer.start();
  const port = gone.port;
  await gone.stop();
  return port;
}

async function start(opts: Parameters<typeof FakeOscarServer.start>[0]): Promise<void> {
  fake = await FakeOscarServer.start({ now: timers.now, hostOnline: HOST_ONLINE_WITHOUT_ICONS, ...opts });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  fake.setFeedbag('Alice', buddies(['bob']));
}

beforeEach(() => {
  timers = new ManualTimers();
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe('pinned redirects', () => {
  it('pins BOS, ChatNav, Chat and BART to the configured address', async () => {
    await start({ advertisedHost: ADVERTISED, serviceHost: ADVERTISED });
    const bob = fake.peer('Bob');
    h = makeClient(fake, { timers, iconStore: memoryIconStore(), pinRedirects: { host: '127.0.0.1', port: fake.port } });
    await h.signOn();
    expect((await h.client.joinRoom({ exchange: 4, name: 'pinned' })).state).toBe('joined');
    const hash = bob.setIcon(ICON);
    expect(hash).toBe(ICON_HASH);
    await waitFor(() => h.client.iconOf('bob') === hash, "Bob's icon");
    expect(fake.openConnections('alice')).toEqual(['bart', 'bos', 'chat']);
  });

  it('pins the Admin service connection', async () => {
    await start({ advertisedHost: ADVERTISED, serviceHost: ADVERTISED });
    h = makeClient(fake, { timers, pinRedirects: { host: '127.0.0.1', port: fake.port } });
    await h.signOn();
    await h.client.accountEmail();
    expect(fake.snacsFrom('alice').some((snac) => snac.conn === 'admin')).toBe(true);
  });

  it('pins the directory connection', async () => {
    await start({ advertisedHost: ADVERTISED, serviceHost: ADVERTISED });
    h = makeClient(fake, { timers, pinRedirects: { host: '127.0.0.1', port: fake.port } });
    await h.signOn();
    await h.client.directoryKeywords();
    expect(fake.snacsFrom('alice').some((snac) => snac.conn === 'odir')).toBe(true);
  });

  it('without a pin, follows the advertised host and fails', async () => {
    await start({ advertisedHost: `127.0.0.1:${await closedPort()}` });
    h = makeClient(fake, { timers });
    const error = await h.signOn().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignOnError);
    expect((error as SignOnError).failure).toEqual({ kind: 'unreachable' });
  });
});
