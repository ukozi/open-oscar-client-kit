import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BosLink } from '../../../src/client/bos-link.js';
import { clientIdFor } from '../../../src/client/client-id.js';
import type { OscarError } from '../../../src/client/errors.js';
import { SignOnError } from '../../../src/client/errors.js';
import { connectionTls, redirectMode } from '../../../src/client/connect-options.js';
import { INVISIBLE_TIMEOUT_MS, LOGIN_COOKIE_NAME_BUDGET, SignOn, classifyBosClose, loginFailure, parseSelfInfo } from '../../../src/client/sign-on.js';
import type { Restore } from '../../../src/client/sign-on.js';
import { bucpTicketSource, storedTicketSource } from '../../../src/client/tickets.js';
import { FLAP_SIGNON } from '../../../src/wire/constants.js';
import { FlapDecoder, encodeFlap, encodeSignonPayload } from '../../../src/wire/flap.js';
import { decodeUserInfo, encodeUserInfo } from '../../../src/wire/snac.js';
import { decodeTlvs, tlv } from '../../../src/wire/tlv.js';
import { MAX_SCREEN_NAME_BYTES } from '../../../src/model/screen-name.js';
import type { SelfInfo } from '../../../src/model/session.js';
import { makeClient, stopAllClients } from '../../fake/harness.js';
import { ManualTimers, captureLog, waitFor } from '../../fake/oscar-client.js';
import { FakeOscarServer } from '../../fake/oscar-server.js';
import { StubConn } from '../../fake/stub-conn.js';
import type { SentSnac } from '../../fake/stub-conn.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const flap = loadVectors('flap.json');
const signoff = (name: string) => {
  const [frame] = new FlapDecoder().push(bytesOf(flap, name));
  return { kind: 'signoff' as const, clean: true as const, tlvs: decodeTlvs(frame?.payload ?? new Uint8Array(0)), truncated: false };
};

describe('login constants', () => {
  it('fits the longest screen name and a long client ID in the login cookie', () => {
    const long = '0.2.3-beta.1234567890123456789012'; // 32 bytes or more
    expect(Buffer.byteLength(long)).toBeGreaterThanOrEqual(32);
    for (const platform of ['darwin', 'win32', 'linux'] as const)
      expect(Buffer.byteLength(clientIdFor('Chimr', long, platform)) + MAX_SCREEN_NAME_BYTES).toBeLessThanOrEqual(LOGIN_COOKIE_NAME_BUDGET);
    expect(LOGIN_COOKIE_NAME_BUDGET).toBe(202);
  });
});

describe('loginFailure', () => {
  const rows: [string, number | undefined, object][] = [
    ['unknown-name', 0x0001, { kind: 'unknown-screen-name' }],
    ['unknown-name', 0x0007, { kind: 'unknown-screen-name' }],
    ['bad-password', 0x0005, { kind: 'wrong-password' }],
    ['suspended', 0x0008, { kind: 'account-unavailable', code: 0x0008 }],
    ['suspended', 0x0009, { kind: 'account-unavailable', code: 0x0009 }],
    ['suspended', 0x0011, { kind: 'account-unavailable', code: 0x0011 }],
    ['suspended', 0x0022, { kind: 'account-unavailable', code: 0x0022 }],
    ['login-rate-limited', 0x001d, { kind: 'login-rate-limited' }],
    ['network', 0x0006, { kind: 'refused', code: 0x0006 }],
    ['network', 0x0018, { kind: 'refused', code: 0x0018 }],
    ['network', undefined, { kind: 'unreachable' }],
    ['tls', undefined, { kind: 'unreachable' }],
  ];
  it.each(rows)('%s with code %s', (reason, code, want) => {
    expect(loginFailure({ ok: false, reason: reason as never, detail: '', ...(code === undefined ? {} : { code }) })).toEqual(want);
  });

  it('reads a 0x1D after the challenge as the instance cap', () => {
    expect(loginFailure({ ok: false, reason: 'login-rate-limited', code: 0x1d, detail: '', loginSent: true })).toEqual({ kind: 'too-many-sessions' });
    expect(loginFailure({ ok: false, reason: 'login-rate-limited', code: 0x1d, detail: '', loginSent: false })).toEqual({ kind: 'login-rate-limited' });
  });
});

