import type { CloseInfo } from '../wire/connection.js';
import {
  FAMILY_OSERVICE,
  FOOD_GROUP_VERSION,
  OSERVICE_RATE_PARAM_CHANGE,
  OSERVICE_USER_INFO_QUERY,
  RATE_CODE_ALERT,
  RATE_CODE_CLEAR,
  RATE_CODE_LIMITED,
} from '../wire/constants.js';
import { RateGovernor, decodeRateParamChange } from '../wire/rate.js';
import type { RateParamsReply } from '../wire/rate.js';
import type { Snac } from '../wire/snac.js';
import type { Logger, TimerApi } from '../wire/types.js';
import { OscarError } from './errors.js';
import { takesStrayRate } from './stray-rate.js';

export interface BosConn {
  readonly isOpen: boolean;
  send(family: number, subtype: number, body?: Uint8Array): number;
  request(family: number, subtype: number, body?: Uint8Array, timeoutMs?: number): Promise<Snac>;
  onSnac(fn: (snac: Snac) => void): () => void;
  onClose(fn: (info: CloseInfo) => void): () => void;
  close(): void;
  destroy(info?: CloseInfo): void;
  pauseProbeWhile?(gate: () => boolean): void;
}

export type BosLinkDeps = {
  now: () => number;
  timers: TimerApi;
  log: Logger;
  /** Jobs waiting in one rate class, queue and low together; a write past it rejects as `rate-held`. The default is no limit. */
  classQueueMax?: number | undefined;
  /** Sends no liveness probe while the probe's rate class is held. The default sends the probe on schedule. */
  skipProbeWhileRateHeld?: boolean | undefined;
  /** How early a send can reach the server and cause no alert, in milliseconds. `RateGovernor` gives the cost. The default is `PACE_MARGIN_MS`. */
  paceMarginMs?: number | undefined;
};

type Timer = ReturnType<typeof setTimeout>;
type Job = { write: () => void; reject: (e: Error) => void };
type RateClass = {
  governor: RateGovernor;
  queue: Job[];
  low: Job[];
  held: boolean;
  limited: boolean;
  timer: Timer | null;
  release: Timer | null;
};

const connectionLost = (): OscarError => new OscarError({ kind: 'connection-lost' });
const rateHeld = (): OscarError => new OscarError({ kind: 'local', code: 'rate-held' });

/**
 * Every SNAC waits its turn in its rate class, so no SNAC reaches the server's limiter, which drops without a reply.
 * After an alert or a limit notice the class sends nothing. The clear notice ends that. The level of the model also ends that, when a send leaves it at or above the line of the server plus the pacing margin.
 * The line is the alert level after an alert, and the clear level after a limit.
 */
export class BosLink {
  private readonly classes = new Map<number, RateClass>();
  private readonly rateListeners: ((classId: number, limited: boolean) => void)[] = [];
  private readonly waiters = new Set<(e: Error) => void>();
  private rates: RateParamsReply | null = null;
  private heardAt: number | null = null;
  private exempt = false;
  /** The OService version that this connection negotiated. It is 1 until the sign-on sets it. */
  oserviceVersion = FOOD_GROUP_VERSION;

