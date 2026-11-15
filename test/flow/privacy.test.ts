import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imFailureReason } from '../../src/client/messaging.js';
import { FEEDBAG_ATTR_PD_MODE, FEEDBAG_ATTR_PENDING } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { tlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { RichText } from '../../src/model/rich-text.js';
import { normalizeScreenName } from '../../src/model/screen-name.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

// The privacy setting on the test server, which applies the server's rule (state/relationship.go:109-116 at 7af2464), with three clients.

const item = (classId: number, name: string, groupId: number, itemId: number, attrs: Tlv[] = []): FeedbagItem => ({ name, groupId, itemId, classId, attrs });
const group = (): FeedbagItem => item(1, 'Buddies', 1, 0);
const buddy = (itemId: number, name: string, attrs: Tlv[] = []): FeedbagItem => item(0, name, 1, itemId, attrs);
const deny = (itemId: number, name: string): FeedbagItem => item(3, name, 0, itemId);
const privacy = (itemId: number, mode: number): FeedbagItem => item(4, '', 0, itemId, [tlv.u8(FEEDBAG_ATTR_PD_MODE, mode)]);
const PENDING = tlv.bytes(FEEDBAG_ATTR_PENDING, new Uint8Array(0));
const text = (words: string): RichText => [{ text: words }];

let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: ClientHarness;
let carol: ClientHarness;

beforeEach(async () => {
  fake = await FakeOscarServer.start();
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  fake.addUser('Carol', 'carolpw1');
  alice = makeClient(fake);
  bob = makeClient(fake);
  carol = makeClient(fake);
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

/** Each account's list as given (with the typing preference), then Bob and Carol signed on, then Alice. */
async function start(lists: { alice: FeedbagItem[]; bob?: FeedbagItem[]; carol?: FeedbagItem[] }): Promise<void> {
  fake.setFeedbag('Alice', withTypingPref(lists.alice));
  fake.setFeedbag('Bob', withTypingPref(lists.bob ?? []));
  fake.setFeedbag('Carol', withTypingPref(lists.carol ?? []));
  await bob.signOn('Bob', 'bobpw1');
  await carol.signOn('Carol', 'carolpw1');
  await alice.signOn('Alice', 'alicepw1');
  await settle(fake.port);
}

/** What became of an IM: 'sent', or the reason it failed. */
async function sent(from: ClientHarness, to: string, words = 'hi'): Promise<string> {
  return from.client.sendIm(to, text(words)).then(
    () => 'sent',
    (error: unknown) => imFailureReason(error).reason,
  );
}

/** The online flag of each presence event `watcher` had of `name`, in order. */
const seen = (watcher: ClientHarness, name: string): boolean[] =>
  watcher.presence.filter((p) => normalizeScreenName(p.screenName) === normalizeScreenName(name)).map((p) => p.online);
const lastSeen = (watcher: ClientHarness, name: string): boolean | undefined => seen(watcher, name).at(-1);

const LISTS_ALICE = (): FeedbagItem[] => [group(), buddy(1, 'bob'), buddy(2, 'carol')];
const LISTS_ALICE_ONLY = (): FeedbagItem[] => [group(), buddy(1, 'alice')];

describe('"Allow only the people below" (mode 3)', () => {
  it('a buddy not allowed is refused and departs both ways; allowed, each arrives again', async () => {
    await start({ alice: [group(), buddy(1, 'bob')], bob: LISTS_ALICE_ONLY() });
    expect([lastSeen(alice, 'Bob'), lastSeen(bob, 'Alice')]).toEqual([true, true]);
    await alice.client.setPrivacyMode('allow-list');
    await waitFor(() => lastSeen(alice, 'Bob') === false && lastSeen(bob, 'Alice') === false, 'both departures');
    expect(await sent(bob, 'Alice')).toBe('unavailable');
    expect(await sent(alice, 'Bob')).toBe('youBlocked');
    await alice.client.allow('Bob');
    await waitFor(() => lastSeen(alice, 'Bob') === true && lastSeen(bob, 'Alice') === true, 'both arrivals');
    expect(await sent(bob, 'Alice')).toBe('sent');
  });
});

describe('"Allow only my buddies" (mode 5)', () => {
  it("a buddy's IM passes, and someone who lists the user without being a buddy is refused", async () => {
    await start({ alice: [group(), buddy(1, 'bob'), privacy(9, 5)], bob: LISTS_ALICE_ONLY(), carol: LISTS_ALICE_ONLY() });
    expect(await sent(bob, 'Alice')).toBe('sent');
    expect(await sent(carol, 'Alice')).toBe('unavailable');
  });

  it('a buddy waiting for authorisation is refused (state/relationship.go:32, :59 at 7af2464)', async () => {
    await start({ alice: [group(), buddy(1, 'bob'), buddy(2, 'carol', [PENDING]), privacy(9, 5)], carol: LISTS_ALICE_ONLY() });
    expect(await sent(carol, 'Alice')).toBe('unavailable');
  });
});

describe('the mode written after the items', () => {
  it('the first Block under "Allow everyone" sends a departure to a stale deny holder who lists the user', async () => {
    await start({ alice: [group(), buddy(1, 'bob'), deny(5, 'carol'), privacy(9, 1)], bob: LISTS_ALICE_ONLY(), carol: LISTS_ALICE_ONLY() });
    expect(lastSeen(carol, 'Alice')).toBe(true);
    expect(await alice.client.block('Bob')).toEqual({ alsoBlocked: 1 });
    // The server broadcasts a privacy item written in the cluster only to Bob (foodgroup/feedbag.go:393-399, 549-563 at 7af2464).
    await waitFor(() => lastSeen(carol, 'Alice') === false, "Carol's sight of the departure");
    expect(lastSeen(bob, 'Alice')).toBe(false);
  });
});

describe('a mode switch', () => {
  it('from 1 to 2 sends the user every related buddy\'s departure, and from 2 to 1 their arrivals', async () => {
    await start({ alice: LISTS_ALICE(), bob: LISTS_ALICE_ONLY(), carol: LISTS_ALICE_ONLY() });
    expect([lastSeen(alice, 'Bob'), lastSeen(alice, 'Carol')]).toEqual([true, true]);
    await alice.client.setPrivacyMode('block-all');
    await waitFor(() => lastSeen(alice, 'Bob') === false && lastSeen(alice, 'Carol') === false, 'the departures');
    await alice.client.setPrivacyMode('allow-all');
    await waitFor(() => lastSeen(alice, 'Bob') === true && lastSeen(alice, 'Carol') === true, 'the arrivals');
  });

  it('while the user is invisible, leaving "Block everyone" sends nobody an arrival of the user', async () => {
    await start({ alice: [...LISTS_ALICE(), privacy(9, 2)], bob: LISTS_ALICE_ONLY() });
    await alice.client.setInvisible(true);
    await settle(fake.port);
    const before = seen(bob, 'Alice').length;
    await alice.client.setPrivacyMode('allow-all');
    await waitFor(() => lastSeen(alice, 'Bob') === true, "Alice's sight of Bob");
    await settle(fake.port);
    expect(seen(bob, 'Alice').slice(before)).not.toContain(true);
  });
});

describe('a stranger', () => {
  it('on none of the lists and not listing the user, gets through "Block everyone" until a deny item makes the row', async () => {
    await start({ alice: [group(), buddy(1, 'bob'), privacy(9, 2)] });
    expect(await sent(carol, 'Alice', 'first')).toBe('sent');
    await waitFor(() => alice.ims.length === 1, 'the stranger\'s IM');
    expect(alice.ims[0]?.from).toBe('Carol');
    await alice.client.addBlocked('Carol');
    expect(await sent(carol, 'Alice', 'second')).toBe('unavailable');
    expect(alice.ims).toHaveLength(1);
  });

  it('gets no auto-response while the host holds it, as it does for a discarded IM', async () => {
    alice.client.on('im', (im) => {
      if (normalizeScreenName(im.from) === 'carol') alice.client.holdAutoResponse(im.from);
    });
    await start({ alice: [group(), buddy(1, 'bob'), privacy(9, 2)] });
    await alice.client.setAway(text('out'));
    expect(await sent(carol, 'Alice')).toBe('sent');
    await waitFor(() => alice.ims.length === 1, 'the IM');
    await settle(fake.port);
    expect(alice.autoResponses).toEqual([]);
    expect(carol.ims).toEqual([]);
  });
});

// The own-name checks compare normalised names, so the session's new spelling still finds the old one.
describe('the own name after a format', () => {
  const ownName = { info: { kind: 'local', code: 'own-screen-name' } };
  const listed = (classId: number): string[] => fake.feedbagOf('Alice').filter((each) => each.classId === classId).map((each) => each.name);

  it('after a format, allowing the own name in the old spelling is refused own-screen-name', async () => {
    await start({ alice: LISTS_ALICE() });
    expect(await alice.client.formatScreenName('A Lice')).toBe('A Lice');
    await expect(alice.client.allow('alice')).rejects.toMatchObject(ownName);
    expect(listed(2)).toEqual([]);
  });

  it('after a format, adding the own name in the old spelling to the Block list is refused own-screen-name', async () => {
    await start({ alice: LISTS_ALICE() });
    expect(await alice.client.formatScreenName('A Lice')).toBe('A Lice');
    await expect(alice.client.addBlocked('alice')).rejects.toMatchObject(ownName);
    expect(listed(3)).toEqual([]);
  });
});