describe('classifyBosClose', () => {
  it('reads each sign-off frame form', () => {
    expect(classifyBosClose(signoff('signoff after a server-side close, sequence 101'))).toBe('signed-off-by-server');
    expect(classifyBosClose(signoff('signoff when five instances are already online, sequence 101'))).toBe('too-many-sessions');
    expect(classifyBosClose(signoff('signoff from the login limiter, sequence 101'))).toBe('too-many-sessions');
    expect(classifyBosClose(signoff('empty signoff, sequence 102'))).toBe('dropped');
    expect(classifyBosClose({ kind: 'signoff', clean: true, tlvs: [], truncated: true })).toBe('dropped');
    expect(classifyBosClose({ kind: 'signoff', clean: true, tlvs: [tlv.u8(0x09, 1)], truncated: true })).toBe('dropped');
    expect(classifyBosClose({ kind: 'eof', clean: false })).toBe('dropped');
    expect(classifyBosClose({ kind: 'probe-timeout', clean: false })).toBe('dropped');
    expect(classifyBosClose({ kind: 'error', clean: false, error: new Error('x') })).toBe('dropped');
  });
});

describe('SignOn self info', () => {
  const handSession = loadVectors('hand-session.json');
  const selfSnac = (name: string, subtype = 0x0f) => ({ family: 1, subtype, flags: 0, requestId: 0x80000000, body: bytesOf(handSession, name) });

  it('holds self info from 0x01/0x0F, emits only on a change, and forgets it on reset', () => {
    const seen: SelfInfo[] = [];
    const timers = new ManualTimers();
    const signOn = new SignOn({ log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} }, emitSelf: (self) => seen.push(self) });
    const plain = { screenName: 'Chimr Dev 2', signedOnAt: 1_790_000_000_000, warnLevel: 0, invisible: false };
    expect(signOn.self).toBeNull();
    expect(signOn.handle(selfSnac('buddy arrived body, plain'))).toBe(true);
    expect(signOn.handle(selfSnac('buddy arrived body, plain'))).toBe(true);
    expect([signOn.self, seen]).toEqual([plain, [plain]]);
    signOn.handle(selfSnac('buddy arrived body, away and idle'));
    expect(seen.map((s) => s.warnLevel)).toEqual([0, 100]);
    expect(signOn.handle(selfSnac('buddy arrived body, plain', 0x0e))).toBe(false);
    signOn.reset();
    expect([signOn.self, seen.length]).toEqual([null, 2]);
  });

  // A format's reply and the server's 0x01/0x0F can come in either order, and only the first emits.
  describe('renamed', () => {
    const PLAIN = 'buddy arrived body, plain';
    // The plain self info, 'Chimr Dev 2', under another spelling of the same screen name, every other field the same.
    const spelled = (name: string) => {
      const snac = selfSnac(PLAIN);
      const { info } = decodeUserInfo(snac.body, 0);
      return { ...snac, body: encodeUserInfo({ ...info, name }) };
    };
    function make() {
      const seen: SelfInfo[] = [];
      const timers = new ManualTimers();
      const signOn = new SignOn({ log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} }, emitSelf: (self) => seen.push(self) });
      return { signOn, seen };
    }

    it('renamed emits self once, and a self info with the same name after it emits nothing', () => {
      const { signOn, seen } = make();
      signOn.handle(spelled('chimr dev 2'));
      const held = signOn.self;
      signOn.renamed('Chimr Dev 2');
      expect(seen.map((self) => self.screenName)).toEqual(['chimr dev 2', 'Chimr Dev 2']);
      expect(signOn.self).toEqual({ ...held, screenName: 'Chimr Dev 2' });
      expect(signOn.handle(selfSnac(PLAIN))).toBe(true);
      expect(seen).toHaveLength(2);
    });

    it('a self info with the new name before renamed leaves renamed emitting nothing', () => {
      const { signOn, seen } = make();
      signOn.handle(spelled('chimr dev 2'));
      signOn.handle(selfSnac(PLAIN));
      signOn.renamed('Chimr Dev 2');
      expect(seen.map((self) => self.screenName)).toEqual(['chimr dev 2', 'Chimr Dev 2']);
      expect(signOn.self?.screenName).toBe('Chimr Dev 2');
    });

    it('renamed does nothing with no self info held', () => {
      const { signOn, seen } = make();
      signOn.renamed('Chimr Dev 2');
      expect([signOn.self, seen]).toEqual([null, []]);
      signOn.handle(selfSnac(PLAIN));
      signOn.reset();
      signOn.renamed('Chimr Dev 2');
      expect([signOn.self, seen.length]).toEqual([null, 1]);
    });
  });
});

