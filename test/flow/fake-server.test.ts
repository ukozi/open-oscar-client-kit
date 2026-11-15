import { afterEach, describe, expect, it } from 'vitest';
import { ByteReader, toHex } from '../../src/wire/bytes.js';
import { decodeFeedbagReply, encodeFeedbagItems } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import type { FlapFrame } from '../../src/wire/flap.js';
import { decodeSnac, decodeUserInfo } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvStr, tlvU16, tlvU8 } from '../../src/wire/tlv.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { bytesOf, loadVectors } from '../support/vectors.js';

const v = loadVectors('hand-session.json');
let server: FakeOscarServer;
afterEach(async () => { await server?.stop(); });

const buddy = (name: string, groupId: number, itemId: number): FeedbagItem => ({ name, groupId, itemId, classId: 0, attrs: [] });
const group = (name: string, groupId: number): FeedbagItem => ({ name, groupId, itemId: 0, classId: 1, attrs: [] });

const EVICTION_URL = 'https://github.com/mk6i/open-oscar-server';

async function openBos(port: number, name: string, password: string, multiConn = 0x01): Promise<RawClient> {
  const { tlvs, client: auth } = await RawClient.login(port, name, password, multiConn);
  auth.close();
  const cookie = findTlv(tlvs, 0x06);
  if (!cookie) throw new Error('login failed');
  const bos = await RawClient.connect(port);
  bos.signon([tlv.bytes(0x06, cookie)]);
  return bos;
}

async function rawBos(port: number, name: string, password: string): Promise<RawClient> {
  const bos = await openBos(port, name, password);
  await bos.nextSnac();
  return bos;
}

function lastFrame(client: RawClient): FlapFrame {
  const frame = client.frames.at(-1);
  if (!frame) throw new Error('no frame');
  return frame;
}

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

function arrivalsOf(client: RawClient): Snac[] {
  return snacsOf(client).filter((s) => s.family === 0x03 && s.subtype === 0x0b);
}

// The test server handles one connection's SNACs in order, so when this echo is back, all it wrote to this client before has arrived too.
let marker = 0x7000;
async function roundTrip(client: RawClient): Promise<void> {
  const requestId = marker++;
  client.snac(1, 0x17, requestId);
  await waitFor(() => snacsOf(client).some((s) => s.subtype === 0x18 && s.requestId === requestId), 'the version echo');
}

async function reply(client: RawClient, family: number, subtype: number, body?: Uint8Array): Promise<Snac> {
  const requestId = marker++;
  client.snac(family, subtype, requestId, body);
  await waitFor(() => snacsOf(client).some((s) => s.requestId === requestId), 'a reply');
  const found = snacsOf(client).find((s) => s.requestId === requestId);
  if (!found) throw new Error('no reply');
  return found;
}

async function lastArrival(client: RawClient, count: number): Promise<Snac> {
  await waitFor(() => arrivalsOf(client).length === count, `arrival ${count}`);
  const found = arrivalsOf(client).at(-1);
  if (!found) throw new Error('no arrival');
  return found;
}

