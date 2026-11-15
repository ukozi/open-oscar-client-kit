import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OscarError } from '../../src/client/errors.js';
import { locateText } from '../../src/client/profiles.js';
import { ByteReader } from '../../src/wire/bytes.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeTlvs, tlvStr } from '../../src/wire/tlv.js';
import type { UserInfoResult } from '../../src/model/buddy-list.js';
import type { RichText } from '../../src/model/rich-text.js';
import type { CommandError } from '../../src/model/session.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord } from '../fake/oscar-server.js';

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;

const buddies = (names: string[]): FeedbagItem[] =>
  withTypingPref([
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    ...names.map((name, i): FeedbagItem => ({ name, groupId: 1, itemId: i + 1, classId: 0, attrs: [] })),
  ]);

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
  server.setFeedbag('alice', buddies(['bob', 'dave']));
  h = makeClient(server, { timers });
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const text = (words: string): RichText => [{ text: words }];
const fromAlice = (family: number, subtype: number): SnacRecord[] =>
  server.snacsFrom('alice').filter((s) => s.conn === 'bos' && s.family === family && s.subtype === subtype);
const locateWrites = (): SnacRecord[] => fromAlice(0x02, 0x04);
const queries = (): SnacRecord[] => fromAlice(0x02, 0x15);
const tagsOf = (snac: SnacRecord | undefined): number[] => decodeTlvs(snac?.body ?? new Uint8Array(0)).map((t) => t.tag);
const queryType = (snac: SnacRecord | undefined): number => new ByteReader(snac?.body ?? new Uint8Array(4)).u32();
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

async function refusalOf(promise: Promise<unknown>): Promise<CommandError | undefined> {
  return promise.then(
    () => undefined,
    (e: OscarError) => e.info,
  );
}

const presenceEvents = (count: number): Promise<void> => waitFor(() => h.presence.length >= count, `presence event ${count}`);
const infoEvents = (count: number): Promise<void> => waitFor(() => h.infos.length >= count, `buddyInfo event ${count}`);

async function signOn(...online: string[]): Promise<void> {
  await h.signOn();
  await waitFor(() => online.every((name) => h.client.presenceOf(name)?.online === true), 'the buddies to arrive');
}

const roundTrip = (): Promise<void> => imRoundTrip(server, h);

function awayPeer(name: string, message = 'brb'): FakePeer {
  const peer = server.peer(name);
  peer.setAwayMessage(message);
  return peer;
}

const ok = (result: UserInfoResult): Extract<UserInfoResult, { status: 'ok' }> => {
  if (result.status !== 'ok') throw new Error('the info result is not ok');
  return result;
};