describe('parseSelfInfo', () => {
  it('reads the invisible bit of a self info', () => {
    const body = bytesOf(loadVectors('hand-lists-info.json'), 'self info body, Alice invisible at warn level 5%');
    expect(parseSelfInfo(body)).toEqual({ screenName: 'Alice', signedOnAt: 1_790_000_000_000, warnLevel: 50, invisible: true });
  });
});

describe('SignOn status commands', () => {
  const handListsInfo = loadVectors('hand-lists-info.json');
  const invisibleSelf = bytesOf(handListsInfo, 'self info body, Alice invisible at warn level 5%');
  // The same self info with the status TLV's invisible bit cleared: the last four bytes are the status.
  const visibleSelf = Uint8Array.from(invisibleSelf).fill(0, invisibleSelf.length - 4);

  function make() {
    const timers = new ManualTimers();
    const conn = new StubConn(timers);
    const logs = captureLog();
    const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: logs.log });
    const selves: SelfInfo[] = [];
    const warned: { level: number; by: string | null }[] = [];
    const signOn = new SignOn({
      log: logs.log,
      now: timers.now,
      timers: timers.api,
      budget: { take: async () => {} },
      emitSelf: (self) => selves.push(self),
      emitWarned: (warning) => warned.push(warning),
    });
    conn.onSnac((snac) => {
      signOn.handle(snac);
    });
    const selfInfo = (body: Uint8Array, requestId = 0x80000000): void => conn.deliver({ family: 1, subtype: 0x0f, body, requestId });
    const track = (promise: Promise<void>) => {
      const outcome: { done: boolean; error?: unknown } = { done: false };
      promise.then(
        () => { outcome.done = true; },
        (e: unknown) => { outcome.done = true; outcome.error = e; },
      );
      return outcome;
    };
    return { timers, conn, link, signOn, selves, warned, selfInfo, track };
  }

  it('the visible self info differs from the vector in the invisible bit only', () => {
    expect(parseSelfInfo(visibleSelf)).toEqual({ ...parseSelfInfo(invisibleSelf), invisible: false });
  });

  it('emits self when only the invisible bit changed', () => {
    const { selves, selfInfo } = make();
    selfInfo(visibleSelf);
    selfInfo(visibleSelf);
    selfInfo(invisibleSelf);
    expect(selves.map((s) => s.invisible)).toEqual([false, true]);
  });

  it('setInvisible is confirmed by the self info that carries the value, also when a liveness reply is read just before it', async () => {
    const { timers, conn, link, signOn, selfInfo, track } = make();
    selfInfo(visibleSelf);
    const outcome = track(signOn.setInvisible(link, true));
    await timers.advance(0);
    expect(conn.sent.map((s) => [s.family, s.subtype, Buffer.from(s.body).toString('hex')])).toEqual([[1, 0x1e, '0006000400000100']]);
    // Both in one turn, as when one read carries both SNACs.
    selfInfo(visibleSelf, 7);
    expect(signOn.self?.invisible).toBe(false);
    expect(timers.pending()).toEqual([INVISIBLE_TIMEOUT_MS]);
    selfInfo(invisibleSelf);
    await timers.advance(0);
    expect(outcome).toEqual({ done: true });
    expect(signOn.self?.invisible).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('a self info read before the status is written does not confirm it', async () => {
    const { timers, signOn, link, selfInfo, track } = make();
    selfInfo(invisibleSelf);
    const first = track(signOn.setInvisible(link, false));
    await timers.advance(0);
    selfInfo(visibleSelf);
    await timers.advance(0);
    expect(first).toEqual({ done: true });
    // Asked for what the session already is: only a self info after the write settles it.
    const again = track(signOn.setInvisible(link, false));
    await timers.advance(0);
    expect(again).toEqual({ done: false });
    selfInfo(visibleSelf);
    await timers.advance(0);
    expect(again).toEqual({ done: true });
  });

  it('setInvisible times out 15 s after the write and a later confirmation still sets the status', async () => {
    const { timers, signOn, link, selfInfo, track } = make();
    selfInfo(visibleSelf);
    const outcome = track(signOn.setInvisible(link, true));
    // The clock runs from the write.
    await timers.advance(0);
    await timers.advance(INVISIBLE_TIMEOUT_MS - 1);
    expect(outcome).toEqual({ done: false });
    await timers.advance(1);
    expect((outcome.error as OscarError).info).toEqual({ kind: 'timeout', rateLimited: false });
    expect(signOn.self?.invisible).toBe(false);
    selfInfo(invisibleSelf);
    expect(signOn.self?.invisible).toBe(true);
  });

  it('setInvisible fails as connection lost when the session ends first, and leaves no timer', async () => {
    const { timers, signOn, link, selfInfo, track } = make();
    selfInfo(visibleSelf);
    const outcome = track(signOn.setInvisible(link, true));
    // In the turn of the write, before the command has seen it settle.
    signOn.reset();
    await timers.advance(0);
    expect((outcome.error as OscarError).info).toEqual({ kind: 'connection-lost' });
    expect(timers.pending()).toEqual([]);
    await timers.advance(INVISIBLE_TIMEOUT_MS);
    expect(signOn.self).toBeNull();
  });

  it('remembers whether idle is reported, until the session ends', async () => {
    const { conn, signOn, link } = make();
    expect(signOn.idleReported).toBe(false);
    await signOn.reportIdle(link, 600);
    expect(signOn.idleReported).toBe(true);
    await signOn.reportIdle(link, 0);
    expect(signOn.idleReported).toBe(false);
    expect(conn.sent.map((s) => [s.family, s.subtype, Buffer.from(s.body).toString('hex')])).toEqual([
      [1, 0x11, '00000258'],
      [1, 0x11, '00000000'],
    ]);
    await signOn.reportIdle(link, 60);
    signOn.reset();
    expect(signOn.idleReported).toBe(false);
  });

  it('a warning notice sets the own level, then tells of the warning', () => {
    const { conn, signOn, selves, warned, selfInfo } = make();
    selfInfo(visibleSelf);
    conn.deliver({ family: 1, subtype: 0x10, body: bytesOf(handListsInfo, 'warning notice body, level 10% from Bob') });
    expect(signOn.self?.warnLevel).toBe(100);
    expect(selves.map((s) => s.warnLevel)).toEqual([50, 100]);
    expect(warned).toEqual([{ level: 100, by: 'Bob' }]);
    conn.deliver({ family: 1, subtype: 0x10, body: bytesOf(handListsInfo, 'warning notice body, level 3%, anonymous') });
    expect(warned[1]).toEqual({ level: 30, by: null });
    expect(signOn.self).toEqual({ screenName: 'Alice', signedOnAt: 1_790_000_000_000, warnLevel: 30, invisible: false });
  });
});

