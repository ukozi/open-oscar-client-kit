import { describe, expect, it } from 'vitest';
import { Account } from '../../../src/client/account.js';
import type { AccountConnection, AccountDeps } from '../../../src/client/account.js';
import type { BosLink } from '../../../src/client/bos-link.js';
import { OscarError } from '../../../src/client/errors.js';
import { encodeAdminEmailQuery, encodeAdminFormat } from '../../../src/wire/admin.js';
import { toHex } from '../../../src/wire/bytes.js';
import { ConnectionClosedError, RedirectRefusedError, RequestTimeoutError } from '../../../src/wire/connection.js';
import { encodeClientOnline, encodeClientVersions, encodeServiceRequest } from '../../../src/wire/oservice.js';
import type { Snac } from '../../../src/wire/snac.js';
import { encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import type { CommandError } from '../../../src/model/session.js';
import { ManualTimers, captureLog, tick } from '../../fake/oscar-client.js';
import type { LogLine } from '../../fake/oscar-client.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const v = loadVectors('hand-admin.json');
const server = { host: '127.0.0.1', port: 5190 };
const COOKIE = Uint8Array.of(0xc0, 0x0c, 0x1e);
const NAME = 'Chimr Dev 2';
const ADDRESS = 'dev2@example.com';

const snac = (family: number, subtype: number, body: Uint8Array): Snac => ({ family, subtype, flags: 0, requestId: 1, body });
const hang = <T>(): Promise<T> => new Promise<T>(() => {});
const key = (family: number, subtype: number): string => `${family}/${subtype}`;

// 0x01/0x05 naming 127.0.0.1:5191 with the cookie.
const grantReply = (): Snac =>
  snac(0x0001, 0x0005, encodeTlvs([tlv.str(0x0005, '127.0.0.1:5191'), tlv.bytes(0x0006, COOKIE)]));
// A change reply refused with that code: TLV 0x08 and an empty TLV 0x04.
const refusedChange = (code: number): Snac =>
  snac(0x0007, 0x0005, Uint8Array.of(0x00, 0x03, 0x00, 0x02, 0x00, 0x08, 0x00, 0x02, code >> 8, code & 0xff, 0x00, 0x04, 0x00, 0x00));
const adminErr = (code: number): Snac => snac(0x0007, 0x0001, Uint8Array.of(code >> 8, code & 0xff));

type Answer = (family: number, subtype: number, body: Uint8Array | undefined) => Promise<Snac>;

const answers: Answer = (family, subtype) => {
  if (family === 0x0001 && subtype === 0x0017) return Promise.resolve(snac(0x0001, 0x0018, new Uint8Array(0)));
  if (family === 0x0007 && subtype === 0x0004) return Promise.resolve(snac(0x0007, 0x0005, bytesOf(v, 'admin change reply body, success, Chimr Dev 2')));
  if (family === 0x0007 && subtype === 0x0002) return Promise.resolve(snac(0x0007, 0x0003, bytesOf(v, 'admin info reply body, email dev2@example.com')));
  return hang();
};

function stubConnection(id: number, events: string[], answer: Answer) {
  const closeListeners: (() => void)[] = [];
  const waiting = new Set<(error: Error) => void>();
  const bodies: { family: number; subtype: number; body: Uint8Array | undefined; timeoutMs: number | undefined }[] = [];
  let closes = 0;
  const conn: AccountConnection = {
    request(family, subtype, body, timeoutMs) {
      events.push(`request:${key(family, subtype)}#${id}`);
      bodies.push({ family, subtype, body, timeoutMs });
      return new Promise<Snac>((resolve, reject) => {
        waiting.add(reject);
        answer(family, subtype, body).then(resolve, reject);
      });
    },
    send(family, subtype, body) {
      events.push(`send:${key(family, subtype)}#${id}`);
      bodies.push({ family, subtype, body, timeoutMs: undefined });
      return 1;
    },
    close() {
      closes++;
      events.push(`close#${id}`);
    },
    onClose(fn) {
      closeListeners.push(() => fn({ kind: 'eof', clean: false }));
      return () => {
        closeListeners.length = 0;
      };
    },
  };
  // The server ends it: what waits rejects as closed, then the close listeners run (connection.ts finish).
  const drop = (): void => {
    for (const reject of waiting) reject(new ConnectionClosedError({ kind: 'eof', clean: false }));
    for (const fn of [...closeListeners]) fn();
  };
  return { conn, bodies, drop, closes: () => closes };
}

type Options = {
  service?: () => Promise<Snac>;
  open?: (grant: { host: string; port: number; cookie: Uint8Array }) => Promise<AccountConnection> | undefined;
  answer?: Answer;
  limited?: (family: number, subtype: number) => boolean;
  renamed?: (name: string) => void;
};

function harness(opts: Options = {}) {
  const events: string[] = [];
  const serviceCalls: { family: number; subtype: number; body: Uint8Array | undefined; timeoutMs: number }[] = [];
  const grants: { host: string; port: number; cookie: Uint8Array }[] = [];
  const conns: ReturnType<typeof stubConnection>[] = [];
  const renamed: string[] = [];
  const limited = opts.limited ?? (() => false);
  const link = {
    oserviceVersion: 1,
    paced(family: number, subtype: number): Promise<void> {
      events.push(`paced:${key(family, subtype)}`);
      return Promise.resolve();
    },
    isLimited: limited,
    requestMatching(family: number, subtype: number, body: Uint8Array | undefined, timeoutMs: number): Promise<Snac> {
      events.push(`requestMatching:${key(family, subtype)}`);
      serviceCalls.push({ family, subtype, body, timeoutMs });
      return opts.service ? opts.service() : Promise.resolve(grantReply());
    },
  } as unknown as BosLink;
  const timers = new ManualTimers();
  const log = captureLog();
  const deps: AccountDeps = {
    log: log.log,
    now: timers.now,
    timers: timers.api,
    renamed: (name) => {
      events.push(`renamed:${name}`);
      renamed.push(name);
      opts.renamed?.(name);
    },
    open: (grant) => {
      events.push('open');
      grants.push(grant);
      const given = opts.open?.(grant);
      if (given) return given;
      const stub = stubConnection(conns.length + 1, events, opts.answer ?? answers);
      conns.push(stub);
      return Promise.resolve(stub.conn);
    },
  };
  return { account: new Account(deps), link, events, serviceCalls, grants, conns, renamed, lines: log.lines, text: log.text };
}

async function failure(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OscarError) return error.info;
    throw error;
  }
  throw new Error('it did not fail');
}