describe('own away message and profile', () => {
  it('sends the capabilities and the profile in one Locate write at sign-on, and no away message', async () => {
    const profile: RichText = [{ text: 'café 😀', bold: true }];
    await h.client.signOn({ screenName: 'Alice', password: 'alicepw1' }, { host: '127.0.0.1', port: server.port }, { profile });
    await roundTrip();
    const writes = locateWrites();
    expect(writes).toHaveLength(1);
    expect(tagsOf(writes[0])).toEqual([0x05, 0x01, 0x02]);
    expect(tlvStr(decodeTlvs(writes[0]?.body ?? new Uint8Array(0)), 0x02)).toBe(locateText(profile));
    expect(h.client.awayMessage).toBeNull();
  });

  it('starts the session with an empty profile when the one given is over the limit the server advertises', async () => {
    const profile = text('x'.repeat(1001));
    await h.client.signOn({ screenName: 'Alice', password: 'alicepw1' }, { host: '127.0.0.1', port: server.port }, { profile });
    await roundTrip();
    const writes = locateWrites();
    expect(writes.map(tagsOf)).toEqual([[0x05, 0x01, 0x02]]);
    expect(tlvStr(decodeTlvs(writes[0]?.body ?? new Uint8Array(0)), 0x02)).toBe('');
    expect(h.logs.lines.filter((l) => l.level === 'warn').map((l) => [l.msg, l.fields])).toEqual([
      ['the profile is over the limit and was not sent', { limit: 1000 }],
    ]);
  });

  it('an away or profile change carries no capability list', async () => {
    await signOn();
    await h.client.setAway(text('brb'));
    await h.client.setProfile(text('hello'));
    await roundTrip();
    const writes = locateWrites();
    expect(writes.map(tagsOf)).toEqual([[0x05, 0x01, 0x02], [0x03, 0x04], [0x01, 0x02]]);
    expect(tlvStr(decodeTlvs(writes[1]?.body ?? new Uint8Array(0)), 0x04)).toBe('brb');
    expect(tlvStr(decodeTlvs(writes[2]?.body ?? new Uint8Array(0)), 0x02)).toBe('hello');
  });

  it('sets and clears the away message, and a watcher sees the away flag follow', async () => {
    const bob = server.peer('Bob');
    await signOn('Bob');
    bob.watch('Alice');
    const seen = (): boolean[] => bob.sightings().filter((s) => s.name === 'Alice').map((s) => s.away);
    expect([seen(), h.client.awayMessage]).toEqual([[false], null]);

    const message: RichText = [{ text: 'out for coffee ☕', italic: true }];
    await h.client.setAway(message);
    expect(h.client.awayMessage).toEqual(message);
    await waitFor(() => seen().length === 2, 'the away arrival');

    await h.client.setAway(null);
    expect(h.client.awayMessage).toBeNull();
    await waitFor(() => seen().length === 3, 'the return');
    expect(seen()).toEqual([false, true, false]);
  });

  it('refuses an away message or a profile over the advertised limit and sends nothing', async () => {
    await signOn();
    expect(h.client.limits?.awayAndProfileBytes).toBe(1000);
    // 166 references of six bytes and five letters: 1001 bytes as sent, 171 characters as typed.
    const tooLong = text(`${'é'.repeat(166)}aaaaa`);
    expect(await refusalOf(h.client.setAway(tooLong))).toEqual({ kind: 'local', code: 'text-too-long' });
    expect(await refusalOf(h.client.setProfile(tooLong))).toEqual({ kind: 'local', code: 'text-too-long' });
    expect(h.client.awayMessage).toBeNull();
    await roundTrip();
    expect(locateWrites()).toHaveLength(1);
    await h.client.setProfile(text(`${'é'.repeat(166)}aaaa`));
    await roundTrip();
    expect(locateWrites()).toHaveLength(2);
  });

  it('refuses an empty away message: the caller supplies the default text', async () => {
    await signOn();
    expect(await refusalOf(h.client.setAway([]))).toEqual({ kind: 'local', code: 'invalid-argument' });
    expect(await refusalOf(h.client.setAway(text('')))).toEqual({ kind: 'local', code: 'invalid-argument' });
    await roundTrip();
    expect(locateWrites()).toHaveLength(1);
    await h.client.setProfile([]);
    await roundTrip();
    expect(locateWrites().map(tagsOf)).toEqual([[0x05, 0x01, 0x02], [0x01, 0x02]]);
  });

  it('refuses every one of them when not signed on, and a hover fetch resolves', async () => {
    expect(await refusalOf(h.client.setAway(text('brb')))).toEqual({ kind: 'not-signed-on' });
    expect(await refusalOf(h.client.setProfile(text('hi')))).toEqual({ kind: 'not-signed-on' });
    expect(await refusalOf(h.client.getInfo('Bob'))).toEqual({ kind: 'not-signed-on' });
    await expect(h.client.fetchAway('Bob')).resolves.toBeUndefined();
  });

  it('forgets the away message when the session ends', async () => {
    await signOn();
    await h.client.setAway(text('brb'));
    await h.client.signOff();
    expect(h.client.awayMessage).toBeNull();
  });
});