describe('SignOn.bringUp', () => {
  function make() {
    const timers = new ManualTimers();
    const conn = new StubConn(timers);
    const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captureLog().log });
    const signOn = new SignOn({ log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} } });
    const outcome: { done: boolean; error?: unknown } = { done: false };
    signOn.bringUp(link, { loadFeedbag: async () => {}, useFeedbag: async () => {} }).then(
      () => { outcome.done = true; },
      (e: unknown) => { outcome.done = true; outcome.error = e; },
    );
    const steps = () => conn.sent.map((s) => [s.family, s.subtype]);
    return { timers, conn, outcome, steps };
  }
  const hostOnline = Uint8Array.of(0, 1, 0, 2, 0, 3, 0, 4, 0, 0x13);

  it("does not fail a step on a relayed SNAC of another family that carries the step's request id", async () => {
    const { timers, conn, outcome, steps } = make();
    conn.deliver({ family: 1, subtype: 3, body: hostOnline, requestId: 0x80000000 });
    await timers.advance(0);
    expect(steps()).toEqual([[1, 0x17]]);
    const requestId = conn.sent[0]?.requestId ?? -1;
    // A peer's typing event and client error, relayed with the request id the peer chose.
    conn.deliver({ family: 4, subtype: 0x14, requestId });
    conn.deliver({ family: 4, subtype: 0x0b, requestId });
    // The error subtype of another family, and the reply subtype in another family.
    conn.deliver({ family: 4, subtype: 0x01, body: Uint8Array.of(0, 4), requestId });
    conn.deliver({ family: 4, subtype: 0x18, requestId });
    await timers.advance(0);
    expect([outcome, steps()]).toEqual([{ done: false }, [[1, 0x17]]]);
    conn.deliver({ family: 1, subtype: 0x18, requestId });
    await timers.advance(0);
    expect([outcome, steps()]).toEqual([{ done: false }, [[1, 0x17], [1, 0x06]]]);
  });

  it("fails a step on the error SNAC of the step's own family, with its code", async () => {
    const { timers, conn, outcome } = make();
    conn.deliver({ family: 1, subtype: 3, body: hostOnline, requestId: 0x80000000 });
    await timers.advance(0);
    conn.deliver({ family: 1, subtype: 0x01, body: Uint8Array.of(0, 0x0d), requestId: conn.sent[0]?.requestId ?? -1 });
    await timers.advance(0);
    expect((outcome.error as OscarError).info).toEqual({ kind: 'refused', code: 0x0d });
  });

  // The replies the sequence waits for before client online, each empty but the rate parameters' (no rate classes).
  const REPLIES = new Map<string, { family: number; subtype: number; body: Uint8Array }>([
    ['1/23', { family: 1, subtype: 0x18, body: new Uint8Array(0) }],
    ['1/6', { family: 1, subtype: 0x07, body: Uint8Array.of(0, 0) }],
    ['2/2', { family: 2, subtype: 0x03, body: new Uint8Array(0) }],
    ['4/4', { family: 4, subtype: 0x05, body: new Uint8Array(0) }],
  ]);

  /** A reconnect's sequence with idle reported (600 s) on the connection before, run until client online (0x01/0x02) is sent. */
  async function restoreRun(restore: Restore): Promise<{ signOn: SignOn; sent: SentSnac[] }> {
    const timers = new ManualTimers();
    const conn = new StubConn(timers);
    const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captureLog().log });
    const signOn = new SignOn({ log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} } });
    await signOn.reportIdle(link, 600);
    const from = conn.sent.length;
    signOn.bringUp(link, { loadFeedbag: async () => {}, useFeedbag: async () => {} }, [], restore).catch(() => {});
    conn.deliver({ family: 1, subtype: 3, body: hostOnline, requestId: 0x80000000 });
    const answered = new Set<number>();
    const online = (): boolean => conn.sent.some((s) => s.family === 1 && s.subtype === 0x02);
    for (let turn = 0; turn < 50 && !online(); turn++) {
      await timers.advance(0);
      for (const request of conn.sent.slice(from)) {
        const reply = REPLIES.get(`${request.family}/${request.subtype}`);
        if (reply === undefined || answered.has(request.requestId)) continue;
        answered.add(request.requestId);
        conn.deliver({ ...reply, requestId: request.requestId });
      }
    }
    expect(online()).toBe(true);
    return { signOn, sent: conn.sent.slice(from) };
  }
  const idleWrites = (sent: SentSnac[]): string[] => sent.filter((s) => s.family === 1 && s.subtype === 0x11).map((s) => Buffer.from(s.body).toString('hex'));

  it("restores idle against the screen name's idle time: 300 s and the system idle at 400 sends 400", async () => {
    const { signOn, sent } = await restoreRun({ away: null, invisible: false, systemIdleSeconds: () => 400, idleAfterSeconds: 300 });
    expect(idleWrites(sent)).toEqual(['00000190']);
    expect(signOn.idleReported).toBe(true);
  });

  it('restores no idle below the time, and forgets that idle was reported', async () => {
    const { signOn, sent } = await restoreRun({ away: null, invisible: false, systemIdleSeconds: () => 200, idleAfterSeconds: 300 });
    expect(idleWrites(sent)).toEqual([]);
    expect(signOn.idleReported).toBe(false);
  });

  it('restores no idle under Never, however long the system has been idle, and forgets that idle was reported', async () => {
    let read = 0;
    const { signOn, sent } = await restoreRun({
      away: null, invisible: false, idleAfterSeconds: null,
      systemIdleSeconds: () => {
        read += 1;
        return 10_000;
      },
    });
    expect(idleWrites(sent)).toEqual([]);
    expect(signOn.idleReported).toBe(false);
    // Under Never the system idle time is not read.
    expect(read).toBe(0);
  });
});

