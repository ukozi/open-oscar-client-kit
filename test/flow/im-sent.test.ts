import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const FAMILY_ICBM = 0x0004;
const ICBM_MSG_TO_HOST = 0x0006;
const ICBM_HOST_ACK = 0x000c;
const ICBM_RATE_CLASS = 3;

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.peer('Bob');
  h = makeClient(fake, { timers });
  await h.signOn();
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const imsRead = (): number => fake.snacsFrom('alice').filter((s) => s.family === FAMILY_ICBM && s.subtype === ICBM_MSG_TO_HOST).length;
const failure = (send: Promise<unknown>): Promise<unknown> =>
  send.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('an IM that was on the wire when the connection closed', () => {
  it('rejects as connection-lost and sent once the IM was written', async () => {
    const release = fake.withhold(FAMILY_ICBM, ICBM_HOST_ACK);
    const sending = failure(h.client.sendIm('Bob', [{ text: 'hello' }]));
    await waitFor(() => imsRead() === 1, 'the test server to read the IM');
    h.client.dropConnection();
    expect(await sending).toMatchObject({ info: { kind: 'connection-lost' }, sent: true });
    release();
  });

  it('rejects as connection-lost without sent while the IM is still queued behind a held rate class', async () => {
    fake.spend('alice', ICBM_RATE_CLASS, 4);
    await waitFor(() => h.logs.lines.some((l) => l.msg === 'rate notice'), 'the alert notice');
    const sending = failure(h.client.sendIm('Bob', [{ text: 'hello' }]));
    await timers.advance(1_000);
    expect(imsRead()).toBe(0);
    h.client.dropConnection();
    const error = await sending;
    expect(error).toMatchObject({ info: { kind: 'connection-lost' } });
    expect(error).not.toHaveProperty('sent');
  });
});
