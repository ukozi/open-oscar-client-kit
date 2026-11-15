import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ByteWriter, toHex } from '../../src/wire/bytes.js';
import { decodeHostAck, decodeImFragments, decodeImToClient } from '../../src/wire/icbm.js';
import { decodeRateParamChange } from '../../src/wire/rate.js';
import { decodeSnac } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { findTlv, hasTlv } from '../../src/wire/tlv.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { bytesOf, loadVectors } from '../support/vectors.js';

const icbm = loadVectors('icbm.json');
const VECTOR_COOKIE = 0x1122334455667788n;
// Cookie u64, channel u16, then the recipient "alice" with its length byte: the TLVs start at 16.
const VECTOR_TLVS_AT = 16;
const MULTI_SESSION = 0x01;

let t = 1_800_000_000_000;
let server: FakeOscarServer;
beforeEach(async () => {
  t = 1_800_000_000_000;
  server = await FakeOscarServer.start({ now: () => t });
  server.addUser('alice', 'pw');
});
afterEach(async () => {
  await server?.stop();
});

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

function of(client: RawClient, family: number, subtype: number): Snac[] {
  return snacsOf(client).filter((s) => s.family === family && s.subtype === subtype);
}

// The test server handles one connection's SNACs in order, so when this echo is back, all it wrote to this client before has arrived too.
let marker = 0x7000;
async function roundTrip(client: RawClient): Promise<void> {
  const requestId = marker++;
  client.snac(1, 0x17, requestId);
  await waitFor(() => snacsOf(client).some((s) => s.subtype === 0x18 && s.requestId === requestId), 'the version echo');
}

async function session(name: string, classes: number[] = [1, 2, 3, 4, 5]): Promise<RawClient> {
  const client = await RawClient.signOn(server.port, name, 'pw', MULTI_SESSION);
  const w = new ByteWriter();
  for (const id of classes) w.u16(id);
  client.snac(1, 0x08, marker++, w.toBytes());
  await roundTrip(client);
  return client;
}

function imBody(vectorName: string, to: string): Uint8Array {
  const body = bytesOf(icbm, vectorName);
  return new ByteWriter().bytes(body.subarray(0, 10)).str8(to).bytes(body.subarray(VECTOR_TLVS_AT)).toBytes();
}

const STORED = 'message to host body, offline recipient';
const NOT_STORED = 'message to host body, online recipient';

async function replyTo(client: RawClient, requestId: number): Promise<Snac> {
  await waitFor(() => snacsOf(client).some((s) => s.requestId === requestId), `a reply to request ${requestId}`);
  const found = snacsOf(client).find((s) => s.requestId === requestId);
  if (!found) throw new Error('no reply');
  return found;
}

async function sendIm(client: RawClient, vectorName: string, to: string): Promise<Snac> {
  const requestId = marker++;
  client.snac(4, 0x06, requestId, imBody(vectorName, to));
  return replyTo(client, requestId);
}

async function notices(client: RawClient, count: number): Promise<ReturnType<typeof decodeRateParamChange>[]> {
  await waitFor(() => of(client, 1, 0x0a).length >= count, `rate notice ${count}`);
  await roundTrip(client);
  const found = of(client, 1, 0x0a);
  expect(found.map((s) => s.requestId)).toEqual(found.map(() => 0x80000000));
  return found.map((s) => decodeRateParamChange(s.body));
}

