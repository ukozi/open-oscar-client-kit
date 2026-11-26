import { afterEach, describe, expect, it } from 'vitest';
import { BART_FOOD_GROUP, BOS_FOOD_GROUPS } from '../../src/client/sign-on.js';
import { concatBytes, toHex } from '../../src/wire/bytes.js';
import { CAP_CHAT, CAP_MOBILE_CLIENT, CAP_UTF8_MESSAGES } from '../../src/wire/constants.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeHostVersions, decodeUserInfoUpdate, encodeClientOnline, encodeClientVersions } from '../../src/wire/oservice.js';
import { decodeRateParamChange, decodeRateParamsReply } from '../../src/wire/rate.js';
import { decodeSnac } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { decodeTlvs, findTlv, tlv } from '../../src/wire/tlv.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord, StartOptions } from '../fake/oscar-server.js';

const MULTI_SESSION = 0x01;
const PHONE_CAPS = [CAP_UTF8_MESSAGES, CAP_CHAT, CAP_MOBILE_CLIENT];
const BUDDIES: FeedbagItem = { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] };
const BOB: FeedbagItem = { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] };

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;
const raw: RawClient[] = [];

async function start(server: StartOptions = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ ...server, now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([BUDDIES, BOB]));
  bob = fake.peer('Bob');
  bob.watch('Alice');
}

afterEach(async () => {
  await stopAllClients();
  for (const client of raw.splice(0)) client.close();
  await fake.stop();
});

const first = (family: number, subtype: number): SnacRecord | undefined =>
  fake.snacsFrom('alice').find((s) => s.conn === 'bos' && s.family === family && s.subtype === subtype);
const bodyOf = (snac: SnacRecord | undefined): Uint8Array => snac?.body ?? new Uint8Array(0);
const families = [...BOS_FOOD_GROUPS, BART_FOOD_GROUP];

describe('OService version of a client', () => {
  it('asks for OService 4 and reads the 35-byte rate records it is granted', async () => {
    await start();
    h = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await h.signOn();
    expect(toHex(bodyOf(first(1, 0x17))).slice(0, 8)).toBe('00010004');
    expect([h.client.oserviceVersion, fake.oserviceVersionOf('alice', 0)]).toEqual([4, 4]);
    await h.client.sendIm('Bob', [{ text: 'hi' }]);
    expect(bob.ims().map((im) => im.html)).toEqual(['hi']);
  });

  it('changes only the OService version, in the versions and in the online announcement', async () => {
    await start();
    h = makeClient(fake, { timers, oserviceVersion: 4 });
    await h.signOn();
    const versionOf = (family: number): number => (family === 1 ? 4 : 1);
    expect(toHex(bodyOf(first(1, 0x17)))).toBe(toHex(encodeClientVersions(families, versionOf)));
    expect(toHex(bodyOf(first(1, 0x02)))).toBe(toHex(encodeClientOnline(families, versionOf)));
  });

  it('advertises the capabilities it was given', async () => {
    await start();
    h = makeClient(fake, { timers, capabilities: PHONE_CAPS });
    await h.signOn();
    expect(toHex(findTlv(decodeTlvs(bodyOf(first(2, 0x04))), 0x05) ?? new Uint8Array(0))).toBe(toHex(concatBytes(PHONE_CAPS)));
  });

  it('stays on version 1 when the server grants no more', async () => {
    await start({ oserviceMax: 1 });
    h = makeClient(fake, { timers, oserviceVersion: 4 });
    await h.signOn();
    expect([h.client.oserviceVersion, fake.oserviceVersionOf('alice', 0)]).toEqual([1, 1]);
    await h.client.sendIm('Bob', [{ text: 'hi' }]);
    expect(bob.ims().map((im) => im.html)).toEqual(['hi']);
  });

  it('a client with no options announces version 1 and its two capabilities', async () => {
    await start();
    h = makeClient(fake, { timers });
    await h.signOn();
    expect(toHex(bodyOf(first(1, 0x17)))).toBe(toHex(encodeClientVersions(families)));
    expect(toHex(findTlv(decodeTlvs(bodyOf(first(2, 0x04))), 0x05) ?? new Uint8Array(0))).toBe(toHex(concatBytes([CAP_UTF8_MESSAGES, CAP_CHAT])));
    expect([h.client.oserviceVersion, fake.oserviceVersionOf('alice', 0)]).toEqual([1, 1]);
  });

  it('announces the negotiated OService version on a directory connection, and the list of instances stays', async () => {
    await start();
    h = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await h.signOn();
    await h.client.directoryKeywords();
    const odir = fake.snacsFrom('alice').filter((s) => s.conn === 'odir' && s.family === 1 && (s.subtype === 0x17 || s.subtype === 0x02));
    expect(odir.map((s) => [s.subtype, toHex(s.body).slice(0, 8)])).toEqual([
      [0x17, '00010004'],
      [0x02, '00010004'],
    ]);
    expect(fake.oserviceVersionOf('alice', 0)).toBe(4);
    const info = await h.client.queryUserInfo();
    expect([info.instances.length, info.selfMatches]).toEqual([1, 1]);
  });

  it('announces version 1 on a directory connection when the server grants no more', async () => {
    await start({ oserviceMax: 1 });
    h = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await h.signOn();
    await h.client.directoryKeywords();
    const versions = fake.snacsFrom('alice').find((s) => s.conn === 'odir' && s.family === 1 && s.subtype === 0x17);
    expect(toHex(bodyOf(versions)).slice(0, 8)).toBe('00010001');
  });

  it('reports the version only while online, and negotiates it again after a drop', async () => {
    await start();
    h = makeClient(fake, { timers, random: () => 0, oserviceVersion: 4 });
    expect(h.client.oserviceVersion).toBeNull();
    await h.signOn();
    expect(h.client.oserviceVersion).toBe(4);
    fake.dropSocket('Alice');
    await waitFor(() => h.client.state === 'reconnecting', 'the client to notice the drop');
    expect(h.client.oserviceVersion).toBeNull();
    await timers.advance(2_000);
    await waitFor(() => h.client.state === 'online', 'the client to be online again');
    expect(h.client.oserviceVersion).toBe(4);
    await h.client.signOff();
    expect(h.client.oserviceVersion).toBeNull();
  });
});

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

