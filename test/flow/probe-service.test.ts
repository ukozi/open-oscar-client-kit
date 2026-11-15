import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClient, stopAllClients } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const FAMILY_CHATNAV = 0x000d;
const PROBE_TIMEOUT_MS = 20_000;

let timers: ManualTimers;
let fake: FakeOscarServer;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, serviceHost: 'oscar.example.invalid:5190' });
  fake.addUser('Alice', 'alicepw1');
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });

describe('probing a service', () => {
  it('makes a ChatNav round trip through the pinned address and closes it', async () => {
    const h = makeClient(fake, { timers, pinRedirects: here() });
    await h.signOn();
    expect(await h.client.probeService(FAMILY_CHATNAV)).toEqual({ host: '127.0.0.1', port: fake.port, pinned: true });
    await waitFor(() => !fake.openConnections('alice').includes('chatnav'), 'the probe closed');
  });

  it('rejects not-signed-on unless online', async () => {
    await expect(makeClient(fake, { timers }).client.probeService(FAMILY_CHATNAV)).rejects.toMatchObject({ info: { kind: 'not-signed-on' } });
  });

  it('rejects with the code of a service the server will not give', async () => {
    const h = makeClient(fake, { timers, pinRedirects: here() });
    await h.signOn();
    await expect(h.client.probeService(0x0777)).rejects.toMatchObject({ info: { kind: 'refused', code: 0x0005 } });
    expect(fake.openConnections('alice')).toEqual(['bos']);
  });

  it('times out after 20 s when the service connection never says it is online, and closes it', async () => {
    const h = makeClient(fake, { timers, pinRedirects: here() });
    await h.signOn();
    const release = fake.withhold(0x0001, 0x0003);
    const probe = h.client.probeService(FAMILY_CHATNAV).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitFor(() => fake.openConnections('alice').includes('chatnav'), 'the service connection');
    await timers.advance(PROBE_TIMEOUT_MS);
    expect(await probe).toMatchObject({ info: { kind: 'timeout', rateLimited: false } });
    await waitFor(() => !fake.openConnections('alice').includes('chatnav'), 'the probe closed');
    release();
  });

  it('rejects connection-lost when the service connection closes first', async () => {
    const h = makeClient(fake, { timers, pinRedirects: here() });
    await h.signOn();
    const release = fake.withhold(0x0001, 0x0003);
    const probe = h.client.probeService(FAMILY_CHATNAV).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitFor(() => fake.openConnections('alice').includes('chatnav'), 'the service connection');
    fake.dropServices('alice');
    expect(await probe).toMatchObject({ info: { kind: 'connection-lost' } });
    release();
  });
});
