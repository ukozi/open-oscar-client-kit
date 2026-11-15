import { describe, expect, it } from 'vitest';
import { BosLink } from '../../../src/client/bos-link.js';
import type { OscarError } from '../../../src/client/errors.js';
import { strayRate } from '../../../src/client/stray-rate.js';
import { decodeRateParamsReply } from '../../../src/wire/rate.js';
import { captureLog, ManualTimers } from '../../fake/oscar-client.js';
import { StubConn } from '../../fake/stub-conn.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const oservice = loadVectors('oservice.json');
const IM = [0x0004, 0x0006] as const;

function make(seed = true) {
  const timers = new ManualTimers();
  const conn = new StubConn(timers);
  const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captureLog().log });
  if (seed) link.seedRates(decodeRateParamsReply(bytesOf(oservice, 'rate params reply body, default classes, OService 1')));
  const start = timers.now();
  const imTimes = () => conn.sent.filter((s) => s.family === 4 && s.subtype === 6).map((s) => s.at - start);
  return { timers, conn, link, imTimes };
}

// 0x01/0x0A: code, then class 3's 30-byte record with the given current level
const notice = (code: number, level: number): Uint8Array => {
  const b = Buffer.alloc(32);
  b.writeUInt16BE(code, 0); b.writeUInt16BE(3, 2);
  for (const [i, n] of [20, 5100, 5000, 4000, 3000, level, 6000].entries()) b.writeUInt32BE(n, 4 + i * 4);
  return b;
};

