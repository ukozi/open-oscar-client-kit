import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SignOnDeps } from '../../src/client/sign-on.js';
import { bucpTicketSource } from '../../src/client/tickets.js';
import type { TicketRequest } from '../../src/client/tickets.js';
import { ManualTimers, captureLog } from '../fake/oscar-client.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const ALICE = { screenName: 'Alice', password: 'alicepw1' };

let timers: ManualTimers;
let fake: FakeOscarServer;
let deps: SignOnDeps;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  deps = { log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} } };
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });
const req: TicketRequest = { reconnect: false, track: () => {} };

describe('a login for a gateway', () => {
  it('binds the login connection to the source address it is given', async () => {
    await bucpTicketSource({ ...deps, localAddress: '127.0.0.1', credentials: ALICE, server: here() }).ticket(req);
    expect(fake.bucpLogins.at(-1)).toMatchObject({ name: 'Alice', remoteAddress: '127.0.0.1', multiConn: 0x01 });
  });

  it.runIf(process.platform === 'linux')('a second loopback address is a source of its own', async () => {
    await bucpTicketSource({ ...deps, localAddress: '127.0.0.2', credentials: ALICE, server: here() }).ticket(req);
    expect(fake.bucpLogins.at(-1)?.remoteAddress).toBe('127.0.0.2');
  });

  it('keeps the name as the server formats it', async () => {
    fake.addUser('Mixed Case', 'mixed123');
    const issued = await bucpTicketSource({ ...deps, credentials: { screenName: 'mixedcase', password: 'mixed123' }, server: here() }).ticket(req);
    expect(issued.screenName).toBe('Mixed Case');
    expect(JSON.stringify(fake.bucpLogins)).not.toContain('mixed123');
  });

  it('gets the formatted name at BOS online when the reply carries the name as typed', async () => {
    const oos = await FakeOscarServer.start({ now: timers.now, loginReplyName: 'typed' });
    try {
      oos.addUser('Mixed Case', 'mixed123');
      const server = { host: '127.0.0.1', port: oos.port };
      const issued = await bucpTicketSource({ ...deps, credentials: { screenName: 'mixedcase', password: 'mixed123' }, server }).ticket(req);
      expect(issued.screenName).toBe('mixedcase');
      const h = makeClient(oos, { timers });
      await h.signOn('mixedcase', 'mixed123');
      expect(h.client.self?.screenName).toBe('Mixed Case');
    } finally {
      await oos.stop();
    }
  });

  it('records what the login asked for, one entry for each attempt', async () => {
    await bucpTicketSource({ ...deps, credentials: ALICE, server: here() }).ticket(req);
    await bucpTicketSource({ ...deps, tokenTtlSeconds: 3600, clientId: 'Gateway', credentials: ALICE, server: here() }).ticket(req);
    await expect(bucpTicketSource({ ...deps, credentials: { ...ALICE, password: 'wrong' }, server: here() }).ticket(req)).rejects.toMatchObject({
      failure: { kind: 'wrong-password' },
    });
    expect(fake.bucpLogins.map(({ name, multiConn, clientId, tokenTtl }) => ({ name, multiConn, tokenTtl, named: clientId !== null }))).toEqual([
      { name: 'Alice', multiConn: 0x01, tokenTtl: null, named: true },
      { name: 'Alice', multiConn: 0x01, tokenTtl: 3600, named: true },
      { name: 'Alice', multiConn: 0x01, tokenTtl: null, named: true },
    ]);
    expect(fake.bucpLogins[1]?.clientId).toBe('Gateway');
  });
});
