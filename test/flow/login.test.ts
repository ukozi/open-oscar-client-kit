import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SignOnError } from '../../src/client/errors.js';
import type { LoginBudget } from '../../src/client/login-budget.js';
import { FALLBACK_CLIENT_ID } from '../../src/client/client-id.js';
import { SignOn } from '../../src/client/sign-on.js';
import type { OscarConnection } from '../../src/wire/connection.js';
import { decodeTlvs, findTlv, hasTlv, tlvStr } from '../../src/wire/tlv.js';
import type { SignOnFailure } from '../../src/model/session.js';
import { ManualTimers, captureLog, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord, StartOptions } from '../fake/oscar-server.js';

const ALICE = { screenName: 'Alice', password: 'alicepw1' };
const WRONG_PASSWORD = 'wrongpw9';

let server: FakeOscarServer;
const opened: OscarConnection[] = [];
const track = (conn: OscarConnection): void => {
  opened.push(conn);
};

afterEach(async () => {
  for (const conn of opened.splice(0)) conn.destroy();
  await server?.stop();
});

async function start(opts: StartOptions = {}): Promise<FakeOscarServer> {
  server = await FakeOscarServer.start(opts);
  server.addUser('Alice', 'alicepw1');
  return server;
}

function make(budget: LoginBudget = { take: async () => {} }, clientId?: string) {
  const timers = new ManualTimers();
  const logs = captureLog();
  return { timers, logs, signOn: new SignOn({ log: logs.log, now: timers.now, timers: timers.api, budget, clientId }) };
}

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: server.port });

function authSnacs(subtype: number): SnacRecord[] {
  return server.snacsFrom('alice').filter((s) => s.conn === 'auth' && s.family === 0x17 && s.subtype === subtype);
}

function loginTlvs(): ReturnType<typeof decodeTlvs> {
  const logins = authSnacs(0x02);
  expect(logins.length).toBe(1);
  return decodeTlvs(logins[0]?.body ?? new Uint8Array(0));
}

async function failureOf(promise: Promise<unknown>): Promise<SignOnFailure> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SignOnError);
  return (error as SignOnError).failure;
}

// A port nothing listens on: one a test server held and gave back.
async function closedPort(): Promise<number> {
  const gone = await FakeOscarServer.start();
  const port = gone.port;
  await gone.stop();
  return port;
}