describe('BosLink pacing', () => {
  it('keeps class 3 at or above its alert level: five sends go out at 0, 0, 0, 2264 and 7264 ms', async () => {
    const { timers, link, imTimes } = make();
    for (let i = 0; i < 5; i++) void link.send(...IM, Uint8Array.of(i));
    await timers.advance(0);
    expect(imTimes()).toEqual([0, 0, 0]);
    await timers.advance(2263);
    expect(imTimes()).toHaveLength(3);
    await timers.advance(1);
    expect(imTimes()).toEqual([0, 0, 0, 2264]);
    await timers.advance(4999);
    expect(imTimes()).toHaveLength(4);
    await timers.advance(1);
    expect(imTimes()).toEqual([0, 0, 0, 2264, 7264]);
  });

  it('releases in the order asked', async () => {
    const { timers, conn, link } = make();
    for (let i = 0; i < 5; i++) void link.send(...IM, Uint8Array.of(i));
    await timers.advance(10_000);
    expect(conn.sent.map((s) => s.body[0])).toEqual([0, 1, 2, 3, 4]);
  });

  it('does not let one class delay another', async () => {
    const { timers, conn, link } = make();
    for (let i = 0; i < 5; i++) void link.send(...IM);
    void link.send(0x0004, 0x0014);            // class 1 in the vector's map
    await timers.advance(0);
    expect(conn.sent.some((s) => s.family === 4 && s.subtype === 0x14)).toBe(true);
  });

  it('writes at once before rates are seeded and for an unmapped SNAC', async () => {
    const unseeded = make(false);
    for (let i = 0; i < 10; i++) void unseeded.link.send(...IM);
    await unseeded.timers.advance(0);
    expect(unseeded.imTimes()).toHaveLength(10);
    const seeded = make();
    for (let i = 0; i < 10; i++) void seeded.link.send(0x000e, 0x0005);
    await seeded.timers.advance(0);
    expect(seeded.conn.sent).toHaveLength(10);
  });

  it('holds a class after an alert notice until the clear notice, however long that takes', async () => {
    const { timers, conn, link, imTimes } = make();
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    void link.send(...IM);
    await timers.advance(60_000);
    expect(imTimes()).toEqual([]);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(4, 5100), requestId: 0x80000000 });
    await timers.advance(0);
    expect(imTimes()).toEqual([60_000]);
  });

  it('stops the hold of an alert 60 s after the level is back, when no clear notice comes', async () => {
    const { timers, conn, link, imTimes } = make();
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    void link.send(...IM);
    // Level 4886 is back at the alert level of 5000 after 7166 ms.
    await timers.advance(67_165);
    expect(imTimes()).toEqual([]);
    expect(link.isHeld(...IM)).toBe(true);
    await timers.advance(1);
    expect(imTimes()).toEqual([67_166]);
    expect(link.isHeld(...IM)).toBe(false);
  });

  it('stops the hold of a limit 60 s after the level is back, and reports the class as not limited', async () => {
    const { timers, conn, link, imTimes } = make();
    const seen: [number, boolean][] = [];
    link.onRateChange((classId, limited) => seen.push([classId, limited]));
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 3977), requestId: 0x80000000 });
    void link.send(...IM);
    // Level 3977 is back at the clear level of 5100 after 26437 ms.
    await timers.advance(86_436);
    expect(imTimes()).toEqual([]);
    expect(link.isLimited(...IM)).toBe(true);
    await timers.advance(1);
    expect(imTimes()).toEqual([86_437]);
    expect(link.isLimited(...IM)).toBe(false);
    expect(seen).toEqual([[3, true], [3, false]]);
  });

  it('counts the 60 s again from each notice of the held class, and not at all after the clear notice or a close', async () => {
    const { timers, conn, link, imTimes } = make();
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    void link.send(...IM);
    await timers.advance(60_000);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    await timers.advance(59_999);
    expect(imTimes()).toEqual([]);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(4, 5100), requestId: 0x80000000 });
    await timers.advance(0);
    expect(imTimes()).toEqual([119_999]);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    conn.close();
    expect(timers.pending()).toEqual([]);
  });

  it('keeps a hold with no send in the queue and sets no timer for it; a send after the 60 s goes out at once', async () => {
    const { timers, conn, link, imTimes } = make();
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    expect(timers.pending()).toEqual([]);
    await timers.advance(200_000);
    expect(link.isHeld(...IM)).toBe(true);
    void link.send(...IM);
    expect(imTimes()).toEqual([200_000]);
    expect(link.isHeld(...IM)).toBe(false);
  });

  it('reports the limited state of a class from the latest notice', async () => {
    const { conn, link } = make();
    const seen: [number, boolean][] = [];
    link.onRateChange((classId, limited) => seen.push([classId, limited]));
    expect(link.isLimited(...IM)).toBe(false);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886) });
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 3977) });
    expect(link.isLimited(...IM)).toBe(true);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(4, 5100) });
    expect(link.isLimited(...IM)).toBe(false);
    expect(seen).toEqual([[3, true], [3, false]]);
  });

  it('a rate listener that throws does not keep the queue held', async () => {
    const timers = new ManualTimers();
    const conn = new StubConn(timers);
    const captured = captureLog();
    const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captured.log });
    link.seedRates(decodeRateParamsReply(bytesOf(oservice, 'rate params reply body, default classes, OService 1')));
    const seen: boolean[] = [];
    link.onRateChange((_classId, limited) => {
      if (!limited) throw new TypeError('listener failed');
    });
    link.onRateChange((_classId, limited) => seen.push(limited));
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 3977) });
    void link.send(...IM);
    await timers.advance(60_000);
    expect(conn.sent).toEqual([]);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(4, 5100) });
    await timers.advance(0);
    expect(conn.sent.map((s) => [s.family, s.subtype])).toEqual([[4, 6]]);
    // The listener after the one that threw still heard both notices, and the failure is in the log.
    expect(seen).toEqual([true, false]);
    expect(link.isLimited(...IM)).toBe(false);
    expect(captured.text()).toContain('a rate listener threw');
  });
});

