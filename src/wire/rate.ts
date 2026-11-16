import { ByteReader } from './bytes.js';
import type { RoomPacer } from './chatroom.js';
import {
  CHAT_MSG_TO_HOST,
  CHAT_SEND_RATE_CLASS,
  FAMILY_CHAT,
  RATE_CLASS_RECORD_LENGTH_V2,
  RATE_CODE_ALERT,
  RATE_CODE_CLEAR,
  RATE_CODE_LIMITED,
} from './constants.js';

export type RateClassParams = {
  id: number;
  windowSize: number;
  clearLevel: number;
  alertLevel: number;
  limitLevel: number;
  disconnectLevel: number;
  currentLevel: number;
  maxLevel: number;
};
export type RateStatus = 'clear' | 'alert' | 'limited';
export type RateCheck = { status: RateStatus | 'disconnect'; level: number };

// Same arithmetic as the server's CheckRateLimit, integer division included.
export function checkRate(p: RateClassParams, level: number, elapsedMs: number, limitedNow: boolean): RateCheck {
  const next = Math.min(p.maxLevel, Math.trunc((level * (p.windowSize - 1) + elapsedMs) / p.windowSize));
  if (next < p.disconnectLevel) return { status: 'disconnect', level: next };
  if (limitedNow) return { status: next >= p.clearLevel ? 'clear' : 'limited', level: next };
  if (next < p.limitLevel) return { status: 'limited', level: next };
  if (next < p.alertLevel) return { status: 'alert', level: next };
  return { status: 'clear', level: next };
}

function readRateClass(r: ByteReader, v2: boolean): RateClassParams {
  const p: RateClassParams = {
    id: r.u16(),
    windowSize: r.u32(),
    clearLevel: r.u32(),
    alertLevel: r.u32(),
    limitLevel: r.u32(),
    disconnectLevel: r.u32(),
    currentLevel: r.u32(),
    maxLevel: r.u32(),
  };
  if (v2) r.bytes(5);
  return p;
}

export type RateParamsReply = { classes: RateClassParams[]; classOf(family: number, subtype: number): number | undefined };

// Records are 30 bytes when ClientVersions announced OService 1, and 35 above it.
export function decodeRateParamsReply(body: Uint8Array, oserviceVersion = 1): RateParamsReply {
  const r = new ByteReader(body);
  const count = r.u16();
  const classes: RateClassParams[] = [];
  for (let i = 0; i < count; i++) classes.push(readRateClass(r, oserviceVersion > 1));
  const groups = new Map<number, number>();
  while (r.remaining > 0) {
    const classId = r.u16();
    const pairs = r.u16();
    for (let i = 0; i < pairs; i++) groups.set(r.u16() * 0x10000 + r.u16(), classId);
  }
  return { classes, classOf: (family, subtype) => groups.get(family * 0x10000 + subtype) };
}

export function decodeRateParamChange(body: Uint8Array): { code: number; params: RateClassParams } {
  const r = new ByteReader(body);
  const code = r.u16();
  return { code, params: readRateClass(r, r.remaining >= RATE_CLASS_RECORD_LENGTH_V2) };
}

/** The default of `marginMs`. A send can reach the server this much nearer to the send before it and cause no alert. */
export const PACE_MARGIN_MS = 250;

/**
 * A limit notice does not count a send that the client wrote less than this time before the notice arrived, in milliseconds.
 * The time is for the send to go to the server and for the notice to come back. A connection that is slower than this can lose a send after a limit.
 */
export const NOTICE_FLIGHT_MS = 2000;

export class RateGovernor {
  private readonly now: () => number;
  private readonly marginMs: number;
  private recent: number[] = [];
  private params: RateClassParams | null = null;
  private level = 0;
  private lastAt = 0;
  private limited = false;
  private troubleAt = Number.NEGATIVE_INFINITY;
  private noticeLevel: number | null = null;

  /**
   * The pacing keeps the level a margin above the line of the server. The margin is `ceil(marginMs / windowSize) + windowSize` of level.
   * The first part is for the arrival times, and the second part is for the rounding. The second part stays when `marginMs` is 0.
   * The margin can move the first wait of a burst to an earlier send. In its first waits, a burst takes longer by approximately the margin times `windowSize`, in milliseconds.
   * After that, each paced wait is longer by the margin, in milliseconds.
   * A `marginMs` that is not a number gives the default.
   */
  constructor(opts: { now: () => number; marginMs?: number | undefined }) {
    this.now = opts.now;
    const marginMs = opts.marginMs ?? PACE_MARGIN_MS;
    this.marginMs = Number.isNaN(marginMs) ? PACE_MARGIN_MS : Math.max(0, marginMs);
  }

  seed(params: RateClassParams): void {
    this.params = params;
    this.level = params.currentLevel;
    this.lastAt = this.now();
    this.limited = params.currentLevel < params.limitLevel;
    this.noticeLevel = null;
  }

  status(): RateStatus {
    if (!this.params) return 'clear';
    if (this.limited) return 'limited';
    return this.level < this.params.alertLevel ? 'alert' : 'clear';
  }