describe('test server: auth', () => {
  it('refuses an unknown name at the challenge with code 0x0001 and no screen name TLV', async () => {
    server = await FakeOscarServer.start();
    const { tlvs } = await RawClient.login(server.port, 'nobody', 'x');
    expect(tlvU16(tlvs, 0x08)).toBe(0x0001);
    expect(findTlv(tlvs, 0x01)).toBeUndefined();
  });

  it('refuses a wrong password with 0x0005 and echoes the screen name', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const { tlvs } = await RawClient.login(server.port, 'alice', 'wrong');
    expect(tlvU16(tlvs, 0x08)).toBe(0x0005);
    expect(tlvStr(tlvs, 0x01)).toBe('alice');
    expect(findTlv(tlvs, 0x06)).toBeUndefined();
  });

  it('returns the stored account status', async () => {
    server = await FakeOscarServer.start();
    server.addUser('sus', 'pw', { loginError: 0x0011 });
    const { tlvs } = await RawClient.login(server.port, 'sus', 'pw');
    expect(tlvU16(tlvs, 0x08)).toBe(0x0011);
    expect(tlvStr(tlvs, 0x01)).toBe('sus');
  });

  it('advertises its own loopback address and a 256-byte cookie', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const { tlvs } = await RawClient.login(server.port, 'alice', 'pw');
    expect(tlvStr(tlvs, 0x05)).toBe(`127.0.0.1:${server.port}`);
    expect(findTlv(tlvs, 0x06)?.length).toBe(256);
    expect(tlvU16(tlvs, 0x08)).toBeUndefined();
  });

  it('closes with no reply when name plus client id exceed 202 bytes', async () => {
    server = await FakeOscarServer.start();
    const name = 'sixteen byte nam';
    expect(Buffer.byteLength(name)).toBe(16);
    server.addUser(name, 'pw');
    const client = await RawClient.connect(server.port);
    client.signon();
    client.snac(0x17, 0x02, 1, encodeTlvs([tlv.str(0x01, name), tlv.bytes(0x25, new Uint8Array(16)), tlv.str(0x03, 'c'.repeat(187)), tlv.u8(0x4a, 0x01)]));
    await client.untilClosed();
    expect(snacsOf(client)).toEqual([]);
    expect(client.frames.length).toBe(1);
    expect(server.faults).toEqual([]);
  });

  it('limits auth connections in both shapes', async () => {
    server = await FakeOscarServer.start({ loginLimit: 1 });
    const first = await RawClient.connect(server.port);
    first.signon();
    await waitFor(() => server.authSignons.length === 1, 'the first sign-on frame');
    const second = await RawClient.connect(server.port);
    second.signon();
    const refusal = await second.nextSnac();
    expect([refusal.family, refusal.subtype]).toEqual([0x17, 0x03]);
    expect(tlvU16(decodeTlvs(refusal.body), 0x08)).toBe(0x001d);
    await second.untilClosed();
    first.close();
    await server.stop();

    server = await FakeOscarServer.start({ loginLimit: 1, limiterShape: 'signoff' });
    const third = await RawClient.connect(server.port);
    third.signon();
    await waitFor(() => server.authSignons.length === 1, 'the first sign-on frame');
    const fourth = await RawClient.connect(server.port);
    fourth.signon();
    const frame = await fourth.nextFrame();
    expect(frame.type).toBe(4);
    expect(tlvU16(decodeTlvs(frame.payload), 0x08)).toBe(0x001d);
    await fourth.untilClosed();
    third.close();
  });
});

