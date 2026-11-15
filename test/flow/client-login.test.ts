import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientLogin } from '../../src/client/client-login.js';
import type { ClientLoginOptions, ClientLoginResult } from '../../src/client/client-login.js';
import { storedTicketSource } from '../../src/client/tickets.js';
import { toHex } from '../../src/wire/bytes.js';
import { startClientLoginFake } from '../fake/client-login.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import { ManualTimers, RawClient } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let timers: ManualTimers;
let fake: FakeOscarServer;
let wim: Awaited<ReturnType<typeof startClientLoginFake>>;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  wim = await startClientLoginFake(fake);
});

afterEach(async () => {
  await stopAllClients();
  await wim.stop();
  await fake.stop();
});

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });

async function closedPort(): Promise<number> {
  const gone = await FakeOscarServer.start();
  const port = gone.port;
  await gone.stop();
  return port;
}

const answering = (response: () => Promise<Response>): ClientLoginOptions['fetch'] => (() => response()) as typeof fetch;
const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('clientLogin', () => {
  it('gets a cookie the BOS takes, with its lifetime', async () => {
    const result = await clientLogin({
      url: wim.url,
      screenName: 'Alice',
      password: 'alicepw1',
      devId: 'Chimr, version 1.0.0/MOBILE',
      bos: here(),
      tokenTtlSeconds: 1_209_600,
      now: timers.now,
    });
    expect(result.ok && result.ticket.expiresAt).toBe(timers.now() + 1_209_600_000);
    if (!result.ok) throw new Error('login failed');
    expect([result.screenName, result.ticket.source, result.ticket.obtainedAt, result.ticket.ticket.port]).toEqual(['Alice', 'adapter', timers.now(), fake.port]);
    const h = makeClient(fake, { timers });
    expect(await h.client.signOnWith(storedTicketSource(result.ticket), here())).toBe('online');
    expect(wim.requests).toEqual([{ screenName: 'Alice', devId: 'Chimr, version 1.0.0/MOBILE', tokenType: '1209600' }]);
    const { cookie } = result.ticket.ticket;
    for (const secret of ['alicepw1', toHex(cookie.subarray(8, 24)), Buffer.from(cookie).toString('base64url')]) expect(h.logs.text()).not.toContain(secret);
  });

  it('answers a wrong password with wrong-credentials and never echoes it', async () => {
    const result = await clientLogin({ url: wim.url, screenName: 'Alice', password: 'not-it-9', devId: 'x', bos: here() });
    expect(result).toEqual({ ok: false, code: 'wrong-credentials', status: 401 });
    expect(JSON.stringify([result, wim.requests])).not.toContain('not-it-9');
  });

  it('answers a correct password with 401 while the account is at its session cap', async () => {
    for (let i = 0; i < 5; i++) await RawClient.signOn(fake.port, 'Alice', 'alicepw1', 0x01);
    const result = await clientLogin({ url: wim.url, screenName: 'Alice', password: 'alicepw1', devId: 'x', bos: here() });
    expect(result).toEqual({ ok: false, code: 'wrong-credentials', status: 401 });
  });

  it('answers a closed port with unreachable', async () => {
    const result = await clientLogin({ url: `http://127.0.0.1:${await closedPort()}`, screenName: 'Alice', password: 'alicepw1', devId: 'x', bos: here() });
    expect(result).toEqual({ ok: false, code: 'unreachable', status: null });
  });

  it.each<[string, () => Promise<Response>, ClientLoginResult]>([
    ['another 4xx', () => json(403, {}), { ok: false, code: 'refused', status: 403 }],
    ['a 5xx', () => json(503, {}), { ok: false, code: 'unreachable', status: 503 }],
    ['a body that is not JSON', () => Promise.resolve(new Response('<html>', { status: 200 })), { ok: false, code: 'unreachable', status: 200 }],
    ['a token that is not base64url', () => json(200, { response: { data: { token: { a: 'no+such/', expiresIn: '60' } } } }), { ok: false, code: 'unreachable', status: 200 }],
    ['a lifetime that is not decimal seconds', () => json(200, { response: { data: { token: { a: 'AAEC', expiresIn: '1h' } } } }), { ok: false, code: 'unreachable', status: 200 }],
  ])('maps %s to its result', async (_, response, expected) => {
    expect(await clientLogin({ url: 'http://wim.test', screenName: 'Alice', password: 'alicepw1', devId: 'x', bos: here(), fetch: answering(response) })).toEqual(expected);
  });

  it('gives up after the timeout', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    expect(await clientLogin({ url: 'http://wim.test', screenName: 'Alice', password: 'alicepw1', devId: 'x', bos: here(), timeoutMs: 5, fetch: hang })).toEqual({
      ok: false,
      code: 'unreachable',
      status: null,
    });
  });
});
