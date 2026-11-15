import { afterEach, describe, expect, it } from 'vitest';
import { SignOnError } from '../../src/client/errors.js';
import { SignOn } from '../../src/client/sign-on.js';
import { readOosCookieExpiry, strongHash } from '../../src/wire/auth.js';
import { ByteReader, ByteWriter, toHex } from '../../src/wire/bytes.js';
import type { OscarConnection } from '../../src/wire/connection.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvU16, tlvU32 } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { SignOnFailure } from '../../src/model/session.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import { ManualTimers, RawClient, captureLog } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { StartOptions } from '../fake/oscar-server.js';

const ALICE = { screenName: 'Alice', password: 'alicepw1' };

let fake: FakeOscarServer;
let timers: ManualTimers;
const opened: OscarConnection[] = [];
const raw: RawClient[] = [];
const track = (conn: OscarConnection): void => {
  opened.push(conn);
};

afterEach(async () => {
  await stopAllClients();
  for (const conn of opened.splice(0)) conn.destroy();
  for (const client of raw.splice(0)) client.close();
  await fake?.stop();
});

async function start(opts: StartOptions = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, ...opts });
  fake.addUser('Alice', 'alicepw1');
}

function make(deps: { tokenTtlSeconds?: number }) {
  const logs = captureLog();
  return { logs, signOn: new SignOn({ log: logs.log, now: timers.now, timers: timers.api, budget: { take: async () => {} }, ...deps }) };
}

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });

async function failureOf(promise: Promise<unknown>): Promise<SignOnFailure> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SignOnError);
  return (error as SignOnError).failure;
}

interface LoginAs {
  name?: string;
  password?: string;
  clientId?: string;
  challenge?: boolean;
}

// Written by hand, so the test server sees lifetimes the kit refuses to send. An unknown name's challenge ends the connection.
async function loginAsking(seconds: number, as: LoginAs = {}): Promise<Tlv[]> {
  const { name = 'Alice', password = 'alicepw1', clientId = 'raw', challenge = true } = as;
  const client = await RawClient.connect(fake.port);
  raw.push(client);
  client.signon();
  let key = '';
  if (challenge) {
    client.snac(0x17, 0x06, 1, encodeTlvs([tlv.str(0x01, name)]));
    key = new ByteReader((await client.nextSnac()).body).str16();
  }
  const lifetime = new ByteWriter().u32(seconds).toBytes();
  client.snac(
    0x17,
    0x02,
    2,
    encodeTlvs([tlv.str(0x01, name), tlv.bytes(0x25, strongHash(password, key)), tlv.str(0x03, clientId), tlv.u8(0x4a, 0x01), tlv.bytes(0x133a, lifetime)]),
  );
  return decodeTlvs((await client.nextSnac()).body);
}

