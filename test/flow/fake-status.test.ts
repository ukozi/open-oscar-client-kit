import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../../src/wire/bytes.js';
import { ICBM_CHANNEL_IM, ICBM_TLV_IM_DATA, ICBM_TLV_SEND_TIME } from '../../src/wire/constants.js';
import { FEEDBAG_ATTR_PD_MODE } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeImFragments, decodeImToClient, decodeWarnReply, encodeImFragments, encodeTyping, encodeWarn } from '../../src/wire/icbm.js';
import { LOCATE_MIME, decodeUserInfoReply, encodeAway, encodeUserInfoQuery } from '../../src/wire/locate.js';
import { decodeEvilNotification, encodeIdle, encodeStatus, userStatus } from '../../src/wire/oservice.js';
import { decodeRateParamChange, decodeRateParamsReply } from '../../src/wire/rate.js';
import { decodeSnac, decodeUserInfo } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { decodeWireText, encodeImText } from '../../src/wire/text.js';
import { encodeTlvs, tlv, tlvU32 } from '../../src/wire/tlv.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { Sighting } from '../fake/oscar-server.js';

const MULTI_SESSION = 0x01;
const SERVER_REQUEST_ID = 0x80000000;
const NOTICE_SENDER = 'OOS System Msg';
const PROFILE_AND_AWAY = 3;

const deny = (name: string): FeedbagItem => ({ name, groupId: 0, itemId: 0x31, classId: 3, attrs: [] });
const denySome: FeedbagItem = { name: '', groupId: 0, itemId: 0x41, classId: 4, attrs: [tlv.u8(FEEDBAG_ATTR_PD_MODE, 4)] };

let fake: FakeOscarServer;
let marker = 0x7000;
beforeEach(async () => {
  fake = await FakeOscarServer.start();
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Carol', 'carolpw1');
});
afterEach(async () => {
  await fake.stop();
});

const session = (name = 'Alice'): Promise<RawClient> => RawClient.signOn(fake.port, name, `${name.toLowerCase()}pw1`, MULTI_SESSION);

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

const received = (client: RawClient, family: number, subtype: number): Snac[] =>
  snacsOf(client).filter((s) => s.family === family && s.subtype === subtype);

async function request(client: RawClient, family: number, subtype: number, body?: Uint8Array): Promise<Snac> {
  const requestId = marker++;
  client.snac(family, subtype, requestId, body);
  await waitFor(() => snacsOf(client).some((s) => s.requestId === requestId), `a reply to request ${requestId}`);
  const found = snacsOf(client).find((s) => s.requestId === requestId);
  if (!found) throw new Error('no reply');
  return found;
}

// The test server handles one connection's SNACs in order, so when this echo is back it has handled everything the client sent before it.
const roundTrip = (client: RawClient): Promise<Snac> => request(client, 1, 0x17);

async function tell(client: RawClient, family: number, subtype: number, body: Uint8Array): Promise<void> {
  client.snac(family, subtype, marker++, body);
  await roundTrip(client);
}

const setAway = (client: RawClient, text: string): Promise<void> => tell(client, 2, 0x04, encodeAway(text));
const setStatus = (client: RawClient, status: number): Promise<void> => tell(client, 1, 0x1e, encodeTlvs([tlv.u32(0x06, status)]));

const errorOf = (reply: Snac): number[] => [reply.family, reply.subtype, new ByteReader(reply.body).u16()];
const latin1 = (bytes: Uint8Array | undefined): string | undefined => (bytes ? Buffer.from(bytes).toString('latin1') : undefined);

const info = (client: RawClient, name: string, types = PROFILE_AND_AWAY): Promise<Snac> =>
  request(client, 2, 0x15, encodeUserInfoQuery(types, name));

function imBody(to: string, html: string): Uint8Array {
  const text = encodeImText(html);
  const tlvs = encodeTlvs([tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(text.charset, text.bytes))]);
  return new ByteWriter().u64(1n).u16(ICBM_CHANNEL_IM).str8(to).bytes(tlvs).toBytes();
}

async function sendIm(client: RawClient, to: string, html: string): Promise<void> {
  await tell(client, 4, 0x06, imBody(to, html));
}