describe('Get Info', () => {
  it('Get Info returns the user as the server formats it, the profile and the away message', async () => {
    const bob = server.peer('Bob');
    bob.setProfile('<B>caf&#233;</B> &#128512;');
    bob.setAwayMessage('brb &#9749;');
    bob.setIdle(5);
    bob.setWarning(125);
    await signOn('Bob');
    const now = timers.now();
    expect(await h.client.getInfo('bob')).toEqual({
      status: 'ok',
      screenName: 'Bob',
      away: true,
      idleSince: now - 300_000,
      signedOnAt: Math.floor(now / 1000) * 1000,
      warnLevel: 125,
      profile: [{ text: 'café', bold: true }, { text: ' 😀' }],
      awayMessage: [{ text: 'brb ☕' }],
    });
    expect(queries()).toHaveLength(1);
    expect(queryType(queries()[0])).toBe(3);
  });

  it('Get Info for a user who is not away or idle and has no profile carries an empty profile and no away message', async () => {
    server.peer('Carol');
    await signOn();
    expect(await h.client.getInfo('Carol')).toMatchObject({ status: 'ok', screenName: 'Carol', away: false, idleSince: null, profile: [], awayMessage: null });
  });

  it('decodes a profile by the charset its type declares, and an away message as UTF-8 when it is not ASCII', async () => {
    const carol = server.peer('Carol');
    await signOn();
    const profile = async (): Promise<RichText> => ok(await h.client.getInfo('Carol')).profile;

    carol.setProfile(utf8('é'), 'text/aolrtf; charset="utf-8"');
    expect(await profile()).toEqual(text('é'));
    carol.setProfile(Uint8Array.of(0xe9), 'text/aolrtf; charset="iso-8859-1"');
    expect(await profile()).toEqual(text('é'));
    carol.setProfile(Uint8Array.of(0x00, 0xe9, 0x26, 0x15), 'text/aolrtf; charset="unicode-2-0"');
    expect(await profile()).toEqual(text('é☕'));
    // The same two bytes are two Latin-1 characters when the type says so, and one when it names no known charset.
    carol.setProfile(utf8('é'), 'text/aolrtf; charset="iso-8859-1"');
    expect(await profile()).toEqual(text('Ã©'));
    carol.setProfile(utf8('é'), 'text/aolrtf; charset="x-unknown"');
    expect(await profile()).toEqual(text('é'));

    carol.setAwayMessage(utf8('é'));
    expect(ok(await h.client.getInfo('Carol')).awayMessage).toEqual(text('é'));
    // The client reads bytes that are not UTF-8 as ISO-8859-1.
    carol.setAwayMessage(Uint8Array.of(0xe9));
    expect(ok(await h.client.getInfo('Carol')).awayMessage).toEqual(text('é'));
  });

  it('Get Info for someone not available is a result, not an error', async () => {
    server.addUser('Carol', 'carolpw1');
    await signOn();
    expect(await h.client.getInfo('Carol')).toEqual({ status: 'unavailable' });
    expect(queries()).toHaveLength(1);
    expect(h.infos).toEqual([]);
  });

  it('Get Info for a buddy shown as offline sends no query', async () => {
    const bob = server.peer('Bob');
    await signOn('Bob');
    bob.signOff();
    await waitFor(() => h.client.presenceOf('Bob')?.online === false, 'the departure');
    expect(await h.client.getInfo('Bob')).toEqual({ status: 'unavailable' });
    expect(await h.client.getInfo('Dave')).toEqual({ status: 'unavailable' });
    await roundTrip();
    expect(queries()).toEqual([]);
  });

  it('Get Info times out after 15 s', async () => {
    server.peer('Carol');
    await signOn();
    const release = server.withhold(0x02, 0x06);
    let error: OscarError | undefined;
    h.client.getInfo('Carol').catch((e: OscarError) => {
      error = e;
    });
    await waitFor(() => queries().length === 1, 'the query');
    await timers.advance(14_999);
    expect(error).toBeUndefined();
    await timers.advance(1);
    expect(error?.info).toEqual({ kind: 'timeout', rateLimited: false });
    release();
  });

  it('Get Info rejects with the code of any other error', async () => {
    server.peer('Carol');
    await signOn();
    server.failNext(0x02, 0x15, { code: 0x000d });
    expect(await refusalOf(h.client.getInfo('Carol'))).toEqual({ kind: 'refused', code: 0x000d });
  });

  it('refuses a screen name that cannot be asked about', async () => {
    await signOn();
    expect(await refusalOf(h.client.getInfo('  '))).toEqual({ kind: 'local', code: 'invalid-screen-name' });
    expect(await refusalOf(h.client.getInfo('a'.repeat(256)))).toEqual({ kind: 'local', code: 'invalid-screen-name' });
    await roundTrip();
    expect(queries()).toEqual([]);
  });
});