describe('the transport of a server connection', () => {
  it('is plain TCP with no tls, and TLS with the certificate file of tls', () => {
    expect(connectionTls(undefined)).toEqual({ tls: false });
    expect(connectionTls({})).toEqual({ tls: true, caFile: undefined });
    expect(connectionTls({ caFile: '/trust/ca.pem' })).toEqual({ tls: true, caFile: '/trust/ca.pem' });
  });

  it('pins first, then follows, and by default decides for each advertised host', () => {
    const pin = { host: '127.0.0.1', port: 5190 };
    expect([redirectMode(pin, true), redirectMode(pin, false), redirectMode(undefined, true), redirectMode(undefined, false), redirectMode(undefined, undefined)]).toEqual([
      'pin', 'pin', 'follow', 'auto', 'auto',
    ]);
  });

  it('a connection that does not open gives a SignOnError with the connect error as cause', async () => {
    const timers = new ManualTimers();
    const deps = { log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} } };
    const missing = '/nonexistent/ca.pem';
    const error = await new SignOn({ ...deps, tls: { caFile: missing } })
      .openBos({ host: '127.0.0.1', port: 1, cookie: Uint8Array.of(1) }, () => {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignOnError);
    expect((error as SignOnError).failure).toEqual({ kind: 'unreachable' });
    expect((error as SignOnError).evidence).toEqual({ kind: 'unreachable' });
    expect(((error as SignOnError).cause as { code?: unknown }).code).toBe('ENOENT');
  });
});