const warnings = (lines: LogLine[]): LogLine[] => lines.filter((l) => l.level === 'warn');

describe('Account', () => {
  it('asks the Admin service on BOS and announces OService and Admin at version 1', async () => {
    const h = harness();
    await expect(h.account.format(h.link, server, NAME)).resolves.toBe(NAME);
    expect(h.serviceCalls).toHaveLength(1);
    const [service] = h.serviceCalls;
    expect(service?.family).toBe(0x0001);
    expect(service?.subtype).toBe(0x0004);
    expect(toHex(service?.body ?? new Uint8Array(0))).toBe(toHex(encodeServiceRequest(0x0007, { useSsl: false })));
    expect(service?.timeoutMs).toBe(10_000);
    expect(h.grants).toEqual([{ host: '127.0.0.1', port: 5191, cookie: COOKIE }]);
    expect(h.events).toEqual([
      'requestMatching:1/4',
      'open',
      'paced:1/23',
      'request:1/23#1',
      'paced:1/2',
      'send:1/2#1',
      'paced:7/4',
      'request:7/4#1',
      'renamed:Chimr Dev 2',
      'close#1',
    ]);
    const bodies = h.conns[0]?.bodies ?? [];
    expect(bodies.map((b) => [b.family, b.subtype, toHex(b.body ?? new Uint8Array(0)), b.timeoutMs])).toEqual([
      [0x0001, 0x0017, toHex(encodeClientVersions([0x0001, 0x0007])), 10_000],
      [0x0001, 0x0002, toHex(encodeClientOnline([0x0001, 0x0007])), undefined],
      [0x0007, 0x0004, toHex(encodeAdminFormat(NAME)), 10_000],
    ]);
    expect(h.conns[0]?.closes()).toBe(1);
  });

  it("calls renamed with the reply's name before format resolves", async () => {
    const h = harness();
    // The client passes on the reply's TLV 0x01, not the name it asked for.
    await h.account.format(h.link, server, 'chimr dev 2').then(() => h.events.push('resolved'));
    expect(h.events.filter((e) => e.startsWith('renamed:') || e === 'resolved')).toEqual(['renamed:Chimr Dev 2', 'resolved']);
  });

  describe('maps each failure to its CommandError', () => {
    const notOffered: CommandError = { kind: 'account', reason: 'not-offered' };
    const refused0: CommandError = { kind: 'refused', code: 0 };
    const lost: CommandError = { kind: 'connection-lost' };
    const formatAnswer =
      (reply: () => Promise<Snac>): Answer =>
      (family, subtype, body) =>
        family === 0x0007 ? reply() : answers(family, subtype, body);
    const cases: { name: string; op?: 'format' | 'email'; opts: Options; expected: CommandError; opened: boolean }[] = [
      {
        name: 'ServiceRefusedError (0x01/0x01 code 5)',
        opts: { service: () => Promise.resolve(snac(0x0001, 0x0001, Uint8Array.of(0x00, 0x05))) },
        expected: notOffered,
        opened: false,
      },
      {
        name: 'RedirectRefusedError',
        opts: { service: () => Promise.reject(new RedirectRefusedError('127.0.0.1:5191')) },
        expected: notOffered,
        opened: false,
      },
      { name: 'AdminErr 0x0008', opts: { answer: formatAnswer(() => Promise.resolve(adminErr(0x0008))) }, expected: notOffered, opened: true },
      { name: 'AdminErr 0x0005', opts: { answer: formatAnswer(() => Promise.resolve(adminErr(0x0005))) }, expected: notOffered, opened: true },
      {
        name: 'TLV 0x08 of 0x0001',
        opts: { answer: formatAnswer(() => Promise.resolve(snac(0x0007, 0x0005, bytesOf(v, 'admin change reply body, failure 0x0001')))) },
        expected: { kind: 'account', reason: 'not-same' },
        opened: true,
      },
      { name: 'TLV 0x08 of 0x0006', opts: { answer: formatAnswer(() => Promise.resolve(refusedChange(0x0006))) }, expected: { kind: 'account', reason: 'invalid' }, opened: true },
      { name: 'TLV 0x08 of 0x000B', opts: { answer: formatAnswer(() => Promise.resolve(refusedChange(0x000b))) }, expected: { kind: 'account', reason: 'invalid' }, opened: true },
      { name: 'TLV 0x08 of 0x0004', opts: { answer: formatAnswer(() => Promise.resolve(refusedChange(0x0004))) }, expected: notOffered, opened: true },
      { name: 'TLV 0x08 of 0x0013', opts: { answer: formatAnswer(() => Promise.resolve(refusedChange(0x0013))) }, expected: notOffered, opened: true },
      {
        name: 'a reply cut short',
        opts: {
          answer: formatAnswer(() =>
            Promise.resolve(snac(0x0007, 0x0005, bytesOf(v, 'admin change reply body, success, Chimr Dev 2').subarray(0, 10))),
          ),
        },
        expected: refused0,
        opened: true,
      },
      {
        name: 'a format reply with neither TLV',
        opts: { answer: formatAnswer(() => Promise.resolve(snac(0x0007, 0x0005, Uint8Array.of(0x00, 0x03, 0x00, 0x00)))) },
        expected: refused0,
        opened: true,
      },
      {
        // An empty name is no name: renamed('') lets the host write '' over the remembered entry.
        name: 'a format reply whose TLV 0x01 is empty',
        opts: { answer: formatAnswer(() => Promise.resolve(snac(0x0007, 0x0005, Uint8Array.of(0x00, 0x03, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00)))) },
        expected: refused0,
        opened: true,
      },
      {
        name: 'an email reply without TLV 0x11',
        op: 'email',
        opts: { answer: formatAnswer(() => Promise.resolve(snac(0x0007, 0x0003, Uint8Array.of(0x00, 0x03, 0x00, 0x00)))) },
        expected: refused0,
        opened: true,
      },
      {
        name: "the service step's timeout",
        opts: {
          limited: (family, subtype) => family === 0x0001 && subtype === 0x0004,
          // As BosLink.requestMatching rejects (bos-link.ts): a timeout that says whether the class is limited.
          service: () => Promise.reject(new OscarError({ kind: 'timeout', rateLimited: true })),
        },
        expected: { kind: 'timeout', rateLimited: true },
        opened: false,
      },
      {
        name: "the versions step's timeout",
        opts: {
          limited: (family, subtype) => family === 0x0001 && subtype === 0x0017,
          answer: (family, subtype, body) => (family === 0x0001 ? Promise.reject(new RequestTimeoutError()) : answers(family, subtype, body)),
        },
        expected: { kind: 'timeout', rateLimited: true },
        opened: true,
      },
      {
        name: "the versions step's timeout, its class not limited",
        opts: {
          limited: (family) => family === 0x0007,
          answer: (family, subtype, body) => (family === 0x0001 ? Promise.reject(new RequestTimeoutError()) : answers(family, subtype, body)),
        },
        expected: { kind: 'timeout', rateLimited: false },
        opened: true,
      },
      {
        name: "the request step's timeout",
        opts: { limited: (family, subtype) => family === 0x0007 && subtype === 0x0004, answer: formatAnswer(() => Promise.reject(new RequestTimeoutError())) },
        expected: { kind: 'timeout', rateLimited: true },
        opened: true,
      },
      { name: 'open rejecting', opts: { open: () => Promise.reject(new Error('ECONNREFUSED')) }, expected: lost, opened: false },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const h = harness(c.opts);
        const asked = c.op === 'email' ? h.account.email(h.link, server) : h.account.format(h.link, server, NAME);
        expect(await failure(asked)).toEqual(c.expected);
        expect(h.renamed).toEqual([]);
        expect(h.conns).toHaveLength(c.opened ? 1 : 0);
        for (const conn of h.conns) expect(conn.closes()).toBe(1);
      });
    }

    it('the connection closing before the answer', async () => {
      const h = harness({ answer: formatAnswer(() => hang()) });
      const asked = failure(h.account.format(h.link, server, NAME));
      await tick();
      expect(h.events).toContain('request:7/4#1');
      h.conns[0]?.drop();
      expect(await asked).toEqual(lost);
      expect(h.conns[0]?.closes()).toBe(1);
      expect(h.renamed).toEqual([]);
      // A closed connection is a named failure: the line names no error class.
      expect(warnings(h.lines)).toEqual([{ level: 'warn', msg: 'account request failed', fields: { op: 'format', step: 'request', kind: 'connection-lost' } }]);
    });

    it('an error none of its rows names is said as connection-lost, and the log names its class alone', async () => {
      const h = harness({
        renamed: (name) => {
          throw new TypeError(`could not show ${name}`);
        },
      });
      expect(await failure(h.account.format(h.link, server, NAME))).toEqual(lost);
      expect(h.conns[0]?.closes()).toBe(1);
      expect(warnings(h.lines)).toEqual([
        { level: 'warn', msg: 'account request failed', fields: { op: 'format', step: 'request', kind: 'connection-lost', error: 'TypeError' } },
      ]);
      // The class, never the message: a message can quote what it was about.
      expect(h.text()).not.toContain(NAME);
    });
  });

  it('reads the email with one TLV 0x11 query on its own connection', async () => {
    const h = harness();
    await expect(h.account.email(h.link, server)).resolves.toBe(ADDRESS);
    const bodies = h.conns[0]?.bodies ?? [];
    const query = bodies[2];
    expect([query?.family, query?.subtype, toHex(query?.body ?? new Uint8Array(0)), query?.timeoutMs]).toEqual([
      0x0007,
      0x0002,
      toHex(encodeAdminEmailQuery()),
      10_000,
    ]);
    expect(h.events.filter((e) => e.startsWith('paced:7/'))).toEqual(['paced:7/2']);
    expect(h.conns[0]?.closes()).toBe(1);
    expect(h.renamed).toEqual([]);

    const none = harness({
      answer: (family, subtype, body) =>
        family === 0x0007 ? Promise.resolve(snac(0x0007, 0x0003, bytesOf(v, 'admin info reply body, no email'))) : answers(family, subtype, body),
    });
    await expect(none.account.email(none.link, server)).resolves.toBeNull();
    expect(none.conns[0]?.closes()).toBe(1);
  });

  it('fails what waits and closes the connection on bosLost and on reset', async () => {
    for (const end of ['bosLost', 'reset'] as const) {
      const h = harness({ answer: (family, subtype, body) => (family === 0x0007 ? hang() : answers(family, subtype, body)) });
      const formatting = failure(h.account.format(h.link, server, NAME));
      const reading = failure(h.account.email(h.link, server));
      await tick();
      expect(h.conns).toHaveLength(2);
      h.account[end]();
      expect(await formatting).toEqual({ kind: 'connection-lost' });
      expect(await reading).toEqual({ kind: 'connection-lost' });
      for (const conn of h.conns) expect(conn.closes()).toBe(1);
      expect(warnings(h.lines)).toEqual([]);
      // The next format is not refused as busy: it runs on a connection of its own.
      const next = failure(h.account.format(h.link, server, NAME));
      await tick();
      expect(h.conns).toHaveLength(3);
      h.account[end]();
      expect(await next).toEqual({ kind: 'connection-lost' });
      expect(h.conns[2]?.closes()).toBe(1);
    }
  });

  it('closes a connection that opens under an older epoch', async () => {
    let opened: (conn: AccountConnection) => void = () => {};
    const events: string[] = [];
    const late = stubConnection(9, events, answers);
    const h = harness({
      open: () =>
        new Promise<AccountConnection>((resolve) => {
          opened = resolve;
        }),
    });
    const asked = failure(h.account.format(h.link, server, NAME));
    await tick();
    expect(h.events).toContain('open');
    h.account.bosLost();
    expect(await asked).toEqual({ kind: 'connection-lost' });
    opened(late.conn);
    await tick();
    expect(late.closes()).toBe(1);
    expect(events).toEqual(['close#9']);
    expect(warnings(h.lines)).toEqual([]);
  });

  it('refuses a second format while one waits', async () => {
    const h = harness({ answer: (family, subtype, body) => (family === 0x0007 ? hang() : answers(family, subtype, body)) });
    void h.account.format(h.link, server, NAME).catch(() => {});
    expect(await failure(h.account.format(h.link, server, 'chimrdev2'))).toEqual({ kind: 'local', code: 'busy' });
    await tick();
    expect(h.serviceCalls).toHaveLength(1);
  });

  it('shares one email read between two callers', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.account.email(h.link, server), h.account.email(h.link, server)]);
    expect([a, b]).toEqual([ADDRESS, ADDRESS]);
    expect(h.serviceCalls).toHaveLength(1);
    expect(h.conns).toHaveLength(1);
    await expect(h.account.email(h.link, server)).resolves.toBe(ADDRESS);
    expect(h.serviceCalls).toHaveLength(2);
  });

  it('runs a format and an email read each on its own connection', async () => {
    const h = harness();
    const [name, email] = await Promise.all([h.account.format(h.link, server, NAME), h.account.email(h.link, server)]);
    expect([name, email]).toEqual([NAME, ADDRESS]);
    expect(h.conns).toHaveLength(2);
    const asked = h.conns.map((c) => c.bodies.filter((b) => b.family === 0x0007).map((b) => b.subtype));
    expect(asked).toEqual([[0x0004], [0x0002]]);
    for (const conn of h.conns) expect(conn.closes()).toBe(1);
  });

  it('logs the steps and one failure line with no name and no address', async () => {
    const h = harness();
    await h.account.format(h.link, server, NAME);
    await h.account.email(h.link, server);
    expect(h.lines.filter((l) => l.level === 'debug' && l.msg === 'account request').map((l) => l.fields)).toEqual([
      { step: 'service', op: 'format' },
      { step: 'connect', op: 'format' },
      { step: 'versions', op: 'format' },
      { step: 'request', op: 'format' },
      { step: 'service', op: 'email' },
      { step: 'connect', op: 'email' },
      { step: 'versions', op: 'email' },
      { step: 'request', op: 'email' },
    ]);
    expect(warnings(h.lines)).toEqual([]);

    const refused = harness({
      answer: (family, subtype, body) =>
        family === 0x0007 ? Promise.resolve(snac(0x0007, 0x0005, bytesOf(v, 'admin change reply body, failure 0x0001'))) : answers(family, subtype, body),
    });
    await failure(refused.account.format(refused.link, server, NAME));
    expect(warnings(refused.lines)).toEqual([
      { level: 'warn', msg: 'account request failed', fields: { op: 'format', step: 'request', kind: 'account', code: 0x0001 } },
    ]);

    // 0x0005 is a server built without Admin, 0x0008 one that refuses it off BOS: only the log line tells them apart.
    for (const code of [0x0005, 0x0008]) {
      const unserved = harness({ service: () => Promise.resolve(snac(0x0001, 0x0001, Uint8Array.of(0x00, code))) });
      await failure(unserved.account.format(unserved.link, server, NAME));
      expect(warnings(unserved.lines)).toEqual([
        { level: 'warn', msg: 'account request failed', fields: { op: 'format', step: 'service', kind: 'account', code } },
      ]);
    }

    const timedOut = harness({ answer: (family, subtype, body) => (family === 0x0007 ? Promise.reject(new RequestTimeoutError()) : answers(family, subtype, body)) });
    await failure(timedOut.account.email(timedOut.link, server));
    expect(warnings(timedOut.lines)).toEqual([{ level: 'warn', msg: 'account request failed', fields: { op: 'email', step: 'request', kind: 'timeout' } }]);

    for (const text of [h.text(), refused.text(), timedOut.text()]) {
      for (const secret of [NAME, 'chimrdev2', ADDRESS]) expect(text).not.toContain(secret);
    }
  });
});
