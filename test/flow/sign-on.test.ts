import { afterEach, describe, expect, it } from 'vitest';
import { OscarError, SignOnError } from '../../src/client/errors.js';
import { toHex } from '../../src/wire/bytes.js';
import { CAP_CHAT, CAP_UTF8_MESSAGES } from '../../src/wire/constants.js';
import { encodeLocateInfo } from '../../src/wire/locate.js';
import type { CommandError, SignOnFailure } from '../../src/model/session.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { RawClient, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord, StartOptions } from '../fake/oscar-server.js';
import { loadVectors, vector } from '../support/vectors.js';

const handSession = loadVectors('hand-session.json');
const WRONG_PASSWORD = 'wrongpw9';

let server: FakeOscarServer;
let h: ClientHarness;

async function start(options: StartOptions = {}): Promise<void> {
  server = await FakeOscarServer.start(options);
  server.addUser('Alice', 'alicepw1');
  h = makeClient(server);
}

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const bosSnacs = (): SnacRecord[] => server.snacsFrom('alice').filter((s) => s.conn === 'bos');
const sent = (family: number, subtype: number): boolean => bosSnacs().some((s) => s.family === family && s.subtype === subtype);

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

async function failureOf(promise: Promise<unknown>): Promise<SignOnFailure> {
  const error = await errorOf(promise);
  expect(error).toBeInstanceOf(SignOnError);
  return (error as SignOnError).failure;
}

async function refusalOf(promise: Promise<unknown>): Promise<CommandError> {
  const error = await errorOf(promise);
  expect(error).toBeInstanceOf(OscarError);
  return (error as OscarError).info;
}

const gone = (): Promise<void> => waitFor(() => server.instancesOf('alice') === 0, 'the session to end on the server');
const offline = (harness: ClientHarness): Promise<void> => waitFor(() => harness.client.state === 'offline', 'the client to go offline');