type Im = { from: string; html: string; requestId: number; cookie: bigint; channel: number; senderTlvs: number; sentAt: number | undefined };

function imsOf(client: RawClient): Im[] {
  return received(client, 4, 0x07).map((snac) => {
    const im = decodeImToClient(snac.body);
    const data = im.tlvs.find((t) => t.tag === ICBM_TLV_IM_DATA)?.value ?? new Uint8Array(0);
    return {
      from: im.sender.name,
      html: decodeImFragments(data)
        .map((f) => decodeWireText(f.text, f.charset))
        .join(''),
      requestId: snac.requestId,
      cookie: im.cookie,
      channel: im.channel,
      senderTlvs: im.sender.tlvs.length,
      sentAt: tlvU32(im.tlvs, ICBM_TLV_SEND_TIME),
    };
  });
}

const imsFrom = (client: RawClient, from: string): string[] =>
  imsOf(client)
    .filter((im) => im.from === from)
    .map((im) => im.html);

const last = (sightings: Sighting[]): Sighting | undefined => sightings.at(-1);

describe('test server: away, profile and info', () => {
  it('an away message makes the account away to its watchers, and an empty one brings it back', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    const alice = await session();
    expect(bob.sightings()).toEqual([{ name: 'Alice', event: 'arrived', away: false, idleMinutes: null, warning: 0, icon: null }]);
    await setAway(alice, 'brb');
    expect(bob.sightings().length).toBe(2);
    expect(last(bob.sightings())).toEqual({ name: 'Alice', event: 'arrived', away: true, idleMinutes: null, warning: 0, icon: null });
    await setAway(alice, '');
    expect(bob.sightings().length).toBe(3);
    expect(last(bob.sightings())).toEqual({ name: 'Alice', event: 'arrived', away: false, idleMinutes: null, warning: 0, icon: null });
  });

  it('an account with two sessions is away only when both are', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    const first = await session();
    const second = await session();
    expect(bob.sightings().length).toBe(2);
    await setAway(first, 'brb');
    expect(bob.sightings().length).toBe(3);
    expect(bob.sightings().map((s) => s.away)).toEqual([false, false, false]);
    await setAway(second, 'lunch');
    expect(last(bob.sightings())?.away).toBe(true);
    const carol = await session('Carol');
    expect(latin1(decodeUserInfoReply((await info(carol, 'Alice')).body).away)).toBe('lunch');
  });

  // oservice.go:780-786: ClientOnline broadcasts the merged user info, so an idle account whose second session is not idle is no longer idle.
  it('an idle account whose second session signs on not idle arrives without idle', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    const first = await session();
    await tell(first, 1, 0x11, encodeIdle(600));
    expect(last(bob.sightings())?.idleMinutes).toBe(10);
    await session();
    expect(last(bob.sightings())).toEqual({ name: 'Alice', event: 'arrived', away: false, idleMinutes: null, warning: 0, icon: null });
  });

  it('the info reply carries the profile with its type and the away message only while away', async () => {
    const bob = fake.peer('Bob');
    bob.setProfile('<B>p</B>');
    bob.setAwayMessage('gone');
    const alice = await session();
    const reply = await info(alice, 'Bob');
    expect([reply.family, reply.subtype]).toEqual([0x02, 0x06]);
    const decoded = decodeUserInfoReply(reply.body);
    expect(decoded.info.name).toBe('Bob');
    expect(latin1(decoded.profile?.bytes)).toBe('<B>p</B>');
    expect(decoded.profile?.mime).toBe(LOCATE_MIME);
    expect(latin1(decoded.away)).toBe('gone');

    bob.setAwayMessage('');
    const back = decodeUserInfoReply((await info(alice, 'Bob')).body);
    expect(back.away).toBeUndefined();
    expect(latin1(back.profile?.bytes)).toBe('<B>p</B>');

    const carol = await session('Carol');
    await tell(carol, 2, 0x04, encodeTlvs([tlv.str(0x01, 'text/x-test'), tlv.str(0x02, 'mine')]));
    const hers = decodeUserInfoReply((await info(alice, 'Carol')).body);
    expect([hers.profile?.mime, latin1(hers.profile?.bytes)]).toEqual(['text/x-test', 'mine']);
    expect(decodeUserInfoReply((await info(alice, 'Carol', 2)).body).profile).toBeUndefined();
  });

  it('an info query for someone offline or blocked either way is answered not available', async () => {
    fake.peer('Bob');
    const alice = await session();
    expect(errorOf(await info(alice, 'Carol'))).toEqual([0x02, 0x01, 0x0004]);

    expect((await info(alice, 'Bob')).subtype).toBe(0x06);
    fake.setFeedbag('Alice', [deny('bob'), denySome]);
    expect(errorOf(await info(alice, 'Bob'))).toEqual([0x02, 0x01, 0x0004]);
    fake.setFeedbag('Alice', []);
    fake.setFeedbag('Bob', [deny('alice'), denySome]);
    expect(errorOf(await info(alice, 'Bob'))).toEqual([0x02, 0x01, 0x0004]);
    fake.setFeedbag('Bob', []);
    expect((await info(alice, 'Bob')).subtype).toBe(0x06);
  });

  it('the newer info query is rate class 1 and the older one class 3', async () => {
    const bob = fake.peer('Bob');
    bob.setProfile('about me');
    bob.setAwayMessage('out');
    const alice = await session();
    const rates = decodeRateParamsReply((await request(alice, 1, 0x06)).body);
    expect(rates.classOf(2, 0x15)).toBe(1);
    expect(rates.classOf(2, 0x05)).toBe(3);

    const newer = await info(alice, 'Bob');
    const older = await request(alice, 2, 0x05, new ByteWriter().u16(PROFILE_AND_AWAY).str8('Bob').toBytes());
    expect([older.family, older.subtype]).toEqual([0x02, 0x06]);
    expect(Buffer.from(older.body).toString('hex')).toBe(Buffer.from(newer.body).toString('hex'));
    expect(latin1(decodeUserInfoReply(older.body).away)).toBe('out');
  });
});

