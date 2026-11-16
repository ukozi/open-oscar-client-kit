import { describe, expect, it } from 'vitest';
import { BosLink } from '../../../src/client/bos-link.js';
import type { BosConn } from '../../../src/client/bos-link.js';
import { NOTICE_FLIGHT_MS, checkRate, decodeRateParamsReply } from '../../../src/wire/rate.js';
import type { RateClassParams } from '../../../src/wire/rate.js';
import type { Snac } from '../../../src/wire/snac.js';
import type { TimerApi } from '../../../src/wire/types.js';
import { captureLog } from '../../fake/oscar-client.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const oservice = loadVectors('oservice.json');
const IM = [0x0004, 0x0006] as const;
const CLASS3: RateClassParams = { id: 3, windowSize: 20, clearLevel: 5100, alertLevel: 5000, limitLevel: 4000, disconnectLevel: 3000, currentLevel: 6000, maxLevel: 6000 };
const ALERT = 2;
const LIMITED = 3;
const CLEAR = 4;
// The pacing margin: 33 of level in a window of 20.
const MARGIN_MS = 660;
// A send that the model counts two times puts its level lower by a 20th of the level at most. The wait is 19 times that.
const MONITOR_MS = 1000;
const TWICE_MS = Math.ceil((CLASS3.limitLevel * 19) / 20);

// The same numbers for each run of one seed.
function numbers(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648;
  };
}

// A clock with timers that run in the call to `run`, in order of time.
class Clock {
  t = 1_000_000;
  private next = 1;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();
  readonly api: TimerApi = {
    setTimeout: ((fn: () => void, ms?: number) => {
      const id = this.next++;
      this.queue.set(id, { at: this.t + Math.max(0, ms ?? 0), fn });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id?: number) => {
      if (id !== undefined) this.queue.delete(id);
    }) as unknown as typeof clearTimeout,
  };
  now = (): number => this.t;
  at(time: number, fn: () => void): void {
    this.queue.set(this.next++, { at: Math.max(this.t, time), fn });
  }
  run(until: number): void {
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.queue) if (entry[1].at <= until && (!first || entry[1].at < first[1].at)) first = entry;
      if (!first) break;
      this.queue.delete(first[0]);
      this.t = first[1].at;
      first[1].fn();
    }
    this.t = until;
  }
}

// `late` is true for a send that the client wrote after the limit notice arrived.
type Sent = { writtenAt: number; arrivedAt: number; dropped: boolean; inNotice: boolean; late: boolean };
type Run = {
  limitNoticeAt: number | null;
  sends: Sent[];
  // The time when a send that arrives ends the limit. Such a send leaves the server at its clear level.
  // The time is from the last send that the server counted while it was limited.
  backAt: number;
  codes: number[];
};