describe('BosLink low priority', () => {
  const LOW = { low: true } as const;
  type Outcome = { result?: string };
  const note = (p: Promise<unknown>): Outcome => {
    const outcome: Outcome = {};
    p.then(() => (outcome.result = 'ok'), (e: OscarError) => (outcome.result = e.info.kind === 'local' ? e.info.code : e.info.kind));
    return outcome;
  };

  it('a low-priority request goes out after every other queued request of its class', async () => {
    const { timers, conn, link } = make();
    // Three sends use what the class allows at once: everything after them waits.
    for (let i = 0; i < 3; i++) void link.send(...IM, Uint8Array.of(i));
    const low = note(link.requestMatching(...IM, Uint8Array.of(0x10), 15_000, () => true, LOW));
    void link.send(...IM, Uint8Array.of(0x20));
    const normal = note(link.requestMatching(...IM, Uint8Array.of(0x21), 15_000, () => true));
    await timers.advance(0);
    expect(conn.sent.map((s) => s.body[0])).toEqual([0, 1, 2]);
    await timers.advance(60_000);
    expect(conn.sent.map((s) => s.body[0])).toEqual([0, 1, 2, 0x20, 0x21, 0x10]);
    expect([low.result, normal.result]).toEqual(['timeout', 'timeout']);
  });

  it('low-priority requests are dropped when the class is held, and refused while it is', async () => {
    const { timers, conn, link } = make();
    for (let i = 0; i < 3; i++) void link.send(...IM, Uint8Array.of(i));
    const waiting = note(link.requestMatching(...IM, Uint8Array.of(0x10), 15_000, () => true, LOW));
    const normal = note(link.send(...IM, Uint8Array.of(0x20)));
    await timers.advance(0);
    expect([waiting.result, link.isHeld(...IM)]).toEqual([undefined, false]);

    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    await timers.advance(0);
    expect(waiting.result).toBe('rate-held');
    expect(link.isHeld(...IM)).toBe(true);
    const refused = note(link.requestMatching(...IM, Uint8Array.of(0x11), 15_000, () => true, LOW));
    await timers.advance(0);
    expect(refused.result).toBe('rate-held');
    expect(link.isHeld(0x0004, 0x0014)).toBe(false);

    conn.deliver({ family: 1, subtype: 0x0a, body: notice(4, 5100), requestId: 0x80000000 });
    expect(link.isHeld(...IM)).toBe(false);
    await timers.advance(60_000);
    // The normal send waited out the hold; the link wrote neither low request.
    expect(normal.result).toBe('ok');
    expect(conn.sent.map((s) => s.body[0])).toEqual([0, 1, 2, 0x20]);
    expect(timers.pending()).toEqual([]);
  });

  it('a low-priority request is written at once when its class has room, and rejected as connection lost on a close', async () => {
    const { timers, conn, link } = make();
    const written = note(link.requestMatching(...IM, Uint8Array.of(0x10), 15_000, () => true, LOW));
    await timers.advance(0);
    expect(conn.sent.map((s) => s.body[0])).toEqual([0x10]);
    for (let i = 0; i < 2; i++) void link.send(...IM, Uint8Array.of(i));
    const queued = note(link.requestMatching(...IM, Uint8Array.of(0x11), 15_000, () => true, LOW));
    await timers.advance(0);
    conn.closeWith({ kind: 'eof', clean: false });
    await timers.advance(60_000);
    expect([written.result, queued.result]).toEqual(['connection-lost', 'connection-lost']);
    expect(conn.sent.map((s) => s.body[0])).toEqual([0x10, 0, 1]);
  });
});