// The machine does not hold 192.0.2.1, so a connection that binds it fails.
describe('the local address', () => {
  let fake: FakeOscarServer | null = null;
  let listener: net.Server | null = null;
  const sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await stopAllClients();
    await fake?.stop();
    fake = null;
    const open = listener;
    listener = null;
    if (open) await new Promise((resolve) => open.close(resolve));
  });

  it('the BOS connection binds localAddress', async () => {
    const sources: string[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      sources.push((socket.remoteAddress ?? '').replace(/^::ffff:/, ''));
      socket.write(encodeFlap(FLAP_SIGNON, 1, encodeSignonPayload()));
    });
    listener = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const ticket = { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, cookie: Uint8Array.of(1) };
    const timers = new ManualTimers();
    const deps = { log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} } };
    const error = await new SignOn({ ...deps, localAddress: '192.0.2.1' }).openBos(ticket, () => {}).catch((e: unknown) => e);
    expect([error instanceof SignOnError, (error as SignOnError).failure]).toEqual([true, { kind: 'unreachable' }]);
    const conn = await new SignOn({ ...deps, localAddress: '127.0.0.1' }).openBos(ticket, () => {});
    await waitFor(() => sources.length === 1, 'the connection');
    expect(sources).toEqual(['127.0.0.1']);
    conn.close();
  });

  it('a client binds localAddress for the login and for BOS', async () => {
    const timers = new ManualTimers();
    const server = await FakeOscarServer.start({ now: timers.now });
    fake = server;
    server.addUser('Alice', 'alicepw1');
    const here = { host: '127.0.0.1', port: server.port };
    const failed = (run: Promise<unknown>) => run.then(() => 'online', (e: unknown) => (e instanceof SignOnError ? e.failure : e));

    expect(await failed(makeClient(server, { timers, localAddress: '192.0.2.1' }).signOn())).toEqual({ kind: 'unreachable' });
    expect(server.authSignons).toHaveLength(0);

    const deps = { log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} } };
    const issued = await bucpTicketSource({ ...deps, credentials: { screenName: 'Alice', password: 'alicepw1' }, server: here })
      .ticket({ reconnect: false, track: () => {} });
    const bound = makeClient(server, { timers, localAddress: '192.0.2.1' });
    expect(await failed(bound.client.signOnWith(storedTicketSource(issued), here))).toEqual({ kind: 'unreachable' });

    expect(await makeClient(server, { timers, localAddress: '127.0.0.1' }).signOn()).toBe('online');
  });
});