describe('test server: sessions', () => {
  it('lets a multi-session sign-on join a multi-session', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const first = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const second = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    expect(server.instancesOf('alice')).toBe(2);
    await roundTrip(first);
    expect(first.closed).toBe(false);
    expect(second.closed).toBe(false);
  });

  it('evicts on a single-session sign-on with the TLV 0x09 frame', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const first = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const second = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const third = await RawClient.signOn(server.port, 'alice', 'pw', 0x03);
    for (const evicted of [first, second]) {
      await evicted.untilClosed();
      const frame = lastFrame(evicted);
      expect(frame.type).toBe(4);
      expect(frame.truncated).toBeUndefined();
      const tlvs = decodeTlvs(frame.payload);
      expect(tlvU8(tlvs, 0x09)).toBe(1);
      expect(tlvStr(tlvs, 0x0b)).toBe(EVICTION_URL);
    }
    expect(server.instancesOf('alice')).toBe(1);
    expect(third.closed).toBe(false);
  });

  it('evicts a flag-0 instance with the truncated four bytes', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const first = await RawClient.signOn(server.port, 'alice', 'pw', 0x00);
    await RawClient.signOn(server.port, 'alice', 'pw', 0x03);
    await first.untilClosed();
    expect(lastFrame(first).truncated).toBe(true);
    expect(lastFrame(first).type).toBe(4);
    expect(server.instancesOf('alice')).toBe(1);
  });

  it('refuses a sixth instance in both forms', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    for (let i = 0; i < 5; i++) await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const refused = await RawClient.login(server.port, 'alice', 'pw', 0x01);
    expect(tlvU16(refused.tlvs, 0x08)).toBe(0x001d);
    expect(tlvStr(refused.tlvs, 0x01)).toBe('alice');
    expect(findTlv(refused.tlvs, 0x06)).toBeUndefined();
    expect(server.instancesOf('alice')).toBe(5);
    await server.stop();

    server = await FakeOscarServer.start({ sixthSession: 'bos-signoff' });
    server.addUser('alice', 'pw');
    for (let i = 0; i < 5; i++) await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const sixth = await openBos(server.port, 'alice', 'pw', 0x01);
    const frame = await sixth.nextFrame();
    expect(frame.type).toBe(4);
    expect(tlvU8(decodeTlvs(frame.payload), 0x08)).toBe(0x18);
    await sixth.untilClosed();
    expect(server.instancesOf('alice')).toBe(5);
  });

  it('lists its food groups in host online, or the list it was started with', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const first = await (await openBos(server.port, 'alice', 'pw')).nextSnac();
    expect([first.family, first.subtype, first.requestId]).toEqual([0x01, 0x03, 0x80000000]);
    expect(toHex(first.body)).toBe('001800100003001300040015000200010009000a00060008000b');
    await server.stop();

    server = await FakeOscarServer.start({ hostOnline: [0x0001, 0x0002, 0x0003, 0x0004, 0x0013] });
    server.addUser('alice', 'pw');
    const second = await (await openBos(server.port, 'alice', 'pw')).nextSnac();
    expect([second.family, second.subtype]).toEqual([0x01, 0x03]);
    expect(toHex(second.body)).toBe('00010002000300040013');
  });

  it('kicks, sends the empty sign-off, and drops a socket', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');

    const kicked = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    server.kick('alice');
    await kicked.untilClosed();
    expect(lastFrame(kicked).type).toBe(4);
    expect(tlvU8(decodeTlvs(lastFrame(kicked).payload), 0x09)).toBe(1);
    expect(tlvStr(decodeTlvs(lastFrame(kicked).payload), 0x0b)).toBe(EVICTION_URL);
    expect(server.instancesOf('alice')).toBe(0);

    const emptied = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    server.emptySignoff('alice');
    await emptied.untilClosed();
    expect(lastFrame(emptied).type).toBe(4);
    expect(lastFrame(emptied).payload.length).toBe(0);
    expect(lastFrame(emptied).truncated).toBeUndefined();
    expect(server.instancesOf('alice')).toBe(0);

    const dropped = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const before = dropped.frames.length;
    server.dropSocket('alice');
    await dropped.untilClosed();
    expect(dropped.frames.length).toBe(before);
    expect(dropped.frames.some((f) => f.type === 4)).toBe(false);
    expect(server.faults).toEqual([]);
    expect(server.instancesOf('alice')).toBe(0);
  });

  it('inOneWrite sends what the act writes and a sign-off in one read', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    server.inOneWrite('alice', () => {
      server.peer('Bob').sendIm('alice', 'hi');
      server.kick('alice');
    });
    await alice.untilClosed();
    const isIm = (f: FlapFrame): boolean => f.type === 2 && decodeSnac(f.payload).family === 0x04 && decodeSnac(f.payload).subtype === 0x07;
    const together = alice.reads.find((read) => read.some(isIm) && read.some((f) => f.type === 4));
    expect(together).toBeDefined();
    expect(together?.at(-1)?.type).toBe(4);
  });

  it('inOneWrite leaves the socket uncorked when the act writes nothing', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    server.inOneWrite('alice', () => {});
    server.peer('Bob').sendIm('alice', 'hi');
    await waitFor(() => snacsOf(alice).some((s) => s.family === 0x04 && s.subtype === 0x07), 'the IM after inOneWrite');
  });
});