describe('the profile and away-message cache', () => {
  it("a Get Info reply caches a buddy's profile and away message and tells the listeners, and every Get Info asks the server again", async () => {
    const bob = awayPeer('Bob');
    bob.setProfile('<I>hello</I>');
    await signOn('Bob');
    ok(await h.client.getInfo('Bob'));
    expect(h.infos).toEqual([{ screenName: 'Bob', profile: [{ text: 'hello', italic: true }], awayMessage: text('brb') }]);
    // The peer's profile changed on the server and no presence update says so: Get Info still shows the new one.
    bob.setProfile('changed');
    const second = ok(await h.client.getInfo('Bob'));
    expect(queries()).toHaveLength(2);
    expect(second.profile).toEqual(text('changed'));
    expect(h.infos[1]).toEqual({ screenName: 'Bob', profile: text('changed'), awayMessage: text('brb') });
  });

  it('a Get Info reply for a buddy who is not away caches that there is no away message', async () => {
    server.peer('Bob');
    await signOn('Bob');
    await h.client.getInfo('Bob');
    expect(h.infos).toEqual([{ screenName: 'Bob', profile: [], awayMessage: null }]);
  });

  it('a presence update discards the cached profile, and a sign-off discards both', async () => {
    const bob = awayPeer('Bob');
    bob.setProfile('hello');
    await signOn('Bob');
    await h.client.getInfo('Bob');
    const heard = h.presence.length;

    bob.setIdle(5);
    await presenceEvents(heard + 1);
    expect(h.infos.slice(1)).toEqual([{ screenName: 'Bob', profile: null }]);
    expect(order).toContain('info:2');
    expect(order.indexOf('info:2')).toBe(order.indexOf(`presence:${heard + 1}`) - 1);
    await h.client.getInfo('Bob');
    expect(queries()).toHaveLength(2);
    expect(h.infos[2]).toEqual({ screenName: 'Bob', profile: text('hello'), awayMessage: text('brb') });

    bob.signOff();
    await presenceEvents(heard + 2);
    expect(h.infos.slice(3)).toEqual([{ screenName: 'Bob', profile: null, awayMessage: null }]);
  });

  it('nothing is cached for a screen name that is not on the buddy list', async () => {
    const carol = awayPeer('Carol');
    carol.setProfile('hello');
    await signOn();
    const first = ok(await h.client.getInfo('Carol'));
    const second = ok(await h.client.getInfo('Carol'));
    expect(first.profile).toEqual(text('hello'));
    expect(second).toEqual(first);
    expect(queries()).toHaveLength(2);
    expect(h.infos).toEqual([]);
  });

  it('forgets the cache when the session ends, with no events', async () => {
    const bob = awayPeer('Bob');
    bob.setProfile('hello');
    await signOn('Bob');
    await h.client.getInfo('Bob');
    await h.client.signOff();
    expect(h.infos).toHaveLength(1);
    await signOn('Bob');
    await h.client.getInfo('Bob');
    expect(queries()).toHaveLength(2);
  });
});

