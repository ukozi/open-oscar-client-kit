import { afterEach, describe, expect, it } from 'vitest';
import { CAP_CHAT, CAP_MOBILE_CLIENT, CAP_UTF8_MESSAGES } from '../../src/wire/constants.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { StartOptions } from '../fake/oscar-server.js';

const PHONE_CAPS = [CAP_UTF8_MESSAGES, CAP_CHAT, CAP_MOBILE_CLIENT];
const BUDDIES: FeedbagItem = { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] };
const BOB: FeedbagItem = { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] };

let timers: ManualTimers;
let fake: FakeOscarServer;
let carol: ClientHarness;

// Carol has signed on, with Alice on her list unless she is told not to.
async function start(server: StartOptions = {}, watching = true): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ ...server, now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Carol', 'carolpw1');
  fake.setFeedbag('alice', withTypingPref([]));
  fake.setFeedbag('carol', withTypingPref(watching ? [BUDDIES, { ...BOB, name: 'alice' }] : []));
  carol = makeClient(fake, { timers });
  await carol.signOn('Carol', 'carolpw1');
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const alice = () => carol.client.presenceOf('Alice');

describe('a buddy on a mobile client', () => {
  it('shows Alice mobile while her only instance is mobile, and not once a desktop joins', async () => {
    await start();
    const phone = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await phone.signOn();
    await waitFor(() => alice()?.mobile === true, 'mobile');
    const desk = makeClient(fake, { timers });
    await desk.signOn();
    await waitFor(() => alice()?.online === true && alice()?.mobile === undefined, 'not mobile');
    expect('mobile' in (alice() ?? { mobile: true })).toBe(false);
  });

  it('carries mobile in Get info, every time it asks, until a desktop joins', async () => {
    await start();
    const phone = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await phone.signOn();
    await waitFor(() => alice()?.mobile === true, 'mobile');
    const first = await carol.client.getInfo('Alice');
    const again = await carol.client.getInfo('Alice');
    expect([first, again].map((info) => info.status === 'ok' && info.mobile)).toEqual([true, true]);
    expect(fake.snacsFrom('carol').filter((s) => s.conn === 'bos' && s.family === 2 && s.subtype === 0x15)).toHaveLength(2);
    const desk = makeClient(fake, { timers });
    await desk.signOn();
    await waitFor(() => alice()?.mobile === undefined, 'not mobile');
    const joined = await carol.client.getInfo('Alice');
    expect(joined.status).toBe('ok');
    expect('mobile' in joined).toBe(false);
  });

  it('carries mobile in Get info for a name that is not a buddy', async () => {
    await start({}, false);
    const phone = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await phone.signOn();
    // The reply comes after the server has read the online announcement.
    await phone.client.queryUserInfo();
    const info = await carol.client.getInfo('Alice');
    expect(info).toMatchObject({ status: 'ok', mobile: true });
  });

  it("never shows mobile under 'never'", async () => {
    await start({ wireless: 'never' });
    const phone = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await phone.signOn();
    await waitFor(() => alice()?.online === true, 'online');
    expect('mobile' in (alice() ?? {})).toBe(false);
    const info = await carol.client.getInfo('Alice');
    expect([info.status, 'mobile' in info]).toEqual(['ok', false]);
    expect((await phone.client.queryUserInfo()).instances.map((i) => i.mobile)).toEqual([false]);
  });
});
