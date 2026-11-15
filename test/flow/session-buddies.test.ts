import { afterEach, describe, expect, it } from 'vitest';
import { SignOnError } from '../../src/client/errors.js';
import type { OscarError } from '../../src/client/errors.js';
import { OscarClient } from '../../src/client/oscar-client.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { ByteReader } from '../../src/wire/bytes.js';
import {
  BUDDY_ADD_BUDDIES,
  BUDDY_DEL_BUDDIES,
  FAMILY_BUDDY,
  FAMILY_LOCATE,
  FAMILY_OSERVICE,
  OSERVICE_CLIENT_ONLINE,
} from '../../src/wire/constants.js';
import { FAMILY_FEEDBAG } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { LOCATE_USER_INFO_QUERY2 } from '../../src/wire/locate.js';
import { imRoundTrip, makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

type Options = Omit<Partial<OscarClientOptions>, 'now' | 'timers'>;

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let names: string[];
let asked: number;
let broken: Error | null;

async function start(list: readonly string[], over: Options = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  names = [...list];
  asked = 0;
  broken = null;
  const sessionBuddies = (): readonly string[] => {
    asked++;
    if (broken) throw broken;
    return names;
  };
  h = makeClient(fake, { timers, random: () => 0, sessionBuddies, ...over });
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const bos = (): SnacRecord[] => fake.snacsFrom('alice').filter((snac) => snac.conn === 'bos');
const types = (snacs: SnacRecord[]): [number, number][] => snacs.map((snac) => [snac.family, snac.subtype]);
const feedbagSnacs = (): SnacRecord[] => bos().filter((snac) => snac.family === FAMILY_FEEDBAG);

function namesIn(body: Uint8Array): string[] {
  const reader = new ByteReader(body);
  const out: string[] = [];
  while (reader.remaining > 0) out.push(reader.str8());
  return out;
}

// The names of each 0x03 SNAC of one subtype that the client wrote, in order.
const lists = (subtype: number): string[][] =>
  bos()
    .filter((snac) => snac.family === FAMILY_BUDDY && snac.subtype === subtype)
    .map((snac) => namesIn(snac.body));
const adds = (): string[][] => lists(BUDDY_ADD_BUDDIES);
const removes = (): string[][] => lists(BUDDY_DEL_BUDDIES);

const queries = (): SnacRecord[] => bos().filter((snac) => snac.family === FAMILY_LOCATE && snac.subtype === LOCATE_USER_INFO_QUERY2);

const roundTrip = (): Promise<void> => imRoundTrip(fake, h);

async function infoOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: OscarError) => error.info,
  );
}

async function reconnect(): Promise<void> {
  fake.dropSocket('Alice');
  await waitFor(() => h.states.at(-1)?.state === 'reconnecting', 'reconnecting');
  await timers.advance(2_000);
  await waitFor(() => h.client.state === 'online', 'the client to be online again');
}