// The order in which the two kinds of event reached the listeners, as `info:<n>` and `presence:<n>`.
let order: string[] = [];
beforeEach(() => {
  order = [];
  h.client.on('buddyInfo', () => order.push(`info:${h.infos.length}`));
  h.client.on('presence', () => order.push(`presence:${h.presence.length}`));
});

describe('the away message of a hovered or selected buddy', () => {
  it('fetches an away message once per presence update', async () => {
    const bob = awayPeer('Bob');
    await signOn('Bob');
    await h.client.fetchAway('Bob');
    expect(queries()).toHaveLength(1);
    expect(queryType(queries()[0])).toBe(2);
    expect(h.infos).toEqual([{ screenName: 'Bob', awayMessage: text('brb') }]);

    await h.client.fetchAway('Bob');
    await roundTrip();
    expect(queries()).toHaveLength(1);

    const heard = h.presence.length;
    bob.setIdle(5);
    await presenceEvents(heard + 1);
    await roundTrip();
    expect(queries()).toHaveLength(1);
    expect(h.infos).toHaveLength(1);

    await h.client.fetchAway('Bob');
    expect(queries()).toHaveLength(2);
    expect(h.infos).toHaveLength(2);
    await h.client.fetchAway('Bob');
    await roundTrip();
    expect(queries()).toHaveLength(2);
  });

  it('a Get Info reply refreshes the away message, so the next hover fetches nothing', async () => {
    awayPeer('Bob');
    await signOn('Bob');
    await h.client.getInfo('Bob');
    await h.client.fetchAway('Bob');
    await roundTrip();
    expect(queries()).toHaveLength(1);
  });

  it('does not fetch for a buddy who is not away, for a stranger, or while a fetch is in flight', async () => {
    server.peer('Bob');
    awayPeer('Carol');
    awayPeer('Dave');
    await signOn('Bob', 'Dave');
    await h.client.fetchAway('Bob');
    await h.client.fetchAway('Carol');
    await h.client.fetchAway('Nobody');
    await roundTrip();
    expect(queries()).toEqual([]);

    const release = server.withhold(0x02, 0x06);
    let first = false;
    void h.client.fetchAway('Dave').then(() => {
      first = true;
    });
    await waitFor(() => queries().length === 1, 'the fetch');
    await h.client.fetchAway('dave');
    await roundTrip();
    expect([queries().length, first]).toEqual([1, false]);
    release();
    await waitFor(() => first, 'the fetch to settle');
    expect(h.infos).toEqual([{ screenName: 'Dave', awayMessage: text('brb') }]);
  });

  it('discards the away message when the away flag clears', async () => {
    const bob = awayPeer('Bob');
    await signOn('Bob');
    await h.client.fetchAway('Bob');
    bob.setAway(false);
    await infoEvents(2);
    expect(h.infos[1]).toEqual({ screenName: 'Bob', awayMessage: null });
    bob.setAwayMessage('lunch');
    await waitFor(() => h.client.presenceOf('Bob')?.away === true, 'the away arrival');
    await h.client.fetchAway('Bob');
    expect(queries()).toHaveLength(2);
    expect(h.infos[2]).toEqual({ screenName: 'Bob', awayMessage: text('lunch') });
  });

  it('a fetch that fails or is never answered stores nothing, and the next hover fetches again', async () => {
    awayPeer('Bob');
    await signOn('Bob');
    server.failNext(0x02, 0x15, { code: 0x000d });
    await h.client.fetchAway('Bob');
    expect(h.infos).toEqual([]);

    const release = server.withhold(0x02, 0x06);
    let settled = false;
    void h.client.fetchAway('Bob').then(() => {
      settled = true;
    });
    await waitFor(() => queries().length === 2, 'the second fetch');
    await timers.advance(15_000);
    expect([settled, h.infos]).toEqual([true, []]);
    release();

    await h.client.fetchAway('Bob');
    expect(queries()).toHaveLength(3);
    expect(h.infos).toEqual([{ screenName: 'Bob', awayMessage: text('brb') }]);
  });

  it('a hover fetch is dropped, not retried, when the class goes to alert', async () => {
    awayPeer('Bob');
    await signOn('Bob');
    const notices = (code: number): number => server.rateNotices('Alice').filter((n) => n.classId === 1 && n.code === code).length;
    for (let i = 0; i < 500 && notices(2) === 0; i++) server.spend('Alice', 1, 1);
    expect([notices(2), notices(3)]).toEqual([1, 0]);
    await roundTrip();

    await h.client.fetchAway('Bob');
    await roundTrip();
    expect(queries()).toEqual([]);

    for (let i = 0; i < 10 && notices(4) === 0; i++) {
      await timers.advance(30_000);
      server.rateTick('Alice');
    }
    expect(notices(4)).toBe(1);
    await roundTrip();
    await timers.advance(60_000);
    await roundTrip();
    expect(queries()).toEqual([]);
    expect(h.infos).toEqual([]);

    await h.client.fetchAway('Bob');
    expect(queries()).toHaveLength(1);
  });

  it('a hover fetch waits behind a Get Info asked after it', async () => {
    awayPeer('Bob');
    server.peer('Carol');
    await signOn('Bob');
    // The test server has read what sign-on wrote in the class, the request for stored messages last, before the test moves its level.
    await roundTrip();
    // The class is at its alert level: each send has to wait for the level to recover first.
    server.setRateParams('Alice', 1, { currentLevel: 2000 });
    await roundTrip();
    const fetch = h.client.fetchAway('Bob');
    const info = h.client.getInfo('Carol');
    await roundTrip();
    expect(queries()).toEqual([]);
    // The next timer is the class's pacing. The clock goes to it and waits there until the test server has read the send it let go.
    // Then no send is on its way when the clock moves on and counted late.
    for (const count of [1, 2]) {
      await timers.advance(timers.pending()[0] ?? 0);
      await waitFor(() => queries().length === count, `paced query ${count}`);
    }
    await Promise.all([fetch, info]);
    expect(queries().map(queryType)).toEqual([3, 2]);
    expect(server.rateNotices('Alice').filter((n) => n.code !== 1)).toEqual([]);
  });

  it('a hover sweep neither delays nor drops IMs', async () => {
    await h.client.signOff();
    const names = Array.from({ length: 30 }, (_, i) => `Buddy${String(i + 1).padStart(2, '0')}`);
    server.setFeedbag('alice', buddies(names.map((name) => name.toLowerCase())));
    for (const name of names) awayPeer(name);
    await signOn(...names);

    const fetches = names.map((name) => h.client.fetchAway(name));
    // No time passes: an IM that waits behind the sweep is never acknowledged.
    await h.client.sendIm('Buddy01', text('hello'));
    await Promise.all(fetches);
    expect(queries()).toHaveLength(30);
    expect(h.infos).toHaveLength(30);
    expect(server.dropped('Alice')).toBe(0);
    expect(server.rateNotices('Alice').filter((n) => n.classId === 3)).toEqual([]);
  });

  it('never sends the older info query', async () => {
    const bob = awayPeer('Bob');
    bob.setProfile('hello');
    server.peer('Carol');
    await signOn('Bob');
    await h.client.fetchAway('Bob');
    await h.client.getInfo('Bob');
    await h.client.getInfo('Carol');
    await h.client.getInfo('Nobody');
    await roundTrip();
    expect(queries().map(queryType)).toEqual([2, 3, 3, 3]);
    expect(fromAlice(0x02, 0x05)).toEqual([]);
  });
});

afterEach(() => {
  expect(fromAlice(0x02, 0x05)).toEqual([]);
});