describe('BosLink paced turns', () => {
  const kindOf = (e: OscarError): string => (e.info.kind === 'local' ? e.info.code : e.info.kind);

  it("a paced turn waits its class's turn and counts as sent", async () => {
    const { timers, conn, link, imTimes } = make();
    const start = timers.now();
    // Three sends use what the class allows at once: a fourth SNAC waits 2264 ms, a fifth 5000 ms more.
    for (let i = 0; i < 3; i++) void link.send(...IM, Uint8Array.of(i));
    let turnAt: number | undefined;
    void link.paced(...IM).then(() => (turnAt = timers.now() - start));
    await timers.advance(2263);
    expect(turnAt).toBeUndefined();
    await timers.advance(1);
    expect(turnAt).toBe(2264);
    expect(conn.sent).toHaveLength(3);

    void link.send(...IM, Uint8Array.of(9));
    await timers.advance(4999);
    expect(imTimes()).toEqual([0, 0, 0]);
    await timers.advance(1);
    expect(imTimes()).toEqual([0, 0, 0, 7264]);
  });

  it('a low paced turn is refused while the class is held', async () => {
    const { timers, conn, link } = make();
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    await expect(link.paced(...IM, { low: true }).then(() => 'ok', kindOf)).resolves.toBe('rate-held');
    let turn = false;
    void link.paced(...IM).then(() => (turn = true));
    await timers.advance(60_000);
    expect(turn).toBe(false);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(4, 5100), requestId: 0x80000000 });
    await timers.advance(0);
    expect(turn).toBe(true);
  });

  it('a paced turn is refused once the connection has closed', async () => {
    const { timers, conn, link } = make();
    for (let i = 0; i < 3; i++) void link.send(...IM);
    const queued = link.paced(...IM).then(() => 'ok', kindOf);
    await timers.advance(0);
    conn.closeWith({ kind: 'eof', clean: false });
    await expect(queued).resolves.toBe('connection-lost');
    await expect(link.paced(...IM).then(() => 'ok', kindOf)).resolves.toBe('connection-lost');
    expect(timers.pending()).toEqual([]);
  });
});