describe('test server: IM routing', () => {
  it('relays an IM without the ack, store and time TLVs and acknowledges on the request id', async () => {
    const bob = server.peer('bob');
    const alice = await session('alice');
    const ack = await sendIm(alice, STORED, 'bob');
    await waitFor(() => bob.ims().length === 1, 'the relayed IM');
    const [im] = bob.ims();
    expect(im?.from).toBe('alice');
    expect(im?.html).toBe('hi');
    expect(im?.charset).toBe(0);
    expect(hasTlv(im?.tlvs ?? [], 0x02)).toBe(true);
    expect(hasTlv(im?.tlvs ?? [], 0x03)).toBe(false);
    expect(hasTlv(im?.tlvs ?? [], 0x06)).toBe(false);
    expect([ack.family, ack.subtype]).toEqual([0x04, 0x0c]);
    expect(decodeHostAck(ack.body)).toEqual({ cookie: VECTOR_COOKIE, channel: 1, screenName: 'bob' });
  });

  it('delivers to every instance of the recipient', async () => {
    const bob = server.peer('bob');
    const first = await session('alice');
    const second = await session('alice');
    expect(server.instancesOf('alice')).toBe(2);
    bob.sendIm('alice', 'yo');
    const senders = (instance: RawClient): string[] => of(instance, 4, 0x07).map((s) => decodeImToClient(s.body).sender.name);
    await waitFor(() => senders(first).length === 2, 'the notice and the IM');
    await waitFor(() => senders(second).length === 1, 'the IM');
    expect([senders(first), senders(second)]).toEqual([['OOS System Msg', 'bob'], ['bob']]);
    for (const instance of [first, second]) {
      const im = of(instance, 4, 0x07).at(-1);
      expect(im?.requestId).toBe(0x80000000);
      const message = decodeImToClient(im?.body ?? new Uint8Array(0));
      expect(message.sender.name).toBe('bob');
      expect(message.channel).toBe(1);
      expect(decodeImFragments(findTlv(message.tlvs, 0x02) ?? new Uint8Array(0))).toEqual([{ charset: 0, text: new Uint8Array(Buffer.from('yo')) }]);
    }
  });

  it('stores for an offline account and refuses the eleventh', async () => {
    server.addUser('carol', 'pw');
    const alice = await session('alice');
    for (let i = 0; i < 10; i++) {
      t += 10_000;
      const ack = await sendIm(alice, STORED, 'carol');
      expect([ack.family, ack.subtype]).toEqual([0x04, 0x0c]);
      expect(decodeHostAck(ack.body)).toEqual({ cookie: VECTOR_COOKIE, channel: 1, screenName: 'carol' });
    }
    const stored = server.storedFor('carol');
    expect(stored.length).toBe(10);
    expect(stored[0]?.sender).toBe('alice');
    expect(stored[0]?.cookie).toBe(VECTOR_COOKIE);
    expect(stored[0]?.channel).toBe(1);
    expect(stored[0]?.tlvs.map((entry) => entry.tag)).toEqual([0x02, 0x03, 0x06]);
    t += 10_000;
    const refusal = await sendIm(alice, STORED, 'carol');
    expect([refusal.family, refusal.subtype]).toEqual([0x04, 0x01]);
    expect(toHex(refusal.body)).toBe('000400080002000f');
    expect(server.storedFor('carol').length).toBe(10);
    expect(server.dropped('alice')).toBe(0);
  });

  it('refuses an unknown or offline recipient without the store TLV', async () => {
    server.addUser('carol', 'pw');
    const alice = await session('alice');
    const unknown = await sendIm(alice, STORED, 'nobody');
    expect([unknown.family, unknown.subtype]).toEqual([0x04, 0x01]);
    expect(toHex(unknown.body)).toBe('0004');
    const offline = await sendIm(alice, NOT_STORED, 'carol');
    expect([offline.family, offline.subtype]).toEqual([0x04, 0x01]);
    expect(toHex(offline.body)).toBe('0004');
    expect(server.storedFor('carol')).toEqual([]);
    expect(server.storedFor('nobody')).toEqual([]);
  });

  it("sends the peer's bytes with the charset label it was told", async () => {
    const bob = server.peer('bob');
    const alice = await session('alice');
    const bytes = new Uint8Array(Buffer.from('café', 'utf8'));
    bob.sendIm('alice', '', { charset: 0, bytes });
    await waitFor(() => of(alice, 4, 0x07).length === 1, 'the IM');
    const message = decodeImToClient(of(alice, 4, 0x07)[0]?.body ?? new Uint8Array(0));
    expect(decodeImFragments(findTlv(message.tlvs, 0x02) ?? new Uint8Array(0))).toEqual([{ charset: 0, text: bytes }]);
  });
});