describe('test server: status and idle', () => {
  it('going invisible sends a departure and an own-info update with the bit; coming back sends an arrival', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    const alice = await session();
    expect(bob.sightings().map((s) => s.event)).toEqual(['arrived']);

    await tell(alice, 1, 0x1e, encodeStatus(true));
    expect(bob.sightings().map((s) => s.event)).toEqual(['arrived', 'departed']);
    const updates = received(alice, 1, 0x0f).filter((s) => s.requestId === SERVER_REQUEST_ID);
    expect(updates.length).toBe(1);
    const own = decodeUserInfo(updates[0]?.body ?? new Uint8Array(0), 0).info;
    expect(own.name).toBe('Alice');
    expect(userStatus(own)).toBe(0x100);
    expect(userStatus(decodeUserInfo((await request(alice, 1, 0x0e)).body, 0).info)).toBe(0x100);

    await setAway(alice, 'brb');
    expect(bob.sightings().map((s) => s.event)).toEqual(['arrived', 'departed']);

    await tell(alice, 1, 0x1e, encodeStatus(false));
    expect(bob.sightings().map((s) => s.event)).toEqual(['arrived', 'departed', 'arrived']);
    expect(last(bob.sightings())).toEqual({ name: 'Alice', event: 'arrived', away: true, idleMinutes: null, warning: 0, icon: null });
    const after = received(alice, 1, 0x0f).filter((s) => s.requestId === SERVER_REQUEST_ID);
    expect(after.map((s) => userStatus(decodeUserInfo(s.body, 0).info))).toEqual([0x100, 0]);
  });

  it('an invisible account still answers an info query', async () => {
    const bob = fake.peer('Bob');
    const dave = fake.peer('Dave');
    dave.watch('Bob');
    bob.setProfile('still here');
    bob.setInvisible(true);
    expect(last(dave.sightings())?.event).toBe('departed');
    const alice = await session();
    const reply = await info(alice, 'Bob');
    expect([reply.family, reply.subtype]).toEqual([0x02, 0x06]);
    expect(latin1(decodeUserInfoReply(reply.body).profile?.bytes)).toBe('still here');
    fake.setFeedbag('Carol', [{ name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] }]);
    const carol = await session('Carol');
    await roundTrip(carol);
    expect(received(carol, 3, 0x0b)).toEqual([]);
    bob.setInvisible(false);
    await waitFor(() => received(carol, 3, 0x0b).length === 1, "Bob's arrival");
    expect(last(dave.sightings())?.event).toBe('arrived');
  });

  it('a status that drops an away bit erases the away message', async () => {
    const alice = await session();
    const carol = await session('Carol');
    await setStatus(alice, 0x01);
    await setAway(alice, 'brb');
    expect(latin1(decodeUserInfoReply((await info(carol, 'Alice')).body).away)).toBe('brb');
    await setStatus(alice, 0);
    expect(decodeUserInfoReply((await info(carol, 'Alice')).body).away).toBeUndefined();
    await setStatus(alice, 0x01);
    expect(latin1(decodeUserInfoReply((await info(carol, 'Alice')).body).away)).toBe('');
  });

  it('idle is announced in whole minutes and cleared by zero', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    const alice = await session();
    await tell(alice, 1, 0x11, encodeIdle(600));
    expect(bob.sightings().length).toBe(2);
    expect(last(bob.sightings())).toEqual({ name: 'Alice', event: 'arrived', away: false, idleMinutes: 10, warning: 0, icon: null });
    await tell(alice, 1, 0x11, encodeIdle(0));
    expect(bob.sightings().length).toBe(3);
    expect(last(bob.sightings())?.idleMinutes).toBeNull();
  });
});