describe('sessionBuddies', () => {
  it('sends the names in 0x03/0x04 before client online and no feedbag SNAC at all', async () => {
    await start(['Bob', 'Carol']);
    await h.signOn();
    const sent = types(bos());
    expect(sent).toContainEqual([FAMILY_BUDDY, BUDDY_ADD_BUDDIES]);
    const at = (family: number, subtype: number): number => sent.findIndex(([f, s]) => f === family && s === subtype);
    expect(at(FAMILY_BUDDY, BUDDY_ADD_BUDDIES)).toBeLessThan(at(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE));
    expect(sent.filter(([family]) => family === FAMILY_FEEDBAG)).toEqual([]);
    expect(adds()).toEqual([['bob', 'carol']]);
    expect(fake.sessionBuddiesOf('alice')).toEqual(['bob', 'carol']);
  });

  it('normalises the names, drops an empty name and a name over 255 bytes, and sends a name one time', async () => {
    await start(['Bob Smith', 'BOBSMITH', '', '  ', 'x'.repeat(256), 'carol']);
    await h.signOn();
    expect(adds()).toEqual([['bobsmith', 'carol']]);
  });

  it('sends an empty 0x03/0x04 for an empty list, and a watcher then sees the account online', async () => {
    await start([]);
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    await h.signOn();
    expect(adds()).toEqual([[]]);
    expect(feedbagSnacs()).toEqual([]);
    await waitFor(() => bob.sightings().some((s) => s.name === 'Alice' && s.event === 'arrived'), 'the account online');
  });

  it('presence events and presenceOf work for a session buddy', async () => {
    await start(['Bob']);
    const bob = fake.peer('Bob');
    await h.signOn();
    await waitFor(() => h.client.presenceOf('Bob')?.online === true, 'the arrival');
    expect(h.presence.at(-1)).toMatchObject({ screenName: 'Bob', online: true, away: false });
    bob.setAway(true);
    await waitFor(() => h.client.presenceOf('bob')?.away === true, 'the away state');
    bob.signOff();
    await waitFor(() => h.client.presenceOf('Bob')?.online === false, 'the departure');
    expect(h.presence.at(-1)).toMatchObject({ screenName: 'Bob', online: false });
  });

  it('getInfo sends no query for a listed name shown offline, and sends one for a name not on the list', async () => {
    await start(['Bob', 'Dave']);
    fake.addUser('Dave', 'davepw12');
    fake.peer('Erin').setProfile('about erin');
    await h.signOn();
    expect(await h.client.getInfo('Dave')).toEqual({ status: 'unavailable' });
    await roundTrip();
    expect(queries()).toEqual([]);
    expect(await h.client.getInfo('Erin')).toMatchObject({ status: 'ok', screenName: 'Erin' });
    expect(queries()).toHaveLength(1);
    // The client holds no reply for a name that is not on the list.
    expect(h.infos).toEqual([]);
  });

  it('getInfo and fetchAway hold the reply for a listed name, and fetchAway asks nothing for a name not on the list', async () => {
    await start(['Bob']);
    fake.peer('Bob').setAwayMessage('brb');
    fake.peer('Erin').setAwayMessage('out');
    await h.signOn();
    await waitFor(() => h.client.presenceOf('Bob')?.away === true, 'the away state');
    await h.client.fetchAway('Erin');
    await roundTrip();
    expect(queries()).toEqual([]);
    await h.client.fetchAway('Bob');
    expect(queries()).toHaveLength(1);
    expect(h.infos).toEqual([{ screenName: 'Bob', awayMessage: [{ text: 'brb' }] }]);
    // The held reply answers the second call.
    await h.client.fetchAway('Bob');
    await roundTrip();
    expect(queries()).toHaveLength(1);
    expect(await h.client.getInfo('Bob')).toMatchObject({ status: 'ok', awayMessage: [{ text: 'brb' }] });
    expect(h.infos).toHaveLength(2);
    expect(h.infos[1]).toMatchObject({ screenName: 'Bob', awayMessage: [{ text: 'brb' }] });
  });

  it('refreshSessionBuddies sends only the difference, as one add and one remove', async () => {
    await start(['Bob', 'Carol', 'Dave']);
    fake.peer('Erin');
    await h.signOn();
    names = ['carol', 'Erin', 'Frank', 'ERIN'];
    await h.client.refreshSessionBuddies();
    await roundTrip();
    expect(adds()).toEqual([['bob', 'carol', 'dave'], ['erin', 'frank']]);
    expect(removes()).toEqual([['bob', 'dave']]);
    expect(fake.sessionBuddiesOf('Alice').sort()).toEqual(['carol', 'erin', 'frank']);
    await waitFor(() => h.client.presenceOf('Erin')?.online === true, 'the arrival of an added name');
    expect(feedbagSnacs()).toEqual([]);
  });

  it('refreshSessionBuddies with no change sends nothing', async () => {
    await start(['Bob', 'Carol']);
    await h.signOn();
    await roundTrip();
    const before = bos().length;
    names = ['CAROL', 'b o b'];
    await h.client.refreshSessionBuddies();
    expect(asked).toBe(2);
    await settle(fake.port);
    expect(bos().length).toBe(before);
  });

  it('a removed name has no presence after the refresh', async () => {
    await start(['Bob', 'Carol']);
    const bob = fake.peer('Bob');
    fake.peer('Carol');
    await h.signOn();
    await waitFor(() => h.client.presenceOf('Bob')?.online === true && h.client.presenceOf('Carol')?.online === true, 'both arrivals');
    names = ['Carol'];
    const events = h.presence.length;
    // This arrival is on its way when the name goes.
    bob.setAway(true);
    await h.client.refreshSessionBuddies();
    expect(h.client.presenceOf('Bob')).toBeUndefined();
    expect(h.client.presenceOf('Carol')?.online).toBe(true);
    await roundTrip();
    expect(h.client.presenceOf('Bob')).toBeUndefined();
    expect(h.presence.slice(events)).toEqual([]);
  });

  it('refreshSessionBuddies rejects not-signed-on while offline, and does nothing without the option', async () => {
    await start(['Bob']);
    expect(await infoOf(h.client.refreshSessionBuddies())).toEqual({ kind: 'not-signed-on' });
    expect(asked).toBe(0);
    const plain = makeClient(fake);
    expect(await infoOf(plain.client.refreshSessionBuddies())).toEqual({ kind: 'not-signed-on' });
    fake.addUser('Gina', 'ginapw12');
    await plain.signOn('Gina', 'ginapw12');
    await plain.client.refreshSessionBuddies();
    await settle(fake.port);
    expect(fake.snacsFrom('gina').filter((snac) => snac.family === FAMILY_BUDDY)).toEqual([]);
  });

  it('a reconnect asks the function again and sends the list again', async () => {
    await start(['Bob']);
    fake.peer('Bob');
    fake.peer('Carol');
    await h.signOn();
    expect(asked).toBe(1);
    names = ['Bob', 'Carol'];
    await reconnect();
    expect(asked).toBe(2);
    expect(adds()).toEqual([['bob'], ['bob', 'carol']]);
    expect(removes()).toEqual([]);
    await waitFor(() => h.client.presenceOf('Carol')?.online === true, 'the arrival on the new connection');
    names = ['Carol'];
    await h.client.refreshSessionBuddies();
    await roundTrip();
    expect(removes()).toEqual([['bob']]);
    expect(feedbagSnacs()).toEqual([]);
  });

  it('no typing preference is written after online', async () => {
    await start(['Bob']);
    await h.signOn();
    await roundTrip();
    await settle(fake.port);
    expect(feedbagSnacs()).toEqual([]);
    expect(fake.feedbagOf('Alice')).toEqual([]);
  });

  it('without sessionBuddies, the default, the client reads the list, uses it and writes the typing preference', async () => {
    fake = await FakeOscarServer.start();
    fake.addUser('Alice', 'alicepw1');
    h = makeClient(fake);
    await h.signOn();
    await waitFor(() => fake.feedbagOf('Alice').length === 1, 'the typing preference');
    const sent = types(feedbagSnacs());
    expect(sent).toContainEqual([FAMILY_FEEDBAG, 0x04]);
    expect(sent).toContainEqual([FAMILY_FEEDBAG, 0x07]);
    expect(bos().filter((snac) => snac.family === FAMILY_BUDDY)).toEqual([]);
  });

  it('buddyList is empty and addBuddy rejects invalid-argument with nothing written', async () => {
    const stored: FeedbagItem[] = [
      { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
      { name: 'zed', groupId: 1, itemId: 1, classId: 0, attrs: [] },
    ];
    await start(['Bob']);
    fake.setFeedbag('Alice', stored);
    await h.signOn();
    const empty = h.client.buddyList();
    expect(empty.groups).toEqual([]);
    expect(empty.privacy).toMatchObject({ allow: [], block: [] });
    expect(h.lists).toEqual([empty]);
    const c = h.client;
    const ref = { itemId: 1, groupId: 1 };
    const refused = { kind: 'local', code: 'invalid-argument' };
    const writes: Promise<unknown>[] = [
      c.addBuddy({ screenName: 'Carol', groupId: 1, alias: null }),
      c.removeBuddy(ref),
      c.moveBuddy(ref, 2),
      c.setAlias(ref, 'Z'),
      c.addGroup('Work'),
      c.renameGroup(1, 'Friends'),
      c.deleteGroup(1),
      c.block('Carol'),
      c.unblock('Carol'),
      c.setPrivacyMode('allow-all'),
      c.setAcceptNonListIcons(true),
      c.allow('Carol'),
      c.disallow('Carol'),
      c.addBlocked('Carol'),
      c.removeBlocked('Carol'),
      c.setOwnIcon(Uint8Array.of(1, 2, 3)),
      c.clearOwnIcon(),
    ];
    for (const write of writes) expect(await infoOf(write)).toEqual(refused);
    await roundTrip();
    expect(feedbagSnacs()).toEqual([]);
    expect(fake.feedbagOf('Alice')).toEqual(stored);
    expect(fake.snacsFrom('alice').filter((snac) => snac.conn === 'bart')).toEqual([]);
    expect(h.lists).toEqual([empty]);
  });

  it('a list write rejects invalid-argument while offline too', async () => {
    await start(['Bob']);
    expect(await infoOf(h.client.addBuddy({ screenName: 'Carol', groupId: 1, alias: null }))).toEqual({ kind: 'local', code: 'invalid-argument' });
  });

  it('an IM round trip works with no server list', async () => {
    await start([]);
    const bob = fake.peer('Bob');
    await h.signOn();
    await h.client.sendIm('Bob', [{ text: 'hello' }]);
    await waitFor(() => bob.ims().length === 1, 'the IM at the peer');
    expect(bob.ims()[0]?.html).toContain('hello');
    bob.sendIm('Alice', 'hi back');
    await waitFor(() => h.ims.length === 1, 'the IM at the client');
    expect(h.ims[0]).toMatchObject({ from: 'Bob' });
    expect(feedbagSnacs()).toEqual([]);
  });

  it('sessionBuddies with awayRecord throws a RangeError', () => {
    const make = (): OscarClient => new OscarClient({ sessionBuddies: () => [], awayRecord: { name: 'away', role: 'own', source: 'desktop' } });
    expect(make).toThrow(RangeError);
  });

  it('a function that throws fails the sign-on as a sign-on failure and not as an unhandled error', async () => {
    const boom = new Error('no list');
    const guarded: unknown[] = [];
    await start([], {
      sessionBuddies: () => {
        throw boom;
      },
      guard: (error, site) => guarded.push([error, site.kind]),
    });
    const failure = await h.signOn().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SignOnError);
    expect((failure as SignOnError).cause).toBe(boom);
    expect(h.client.state).toBe('offline');
    expect(guarded).toEqual([[boom, 'sign-on']]);
    expect(adds()).toEqual([]);
  });

  it('a function that throws in a refresh rejects with that error and changes nothing', async () => {
    await start(['Bob']);
    await h.signOn();
    await roundTrip();
    const before = bos().length;
    broken = new Error('no list');
    names = ['Carol'];
    await expect(h.client.refreshSessionBuddies()).rejects.toBe(broken);
    broken = null;
    await settle(fake.port);
    expect(bos().length).toBe(before);
    expect(h.client.state).toBe('online');
    await h.client.refreshSessionBuddies();
    await roundTrip();
    expect(adds()).toEqual([['bob'], ['carol']]);
    expect(removes()).toEqual([['bob']]);
  });
});