let marker = 0x7000;
async function request(client: RawClient, family: number, subtype: number, body?: Uint8Array): Promise<Snac> {
  const requestId = marker++;
  client.snac(family, subtype, requestId, body);
  await waitFor(() => snacsOf(client).some((s) => s.requestId === requestId), `a reply to request ${requestId}`);
  const found = snacsOf(client).find((s) => s.requestId === requestId);
  if (!found) throw new Error('no reply');
  return found;
}

// A BOS connection that announces `oservice` and nothing else before it asks for the rate classes.
async function bos(oservice: number): Promise<{ client: RawClient; versions: Map<number, number>; rates: Snac }> {
  const { tlvs, client: auth } = await RawClient.login(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
  auth.close();
  const cookie = findTlv(tlvs, 0x06);
  if (!cookie) throw new Error('login failed');
  const client = await RawClient.connect(fake.port);
  raw.push(client);
  client.signon([tlv.bytes(0x06, cookie)]);
  await client.nextSnac();
  const reply = await request(client, 1, 0x17, encodeClientVersions([1, 2, 3, 4], (f) => (f === 1 ? oservice : 1)));
  const rates = await request(client, 1, 0x06);
  client.snac(1, 0x08, marker++, new Uint8Array([0, 3]));
  // The test server reads one connection's SNACs in order, so this reply means the subscription is in.
  await request(client, 1, 0x0e);
  return { client, versions: decodeHostVersions(reply.body), rates };
}

describe('the test server and the OService version', () => {
  it('replaces the versions of an instance when a service connection of it announces versions', async () => {
    await start();
    const { client } = await bos(4);
    expect(decodeUserInfoUpdate((await request(client, 1, 0x0e)).body)).toHaveLength(2);
    const service = await RawClient.service(fake.port, await client.requestService(0x000f));
    raw.push(service);
    await service.nextSnac();
    service.snac(1, 0x17, marker++, encodeClientVersions([0x0001, 0x000f]));
    await waitFor(() => fake.oserviceVersionOf('alice', 0) === 1, 'the instance at version 1');
    expect(decodeUserInfoUpdate((await request(client, 1, 0x0e)).body)).toHaveLength(1);
  });

  it('grants the lower of the version asked for and its maximum, to each connection of an account', async () => {
    await start({ oserviceMax: 3 });
    const a = await bos(4);
    const b = await bos(1);
    expect([...a.versions]).toEqual([[1, 3], [2, 1], [3, 1], [4, 1]]);
    expect([...b.versions]).toEqual([[1, 1], [2, 1], [3, 1], [4, 1]]);
    expect([fake.oserviceVersionOf('alice', 0), fake.oserviceVersionOf('alice', 1)]).toEqual([3, 1]);
    expect(() => fake.oserviceVersionOf('alice', 2)).toThrow('has no instance 2');
  });

  it('writes 35-byte rate records to a connection granted more than version 1, and 30-byte ones to the rest', async () => {
    await start();
    const a = await bos(4);
    const b = await bos(1);
    expect(decodeRateParamsReply(a.rates.body, 4).classes).toHaveLength(5);
    expect(decodeRateParamsReply(b.rates.body).classes).toHaveLength(5);
    expect(a.rates.body.length - b.rates.body.length).toBe(5 * 5);

    fake.setRateParams('alice', 3, { limitLevel: 4100 });
    const notice = async (client: RawClient): Promise<Snac> => {
      await waitFor(() => snacsOf(client).some((s) => s.family === 1 && s.subtype === 0x0a), 'a rate notice');
      const found = snacsOf(client).find((s) => s.family === 1 && s.subtype === 0x0a);
      if (!found) throw new Error('no notice');
      return found;
    };
    const [forA, forB] = [await notice(a.client), await notice(b.client)];
    expect([forA.body.length, forB.body.length]).toEqual([2 + 35, 2 + 30]);
    expect(decodeRateParamChange(forA.body).params).toEqual(decodeRateParamChange(forB.body).params);
    expect(decodeRateParamChange(forA.body).params).toMatchObject({ id: 3, limitLevel: 4100 });
  });
});