describe('test server: typing and IM delivery', () => {
  it("typing is relayed with the sender's display name, and not at all when either side blocks", async () => {
    const bob = fake.peer('Bob');
    const alice = await session();
    await tell(alice, 4, 0x14, encodeTyping('Bob', 2));
    expect(bob.typingEvents()).toEqual([{ from: 'Alice', event: 2 }]);

    fake.setFeedbag('Alice', [deny('bob'), denySome]);
    await tell(alice, 4, 0x14, encodeTyping('Bob', 1));
    fake.setFeedbag('Alice', []);
    fake.setFeedbag('Bob', [deny('alice'), denySome]);
    await tell(alice, 4, 0x14, encodeTyping('Bob', 1));
    bob.sendTyping('Alice', 2, 9);
    await roundTrip(alice);
    expect(bob.typingEvents()).toEqual([{ from: 'Alice', event: 2 }]);
    expect(received(alice, 4, 0x14)).toEqual([]);

    fake.setFeedbag('Bob', []);
    await tell(alice, 4, 0x14, encodeTyping('Bob', 0));
    expect(bob.typingEvents()).toEqual([
      { from: 'Alice', event: 2 },
      { from: 'Alice', event: 0 },
    ]);
  });

  it('typing reaches only sessions that are neither away nor idle', async () => {
    const bob = fake.peer('Bob');
    const first = await session();
    const second = await session();
    const typing = (client: RawClient): number[] => received(client, 4, 0x14).map((s) => s.requestId);

    await setAway(first, 'brb');
    await tell(second, 1, 0x11, encodeIdle(60));
    bob.sendTyping('Alice', 2, 9);
    await roundTrip(first);
    await roundTrip(second);
    expect([typing(first), typing(second)]).toEqual([[], []]);

    await tell(second, 1, 0x11, encodeIdle(0));
    bob.sendTyping('Alice', 2, 10);
    await roundTrip(first);
    await roundTrip(second);
    expect([typing(first), typing(second)]).toEqual([[], [10]]);

    await setAway(first, '');
    bob.sendTyping('Alice', 2, 11);
    await roundTrip(first);
    await roundTrip(second);
    expect([typing(first), typing(second)]).toEqual([[11], [10, 11]]);
  });

  it('an IM goes to the active sessions only, and to all when none is active', async () => {
    const bob = fake.peer('Bob');
    const first = await session();
    const second = await session();
    await setAway(first, 'brb');
    bob.sendIm('Alice', 'one');
    await roundTrip(first);
    await roundTrip(second);
    expect([imsFrom(first, 'Bob'), imsFrom(second, 'Bob')]).toEqual([[], ['one']]);

    await tell(second, 1, 0x11, encodeIdle(60));
    bob.sendIm('Alice', 'two');
    await roundTrip(first);
    await roundTrip(second);
    expect([imsFrom(first, 'Bob'), imsFrom(second, 'Bob')]).toEqual([['two'], ['one', 'two']]);
  });
});

