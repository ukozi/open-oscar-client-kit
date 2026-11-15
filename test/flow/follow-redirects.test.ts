import { afterEach, describe, expect, it } from 'vitest';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { FAMILY_CHATNAV } from '../../src/wire/constants.js';
import type { RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { StartOptions } from '../fake/oscar-server.js';

const ROOM: RoomId = { exchange: 4, name: 'Far Room' };
const ALICE = { screenName: 'Alice', password: 'alicepw1' };
// A connect to the address 0.0.0.0 reaches this host, and the address is not a loopback address.
const ANY = '0.0.0.0';
const LOOPBACK = '127.0.0.1';

type Options = Omit<Partial<OscarClientOptions>, 'now' | 'timers'>;

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

async function start(options: (port: number) => StartOptions, client: Options = {}): Promise<void> {
  timers = new ManualTimers();
  const free = await FakeOscarServer.start();
  const port = free.port;
  await free.stop();
  fake = await FakeOscarServer.start({ now: timers.now, port, ...options(port) });
  fake.addUser('Alice', 'alicepw1');
  h = makeClient(fake, { timers, ...client });
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

// The host of each connection the client opened, by label.
const hosts = (): [unknown, unknown][] =>
  h.logs.lines.filter((line) => line.msg === 'oscar connection open').map((line) => [line.fields?.conn, line.fields?.host]);

// Windows does not connect to 0.0.0.0.
describe.skipIf(process.platform === 'win32')('followRedirects', () => {
  it('with followRedirects a room service goes to an advertised loopback host the default would pin', async () => {
    await start(() => ({}), { followRedirects: true });
    await h.client.signOn(ALICE, { host: ANY, port: fake.port });
    expect((await h.client.joinRoom(ROOM)).state).toBe('joined');
    expect(await h.client.probeService(FAMILY_CHATNAV)).toEqual({ host: LOOPBACK, port: fake.port, pinned: false });
    expect(hosts()).toEqual([
      ['auth', ANY],
      ['bos', LOOPBACK],
      ['chatnav', LOOPBACK],
      ['chat', LOOPBACK],
      ['probe', LOOPBACK],
    ]);
  });

  it('followRedirects off, the default, pins an advertised loopback host for a server that is not loopback', async () => {
    await start(() => ({}));
    await h.client.signOn(ALICE, { host: ANY, port: fake.port });
    expect((await h.client.joinRoom(ROOM)).state).toBe('joined');
    expect(await h.client.probeService(FAMILY_CHATNAV)).toEqual({ host: ANY, port: fake.port, pinned: true });
    expect(hosts().map(([, host]) => host)).toEqual([ANY, ANY, ANY, ANY, ANY]);
  });

  it('followRedirects off, the default, pins an unroutable advertisement', async () => {
    await start((port) => ({ advertisedHost: `${ANY}:${port}`, serviceHost: `${ANY}:${port}` }));
    await h.signOn();
    expect((await h.client.joinRoom(ROOM)).state).toBe('joined');
    expect(await h.client.probeService(FAMILY_CHATNAV)).toEqual({ host: LOOPBACK, port: fake.port, pinned: true });
    expect(hosts().map(([, host]) => host)).toEqual([LOOPBACK, LOOPBACK, LOOPBACK, LOOPBACK, LOOPBACK]);
  });

  it('with followRedirects the client goes to an unroutable advertisement', async () => {
    await start((port) => ({ advertisedHost: `${ANY}:${port}`, serviceHost: `${ANY}:${port}` }), { followRedirects: true });
    await h.signOn();
    expect((await h.client.joinRoom(ROOM)).state).toBe('joined');
    expect(await h.client.probeService(FAMILY_CHATNAV)).toEqual({ host: ANY, port: fake.port, pinned: false });
    expect(hosts()).toEqual([
      ['auth', LOOPBACK],
      ['bos', ANY],
      ['chatnav', ANY],
      ['chat', ANY],
      ['probe', ANY],
    ]);
  });

  it('with followRedirects the Admin and directory services go to the advertised host', async () => {
    await start((port) => ({ serviceHost: `${ANY}:${port}` }), { followRedirects: true });
    await h.signOn();
    await h.client.accountEmail();
    await h.client.directoryKeywords();
    expect(hosts().slice(2)).toEqual([
      ['admin', ANY],
      ['odir', ANY],
    ]);
  });

  it('pinRedirects wins over followRedirects', async () => {
    await start(() => ({ advertisedHost: 'oscar.example.invalid:5190', serviceHost: 'oscar.example.invalid:5190' }), { followRedirects: true });
    const pinned = makeClient(fake, { timers, followRedirects: true, pinRedirects: { host: LOOPBACK, port: fake.port } });
    await pinned.signOn();
    expect((await pinned.client.joinRoom(ROOM)).state).toBe('joined');
    expect(await pinned.client.probeService(FAMILY_CHATNAV)).toEqual({ host: LOOPBACK, port: fake.port, pinned: true });
  });
});