describe('test server: buddy list', () => {
  it('serves the stored feedbag, rights, locate rights and ICBM parameters', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const stored = bytesOf(v, 'feedbag reply body, six items');
    server.setFeedbag('alice', decodeFeedbagReply(stored).items);
    const alice = await rawBos(server.port, 'alice', 'pw');

    const list = await reply(alice, 0x13, 0x04);
    expect(list.subtype).toBe(0x06);
    expect(toHex(list.body)).toBe(`${toHex(stored).slice(0, -8)}00000000`);

    const rights = await reply(alice, 0x13, 0x02);
    expect(rights.subtype).toBe(0x03);
    expect(toHex(rights.body)).toBe(toHex(bytesOf(v, 'feedbag rights reply body')));

    const locate = await reply(alice, 0x02, 0x02);
    expect(locate.subtype).toBe(0x03);
    expect(toHex(locate.body)).toBe(toHex(bytesOf(v, 'locate rights reply body')));

    const icbm = await reply(alice, 0x04, 0x04);
    expect(icbm.subtype).toBe(0x05);
    expect(toHex(icbm.body)).toBe(toHex(bytesOf(v, 'icbm parameter reply body')));
  });

  it('upserts and deletes feedbag items blindly', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const alice = await rawBos(server.port, 'alice', 'pw');

    const inserted = await reply(alice, 0x13, 0x08, encodeFeedbagItems([group('G', 1), buddy('bob', 1, 5)]));
    expect([inserted.family, inserted.subtype]).toEqual([0x13, 0x0e]);
    expect(toHex(inserted.body)).toBe('00000000');
    expect(server.feedbagOf('alice').map((i) => i.name)).toEqual(['G', 'bob']);

    const updated = await reply(alice, 0x13, 0x09, encodeFeedbagItems([buddy('carol', 1, 5)]));
    expect([updated.family, updated.subtype]).toEqual([0x13, 0x0e]);
    expect(toHex(updated.body)).toBe('0000');
    expect(server.feedbagOf('alice').map((i) => i.name)).toEqual(['G', 'carol']);

    const deleted = await reply(alice, 0x13, 0x0a, encodeFeedbagItems([buddy('x', 9, 9)]));
    expect([deleted.family, deleted.subtype]).toEqual([0x13, 0x0e]);
    expect(toHex(deleted.body)).toBe('0000');
    expect(server.feedbagOf('alice').map((i) => i.name)).toEqual(['G', 'carol']);
  });
});

describe('test server: presence', () => {
  it('announces a buddy only after both list-in-use and client online, in either order', async () => {
    server = await FakeOscarServer.start();
    const orders = [
      { name: 'alice', first: [0x13, 0x07], second: [0x01, 0x02] },
      { name: 'alma', first: [0x01, 0x02], second: [0x13, 0x07] },
    ] as const;
    server.peer('bob');
    for (const { name, first, second } of orders) {
      server.addUser(name, 'pw');
      server.setFeedbag(name, [buddy('bob', 1, 1)]);
      const client = await rawBos(server.port, name, 'pw');
      client.snac(first[0], first[1], 1);
      await roundTrip(client);
      expect(arrivalsOf(client)).toEqual([]);
      client.snac(second[0], second[1], 2);
      await roundTrip(client);
      const arrivals = arrivalsOf(client);
      expect(arrivals.length).toBe(1);
      expect(decodeUserInfo(arrivals[0]?.body ?? new Uint8Array(0), 0).info.name).toBe('bob');
    }
  });

  it('sends an arrival for each state change and a departure at sign-off', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    server.setFeedbag('alice', [buddy('bob', 1, 1)]);
    const bob = server.peer('bob');
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    await lastArrival(alice, 1);

    bob.setAway(true);
    const away = decodeUserInfo((await lastArrival(alice, 2)).body, 0).info;
    expect(away.name).toBe('bob');
    expect(tlvU16(away.tlvs, 0x01)).toBe(0x0030);
    expect(findTlv(away.tlvs, 0x04)).toBeUndefined();

    bob.setIdle(12);
    const idle = decodeUserInfo((await lastArrival(alice, 3)).body, 0).info;
    expect(tlvU16(idle.tlvs, 0x04)).toBe(12);

    bob.signOff();
    await waitFor(() => snacsOf(alice).some((s) => s.family === 0x03 && s.subtype === 0x0c), 'the departure');
    const departure = snacsOf(alice).find((s) => s.family === 0x03 && s.subtype === 0x0c);
    const r = new ByteReader(departure?.body ?? new Uint8Array(0));
    expect(r.str8()).toBe('bob');
    expect(toHex(r.rest())).toBe('00000001000100020000');

    bob.signOn();
    const back = decodeUserInfo((await lastArrival(alice, 4)).body, 0).info;
    expect(back.name).toBe('bob');
  });

  it('does not announce someone who is not on the list', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    server.setFeedbag('alice', [buddy('bob', 1, 1)]);
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    await roundTrip(alice);
    const before = alice.frames.length;
    const carol = server.peer('carol');
    carol.setAway(true);
    carol.signOff();
    await roundTrip(alice);
    expect(alice.frames.length).toBe(before + 1);
    expect(snacsOf(alice).filter((s) => s.family === 0x03)).toEqual([]);
  });

  it('drops the connection on a capability list that is not a multiple of 16', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const before = alice.frames.length;
    alice.snac(0x02, 0x04, 9, encodeTlvs([tlv.bytes(0x05, new Uint8Array(15))]));
    await alice.untilClosed();
    expect(alice.frames.length).toBe(before);
    expect(server.faults).toEqual([]);
    await waitFor(() => server.instancesOf('alice') === 0, 'the instance to end');
  });
});