describe('sign-on', () => {
  it('signs on and reports each state once', async () => {
    await start();
    expect(await h.signOn()).toBe('online');
    expect(h.states).toEqual([{ state: 'connecting' }, { state: 'online' }]);
    expect(h.client.state).toBe('online');
    expect(h.client.self?.screenName).toBe('Alice');
    expect(h.client.limits).toEqual({ imBytes: 512, awayAndProfileBytes: 1000, buddies: 61, groups: 61, permits: 100, denies: 100, buddiesPerGroup: 200, itemNameBytes: 200 });
  });

  it('sends the sign-on sequence in the specified order, with OService at version 1 and both capabilities', async () => {
    await start();
    await h.signOn();
    // Up to and including 0x01/0x0E: what the session sends once it is online is not the sign-on sequence.
    const bos = server.snacsFrom('alice').filter((s) => s.conn === 'bos').slice(0, 11);
    expect(bos.map((s) => [s.family, s.subtype])).toEqual([
      [0x01, 0x17], [0x01, 0x06], [0x01, 0x08], [0x02, 0x02], [0x02, 0x04], [0x04, 0x04],
      [0x13, 0x02], [0x13, 0x04], [0x13, 0x07], [0x01, 0x02], [0x01, 0x0e],
    ]);
    const hex = bos.map((s) => toHex(s.body));
    expect(hex[0]).toBe(vector(handSession, 'client versions body, BOS list with BART').hex);   // the test server lists 0x0010 in host online
    expect(hex[0]?.slice(0, 8)).toBe('00010001');
    expect(hex[2]).toBe('00010002000300040005');
    // One Locate write: the capabilities and the profile, empty when the caller gave none.
    expect(hex[4]).toBe(toHex(encodeLocateInfo({ capabilities: [CAP_UTF8_MESSAGES, CAP_CHAT], profile: '' })));
    expect(hex[9]).toBe(vector(handSession, 'client online body, BOS list with BART').hex);
    expect(h.selves).toHaveLength(1);
    expect(server.authSignons).toEqual([[]]);
  });

  it('announces only the five BOS food groups to a server that does not list BART', async () => {
    await start({ hostOnline: [0x0001, 0x0002, 0x0003, 0x0004, 0x0013] });
    await h.signOn();
    const hex = bosSnacs().map((s) => toHex(s.body));
    expect(hex[0]).toBe(vector(handSession, 'client versions body, BOS list').hex);
    expect(hex[9]).toBe(vector(handSession, 'client online body, BOS list').hex);
  });

  it('joins an existing multi-session instead of evicting it', async () => {
    await start();
    const other = await RawClient.signOn(server.port, 'Alice', 'alicepw1', 0x01);
    await h.signOn();
    await settle(server.port);
    expect(server.instancesOf('alice')).toBe(2);
    expect(other.closed).toBe(false);
  });

  it('refuses an invalid screen name before anything is sent', async () => {
    await start();
    expect(await refusalOf(h.signOn('1bad', 'x'))).toEqual({ kind: 'local', code: 'invalid-screen-name' });
    await settle(server.port);
    expect(server.authSignons).toEqual([]);
    expect(h.states).toEqual([]);
  });

  it('refuses a second sign-on while not offline', async () => {
    await start();
    await h.signOn();
    expect(await refusalOf(h.signOn())).toEqual({ kind: 'local', code: 'not-offline' });
    expect(h.states).toEqual([{ state: 'connecting' }, { state: 'online' }]);
    expect(server.authSignons).toHaveLength(1);
  });

  const refusals: [string, StartOptions, { loginError?: number }, [string, string], SignOnFailure][] = [
    ['a wrong password', {}, {}, ['Alice', WRONG_PASSWORD], { kind: 'wrong-password' }],
    ['an unknown name', {}, {}, ['Nobody1', 'alicepw1'], { kind: 'unknown-screen-name' }],
    ['login error 0x0011', {}, { loginError: 0x0011 }, ['Alice', 'alicepw1'], { kind: 'account-unavailable', code: 0x11 }],
    ['login error 0x0006', {}, { loginError: 0x0006 }, ['Alice', 'alicepw1'], { kind: 'refused', code: 6 }],
    ['the login limiter', { loginLimit: 0 }, {}, ['Alice', 'alicepw1'], { kind: 'login-rate-limited' }],
  ];
  it.each(refusals)('reports each refusal as the offline reason and does not retry (%s)', async (_label, options, user, [name, password], failure) => {
    await start(options);
    server.addUser('Alice', 'alicepw1', user);
    const promise = h.signOn(name, password);
    await expect(promise).rejects.toBeInstanceOf(SignOnError);
    expect(await failureOf(promise)).toEqual(failure);
    expect(h.states).toEqual([{ state: 'connecting' }, { state: 'offline', reason: failure }]);
    await h.timers.advance(600_000);
    expect(server.authSignons).toHaveLength(1);
  });

  it('treats a sixth session refused on the BOS connection as too-many-sessions', async () => {
    await start({ sixthSession: 'bos-signoff' });
    for (let i = 0; i < 5; i++) await RawClient.signOn(server.port, 'Alice', 'alicepw1', 0x01);
    expect(server.instancesOf('alice')).toBe(5);
    const failure: SignOnFailure = { kind: 'too-many-sessions' };
    expect(await failureOf(h.signOn())).toEqual(failure);
    expect(h.states).toEqual([{ state: 'connecting' }, { state: 'offline', reason: failure }]);
    expect(server.instancesOf('alice')).toBe(5);
  });

  // The reply withheld, then the request it answers (host online answers the sign-on frame).
  const replies: [number, number][] = [[1, 0x03], [1, 0x18], [1, 0x07], [2, 0x03], [4, 0x05], [0x13, 0x03], [0x13, 0x06], [1, 0x0f]];
  const requestOf = new Map<number, [number, number]>([
    [0x0001_0018, [1, 0x17]], [0x0001_0007, [1, 0x06]], [0x0002_0003, [2, 0x02]], [0x0004_0005, [4, 0x04]],
    [0x0013_0003, [0x13, 0x02]], [0x0013_0006, [0x13, 0x04]], [0x0001_000f, [1, 0x0e]],
  ]);
  it.each(replies)("fails as unreachable when a step's reply does not come in 20 s (%i, %i)", async (family, subtype) => {
    await start();
    server.withhold(family, subtype);
    let settled = false;
    const failure = failureOf(h.signOn().finally(() => (settled = true)));
    // The 20 s for a reply starts when the client writes its request; manual time must not move before that.
    const request = requestOf.get(family * 0x10000 + subtype);
    if (request) await waitFor(() => sent(request[0], request[1]), 'the request whose reply is withheld');
    else await waitFor(() => server.instancesOf('alice') === 1, 'the BOS connection to be accepted');
    await h.timers.advance(19_999);
    expect(settled).toBe(false);
    await h.timers.advance(1);
    expect(settled).toBe(true);
    expect(await failure).toEqual({ kind: 'unreachable' });
    expect(h.states).toEqual([{ state: 'connecting' }, { state: 'offline', reason: { kind: 'unreachable' } }]);
    await gone();
  });

  it('fails as refused, carrying the code, when the server answers a step with an error, not as unreachable', async () => {
    await start();
    server.failNext(0x13, 0x04, { code: 0x0d });
    const failure: SignOnFailure = { kind: 'refused', code: 0x0d };
    expect(await failureOf(h.signOn())).toEqual(failure);
    expect(h.states).toEqual([{ state: 'connecting' }, { state: 'offline', reason: failure }]);
    await gone();
  });

  it('fails as unreachable when the server closes the connection during a step', async () => {
    await start();
    const scripts: (() => void)[] = [
      () => server.closeOn(1, 0x06, 'destroy'),
      () => server.closeOn(1, 0x06, 'empty-signoff'),
    ];
    for (const script of scripts) {
      const harness = makeClient(server);
      script();
      expect(await failureOf(harness.signOn())).toEqual({ kind: 'unreachable' });
      expect(harness.states).toEqual([{ state: 'connecting' }, { state: 'offline', reason: { kind: 'unreachable' } }]);
      await gone();
    }
  });

  // The test server writes the last reply and the sign-off in one write, so they reach the client in one read. The reply settles the last step.
  const closings: [string, (name: string) => void][] = [
    ['a new-login sign-off', (name) => server.kick(name)],
    ['an empty sign-off', (name) => server.emptySignoff(name)],
  ];
  it.each(closings)('fails as unreachable, and is never online, when %s arrives with the last sign-on reply', async (_name, close) => {
    await start();
    const release = server.withhold(1, 0x0f);
    const signOn = failureOf(h.signOn());
    await waitFor(() => sent(1, 0x0e), 'the last sign-on request');
    server.inOneWrite('alice', () => {
      release();
      close('alice');
    });
    const failure: SignOnFailure = { kind: 'unreachable' };
    expect(await signOn).toEqual(failure);
    expect(h.client.state).toBe('offline');
    expect(h.states).toEqual([{ state: 'connecting' }, { state: 'offline', reason: failure }]);
    expect(h.client.self).toBeNull();
    expect(h.client.limits).toBeNull();
    expect(await refusalOf(h.client.sendIm('Bob', [{ text: 'hi' }]))).toEqual({ kind: 'not-signed-on' });
    await gone();
  });

  it('cancels a sign-on in progress with no error', async () => {
    await start();
    server.withhold(1, 0x07);
    const signOn = h.signOn();
    await waitFor(() => server.snacsFrom('alice').some((s) => s.subtype === 0x06 && s.conn === 'bos'));
    await h.client.signOff();
    expect(await signOn).toBe('cancelled');
    expect(h.states).toStrictEqual([{ state: 'connecting' }, { state: 'offline' }]);
    await gone();
    expect(h.logs.lines.filter((line) => line.level === 'warn' || line.level === 'error')).toEqual([]);
  });

  it('cancels a sign-on that is still waiting for the login budget', async () => {
    server = await FakeOscarServer.start();
    server.addUser('Alice', 'alicepw1');
    let grant = (): void => {};
    h = makeClient(server, { loginBudget: { take: () => new Promise<void>((resolve) => (grant = resolve)) } });
    const signOn = h.signOn();
    await h.client.signOff();
    expect(h.states).toStrictEqual([{ state: 'connecting' }, { state: 'offline' }]);
    grant();
    expect(await signOn).toBe('cancelled');
    expect(h.states).toHaveLength(2);
    await settle(server.port);
    expect(server.instancesOf('alice')).toBe(0);
    expect(server.snacsFrom('alice')).toEqual([]);
  });

  it('keeps going when a listener throws, and stops calling a listener that was removed', async () => {
    await start();
    const seen: string[] = [];
    h.client.on('state', () => {
      throw new Error('listener failure');
    });
    const off = h.client.on('state', ({ state }) => seen.push(state));
    expect(await h.signOn()).toBe('online');
    off();
    await h.client.signOff();
    expect(seen).toEqual(['connecting', 'online']);
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'offline']);
  });

  it('signs off with a FLAP sign-off and can sign on again', async () => {
    await start();
    await h.signOn();
    await h.client.signOff();
    expect(h.states.at(-1)).toStrictEqual({ state: 'offline' });
    await gone();
    expect(h.client.self).toBeNull();
    expect(h.client.limits).toBeNull();
    expect(await h.signOn()).toBe('online');
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online', 'offline', 'connecting', 'online']);
  });

  it('goes offline as signed-off-by-server on the TLV 0x09 frame', async () => {
    await start();
    await h.signOn();
    server.kick('alice');
    await offline(h);
    expect(h.states.at(-1)).toEqual({ state: 'offline', reason: { kind: 'signed-off-by-server' } });
    await h.timers.advance(600_000);
    expect(server.authSignons).toHaveLength(1);
  });

  it('emits self once per sign-on and not again for a liveness reply that changes nothing', async () => {
    await start();
    await h.signOn();
    await h.timers.advance(90_000);
    await waitFor(() => bosSnacs().filter((s) => s.family === 1 && s.subtype === 0x0e).length === 2, 'the liveness probe');
    await settle(server.port);
    await h.timers.advance(20_000);
    expect(h.selves).toHaveLength(1);
    expect(h.client.state).toBe('online');
  });

  it('takes one budget slot per sign-on', async () => {
    server = await FakeOscarServer.start();
    server.addUser('Alice', 'alicepw1');
    let taken = 0;
    h = makeClient(server, {
      loginBudget: {
        take: async () => {
          taken++;
        },
      },
    });
    await h.signOn();
    expect(taken).toBe(1);
    await h.client.signOff();
    await gone();
    await h.signOn();
    expect(taken).toBe(2);
  });

  it('never logs the password', async () => {
    await start();
    await h.signOn();
    await h.client.signOff();
    expect(await failureOf(h.signOn('Alice', WRONG_PASSWORD))).toEqual({ kind: 'wrong-password' });
    expect(h.logs.lines.length).toBeGreaterThan(0);
    expect(h.logs.text()).not.toContain('alicepw1');
    expect(h.logs.text()).not.toContain(WRONG_PASSWORD);
  });
});