describe('test server: warnings', () => {
  const warn = (client: RawClient, name: string): Promise<Snac> => request(client, 4, 0x08, encodeWarn(name));
  const accepted = (reply: Snac): unknown => (reply.subtype === 0x09 ? decodeWarnReply(reply.body) : errorOf(reply));

  it('a warning needs a live IM from the target, is allowed once per IM up to three, and raises the level by 10%', async () => {
    const bob = fake.peer('Bob');
    const alice = await session();
    expect(errorOf(await warn(alice, 'Bob'))).toEqual([0x04, 0x01, 0x000d]);

    bob.sendIm('Alice', 'x');
    const reply = await warn(alice, 'Bob');
    expect([reply.family, reply.subtype]).toEqual([0x04, 0x09]);
    expect(decodeWarnReply(reply.body)).toEqual({ delta: 100, level: 100 });
    expect(errorOf(await warn(alice, 'Bob'))).toEqual([0x04, 0x01, 0x000d]);

    for (let i = 0; i < 4; i++) bob.sendIm('Alice', 'x');
    expect(accepted(await warn(alice, 'Bob'))).toEqual({ delta: 100, level: 200 });
    expect(accepted(await warn(alice, 'Bob'))).toEqual({ delta: 100, level: 300 });
    expect(errorOf(await warn(alice, 'Bob'))).toEqual([0x04, 0x01, 0x000d]);
  });

  it('a stored IM does not allow a warning', async () => {
    const bob = fake.peer('Bob');
    fake.storeOffline('Alice', 'Bob', 'while you were out', 1_790_000_000);
    const alice = await session();
    await request(alice, 4, 0x10);
    expect(imsFrom(alice, 'bob')).toEqual(['while you were out']);
    expect(errorOf(await warn(alice, 'Bob'))).toEqual([0x04, 0x01, 0x000d]);
    bob.sendIm('Alice', 'now');
    expect(accepted(await warn(alice, 'Bob'))).toEqual({ delta: 100, level: 100 });
  });

  it('the warned account is told the level and the warner, its IM rate levels rise, and its watchers see the level', async () => {
    const bob = fake.peer('Bob');
    const dave = fake.peer('Dave');
    dave.watch('Alice');
    const alice = await session();
    alice.snac(1, 0x08, marker++, new ByteWriter().u16(1).u16(2).u16(3).u16(4).u16(5).toBytes());
    await sendIm(alice, 'Bob', 'one');
    await sendIm(alice, 'Bob', 'two');

    bob.warn('Alice');
    await roundTrip(alice);
    const notices = (): Snac[] => received(alice, 1, 0x10);
    expect(notices().length).toBe(1);
    expect(notices()[0]?.requestId).toBe(0);
    expect(decodeEvilNotification(notices()[0]?.body ?? new Uint8Array(0))).toEqual({ level: 100, by: 'Bob' });
    const changes = received(alice, 1, 0x0a).map((s) => decodeRateParamChange(s.body));
    expect(changes.length).toBe(1);
    expect(changes[0]?.code).toBe(1);
    expect(changes[0]?.params).toMatchObject({ id: 3, limitLevel: 4185, clearLevel: 5175, alertLevel: 5085, disconnectLevel: 3000, maxLevel: 6000 });
    expect(last(dave.sightings())).toEqual({ name: 'Alice', event: 'arrived', away: false, idleMinutes: null, warning: 100, icon: null });

    bob.warn('Alice', true);
    await roundTrip(alice);
    expect(notices().length).toBe(2);
    expect(decodeEvilNotification(notices()[1]?.body ?? new Uint8Array(0))).toEqual({ level: 130, by: null });
    expect(last(dave.sightings())?.warning).toBe(130);

    bob.warn('Alice');
    await roundTrip(alice);
    expect(notices().length).toBe(2);
  });

  it('a warning to someone offline or blocked is answered not available, and to oneself 0x08', async () => {
    const bob = fake.peer('Bob');
    const alice = await session();
    bob.sendIm('Alice', 'x');
    expect(errorOf(await warn(alice, 'Carol'))).toEqual([0x04, 0x01, 0x0004]);
    expect(errorOf(await warn(alice, 'alice'))).toEqual([0x04, 0x01, 0x0008]);

    fake.setFeedbag('Alice', [deny('bob'), denySome]);
    expect(errorOf(await warn(alice, 'Bob'))).toEqual([0x04, 0x01, 0x0004]);
    fake.setFeedbag('Alice', []);
    fake.setFeedbag('Bob', [deny('alice'), denySome]);
    expect(errorOf(await warn(alice, 'Bob'))).toEqual([0x04, 0x01, 0x0004]);
    fake.setFeedbag('Bob', []);
    bob.signOff();
    expect(errorOf(await warn(alice, 'Bob'))).toEqual([0x04, 0x01, 0x0004]);
    bob.signOn();
    expect(accepted(await warn(alice, 'Bob'))).toEqual({ delta: 100, level: 100 });
  });
});

