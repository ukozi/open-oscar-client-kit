import { describe, expect, it } from 'vitest';
import type { BosLink } from '../../../src/client/bos-link.js';
import { DIRECTORY_REQUEST_TIMEOUT_MS, Directory, NoDirectoryError } from '../../../src/client/directory.js';
import type { DirectoryConnection } from '../../../src/client/directory.js';
import { OscarError } from '../../../src/client/errors.js';
import { toHex } from '../../../src/wire/bytes.js';
import { ConnectionClosedError, RequestTimeoutError } from '../../../src/wire/connection.js';
import { encodeGetDirInfo, encodeInterestSearch, encodeNameSearch, encodeSetDirInfo, encodeSetKeywordInfo } from '../../../src/wire/odir.js';
import { encodeClientOnline, encodeClientVersions } from '../../../src/wire/oservice.js';
import type { Snac } from '../../../src/wire/snac.js';
import { encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import { ManualTimers, captureLog } from '../../fake/oscar-client.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const v = loadVectors('odir.json');
const server = { host: '127.0.0.1', port: 5190 };
const COOKIE = Uint8Array.of(0x0d, 0x1e, 0xc0);
const LISTING = { firstName: 'Ada', lastName: 'Lovelace', city: 'Marylebone', state: 'London', country: 'UK' };

const snac = (family: number, subtype: number, body: Uint8Array): Snac => ({ family, subtype, flags: 0, requestId: 1, body });
const hang = <T>(): Promise<T> => new Promise<T>(() => {});
const key = (family: number, subtype: number): string => `${family.toString(16)}/${subtype.toString(16)}`;
const u16 = (n: number): Uint8Array => Uint8Array.of(n >> 8, n & 0xff);

const grantReply = (): Snac => snac(0x0001, 0x0005, encodeTlvs([tlv.str(0x0005, '127.0.0.1:5191'), tlv.bytes(0x0006, COOKIE)]));
const serviceRefusal = (code: number): Snac => snac(0x0001, 0x0001, u16(code));

type Answer = (family: number, subtype: number, body: Uint8Array | undefined) => Promise<Snac>;

// ODir as the server answers it: versions, the search reply and the keyword list.
const odirAnswers: Answer = (family, subtype) => {
  if (family === 0x0001 && subtype === 0x0017) return Promise.resolve(snac(0x0001, 0x0018, new Uint8Array(0)));
  if (family === 0x000f && subtype === 0x0002) return Promise.resolve(snac(0x000f, 0x0003, bytesOf(v, 'odir info reply body, two results')));
  if (family === 0x000f && subtype === 0x0004) return Promise.resolve(snac(0x000f, 0x0005, bytesOf(v, 'odir keyword list reply body')));
  return hang();
};

// Locate on BOS as the server answers it.
const bosAnswers: Answer = (family, subtype) => {
  if (family === 0x0001 && subtype === 0x0004) return Promise.resolve(grantReply());
  if (family === 0x0002 && subtype === 0x0009) return Promise.resolve(snac(0x0002, 0x000a, u16(1)));
  if (family === 0x0002 && subtype === 0x000f) return Promise.resolve(snac(0x0002, 0x0010, u16(1)));
  if (family === 0x0002 && subtype === 0x000b) return Promise.resolve(snac(0x0002, 0x000c, bytesOf(v, 'locate get dir reply body, ten fields')));
  return hang();
};

type Call = { family: number; subtype: number; body: Uint8Array | undefined; timeoutMs: number | undefined };

// An ODir connection that answers as `answer` says, records what it is asked, and can be dropped by the server.
function stubConnection(id: number, events: string[], answer: Answer) {
  const closeListeners: (() => void)[] = [];
  const waiting = new Set<(error: Error) => void>();
  const calls: Call[] = [];
  let closes = 0;
  const conn: DirectoryConnection = {
    request(family, subtype, body, timeoutMs) {
      events.push(`request:${key(family, subtype)}#${id}`);
      calls.push({ family, subtype, body, timeoutMs });
      return new Promise<Snac>((resolve, reject) => {
        waiting.add(reject);
        answer(family, subtype, body).then(resolve, reject);
      });
    },
    send(family, subtype, body) {
      events.push(`send:${key(family, subtype)}#${id}`);
      calls.push({ family, subtype, body, timeoutMs: undefined });
      return 1;
    },
    close() {
      closes++;
      events.push(`close#${id}`);
    },
    onClose(fn) {
      closeListeners.push(() => fn({ kind: 'eof', clean: false }));
      return () => {};
    },
  };
  const drop = (): void => {
    for (const reject of waiting) reject(new ConnectionClosedError({ kind: 'eof', clean: false }));
    for (const fn of [...closeListeners]) fn();
  };
  return { conn, calls, drop, closes: () => closes };
}

function harness(opts: { bos?: Answer; odir?: Answer } = {}) {
  const events: string[] = [];
  const bosCalls: Call[] = [];
  const grants: { host: string; port: number; cookie: Uint8Array }[] = [];
  const conns: ReturnType<typeof stubConnection>[] = [];
  const link = {
    paced(family: number, subtype: number): Promise<void> {
      events.push(`paced:${key(family, subtype)}`);
      return Promise.resolve();
    },
    isLimited: () => false,
    requestMatching(family: number, subtype: number, body: Uint8Array | undefined, timeoutMs: number, accept: (s: Snac) => boolean): Promise<Snac> {
      events.push(`bos:${key(family, subtype)}`);
      bosCalls.push({ family, subtype, body, timeoutMs });
      return (opts.bos ?? bosAnswers)(family, subtype, body).then((reply) => {
        if (!accept(reply)) throw new Error(`reply ${key(reply.family, reply.subtype)} not accepted`);
        return reply;
      });
    },
  } as unknown as BosLink;
  const timers = new ManualTimers();
  const log = captureLog();
  const directory = new Directory({
    log: log.log,
    now: timers.now,
    timers: timers.api,
    open: (grant) => {
      events.push('open');
      grants.push(grant);
      const stub = stubConnection(conns.length + 1, events, opts.odir ?? odirAnswers);
      conns.push(stub);
      return Promise.resolve(stub.conn);
    },
  });
  return { directory, link, events, bosCalls, grants, conns, text: log.text };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('Directory', () => {
  it('is unknown until first use', () => {
    const { directory } = harness();
    expect(directory.available()).toBeNull();
  });

  it('opens one ODir connection at first use and announces client versions, then client online, before searching', async () => {
    const { directory, link, events, bosCalls, grants, conns } = harness();
    const results = await directory.searchByName(link, server, '  Ada ', '');
    expect(results.map((r) => r.screenName)).toEqual(['Ada Byron', 'gracehopper']);
    expect(directory.available()).toBe(true);
    // The service request on BOS names ODir.
    expect(bosCalls).toHaveLength(1);
    expect(toHex(bosCalls[0]?.body ?? new Uint8Array(0)).slice(0, 4)).toBe('000f');
    expect(grants).toEqual([{ host: '127.0.0.1', port: 5191, cookie: COOKIE }]);
    expect(events).toEqual([
      'bos:1/4',
      'open',
      'paced:1/17',
      'request:1/17#1',
      'paced:1/2',
      'send:1/2#1',
      'paced:f/2',
      'request:f/2#1',
    ]);
    const stub = conns[0];
    expect(stub?.calls[0]?.body).toEqual(encodeClientVersions([0x0001, 0x000f]));
    expect(stub?.calls[1]?.body).toEqual(encodeClientOnline([0x0001, 0x000f]));
    expect(stub?.calls[2]?.body).toEqual(encodeNameSearch('Ada', ''));
    expect(stub?.calls[2]?.timeoutMs).toBe(DIRECTORY_REQUEST_TIMEOUT_MS);
  });

  it('shares the connection between two searches, at once and later', async () => {
    const { directory, link, grants, conns } = harness();
    const [first, second] = await Promise.all([directory.searchByName(link, server, 'Ada', 'Lovelace'), directory.searchByInterest(link, server, 'Rock')]);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    await directory.keywords(link, server);
    expect(grants).toHaveLength(1);
    expect(conns).toHaveLength(1);
    const asked = conns[0]?.calls.filter((c) => c.family === 0x000f).map((c) => toHex(c.body ?? new Uint8Array(0)));
    expect(asked).toEqual([toHex(encodeNameSearch('Ada', 'Lovelace')), toHex(encodeInterestSearch('Rock')), '']);
  });

  it('reads the keyword list into groups', async () => {
    const { directory, link } = harness();
    expect(await directory.keywords(link, server)).toEqual([
      { category: 'Music', keywords: ['Jazz', 'Rock'] },
      { category: null, keywords: ['Hiking'] },
    ]);
  });

  it.each([0x0008, 0x0005])('takes a service refused with 0x%s as no directory, opens nothing, and refuses at once until the next sign-on', async (code) => {
    let refuse = true;
    const { directory, link, bosCalls, grants } = harness({
      bos: (family, subtype, body) => (family === 0x0001 && subtype === 0x0004 && refuse ? Promise.resolve(serviceRefusal(code)) : bosAnswers(family, subtype, body)),
    });
    expect(await rejection(directory.searchByName(link, server, 'Ada', ''))).toBeInstanceOf(NoDirectoryError);
    expect(directory.available()).toBe(false);
    expect(grants).toEqual([]);
    refuse = false;
    // Later calls refuse without asking the server again.
    expect(await rejection(directory.keywords(link, server))).toBeInstanceOf(NoDirectoryError);
    expect(await rejection(directory.searchByInterest(link, server, 'Rock'))).toBeInstanceOf(NoDirectoryError);
    expect(bosCalls).toHaveLength(1);
    // A lost BOS connection is not a new session.
    directory.bosLost();
    expect(directory.available()).toBe(false);
    // The next sign-on asks again.
    directory.close();
    expect(directory.available()).toBeNull();
    expect(await directory.searchByName(link, server, 'Ada', '')).toHaveLength(2);
    expect(directory.available()).toBe(true);
  });

  it('takes any other refused service as a refusal, not as no directory', async () => {
    const { directory, link } = harness({
      bos: (family, subtype, body) => (family === 0x0001 && subtype === 0x0004 ? Promise.resolve(serviceRefusal(0x0002)) : bosAnswers(family, subtype, body)),
    });
    const error = await rejection(directory.searchByName(link, server, 'Ada', ''));
    expect(error).toBeInstanceOf(OscarError);
    expect((error as OscarError).info).toEqual({ kind: 'refused', code: 0x0002 });
    expect(directory.available()).toBeNull();
  });

  it('rejects a search the connection dropped under as lost, leaves availability as it was, and reopens for the next', async () => {
    let answerSearch = false;
    const { directory, link, conns } = harness({
      odir: (family, subtype, body) => (family === 0x000f && subtype === 0x0002 && !answerSearch ? hang() : odirAnswers(family, subtype, body)),
    });
    const searching = directory.searchByName(link, server, 'Ada', '');
    await expect.poll(() => conns[0]?.calls.some((c) => c.family === 0x000f)).toBe(true);
    // The connection opened: the server has a directory, and a drop does not change that.
    const before = directory.available();
    expect(before).toBe(true);
    conns[0]?.drop();
    const error = await rejection(searching);
    expect(error).toBeInstanceOf(OscarError);
    expect((error as OscarError).info).toEqual({ kind: 'connection-lost' });
    expect(error).not.toBeInstanceOf(NoDirectoryError);
    expect(directory.available()).toBe(before);

    answerSearch = true;
    expect(await directory.searchByName(link, server, 'Ada', '')).toHaveLength(2);
    expect(conns).toHaveLength(2);
    expect(directory.available()).toBe(true);
  });

  it('rejects a search that timed out as a timeout, not as no directory, and keeps the connection', async () => {
    let timeOut = true;
    const { directory, link, conns } = harness({
      odir: (family, subtype, body) =>
        family === 0x000f && subtype === 0x0002 && timeOut ? Promise.reject(new RequestTimeoutError()) : odirAnswers(family, subtype, body),
    });
    await directory.keywords(link, server);
    const error = await rejection(directory.searchByName(link, server, 'Ada', ''));
    expect((error as OscarError).info).toEqual({ kind: 'timeout', rateLimited: false });
    expect(directory.available()).toBe(true);
    timeOut = false;
    expect(await directory.searchByName(link, server, 'Ada', '')).toHaveLength(2);
    expect(conns).toHaveLength(1);
  });

  it('takes an ODir error or a search status other than OK as a refusal', async () => {
    const { directory, link } = harness({
      odir: (family, subtype, body) => {
        if (family === 0x000f && subtype === 0x0004) return Promise.resolve(snac(0x000f, 0x0001, u16(0x0004)));
        if (family === 0x000f && subtype === 0x0002) return Promise.resolve(snac(0x000f, 0x0003, Uint8Array.of(0, 3, 0, 0, 0, 0)));
        return odirAnswers(family, subtype, body);
      },
    });
    expect(((await rejection(directory.keywords(link, server))) as OscarError).info).toEqual({ kind: 'refused', code: 0x0004 });
    expect(((await rejection(directory.searchByName(link, server, 'Ada', ''))) as OscarError).info).toEqual({ kind: 'refused', code: 0x0003 });
  });

  it('refuses a name search with both names empty, and an empty interest, without asking anything', async () => {
    const { directory, link, bosCalls } = harness();
    expect(((await rejection(directory.searchByName(link, server, ' ', '  '))) as OscarError).info).toEqual({ kind: 'local', code: 'invalid-argument' });
    expect(((await rejection(directory.searchByInterest(link, server, ''))) as OscarError).info).toEqual({ kind: 'local', code: 'invalid-argument' });
    expect(bosCalls).toEqual([]);
  });

  it('closes the connection when BOS is lost and when the session ends, and a search that waited is lost', async () => {
    const { directory, link, conns } = harness({
      odir: (family, subtype, body) => (family === 0x000f && subtype === 0x0002 ? hang() : odirAnswers(family, subtype, body)),
    });
    await directory.keywords(link, server);
    const searching = directory.searchByName(link, server, 'Ada', '');
    await expect.poll(() => conns[0]?.calls.some((c) => c.family === 0x000f && c.subtype === 0x0002)).toBe(true);
    directory.bosLost();
    expect(conns[0]?.closes()).toBe(1);
    expect(((await rejection(searching)) as OscarError).info).toEqual({ kind: 'connection-lost' });
    expect(directory.available()).toBe(true);

    await directory.keywords(link, server);
    expect(conns).toHaveLength(2);
    directory.close();
    expect(conns[1]?.closes()).toBe(1);
  });

  it('sets the listing over BOS with the codec body and resolves on the reply', async () => {
    const { directory, link, bosCalls, grants } = harness();
    await directory.setListing(link, LISTING);
    expect(bosCalls).toHaveLength(1);
    expect(bosCalls[0]?.family).toBe(0x0002);
    expect(bosCalls[0]?.subtype).toBe(0x0009);
    expect(bosCalls[0]?.body).toEqual(encodeSetDirInfo(LISTING));
    expect(grants).toEqual([]);
  });

  it('sets interests over BOS with the codec body and resolves on the reply', async () => {
    const { directory, link, bosCalls, grants } = harness();
    await directory.setInterests(link, ['Rock', 'Hiking']);
    expect(bosCalls).toHaveLength(1);
    expect(bosCalls[0]?.family).toBe(0x0002);
    expect(bosCalls[0]?.subtype).toBe(0x000f);
    expect(bosCalls[0]?.body).toEqual(encodeSetKeywordInfo(['Rock', 'Hiking']));
    expect(grants).toEqual([]);
  });

  it('refuses six interests without sending', async () => {
    const { directory, link, bosCalls } = harness();
    const error = await rejection(directory.setInterests(link, ['a', 'b', 'c', 'd', 'e', 'f']));
    expect((error as OscarError).info).toEqual({ kind: 'local', code: 'invalid-argument' });
    expect(bosCalls).toEqual([]);
  });

  it('reads the own listing over BOS', async () => {
    const { directory, link, bosCalls } = harness();
    expect(await directory.ownListing(link, 'Ada Byron')).toEqual(LISTING);
    expect(bosCalls[0]?.subtype).toBe(0x000b);
    expect(bosCalls[0]?.body).toEqual(encodeGetDirInfo('Ada Byron'));
  });

  it('takes a Locate error as a refusal with its code', async () => {
    const { directory, link } = harness({
      bos: (family, subtype, body) => (family === 0x0002 ? Promise.resolve(snac(0x0002, 0x0001, u16(0x000e))) : bosAnswers(family, subtype, body)),
    });
    expect(((await rejection(directory.setListing(link, LISTING))) as OscarError).info).toEqual({ kind: 'refused', code: 0x000e });
    expect(((await rejection(directory.setInterests(link, []))) as OscarError).info).toEqual({ kind: 'refused', code: 0x000e });
    expect(((await rejection(directory.ownListing(link, 'Ada Byron'))) as OscarError).info).toEqual({ kind: 'refused', code: 0x000e });
  });

  it('logs no name, listing or keyword', async () => {
    const { directory, link, conns, text } = harness({
      odir: (family, subtype, body) => (family === 0x000f && subtype === 0x0002 ? hang() : odirAnswers(family, subtype, body)),
    });
    await directory.keywords(link, server);
    const searching = directory.searchByName(link, server, 'Ada', 'Lovelace');
    await expect.poll(() => conns[0]?.calls.some((c) => c.family === 0x000f && c.subtype === 0x0002)).toBe(true);
    conns[0]?.drop();
    await rejection(searching);
    expect(text()).not.toMatch(/Ada|Lovelace|Rock|Hiking/);
  });
});
