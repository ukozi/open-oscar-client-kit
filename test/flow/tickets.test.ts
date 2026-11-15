import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SignOnDeps } from '../../src/client/sign-on.js';
import { adapterTicketSource, bucpTicketSource, storedTicketSource } from '../../src/client/tickets.js';
import type { IssuedTicket } from '../../src/client/tickets.js';
import { readOosCookieExpiry } from '../../src/wire/auth.js';
import { toHex } from '../../src/wire/bytes.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, captureLog, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const ALICE = { screenName: 'Alice', password: 'alicepw1' };
const FIRST_RETRY_MS = 2_000;
const BUCP_COOKIE_MS = 60_000;

let timers: ManualTimers;
let fake: FakeOscarServer;
let logs: ReturnType<typeof captureLog>;
let deps: SignOnDeps;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  logs = captureLog();
  deps = { log: logs.log, now: timers.now, timers: timers.api, budget: { take: async () => {} } };
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });
const login = (): Promise<IssuedTicket> => bucpTicketSource({ ...deps, credentials: ALICE, server: here() }).ticket({ reconnect: false, track: () => {} });

async function dropAndReconnect(h: ClientHarness): Promise<void> {
  fake.dropSocket('alice');
  await waitFor(() => h.client.state === 'reconnecting', 'the client to reconnect');
  await timers.advance(FIRST_RETRY_MS);
  await waitFor(() => h.client.state === 'online', 'the client to be online again');
}

function expectNoSecrets(issued: IssuedTicket[], ...logged: { text(): string }[]): void {
  const secrets = [ALICE.password, ...issued.flatMap(({ ticket: { cookie } }) => [toHex(cookie.subarray(8, 24)), Buffer.from(cookie).toString('base64url')])];
  for (const log of logged) for (const secret of secrets) expect(log.text()).not.toContain(secret);
}

describe('ticket sources', () => {
  it('signs on from a stored ticket with no login', async () => {
    const issued = await login();
    const logins = fake.authSignons.length;
    const h = makeClient(fake, { timers });
    const tickets: IssuedTicket[] = [];
    const statesAtTicket: string[] = [];
    h.client.on('ticket', (t) => {
      tickets.push(t);
      statesAtTicket.push(h.client.state);
    });
    expect(await h.client.signOnWith(storedTicketSource(issued), here())).toBe('online');
    expect([fake.authSignons.length, tickets, h.client.ticket]).toEqual([logins, [issued], issued]);
    expect(statesAtTicket).toEqual(['connecting']);
    expectNoSecrets([issued], logs, h.logs);
  });

  it('reconnects with the same stored cookie and no login', async () => {
    const issued = await login();
    const logins = fake.authSignons.length;
    const h = makeClient(fake, { timers, random: () => 0 });
    const tickets: IssuedTicket[] = [];
    h.client.on('ticket', (t) => tickets.push(t));
    await h.client.signOnWith(storedTicketSource(issued), here());
    await dropAndReconnect(h);
    expect([fake.authSignons.length, fake.instancesOf('Alice'), tickets]).toEqual([logins, 1, [issued, issued]]);
    expectNoSecrets([issued], logs, h.logs);
  });

  it('uses a replaced ticket at the next connect', async () => {
    const first = await login();
    const source = storedTicketSource(first);
    const h = makeClient(fake, { timers, random: () => 0 });
    await h.client.signOnWith(source, here());
    await timers.advance(BUCP_COOKIE_MS + 1_000);
    const second = await login();
    source.replace(second);
    expect(source.current).toBe(second);
    await dropAndReconnect(h);
    expect(h.client.ticket).toBe(second);
    expectNoSecrets([first, second], logs, h.logs);
  });

  it('the BUCP source reads the expiry when told how', async () => {
    const plain = await login();
    const read = await bucpTicketSource({ ...deps, credentials: ALICE, server: here(), readExpiry: readOosCookieExpiry }).ticket({
      reconnect: false,
      track: () => {},
    });
    expect([plain.expiresAt, read.expiresAt]).toEqual([null, Math.floor(timers.now() / 1000) * 1000 + BUCP_COOKIE_MS]);
    expect([read.source, read.obtainedAt, read.ticket.host, read.ticket.port]).toEqual(['bucp', timers.now(), '127.0.0.1', fake.port]);
    expectNoSecrets([plain, read], logs);
  });

  it('asks an adapter source at every connect', async () => {
    const issued = await login();
    const asked: boolean[] = [];
    const source = adapterTicketSource(async (request) => {
      asked.push(request.reconnect);
      return { ...issued, source: 'adapter' };
    });
    const h = makeClient(fake, { timers, random: () => 0 });
    await h.client.signOnWith(source, here());
    await dropAndReconnect(h);
    expect([asked, h.client.ticket?.source]).toEqual([[false, true], 'adapter']);
    expectNoSecrets([issued], logs, h.logs);
  });

  it('signOn still logs in with BUCP at every reconnect', async () => {
    const h = makeClient(fake, { timers, random: () => 0 });
    const tickets: IssuedTicket[] = [];
    h.client.on('ticket', (t) => tickets.push(t));
    await h.signOn();
    expect(fake.authSignons).toHaveLength(1);
    await dropAndReconnect(h);
    expect(fake.authSignons).toHaveLength(2);
    await dropAndReconnect(h);
    expect([fake.authSignons.length, tickets.map((t) => t.source)]).toEqual([3, ['bucp', 'bucp', 'bucp']]);
    expectNoSecrets(tickets, h.logs);
  });
});