describe('BosLink requests', () => {
  it('counts the timeout from release, not from the call', async () => {
    const { timers, link } = make();
    for (let i = 0; i < 3; i++) void link.send(...IM);
    let error: unknown;
    link.request(...IM, undefined, 15_000).catch((e: unknown) => (error = e));
    await timers.advance(2264 + 14_999);
    expect(error).toBeUndefined();
    await timers.advance(1);
    expect((error as OscarError).info).toEqual({ kind: 'timeout', rateLimited: false });
  });

  it('marks a timeout as rate limited when the class was reported limited', async () => {
    const { timers, conn, link } = make();
    let error: unknown;
    link.request(...IM, undefined, 15_000).catch((e: unknown) => (error = e));
    await timers.advance(0);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 3977) });
    await timers.advance(15_000);
    expect((error as OscarError).info).toEqual({ kind: 'timeout', rateLimited: true });
  });

  it('resolves with the SNAC that carries the request id', async () => {
    const { timers, conn, link } = make();
    const reply = link.request(0x0001, 0x000e, undefined, 20_000);
    await timers.advance(0);
    conn.deliver({ family: 1, subtype: 0x0f, requestId: conn.sent[0]?.requestId ?? -1 });
    expect((await reply).subtype).toBe(0x0f);
  });

  it('settles a matching request only on a SNAC with its request id that the caller accepts', async () => {
    const { timers, conn, link } = make();
    const seen: number[] = [];
    link.onSnac((snac) => seen.push(snac.subtype));
    let got: number | undefined;
    void link.requestMatching(...IM, undefined, 15_000, (snac) => snac.subtype === 0x0c).then((snac) => (got = snac.subtype));
    await timers.advance(0);
    const requestId = conn.sent[0]?.requestId ?? -1;
    conn.deliver({ family: 4, subtype: 0x14, requestId });
    conn.deliver({ family: 4, subtype: 0x0c, requestId: requestId + 1 });
    await timers.advance(0);
    expect(got).toBeUndefined();
    conn.deliver({ family: 4, subtype: 0x0c, requestId });
    await timers.advance(0);
    expect(got).toBe(0x0c);
    // Every SNAC, accepted or not, still reached the other listeners; the deadline is gone.
    expect(seen).toEqual([0x14, 0x0c, 0x0c]);
    expect(timers.pending()).toEqual([]);
  });

  it('times a matching request out from release when nothing it accepts arrives, rate limited or not', async () => {
    const { timers, conn, link } = make();
    for (let i = 0; i < 3; i++) void link.send(...IM);
    const errors: unknown[] = [];
    link.requestMatching(...IM, undefined, 15_000, () => false).catch((e: unknown) => errors.push(e));
    await timers.advance(2264);
    conn.deliver({ family: 4, subtype: 0x14, requestId: conn.sent[3]?.requestId ?? -1 });
    await timers.advance(14_999);
    expect(errors).toEqual([]);
    await timers.advance(1);
    expect(errors.map((e) => (e as OscarError).info)).toEqual([{ kind: 'timeout', rateLimited: false }]);

    const limited = make();
    limited.link.requestMatching(...IM, undefined, 15_000, () => false).catch((e: unknown) => errors.push(e));
    await limited.timers.advance(0);
    limited.conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 3977) });
    await limited.timers.advance(15_000);
    expect((errors[1] as OscarError).info).toEqual({ kind: 'timeout', rateLimited: true });
  });

  it('rejects a matching request that is queued, written or asked after the close as connection lost', async () => {
    const { timers, conn, link } = make();
    const results: string[] = [];
    const note = (p: Promise<unknown>) => p.then(() => results.push('ok'), (e: OscarError) => results.push(e.info.kind));
    note(link.requestMatching(0x0001, 0x000e, undefined, 20_000, () => true)); // written, unanswered
    for (let i = 0; i < 3; i++) void link.send(...IM);
    note(link.requestMatching(...IM, undefined, 15_000, () => true));          // queued behind the governor
    await timers.advance(0);
    conn.closeWith({ kind: 'eof', clean: false });
    note(link.requestMatching(0x0001, 0x000e, undefined, 20_000, () => true));
    await timers.advance(60_000);
    expect(results).toEqual(['connection-lost', 'connection-lost', 'connection-lost']);
    expect(timers.pending()).toEqual([]);
  });

  it('rejects everything queued or waiting when the connection closes, and writes nothing after', async () => {
    const { timers, conn, link, imTimes } = make();
    const results: string[] = [];
    const note = (p: Promise<unknown>) => p.then(() => results.push('ok'), (e: OscarError) => results.push(e.info.kind));
    for (let i = 0; i < 3; i++) void link.send(...IM);
    note(link.request(...IM, undefined, 15_000));   // queued behind the governor
    note(link.send(...IM));                         // queued behind it
    note(link.request(0x0001, 0x000e, undefined, 20_000)); // written, unanswered
    await timers.advance(0);
    conn.closeWith({ kind: 'eof', clean: false });
    await timers.advance(60_000);
    expect(results).toEqual(['connection-lost', 'connection-lost', 'connection-lost']);
    expect(imTimes()).toHaveLength(3);
  });

  it('waits for a SNAC by family and subtype', async () => {
    const { timers, conn, link } = make(false);
    const online = link.waitFor(1, 3, 20_000);
    conn.deliver({ family: 1, subtype: 3, requestId: 0x80000000 });
    expect((await online).subtype).toBe(3);
    let error: unknown;
    link.waitFor(1, 3, 20_000).catch((e: unknown) => (error = e));
    await timers.advance(20_000);
    expect((error as OscarError).info).toEqual({ kind: 'timeout', rateLimited: false });
  });

  it('asks the server for a liveness answer at once, unpaced, and takes any answer on its request', async () => {
    const { timers, conn, link } = make();
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    const alive = link.alive(20_000);
    const asked = conn.sent.at(-1);
    expect(asked).toMatchObject({ family: 1, subtype: 0x0e, at: timers.now() });
    conn.deliver({ family: 1, subtype: 0x0f, requestId: asked?.requestId ?? -1 });
    expect(await alive).toBe(true);
    expect(conn.isOpen).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('ends the connection as a failed liveness probe when the answer does not come in time', async () => {
    const { timers, conn, link } = make();
    const closes: unknown[] = [];
    link.onClose((info) => closes.push(info));
    const alive = link.alive(20_000);
    await timers.advance(19_999);
    expect(closes).toEqual([]);
    await timers.advance(1);
    expect(await alive).toBe(false);
    expect(closes).toEqual([{ kind: 'probe-timeout', clean: false }]);

    const sent = conn.sent.length;
    expect(await link.alive(20_000)).toBe(false);
    expect(conn.sent).toHaveLength(sent);
  });

  it('a liveness question cut short by a close of the connection is false, and the close is the one that happened', async () => {
    const { conn, link } = make();
    const closes: unknown[] = [];
    link.onClose((info) => closes.push(info));
    const alive = link.alive(20_000);
    conn.closeWith({ kind: 'eof', clean: false });
    expect(await alive).toBe(false);
    expect(closes).toEqual([{ kind: 'eof', clean: false }]);
  });
});