describe('cookie lifetime', () => {
  it('gets the lifetime it asked for, readable from the cookie', async () => {
    await start();
    const { logs, signOn } = make({ tokenTtlSeconds: 1_209_600 });
    const ticket = await signOn.login(ALICE, here(), track);
    expect(readOosCookieExpiry(ticket.cookie)).toBe(Math.floor(timers.now() / 1000) * 1000 + 1_209_600_000);
    expect(logs.text()).not.toContain(ALICE.password);
    expect(logs.text()).not.toContain(toHex(ticket.cookie.subarray(8, 24)));
  });

  it('gets one minute when it asks for none', async () => {
    await start();
    const ticket = await make({}).signOn.login(ALICE, here(), track);
    expect(readOosCookieExpiry(ticket.cookie)).toBe(Math.floor(timers.now() / 1000) * 1000 + 60_000);
  });

  it("gets one minute whatever it asks under 'one-minute'", async () => {
    await start({ cookieLifetime: 'one-minute' });
    const ticket = await make({ tokenTtlSeconds: 1_209_600 }).signOn.login(ALICE, here(), track);
    expect(readOosCookieExpiry(ticket.cookie)).toBe(Math.floor(timers.now() / 1000) * 1000 + 60_000);
  });

  it('a cookie past its expiry is refused at BOS with nothing written', async () => {
    await start();
    const ticket = await make({}).signOn.login(ALICE, here(), track);
    await timers.advance(61_000);
    const bos = await RawClient.service(fake.port, ticket.cookie);
    raw.push(bos);
    await bos.untilClosed();
    expect(bos.frames.map((frame) => frame.type)).toEqual([1]);
  });

  it('a cookie inside the lifetime it asked for still opens BOS after a minute', async () => {
    await start();
    const ticket = await make({ tokenTtlSeconds: 600 }).signOn.login(ALICE, here(), track);
    await timers.advance(61_000);
    const bos = await RawClient.service(fake.port, ticket.cookie);
    raw.push(bos);
    expect(bos.closed).toBe(false);
    expect(bos.frames.map((frame) => frame.type)).toEqual([1, 2]);
  });

  it("refuses a lifetime outside 1 s to 365 days with 0x0006 under 'requested'", async () => {
    await start();
    for (const seconds of [0, 31_536_001]) expect(tlvU16(await loginAsking(seconds), 0x08)).toBe(0x0006);
    expect(readOosCookieExpiry(findTlv(await loginAsking(31_536_000), 0x06) ?? new Uint8Array(0))).toBe(
      Math.floor(timers.now() / 1000) * 1000 + 31_536_000_000,
    );
  });

  it.each<[string, LoginAs, number]>([
    ['an unknown name', { name: 'Nobody', challenge: false }, 0x0001],
    ['a stored login error', { name: 'Carol', password: 'carolpw1' }, 0x0011],
    ['a wrong password', { password: 'wrongpw1' }, 0x0005],
    ['a full instance cap', {}, 0x001d],
  ])('refuses an out-of-range lifetime with 0x0006 ahead of %s', async (_, as, code) => {
    await start();
    fake.addUser('Carol', 'carolpw1', { loginError: 0x0011 });
    for (let i = 0; i < 5; i++) raw.push(await RawClient.signOn(fake.port, 'Alice', 'alicepw1', 0x01));
    expect(tlvU16(await loginAsking(600, as), 0x08)).toBe(code);
    expect(tlvU16(await loginAsking(0, as), 0x08)).toBe(0x0006);
  });

  it('refuses an out-of-range lifetime with 0x0006 ahead of a name and client too long for the cookie', async () => {
    await start();
    const as = { clientId: 'x'.repeat(250) };
    await expect(loginAsking(600, as)).rejects.toThrow('connection closed with no frame');
    expect(tlvU16(await loginAsking(0, as), 0x08)).toBe(0x0006);
  });

  it('OscarClient asks for the lifetime it was given', async () => {
    await start();
    const h = makeClient(fake, { timers, tokenTtlSeconds: 1_209_600 });
    await h.signOn();
    expect(h.logs.text()).not.toContain(ALICE.password);
    const login = fake.snacsFrom('alice').find((s) => s.conn === 'auth' && s.family === 0x17 && s.subtype === 0x02);
    expect(tlvU32(decodeTlvs(login?.body ?? new Uint8Array(0)), 0x133a)).toBe(1_209_600);
  });

  it('reads 0x1D after the challenge as too-many-sessions', async () => {
    await start();
    for (let i = 0; i < 5; i++) raw.push(await RawClient.signOn(fake.port, 'Alice', 'alicepw1', 0x01));
    expect(await failureOf(make({}).signOn.login(ALICE, here(), track))).toEqual({ kind: 'too-many-sessions' });
  });

  it('reads 0x1D before the challenge as login-rate-limited', async () => {
    await start({ loginLimit: 0 });
    expect(await failureOf(make({}).signOn.login(ALICE, here(), track))).toEqual({ kind: 'login-rate-limited' });
  });
});
