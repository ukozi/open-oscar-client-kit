import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';

let server: FakeOscarServer;
let h: ClientHarness;

beforeEach(async () => {
  server = await FakeOscarServer.start();
  server.addUser('Alice', 'alicepw1');
  server.setFeedbag('alice', [
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] },
  ]);
  h = makeClient(server);
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const events = (count: number): Promise<void> => waitFor(() => h.presence.length >= count, `presence event ${count}`);

async function signOnWithBob(): Promise<FakePeer> {
  const bob = server.peer('Bob');
  await h.signOn();
  await events(1);
  return bob;
}

describe('presence', () => {
  it('sees a buddy who is already online once sign-on completes', async () => {
    await signOnWithBob();
    expect(h.presence).toHaveLength(1);
    expect(h.presence[0]).toMatchObject({ screenName: 'Bob', online: true, away: false, idleSince: null, warnLevel: 0 });
    expect(h.client.presenceOf('bob')?.online).toBe(true);
  });

  it('sees arrivals as updates: away, idle, came back', async () => {
    const bob = await signOnWithBob();
    bob.setAway(true);
    bob.setIdle(12);
    bob.setAway(false);
    await events(4);
    expect(h.presence[1]?.away).toBe(true);
    expect(h.presence[2]?.idleSince).toBe(h.timers.now() - 720_000);
    expect(h.presence[3]?.away).toBe(false);
    expect(h.presence.map((p) => p.online)).toEqual([true, true, true, true]);
  });

  it('sees a departure and a later arrival', async () => {
    const bob = await signOnWithBob();
    bob.signOff();
    await events(2);
    expect(h.presence[1]).toMatchObject({ online: false, away: false, idleSince: null, signedOnAt: null });
    expect(h.client.presenceOf('bob')?.online).toBe(false);
    bob.signOn();
    await events(3);
    expect(h.presence[2]?.online).toBe(true);
  });

  it('stores warn levels as received', async () => {
    const bob = await signOnWithBob();
    bob.setWarning(100);
    await events(2);
    expect(h.presence[1]?.warnLevel).toBe(100);
  });

  it('reports nothing for someone who is not on the buddy list', async () => {
    const bob = await signOnWithBob();
    server.peer('Carol');
    // Bob's update travels the same connection after anything Carol caused.
    bob.setAway(true);
    await events(2);
    expect(h.presence.map((p) => p.screenName)).toEqual(['Bob', 'Bob']);
    expect(h.client.presenceOf('carol')).toBeUndefined();
  });

  it('forgets presence when the session ends, with no events', async () => {
    await signOnWithBob();
    const before = h.presence.length;
    await h.client.signOff();
    expect(h.client.presenceOf('bob')).toBeUndefined();
    expect(h.presence.length).toBe(before);
  });
});