  // The server and the model round each level down. The server counts the time between arrivals, and the model the time between sends.
  // Thus the two levels are not the same. Arrival times that move by `marginMs` put the server `marginMs / windowSize` lower at most.
  // The rounding puts the server less than `windowSize` lower.
  private margin(p: RateClassParams): number {
    const window = Math.max(1, p.windowSize);
    return Math.ceil(this.marginMs / window) + window;
  }

  /**
   * How long until a send leaves the level at the line of the server plus the margin.
   * The line is the clear level while the class is limited, and the alert level otherwise: the server ends an alert at the alert level.
   */
  waitMs(): number {
    const p = this.params;
    if (!p) return 0;
    const line = this.limited ? p.clearLevel : p.alertLevel;
    const target = Math.min(p.maxLevel, line + this.margin(p));
    const needed = target * p.windowSize - this.level * (p.windowSize - 1);
    return Math.max(0, needed - (this.now() - this.lastAt));
  }

  sent(): RateStatus {
    const p = this.params;
    if (!p) return 'clear';
    const now = this.now();
    const check = checkRate(p, this.level, now - this.lastAt, this.limited);
    this.level = check.level;
    this.lastAt = now;
    this.recent = [...this.inFlight(now), now];
    this.noticeLevel = null;
    this.limited = check.status === 'limited' || check.status === 'disconnect';
    if (check.status !== 'clear') this.troubleAt = now;
    return this.status();
  }

  private inFlight(now: number): number[] {
    return this.recent.filter((at) => at > now - NOTICE_FLIGHT_MS);
  }

  // The server's limiter dropped a send with no receipt on a live socket. So the
  // server's level is under the limit, whatever level this model holds.
  dropped(): void {
    const p = this.params;
    if (!p) return;
    this.limited = true;
    this.level = Math.min(this.level, p.limitLevel - 1);
    this.noticeLevel = null;
    this.troubleAt = this.now();
  }

  notice(code: number, params: RateClassParams): RateStatus {
    const trouble = code === RATE_CODE_LIMITED || code === RATE_CODE_ALERT;
    const known = this.params !== null;
    const level = params.currentLevel;
    const margin = this.margin(params);
    // A level far below the level of this model comes from sends that this model did not count. The model does not know the time of the last of them.
    const uncounted = trouble && known && level < this.level - margin;
    // After a limit notice, the server drops each send with no notice. The level of a limit notice can be without the sends that were on their way.
    // The same is true for an alert notice while the model is limited. The server sends it after a limit that it reported before a send.
    const dropping = known && (code === RATE_CODE_LIMITED || (code === RATE_CODE_ALERT && this.limited));
    // A notice can have the level of the notice before it. Then the server counted no send between the two, and the model is correct already.
    const repeat = dropping && this.limited && level === this.noticeLevel;
    // For each other level, the model does not know which sends made it. Thus it counts the time from the notice.
    if (!known || uncounted || (dropping && !repeat)) this.lastAt = this.now();
    this.params = params;
    if (!repeat) this.level = level;
    if (dropping && !repeat) this.countInFlight(params);
    this.noticeLevel = level;
    if (code === RATE_CODE_LIMITED) this.limited = true;
    if (code === RATE_CODE_CLEAR) this.limited = false;
    if (trouble) this.troubleAt = this.now();
    return this.status();
  }

  // The server drops each send after the limit with no notice, and a send that it drops moves its level also.
  // Thus the model counts each send that the client wrote less than `NOTICE_FLIGHT_MS` before the notice. It counts the first of them at the time of the notice level.
  // The level of the model is then not above the level of the server, if a send and its notice take less than `NOTICE_FLIGHT_MS` together.
  // A send of another session after the server made the notice also puts the server lower. The model cannot count a send of another session.
  // A send that the notice did count makes the wait longer than necessary.
  private countInFlight(p: RateClassParams): void {
    let last: number | null = null;
    for (const at of this.inFlight(this.now())) {
      this.level = checkRate(p, this.level, last === null ? 0 : at - last, true).level;
      last = at;
    }
    if (last !== null) this.lastAt = last;
  }

  troubledWithin(ms: number): boolean {
    return this.troubleAt >= this.now() - ms;
  }
}

export function createRoomPacer(now: () => number, marginMs?: number): RoomPacer {
  // Room sessions never have the bot flag, so the server's limiter controls a room also when BOS is exempt.
  const governor = new RateGovernor({ now, marginMs });
  let classId = CHAT_SEND_RATE_CLASS;
  return {
    seed(rateParamsReply) {
      const reply = decodeRateParamsReply(rateParamsReply);
      classId = reply.classOf(FAMILY_CHAT, CHAT_MSG_TO_HOST) ?? CHAT_SEND_RATE_CLASS;
      const params = reply.classes.find((c) => c.id === classId);
      if (params) governor.seed(params);
    },
    notice(rateParamChange) {
      const change = decodeRateParamChange(rateParamChange);
      if (change.params.id !== classId) return null;
      return governor.notice(change.code, change.params);
    },
    waitMs: () => governor.waitMs(),
    sent: () => governor.sent(),
    dropped: () => governor.dropped(),
  };
}