describe('BosLink exemption', () => {
  it('setExempt(true) writes the jobs already queued, in order', async () => {
    const { timers, conn, link, imTimes } = make();
    for (let i = 0; i < 6; i++) void link.send(...IM, Uint8Array.of(i));
    const low = link.requestMatching(...IM, Uint8Array.of(0x10), 15_000, () => true, { low: true });
    low.catch(() => {});
    await timers.advance(0);
    expect(imTimes()).toEqual([0, 0, 0]);
    link.setExempt(true);
    expect(conn.sent.map((s) => s.body[0])).toEqual([0, 1, 2, 3, 4, 5, 0x10]);
    expect(timers.pending().filter((ms) => ms < 15_000)).toEqual([]);
  });

  it('setExempt(true) writes a send in a held class at once', async () => {
    const { timers, conn, link, imTimes } = make();
    link.setExempt(true);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(2, 4886), requestId: 0x80000000 });
    expect(link.isHeld(...IM)).toBe(true);
    for (let i = 0; i < 20; i++) void link.send(...IM, Uint8Array.of(i));
    const low = link.requestMatching(...IM, Uint8Array.of(0x20), 15_000, () => true, { low: true });
    low.catch(() => {});
    expect(imTimes()).toHaveLength(21);
    expect(conn.sent.at(-1)?.body[0]).toBe(0x20);
    await timers.advance(0);
    expect(imTimes()).toHaveLength(21);
  });

  it('a rate notice under the exemption still updates the class and calls the rate listeners', async () => {
    const { conn, link, imTimes } = make();
    const seen: [number, boolean][] = [];
    link.onRateChange((classId, limited) => seen.push([classId, limited]));
    link.setExempt(true);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 3977), requestId: 0x80000000 });
    expect(link.isLimited(...IM)).toBe(true);
    void link.send(...IM);
    expect(imTimes()).toEqual([0]);
    conn.deliver({ family: 1, subtype: 0x0a, body: notice(4, 5100), requestId: 0x80000000 });
    expect(seen).toEqual([[3, true], [3, false]]);
  });

  it('setExempt(false) paces again, and the default is paced', async () => {
    const { timers, link, imTimes } = make();
    link.setExempt(true);
    link.setExempt(false);
    for (let i = 0; i < 5; i++) void link.send(...IM, Uint8Array.of(i));
    await timers.advance(0);
    expect(imTimes()).toEqual([0, 0, 0]);
  });

  it('takes a rate notice from a different connection as its own, and none after the connection closed', async () => {
    const { timers, conn, link, imTimes } = make();
    const seen: [number, boolean][] = [];
    link.onRateChange((classId, limited) => seen.push([classId, limited]));
    strayRate(link, notice(3, 3977));
    void link.send(...IM);
    await timers.advance(10_000);
    expect(imTimes()).toEqual([]);
    strayRate(link, notice(4, 5100));
    await timers.advance(0);
    expect(imTimes()).toEqual([10_000]);
    expect(seen).toEqual([[3, true], [3, false]]);
    conn.close();
    strayRate(link, notice(3, 3977));
    expect(seen).toHaveLength(2);
  });
});