describe('test server: offline messages and notices', () => {
  it("stored IMs are replayed to the session that asks, with the time they were sent and the sender's normalised name, then deleted", async () => {
    fake.storeOffline('Alice', 'Bob Smith', 'hi', 1_790_000_000);
    const first = await session();
    const second = await session();
    await roundTrip(first);
    expect(imsOf(first).filter((im) => im.from !== NOTICE_SENDER)).toEqual([]);

    const done = await request(first, 4, 0x10);
    expect([done.family, done.subtype, done.body.length]).toEqual([0x04, 0x17, 0]);
    const stored = imsOf(first).filter((im) => im.from !== NOTICE_SENDER);
    expect(stored).toEqual([
      { from: 'bobsmith', html: 'hi', requestId: SERVER_REQUEST_ID, cookie: stored[0]?.cookie, channel: 1, senderTlvs: 0, sentAt: 1_790_000_000 },
    ]);
    const order = snacsOf(first).filter((s) => s.family === 4 && (s.subtype === 0x17 || (s.subtype === 0x07 && decodeImToClient(s.body).sender.name === 'bobsmith')));
    expect(order.map((s) => s.subtype)).toEqual([0x07, 0x17]);
    expect(fake.storedFor('Alice')).toEqual([]);

    const again = await request(first, 4, 0x10);
    expect([again.family, again.subtype]).toEqual([0x04, 0x17]);
    expect(imsOf(first).filter((im) => im.from !== NOTICE_SENDER).length).toBe(1);
    await roundTrip(second);
    expect(imsOf(second).filter((im) => im.from !== NOTICE_SENDER)).toEqual([]);
  });

  it("the server's own notices arrive from OOS System Msg", async () => {
    fake.storeOffline('Alice', 'Bob', 'hi', 1_790_000_000);
    const first = await session();
    await waitFor(() => imsOf(first).length === 1, 'the offline notice');
    expect(imsOf(first)).toEqual([
      {
        from: NOTICE_SENDER,
        html: 'You just received 1 IM(s) while you were offline. If you do not wish to receive offline messages, please go to <a href="https://example.invalid/">IM Settings</a>.',
        requestId: SERVER_REQUEST_ID,
        cookie: 0n,
        channel: 1,
        senderTlvs: 0,
        sentAt: undefined,
      },
    ]);

    const second = await session();
    await waitFor(() => imsOf(first).length === 2, 'the multiple sign-on notice');
    expect(imsOf(first)[1]?.from).toBe(NOTICE_SENDER);
    expect(imsOf(first)[1]?.html).toBe(
      'Your screen name (Alice) is now signed into Open OSCAR Server in 2 locations. Click <a href="https://example.invalid/">here</a> for more information.',
    );
    // The session that just came on hears neither: the server reported the count once, and the other notice is for the others.
    await roundTrip(second);
    expect(imsOf(second)).toEqual([]);

    await fake.stop();
    fake = await FakeOscarServer.start({ notices: false });
    fake.addUser('Alice', 'alicepw1');
    fake.storeOffline('Alice', 'Bob', 'hi', 1_790_000_000);
    const quiet = await session();
    const other = await session();
    await roundTrip(quiet);
    await roundTrip(other);
    expect([imsOf(quiet), imsOf(other)]).toEqual([[], []]);
  });
});
