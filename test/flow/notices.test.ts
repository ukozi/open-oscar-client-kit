import { afterEach, describe, expect, it } from 'vitest';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { StartOptions } from '../fake/oscar-server.js';

const SYSTEM = 'OOS System Msg';

let timers: ManualTimers;
let fake: FakeOscarServer;

async function start(options: StartOptions = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ ...options, now: timers.now });
  for (const [name, password] of [['Alice', 'alicepw1'], ['Carol', 'carolpw1']] as const) {
    fake.addUser(name, password);
    fake.setFeedbag(name.toLowerCase(), withTypingPref([]));
  }
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe('the notice of a second location', () => {
  it('is marked by its shape, from whatever sender the server uses', async () => {
    await start({ noticeSender: 'Chimr Notices' });
    const first = makeClient(fake, { timers });
    await first.signOn();
    await makeClient(fake, { timers }).signOn();
    await waitFor(() => first.ims.length === 1, 'the notice of two locations');
    expect(first.ims[0]).toMatchObject({ from: 'Chimr Notices', serverNotice: true, offline: false, autoResponse: false });
    expect(first.ims[0]?.body.map((run) => run.text).join('')).toContain('is now signed into Open OSCAR Server in 2 locations');
  });

  it('comes from OOS System Msg unless the server is set otherwise', async () => {
    await start();
    const first = makeClient(fake, { timers });
    await first.signOn();
    await makeClient(fake, { timers }).signOn();
    await waitFor(() => first.ims.length === 1, 'the notice of two locations');
    expect([first.ims[0]?.from, first.ims[0]?.serverNotice]).toEqual([SYSTEM, true]);
  });
});

describe('a person who holds the name of the notice sender', () => {
  it('writes a live IM that is a notice only to a client configured with that sender', async () => {
    await start({ notices: false });
    const plain = makeClient(fake, { timers });
    const configured = makeClient(fake, { timers, noticeSender: SYSTEM });
    await plain.signOn('Alice', 'alicepw1');
    await configured.signOn('Carol', 'carolpw1');
    const bob = fake.peer(SYSTEM);
    bob.sendIm('Alice', 'click this link');
    bob.sendIm('Carol', 'click this link');
    await waitFor(() => plain.ims.length === 1 && configured.ims.length === 1, 'the live IM');
    expect([plain.ims[0]?.serverNotice, configured.ims[0]?.serverNotice]).toEqual([false, true]);
    expect([plain.ims[0]?.offline, configured.ims[0]?.offline]).toEqual([false, false]);
  });
});