// One client and the arithmetic of the server. `up` and `down` are the times of flight, and each send has a jitter on top of `up`.
function simulate(seed: number, opts: { monitor: boolean; jitterMs: number }): Run {
  const random = numbers(seed);
  const pick = (max: number): number => Math.floor(random() * (max + 1));
  const clock = new Clock();
  const start = clock.t;
  const up = pick(700);
  const down = pick(NOTICE_FLIGHT_MS - 1 - up - opts.jitterMs - 300);
  const result: Run = { limitNoticeAt: null, sends: [], backAt: 0, codes: [] };

  const listeners: ((snac: Snac) => void)[] = [];
  let lastArrival = 0;
  const conn: BosConn = {
    isOpen: true,
    send: () => {
      const sent: Sent = { writtenAt: clock.t, arrivedAt: 0, dropped: false, inNotice: false, late: result.limitNoticeAt !== null };
      // One connection keeps the order of the sends.
      lastArrival = Math.max(lastArrival, clock.t + up + pick(opts.jitterMs));
      sent.arrivedAt = lastArrival;
      result.sends.push(sent);
      clock.at(sent.arrivedAt, () => {
        sent.dropped = arrive(sent);
      });
      return result.sends.length;
    },
    request: () => Promise.reject(new Error('not in this test')),
    onSnac: (fn) => {
      listeners.push(fn);
      return () => {};
    },
    onClose: () => () => {},
    close: () => {},
    destroy: () => {},
  };
  const link = new BosLink(conn, { now: clock.now, timers: clock.api, log: captureLog().log });
  link.seedRates(decodeRateParamsReply(bytesOf(oservice, 'rate params reply body, default classes, OService 1')));

  const server = { level: CLASS3.maxLevel, lastAt: start, limited: false, status: 'clear' as string };
  const counted: Sent[] = [];
  const notify = (code: number): void => {
    result.codes.push(code);
    const body = Buffer.alloc(32);
    body.writeUInt16BE(code, 0);
    body.writeUInt16BE(3, 2);
    for (const [i, n] of [20, 5100, 5000, 4000, 3000, server.level, 6000].entries()) body.writeUInt32BE(n, 4 + i * 4);
    const limit = code === LIMITED && result.codes.filter((c) => c === LIMITED).length === 1;
    if (limit) for (const sent of counted) sent.inNotice = true;
    clock.at(clock.t + down, () => {
      if (limit) result.limitNoticeAt = clock.t;
      for (const fn of [...listeners]) fn({ family: 1, subtype: 0x0a, flags: 0, requestId: 0, body });
    });
  };
  // The arithmetic of the server for one send. True when the server drops the send.
  const arrive = (own: Sent | null): boolean => {
    const check = checkRate(CLASS3, server.level, clock.t - server.lastAt, server.limited);
    expect(check.status).not.toBe('disconnect');
    server.level = check.level;
    server.limited = check.status === 'limited';
    server.lastAt = clock.t;
    if (own) counted.push(own);
    if (server.limited) result.backAt = clock.t + Math.max(0, CLASS3.windowSize * CLASS3.clearLevel - (CLASS3.windowSize - 1) * server.level);
    if (check.status !== server.status) {
      server.status = check.status;
      notify(check.status === 'limited' ? LIMITED : check.status === 'alert' ? ALERT : CLEAR);
    }
    return check.status === 'limited';
  };
  // The monitor of the server: each second it reports a status that changed with the time. It keeps the level only from limited to clear.
  const monitor = (): void => {
    const check = checkRate(CLASS3, server.level, clock.t - server.lastAt, server.limited);
    if (server.limited && check.status === 'clear') {
      server.limited = false;
      server.level = check.level;
    }
    if (check.status !== server.status) {
      server.status = check.status;
      // A limit that the monitor reports before a send: the server is not limited, and the status is that of one more send.
      // The monitor reports clear when one more send is at the alert level.
      if (check.status === 'limited') result.backAt = server.lastAt + Math.max(0, CLASS3.windowSize * CLASS3.alertLevel - (CLASS3.windowSize - 1) * server.level);
      notify(check.status === 'limited' ? LIMITED : check.status === 'alert' ? ALERT : CLEAR);
    }
    clock.at(clock.t + 1000, monitor);
  };
  if (opts.monitor) clock.at(start + pick(999), monitor);

  const write = (): void => void link.send(...IM).catch(() => {});
  // The client sends now and then. Then another session of the account sends a burst, to the limit or to a small number of sends above it.
  let at = start;
  for (let i = pick(6); i > 0; i--) {
    at += pick(7000);
    clock.at(at, write);
  }
  const burstAt = at + pick(9000);
  const stopShort = pick(2);
  clock.at(burstAt, () => {
    for (let i = 0; i < 12 && !server.limited; i++) {
      if (stopShort > 0 && checkRate(CLASS3, server.level, 0, false).level < CLASS3.limitLevel + stopShort * 90) break;
      arrive(null);
    }
  });
  // A burst that stops above the limit has a second part some seconds later, and that part goes to the limit.
  // After a limit notice the server reports no send of the other session, and no client can count such a send. Thus the other session sends nothing then.
  const secondAt = burstAt + pick(5000);
  clock.at(secondAt, () => {
    for (let i = 0; i < 12 && server.status !== 'limited'; i++) arrive(null);
  });
  // The client writes more sends at the time of the burst. Some of them are on their way when the server makes its limit notice.
  for (let i = pick(3); i > 0; i--) clock.at(burstAt - up - opts.jitterMs + pick(up + opts.jitterMs + down), write);

  // After the limit notice the host has four more sends. The client lets each go when it can.
  let asked = false;
  for (let t = start; t < secondAt + 400_000; t += 50) {
    clock.run(t);
    if (result.limitNoticeAt !== null && !asked) {
      asked = true;
      for (let i = 0; i < 4; i++) write();
    }
  }
  return result;
}

describe('BosLink after a limit, many seeds and jitters', () => {
  it.each([
    [false, 0], [false, 50], [false, 250], [true, 0], [true, 50], [true, 250],
  ])('monitor %s, jitter %i ms: the server drops no send that the client wrote after the limit notice, and the first of them is not late', (monitor, jitterMs) => {
    let limits = 0;
    let onTheirWay = 0;
    let worst = 0;
    let worstPlain = 0;
    const bound = MARGIN_MS + NOTICE_FLIGHT_MS + (monitor ? MONITOR_MS : 0);
    // Seeds above 1900 have the case where another session sends between two notices of a limit.
    for (let seed = 1; seed <= 6000; seed++) {
      const run = simulate(seed, { monitor, jitterMs });
      if (run.limitNoticeAt === null) continue;
      limits++;
      const noticeAt = run.limitNoticeAt;
      const after = run.sends.filter((s) => s.late);
      const context = `seed ${seed}`;
      // The four of the host, and each send that was in the queue at the notice.
      expect(after.length, context).toBeGreaterThanOrEqual(4);
      expect(after.filter((s) => s.dropped), context).toEqual([]);
      const before = run.sends.filter((s) => !s.late);
      if (before.some((s) => s.dropped)) onTheirWay++;
      // The client wrote these sends a short time before the notice, and the notice did count them. The model counts each of them two times.
      const twice = before.filter((s) => s.writtenAt > noticeAt - NOTICE_FLIGHT_MS && s.inNotice).length;
      const late = (after[0]?.arrivedAt ?? 0) - run.backAt;
      expect(late, context).toBeGreaterThanOrEqual(0);
      // The bound is the margin and the time of flight of a send and a notice. Each send that the model counted two times adds its wait.
      // With the monitor, the notice that ends a limit that no send caused comes one interval of the monitor later at most.
      expect(late, context).toBeLessThanOrEqual(bound + twice * TWICE_MS);
      worst = Math.max(worst, late);
      if (twice === 0) worstPlain = Math.max(worstPlain, late);
    }
    // Most seeds reach the limit, and in a part of them the server drops a send that was on its way.
    expect(limits).toBeGreaterThan(4000);
    expect(onTheirWay).toBeGreaterThan(2000);
    expect(worstPlain).toBeLessThanOrEqual(bound);
    expect(worst).toBeLessThanOrEqual(bound + 4 * TWICE_MS);
  });
});