describe('SignOn.login', () => {
  it('logs in and returns the BOS ticket', async () => {
    await start();
    const ticket = await make().signOn.login(ALICE, here(), track);
    expect(ticket.host).toBe('127.0.0.1');
    expect(ticket.port).toBe(server.port);
    expect(ticket.cookie.length).toBe(256);
  });

  it('sends the one-byte multi-session flag and no TLV 0x133A', async () => {
    await start();
    await make().signOn.login(ALICE, here(), track);
    const tlvs = loginTlvs();
    expect(findTlv(tlvs, 0x4a)).toEqual(Uint8Array.of(0x01));
    expect(hasTlv(tlvs, 0x133a)).toBe(false);
  });

  it('sends the client ID it was given in TLV 0x03 and signs on', async () => {
    await start();
    const ticket = await make(undefined, 'Chimr, version 0.2.3/MAC').signOn.login(ALICE, here(), track);
    expect(ticket.cookie.length).toBe(256);
    expect(tlvStr(loginTlvs(), 0x03)).toBe('Chimr, version 0.2.3/MAC');
  });

  it('sends the fallback client ID by default', async () => {
    await start();
    await make().signOn.login(ALICE, here(), track);
    const sent = tlvStr(loginTlvs(), 0x03);
    expect(sent).toBe(FALLBACK_CLIENT_ID);
    expect(sent).toBe('OSCAR client, version 0.0.0/UNKNOWN');
  });

  it('opens the auth connection with a sign-on frame that carries no TLVs', async () => {
    await start();
    await make().signOn.login(ALICE, here(), track);
    expect(server.authSignons).toEqual([[]]);
  });

  it('takes one slot of the budget per login', async () => {
    await start();
    let taken = 0;
    const { signOn } = make({
      take: async () => {
        taken++;
      },
    });
    await signOn.login(ALICE, here(), track);
    expect(taken).toBe(1);
  });

  it.each(['0.0.0.0:5190', '169.254.1.1:5190', '[fe80::1]:5190', ':5190'])(
    'uses the configured address when the advertised one is unroutable or malformed (%s)',
    async (advertisedHost) => {
      await start({ advertisedHost });
      const ticket = await make().signOn.login(ALICE, here(), track);
      expect(ticket.host).toBe('127.0.0.1');
      expect(ticket.port).toBe(server.port);
      expect(ticket.cookie.length).toBe(256);
    },
  );

  it('follows a loopback advertisement when the configured host is loopback', async () => {
    await start();
    // Dialled by name, so the advertised literal in the ticket can only come from following.
    const ticket = await make().signOn.login(ALICE, { host: 'localhost', port: server.port }, track);
    expect(ticket.host).toBe('127.0.0.1');
    expect(ticket.port).toBe(server.port);
  });

  const refusals: [string, StartOptions, { loginError?: number }, { screenName: string; password: string }, SignOnFailure][] = [
    ['an unknown name', {}, {}, { screenName: 'Nobody', password: 'alicepw1' }, { kind: 'unknown-screen-name' }],
    ['a wrong password', {}, {}, { screenName: 'Alice', password: WRONG_PASSWORD }, { kind: 'wrong-password' }],
    ['login error 0x0008', {}, { loginError: 0x0008 }, ALICE, { kind: 'account-unavailable', code: 0x0008 }],
    ['login error 0x0009', {}, { loginError: 0x0009 }, ALICE, { kind: 'account-unavailable', code: 0x0009 }],
    ['login error 0x0011', {}, { loginError: 0x0011 }, ALICE, { kind: 'account-unavailable', code: 0x0011 }],
    ['login error 0x0022', {}, { loginError: 0x0022 }, ALICE, { kind: 'account-unavailable', code: 0x0022 }],
    ['login error 0x0006', {}, { loginError: 0x0006 }, ALICE, { kind: 'refused', code: 6 }],
    ['the login limiter answering with a SNAC', { loginLimit: 0, limiterShape: 'snac' }, {}, ALICE, { kind: 'login-rate-limited' }],
    ['the login limiter answering with a sign-off', { loginLimit: 0, limiterShape: 'signoff' }, {}, ALICE, { kind: 'login-rate-limited' }],
  ];
  it.each(refusals)('maps each refusal: %s', async (_label, options, user, credentials, failure) => {
    await start(options);
    server.addUser('Alice', 'alicepw1', user);
    const promise = make().signOn.login(credentials, here(), track);
    await expect(promise).rejects.toBeInstanceOf(SignOnError);
    expect(await failureOf(promise)).toEqual(failure);
  });

  it('reports unreachable for a closed port, a peer that is not FLAP, and an auth connection that closes with no reply', async () => {
    await start();
    const { signOn } = make();
    expect(await failureOf(signOn.login(ALICE, { host: '127.0.0.1', port: await closedPort() }, track))).toEqual({ kind: 'unreachable' });

    const sockets: net.Socket[] = [];
    const http = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    try {
      const port = (http.address() as net.AddressInfo).port;
      expect(await failureOf(signOn.login(ALICE, { host: '127.0.0.1', port }, track))).toEqual({ kind: 'unreachable' });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }

    server.closeOn(0x17, 0x06, 'destroy');
    expect(await failureOf(signOn.login(ALICE, here(), track))).toEqual({ kind: 'unreachable' });
  });

  const withheld: [string, number, number][] = [
    ['challenge', 0x07, 0x06],
    ['login reply', 0x03, 0x02],
  ];
  it.each(withheld)('reports unreachable when the challenge or the login reply does not arrive in 20 s (%s)', async (_label, reply, request) => {
    await start();
    server.withhold(0x17, reply);
    const { signOn, timers } = make();
    let settled = false;
    const promise = signOn.login(ALICE, here(), track);
    const failure = failureOf(promise.finally(() => (settled = true)));
    // The 20 s for a reply starts when the client writes its request; manual time must not move before that.
    await waitFor(() => authSnacs(request).length === 1, 'the request whose reply is withheld');
    await timers.advance(19_999);
    expect(settled).toBe(false);
    await timers.advance(1);
    expect(settled).toBe(true);
    expect(await failure).toEqual({ kind: 'unreachable' });
  });

  it('hands each connection to track', async () => {
    await start();
    const { signOn } = make();
    const tracked: OscarConnection[] = [];
    const keep = (conn: OscarConnection): void => {
      tracked.push(conn);
      track(conn);
    };
    const ticket = await signOn.login(ALICE, here(), keep);
    expect(tracked.length).toBe(1);
    const bos = await signOn.openBos(ticket, keep);
    expect(tracked.length).toBe(2);
    expect(tracked[1]).toBe(bos);
    expect(bos.isOpen).toBe(true);
    await waitFor(() => server.instancesOf('alice') === 1, 'the BOS connection to be accepted');

    server.withhold(0x17, 0x07);
    const promise = signOn.login(ALICE, here(), keep);
    const failure = failureOf(promise);
    await waitFor(() => authSnacs(0x06).length === 2, 'the second challenge request');
    expect(tracked.length).toBe(3);
    tracked[2]?.destroy();
    expect(await failure).toEqual({ kind: 'unreachable' });
  });

  it('never writes the password to the log', async () => {
    await start();
    const { signOn, logs } = make();
    await signOn.login(ALICE, here(), track);
    expect(await failureOf(signOn.login({ screenName: 'Alice', password: WRONG_PASSWORD }, here(), track))).toEqual({ kind: 'wrong-password' });
    expect(logs.lines.length).toBeGreaterThan(0);
    expect(logs.text()).not.toContain(ALICE.password);
    expect(logs.text()).not.toContain(WRONG_PASSWORD);
  });
});

describe('SignOn.openBos', () => {
  it('reports unreachable for a closed port', async () => {
    await start();
    const { signOn } = make();
    const ticket = await signOn.login(ALICE, here(), track);
    expect(await failureOf(signOn.openBos({ ...ticket, port: await closedPort() }, track))).toEqual({ kind: 'unreachable' });
  });
});