  constructor(
    private readonly conn: BosConn,
    private readonly deps: BosLinkDeps,
  ) {
    // Registered before any listener of the client, so the rate state is current when they run.
    conn.onSnac((snac) => {
      this.heardAt = this.deps.now();
      if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_RATE_PARAM_CHANGE) this.onRateNotice(snac.body);
    });
    conn.onClose(() => this.onClosed());
    takesStrayRate(this, (body) => {
      if (conn.isOpen) this.onRateNotice(body);
    });
    if (deps.skipProbeWhileRateHeld) conn.pauseProbeWhile?.(() => this.isHeld(FAMILY_OSERVICE, OSERVICE_USER_INFO_QUERY));
  }

  /** When the last SNAC arrived on the connection; null until one has. */
  get lastHeardAt(): number | null {
    return this.heardAt;
  }

  seedRates(reply: RateParamsReply): void {
    this.rates = reply;
    for (const params of reply.classes) this.rateClass(params.id).governor.seed(params);
  }

  rateClassIds(): number[] {
    return this.rates ? this.rates.classes.map((c) => c.id) : [];
  }

  classOf(family: number, subtype: number): number | undefined {
    return this.rates?.classOf(family, subtype);
  }

  send(family: number, subtype: number, body?: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const write = (): void => {
        this.conn.send(family, subtype, body);
        resolve();
      };
      this.enqueue(family, subtype, { write, reject });
    });
  }

  /** The timeout runs from the moment the link writes the SNAC, not from this call. */
  request(family: number, subtype: number, body: Uint8Array | undefined, timeoutMs: number): Promise<Snac> {
    return this.requestMatching(family, subtype, body, timeoutMs, () => true);
  }

  /** A request id alone is no reply: the server relays a peer's typing event and client error with the id the peer chose. */
  requestMatching(
    family: number,
    subtype: number,
    body: Uint8Array | undefined,
    timeoutMs: number,
    accept: (snac: Snac) => boolean,
    opts: { low?: boolean; onWritten?: () => void } = {},
  ): Promise<Snac> {
    return new Promise<Snac>((resolve, reject) => {
      const write = (): void => {
        const requestId = this.conn.send(family, subtype, body);
        opts.onWritten?.();
        const settle = (): void => {
          off();
          this.deps.timers.clearTimeout(timer);
          this.waiters.delete(fail);
        };
        const fail = (error: Error): void => {
          settle();
          reject(error);
        };
        const off = this.conn.onSnac((snac) => {
          if (snac.requestId !== requestId || !accept(snac)) return;
          settle();
          resolve(snac);
        });
        const timer = this.deps.timers.setTimeout(
          () => fail(new OscarError({ kind: 'timeout', rateLimited: this.isLimited(family, subtype) })),
          timeoutMs,
        );
        this.waiters.add(fail);
      };
      this.enqueue(family, subtype, { write, reject }, opts.low === true);
    });
  }

  paced(family: number, subtype: number, opts: { low?: boolean } = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.enqueue(family, subtype, { write: resolve, reject }, opts.low === true);
    });
  }

  waitFor(family: number, subtype: number, timeoutMs: number): Promise<Snac> {
    if (!this.conn.isOpen) return Promise.reject(connectionLost());
    return new Promise<Snac>((resolve, reject) => {
      const settle = (): void => {
        off();
        this.deps.timers.clearTimeout(timer);
        this.waiters.delete(fail);
      };
      const fail = (error: Error): void => {
        settle();
        reject(error);
      };
      const off = this.conn.onSnac((snac) => {
        if (snac.family !== family || snac.subtype !== subtype) return;
        settle();
        resolve(snac);
      });
      const timer = this.deps.timers.setTimeout(
        () => fail(new OscarError({ kind: 'timeout', rateLimited: false })),
        timeoutMs,
      );
      this.waiters.add(fail);
    });
  }

  alive(timeoutMs: number): Promise<boolean> {
    if (!this.conn.isOpen) return Promise.resolve(false);
    return this.conn.request(FAMILY_OSERVICE, OSERVICE_USER_INFO_QUERY, undefined, timeoutMs).then(
      () => true,
      () => {
        if (this.conn.isOpen) this.conn.destroy({ kind: 'probe-timeout', clean: false });
        return false;
      },
    );
  }

  isLimited(family: number, subtype: number): boolean {
    const classId = this.classOf(family, subtype);
    return classId !== undefined && (this.classes.get(classId)?.limited ?? false);
  }

  isHeld(family: number, subtype: number): boolean {
    const classId = this.classOf(family, subtype);
    return classId !== undefined && (this.classes.get(classId)?.held ?? false);
  }

  /** While on, the link writes each job at once, whatever the queue, hold or level of its class. When it turns on, it writes the waiting jobs in order. */
  setExempt(on: boolean): void {
    this.exempt = on;
    if (!on) return;
    for (const rc of this.classes.values()) {
      if (rc.timer !== null) this.deps.timers.clearTimeout(rc.timer);
      rc.timer = null;
      if (rc.release !== null) this.deps.timers.clearTimeout(rc.release);
      rc.release = null;
      for (const job of [...rc.queue.splice(0), ...rc.low.splice(0)]) job.write();
    }
  }

  onSnac(fn: (snac: Snac) => void): () => void {
    return this.conn.onSnac(fn);
  }

  onClose(fn: (info: CloseInfo) => void): () => void {
    return this.conn.onClose(fn);
  }

  onRateChange(fn: (classId: number, limited: boolean) => void): () => void {
    this.rateListeners.push(fn);
    return () => {
      const i = this.rateListeners.indexOf(fn);
      if (i >= 0) this.rateListeners.splice(i, 1);
    };
  }

  close(): void {
    this.conn.close();
  }

  destroy(): void {
    this.conn.destroy();
  }

  private rateClass(id: number): RateClass {
    let rc = this.classes.get(id);
    if (!rc) {
      rc = { governor: new RateGovernor({ now: this.deps.now, marginMs: this.deps.paceMarginMs }), queue: [], low: [], held: false, limited: false, timer: null, release: null };
      this.classes.set(id, rc);
    }
    return rc;
  }

  private enqueue(family: number, subtype: number, job: Job, low = false): void {
    if (!this.conn.isOpen) {
      job.reject(connectionLost());
      return;
    }
    const classId = this.classOf(family, subtype);
    const rc = classId === undefined ? undefined : this.classes.get(classId);
    if (this.exempt || !rc || classId === undefined) {
      job.write();
      return;
    }
    this.endHold(rc, classId);
    if ((low && rc.held) || rc.queue.length + rc.low.length >= (this.deps.classQueueMax ?? Number.POSITIVE_INFINITY)) {
      job.reject(rateHeld());
      return;
    }
    (low ? rc.low : rc.queue).push(job);
    if (rc.held) this.watchHold(rc, classId);
    else if (rc.timer === null) this.pump(rc);
  }

  private pump(rc: RateClass): void {
    if (rc.timer !== null) this.deps.timers.clearTimeout(rc.timer);
    rc.timer = null;
    while (rc.queue.length + rc.low.length > 0 && !rc.held && this.conn.isOpen) {
      const wait = rc.governor.waitMs();
      if (wait > 0) {
        rc.timer = this.deps.timers.setTimeout(() => {
          rc.timer = null;
          this.pump(rc);
        }, wait);
        return;
      }
      const job = rc.queue.shift() ?? rc.low.shift();
      rc.governor.sent();
      job?.write();
    }
  }

  private onRateNotice(body: Uint8Array): void {
    let change: ReturnType<typeof decodeRateParamChange>;
    try {
      change = decodeRateParamChange(body);
    } catch (error) {
      this.deps.log.warn('skipped a malformed rate notice', { error: (error as Error).message });
      return;
    }
    const { code, params } = change;
    const rc = this.rateClass(params.id);
    rc.governor.notice(code, params);
    if (code === RATE_CODE_ALERT || code === RATE_CODE_LIMITED) {
      rc.held = true;
      for (const job of rc.low.splice(0)) job.reject(rateHeld());
    }
    if (code === RATE_CODE_CLEAR) rc.held = false;
    this.deps.log.debug('rate notice', { classId: params.id, code, level: params.currentLevel });
    this.watchHold(rc, params.id);
    this.setLimited(rc, params.id, code === RATE_CODE_LIMITED);
  }

  // The timer runs only while a send waits in the held class.
  private watchHold(rc: RateClass, classId: number): void {
    if (rc.release !== null) this.deps.timers.clearTimeout(rc.release);
    rc.release = null;
    if (!rc.held || rc.queue.length === 0) return;
    rc.release = this.deps.timers.setTimeout(() => {
      rc.release = null;
      this.endHold(rc, classId);
      this.watchHold(rc, classId);
    }, rc.governor.waitMs());
  }

  // A held class sends nothing, and the server can stay silent about a class that sends nothing.
  // Thus the hold stops when the model has no wait for a send.
  private endHold(rc: RateClass, classId: number): void {
    if (!rc.held || rc.governor.waitMs() > 0) return;
    rc.held = false;
    this.deps.log.debug('a rate hold stopped: the level is back', { classId });
    this.watchHold(rc, classId);
    this.setLimited(rc, classId, false);
  }

  private setLimited(rc: RateClass, classId: number, limited: boolean): void {
    const changed = limited !== rc.limited;
    rc.limited = limited;
    this.pump(rc);
    if (!changed) return;
    for (const fn of [...this.rateListeners]) {
      try {
        fn(classId, limited);
      } catch (error) {
        this.deps.log.warn('a rate listener threw', { error: error instanceof Error ? error.name : typeof error });
      }
    }
  }

  private onClosed(): void {
    for (const rc of this.classes.values()) {
      if (rc.timer !== null) this.deps.timers.clearTimeout(rc.timer);
      rc.timer = null;
      if (rc.release !== null) this.deps.timers.clearTimeout(rc.release);
      rc.release = null;
      for (const job of [...rc.queue.splice(0), ...rc.low.splice(0)]) job.reject(connectionLost());
    }
    for (const fail of [...this.waiters]) fail(connectionLost());
  }
}