describe('test server: rate accounting', () => {
  it('reports alert, limited and clear to every subscribed instance', async () => {
    const instances = [await session('alice'), await session('alice')];
    server.spend('alice', 3, 4);
    for (const instance of instances) {
      const got = await notices(instance, 1);
      expect(got.map((n) => [n.code, n.params.id, n.params.currentLevel])).toEqual([[2, 3, 4886]]);
    }
    server.spend('alice', 3, 4);
    for (const instance of instances) {
      const got = await notices(instance, 2);
      expect(got.map((n) => [n.code, n.params.id, n.params.currentLevel])).toEqual([[2, 3, 4886], [3, 3, 3977]]);
    }
    t += 60_000;
    server.rateTick('alice');
    for (const instance of instances) {
      const got = await notices(instance, 3);
      expect(got.map((n) => n.code)).toEqual([2, 3, 4]);
      expect(got[2]?.params).toEqual({ id: 3, windowSize: 20, clearLevel: 5100, alertLevel: 5000, limitLevel: 4000, disconnectLevel: 3000, currentLevel: 6000, maxLevel: 6000 });
    }
    expect(server.rateNotices('alice')).toEqual([
      { code: 2, classId: 3, level: 4886 },
      { code: 3, classId: 3, level: 3977 },
      { code: 4, classId: 3, level: 6000 },
    ]);
  });

  // state/session.go:477-510: a tick stores no level while the class stays limited and the last-send time stays, so each starts from 3977.
  it('a tick is no send and repeated ticks count the elapsed time once', async () => {
    const alice = await session('alice');
    server.spend('alice', 3, 8);
    const limited = [
      { code: 2, classId: 3, level: 4886 },
      { code: 3, classId: 3, level: 3977 },
    ];
    expect(server.rateNotices('alice')).toEqual(limited);
    // (3977 * 19 + 5000) / 20 = 4028 and (3977 * 19 + 10000) / 20 = 4278: limited both times, nothing stored.
    t += 5_000;
    server.rateTick('alice');
    t += 5_000;
    server.rateTick('alice');
    // A computation from stored levels 4028 and 4278 gives (4326 * 19 + 20000) / 20 = 5109, clear; the server computes (3977 * 19 + 20000) / 20 = 4778.
    t += 10_000;
    server.rateTick('alice');
    expect(server.rateNotices('alice')).toEqual(limited);
    server.setRateParams('alice', 3, {});
    expect(server.rateNotices('alice')).toEqual([...limited, { code: 1, classId: 3, level: 3977 }]);
    // Clear needs (3977 * 19 + e) / 20 >= 5100, so e >= 26437 ms since the last send.
    t += 6_436;
    server.rateTick('alice');
    expect(server.rateNotices('alice').length).toBe(3);
    t += 1;
    server.rateTick('alice');
    expect(server.rateNotices('alice')[3]).toEqual({ code: 4, classId: 3, level: 5100 });
    const got = await notices(alice, 4);
    expect(got.map((n) => [n.code, n.params.currentLevel])).toEqual([[2, 4886], [3, 3977], [1, 3977], [4, 5100]]);
  });

  it('a send after ticks is accounted from the level and time of the last send', async () => {
    await session('alice');
    server.spend('alice', 3, 8);
    t += 5_000;
    server.rateTick('alice');
    t += 5_000;
    server.rateTick('alice');
    // One send 10 s after the last: (3977 * 19 + 10000) / 20 = 4278, not the 4326 of two stored ticks.
    server.spend('alice', 3, 1);
    server.setRateParams('alice', 3, {});
    expect(server.rateNotices('alice')[2]).toEqual({ code: 1, classId: 3, level: 4278 });
  });

  it('a tick skips a class the account did not subscribe to', async () => {
    await session('alice', [1, 2, 4, 5]);
    server.spend('alice', 3, 8);
    t += 60_000;
    server.rateTick('alice');
    expect(server.rateNotices('alice').map((n) => n.code)).toEqual([2, 3]);
    server.setRateParams('alice', 3, {});
    expect(server.rateNotices('alice')[2]).toEqual({ code: 1, classId: 3, level: 3977 });
  });

  it('drops a limited SNAC silently', async () => {
    const bob = server.peer('bob');
    const alice = await session('alice');
    server.spend('alice', 3, 8);
    const requestId = marker++;
    alice.snac(4, 0x06, requestId, imBody(STORED, 'bob'));
    await roundTrip(alice);
    expect(snacsOf(alice).filter((s) => s.requestId === requestId)).toEqual([]);
    expect(of(alice, 4, 0x0c)).toEqual([]);
    expect(of(alice, 4, 0x01)).toEqual([]);
    expect(bob.ims()).toEqual([]);
    expect(server.dropped('alice')).toBe(1);
    expect(alice.closed).toBe(false);
  });

  it('announces a parameter change with code 1', async () => {
    const alice = await session('alice');
    server.setRateParams('alice', 3, { alertLevel: 5500 });
    const got = await notices(alice, 1);
    expect(got.length).toBe(1);
    expect(got[0]?.code).toBe(1);
    expect(got[0]?.params).toEqual({ id: 3, windowSize: 20, clearLevel: 5100, alertLevel: 5500, limitLevel: 4000, disconnectLevel: 3000, currentLevel: 6000, maxLevel: 6000 });
    expect(server.rateNotices('alice')).toEqual([{ code: 1, classId: 3, level: 6000 }]);
  });

  it('sends no notice to an instance that did not subscribe', async () => {
    const subscribed = await session('alice');
    const silent = await session('alice', []);
    const otherClass = await session('alice', [1, 2, 4, 5]);
    server.spend('alice', 3, 4);
    expect((await notices(subscribed, 1)).map((n) => n.code)).toEqual([2]);
    await roundTrip(silent);
    await roundTrip(otherClass);
    expect(of(silent, 1, 0x0a)).toEqual([]);
    expect(of(otherClass, 1, 0x0a)).toEqual([]);
  });
});
