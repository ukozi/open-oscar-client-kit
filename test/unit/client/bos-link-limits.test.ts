import { describe, expect, it } from 'vitest';
import { BosLink } from '../../../src/client/bos-link.js';
import type { BosLinkDeps } from '../../../src/client/bos-link.js';
import { decodeRateParamsReply } from '../../../src/wire/rate.js';
import { captureLog, ManualTimers } from '../../fake/oscar-client.js';
import { StubConn } from '../../fake/stub-conn.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const oservice = loadVectors('oservice.json');
const IM = [0x0004, 0x0006] as const;
const USER_INFO_QUERY = [0x0001, 0x000e] as const;

class ProbeConn extends StubConn {
  readonly gates: (() => boolean)[] = [];

  pauseProbeWhile(gate: () => boolean): void {
    this.gates.push(gate);
  }
}

function make(extra: Partial<BosLinkDeps> = {}, build: (timers: ManualTimers) => StubConn = (timers) => new StubConn(timers)) {
  const timers = new ManualTimers();
  const stub = build(timers);
  const link = new BosLink(stub, { now: timers.now, timers: timers.api, log: captureLog().log, ...extra });
  // The vector's map leaves the user info query out; the server has it in class 1.
  const rates = decodeRateParamsReply(bytesOf(oservice, 'rate params reply body, default classes, OService 1'));
  link.seedRates({ classes: rates.classes, classOf: (family, subtype) => (family === 1 && subtype === 0x0e ? 1 : rates.classOf(family, subtype)) });
  const sentIms = () => stub.sent.filter((s) => s.family === 4 && s.subtype === 6).map((s) => s.body[0]);
  return { timers, conn: stub, link, sentIms };
}

// 0x01/0x0A: code, then the class's 30-byte record with the given current level
const notice = (classId: number, code: number, level: number): Uint8Array => {
  const b = Buffer.alloc(32);
  b.writeUInt16BE(code, 0); b.writeUInt16BE(classId, 2);
  for (const [i, n] of [20, 5100, 5000, 4000, 3000, level, 6000].entries()) b.writeUInt32BE(n, 4 + i * 4);
  return b;
};

const settled = (promise: Promise<void>): Promise<'sent' | { kind: string; code?: string }> =>
  promise.then(
    () => 'sent' as const,
    (error: { info: { kind: string; code?: string } }) => error.info,
  );

describe('BosLink class queue cap', () => {
  it('rejects a write past the cap as rate-held, while the class is held', async () => {
    const { timers, conn, link, sentIms } = make({ classQueueMax: 2 });
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 2, 4500) });
    const outcomes = [0, 1, 2].map((i) => settled(link.send(...IM, Uint8Array.of(i))));
    await timers.advance(0);
    expect(await outcomes[2]).toEqual({ kind: 'local', code: 'rate-held' });
    expect(sentIms()).toEqual([]);
    // The two that waited go out in order once the class clears; the refused one never does.
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 4, 5100) });
    await timers.advance(10_000);
    expect(sentIms()).toEqual([0, 1]);
    expect(await Promise.all([outcomes[0], outcomes[1]])).toEqual(['sent', 'sent']);
  });

  it('counts the sends that wait for the class to pace them', async () => {
    const { timers, link, sentIms } = make({ classQueueMax: 2 });
    // Three go at once; the next two wait for the governor; the sixth finds two waiting.
    const outcomes = [0, 1, 2, 3, 4, 5].map((i) => settled(link.send(...IM, Uint8Array.of(i))));
    await timers.advance(0);
    expect(await outcomes[5]).toEqual({ kind: 'local', code: 'rate-held' });
    await timers.advance(10_000);
    expect(sentIms()).toEqual([0, 1, 2, 3, 4]);
  });

  it('lets another class send while one is full', async () => {
    const { timers, conn, link } = make({ classQueueMax: 1 });
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 2, 4500) });
    void link.send(...IM);
    const refused = settled(link.send(...IM));
    const other = settled(link.send(0x0004, 0x0014));
    await timers.advance(0);
    expect([await refused, await other]).toEqual([{ kind: 'local', code: 'rate-held' }, 'sent']);
  });

  it('rejects a request the same way, and a paced wait', async () => {
    const { timers, conn, link } = make({ classQueueMax: 1 });
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 2, 4500) });
    void link.send(...IM);
    const request = link.request(...IM, undefined, 1_000).catch((error: { info: unknown }) => error.info);
    const paced = settled(link.paced(...IM));
    await timers.advance(0);
    expect(await request).toEqual({ kind: 'local', code: 'rate-held' });
    expect(await paced).toEqual({ kind: 'local', code: 'rate-held' });
  });

  it('queues without a bound by default', async () => {
    const { timers, conn, link, sentIms } = make();
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 2, 4500) });
    const outcomes = Array.from({ length: 20 }, (_, i) => settled(link.send(...IM, Uint8Array.of(i))));
    await timers.advance(0);
    expect(sentIms()).toEqual([]);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 4, 5100) });
    await timers.advance(300_000);
    expect(sentIms()).toHaveLength(20);
    expect(new Set(await Promise.all(outcomes))).toEqual(new Set(['sent']));
  });
});

describe('BosLink liveness probe pause', () => {
  it('asks the connection to skip a probe while the user info query is held, when the option is on', () => {
    const { conn: stub, link } = make({ skipProbeWhileRateHeld: true }, (timers) => new ProbeConn(timers));
    const conn = stub as ProbeConn;
    const [gate] = conn.gates;
    expect(conn.gates).toHaveLength(1);
    expect(link.classOf(...USER_INFO_QUERY)).toBe(1);
    expect(gate?.()).toBe(false);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(1, 2, 4500) });
    expect(gate?.()).toBe(true);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(1, 4, 5100) });
    expect(gate?.()).toBe(false);
  });

  it('does not hold a probe for a class other than the probe class', () => {
    const conn = make({ skipProbeWhileRateHeld: true }, (timers) => new ProbeConn(timers)).conn as ProbeConn;
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 2, 4500) });
    expect(conn.gates[0]?.()).toBe(false);
  });

  it('leaves the probe alone by default', () => {
    const conn = make({}, (timers) => new ProbeConn(timers)).conn as ProbeConn;
    expect(conn.gates).toEqual([]);
  });

  it('does nothing for a connection that cannot pause its probe', () => {
    expect(() => make({ skipProbeWhileRateHeld: true })).not.toThrow();
  });
});

describe('BosLink lastHeardAt', () => {
  it('is null until a SNAC arrives, then the time of the last one', async () => {
    const { timers, conn, link } = make();
    expect(link.lastHeardAt).toBeNull();
    const first = timers.now();
    conn.deliver({ family: 4, subtype: 0x14 });
    expect(link.lastHeardAt).toBe(first);
    await timers.advance(5_000);
    conn.deliver({ family: 4, subtype: 0x14 });
    expect(link.lastHeardAt).toBe(first + 5_000);
  });
});