describe('test server: scripted failures', () => {
  it('withholds and releases a reply', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const release = server.withhold(1, 0x0f);
    const answered = (): boolean => snacsOf(alice).some((s) => s.subtype === 0x0f && s.requestId === 77);
    alice.snac(1, 0x0e, 77);
    await expect(waitFor(answered, 'the withheld reply', 50)).rejects.toThrow('timed out');
    await roundTrip(alice);
    expect(answered()).toBe(false);
    release();
    await waitFor(answered, 'the released reply');
    const next = await reply(alice, 1, 0x0e);
    expect(next.subtype).toBe(0x0f);
  });

  it('holds the close of the auth connection behind a withheld login reply', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const release = server.withhold(0x17, 0x03);
    const login = RawClient.login(server.port, 'alice', 'pw', 0x01);
    await waitFor(() => server.snacsFrom('alice').some((s) => s.conn === 'auth' && s.subtype === 0x02), 'the login request');
    const other = await RawClient.connect(server.port);
    other.close();
    release();
    const { tlvs, client } = await login;
    expect(findTlv(tlvs, 0x06)?.length).toBe(256);
    await client.untilClosed();
    expect(client.frames.map((f) => f.type)).toEqual([1, 2, 2, 4]);
    expect(lastFrame(client).payload.length).toBe(0);
  });

  it('closes on a chosen SNAC', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const before = alice.frames.length;
    server.closeOn(1, 0x06, 'empty-signoff');
    alice.snac(1, 0x06, 5);
    await alice.untilClosed();
    expect(alice.frames.length).toBe(before + 1);
    expect(lastFrame(alice).type).toBe(4);
    expect(lastFrame(alice).payload.length).toBe(0);
    expect(lastFrame(alice).truncated).toBeUndefined();
  });

  it('answers a chosen SNAC with an error', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    server.failNext(0x13, 0x04, { code: 0x0d });
    alice.snac(0x13, 0x04, 41);
    await waitFor(() => snacsOf(alice).some((s) => s.requestId === 41), 'the error');
    const failed = snacsOf(alice).find((s) => s.requestId === 41);
    expect([failed?.family, failed?.subtype]).toEqual([0x13, 0x01]);
    expect(toHex(failed?.body ?? new Uint8Array(0))).toBe('000d');
    const served = await reply(alice, 0x13, 0x04);
    expect(served.subtype).toBe(0x06);
  });
});

describe('test server: faults', () => {
  it('records no fault for a modelled drop', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    // A TLV block cut inside a header, on both kinds of connection: the real server drops on it.
    const auth = await RawClient.connect(server.port);
    auth.signon();
    auth.snac(0x17, 0x06, 1, Uint8Array.of(0x00, 0x01, 0x00));
    await auth.untilClosed();
    expect(auth.frames.length).toBe(1);
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const before = alice.frames.length;
    alice.snac(0x02, 0x04, 9, Uint8Array.of(0x00, 0x05, 0x00));
    await alice.untilClosed();
    expect(alice.frames.length).toBe(before);
    expect(server.faults).toEqual([]);
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('records a bug in its own handler and rejects stop() with it', async () => {
    server = await FakeOscarServer.start();
    server.addUser('alice', 'pw');
    const alice = await RawClient.signOn(server.port, 'alice', 'pw', 0x01);
    const before = alice.frames.length;
    const bug = new TypeError('injected handler bug');
    server.onSnacHook = (snac) => {
      if (snac.family === 0x01 && snac.subtype === 0x17) throw bug;
    };
    alice.snac(1, 0x17, 7);
    await alice.untilClosed();
    expect(alice.frames.length).toBe(before);
    expect(server.faults).toEqual([bug]);
    const stopped = server.stop();
    await expect(stopped).rejects.toThrow('injected handler bug');
    await expect(stopped).rejects.toBeInstanceOf(AggregateError);
    await expect(stopped).rejects.toHaveProperty('errors', [bug]);
    expect(server.faults).toEqual([]);
  });
});
