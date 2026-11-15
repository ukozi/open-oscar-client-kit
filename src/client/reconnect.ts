import type { CloseInfo } from '../wire/connection.js';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  BACKOFF_FLOOR_AFTER_FAILURES,
  BACKOFF_FLOOR_MS,
  BACKOFF_JITTER,
  LOGIN_TLV_ERROR,
  SIGNOFF_TLV_DISCONNECT_REASON,
} from '../wire/constants.js';
import { tlvU16, tlvU8 } from '../wire/tlv.js';
import type { SignOffReason, SignOnFailure } from '../model/session.js';

export type DropEvidence =
  | { kind: 'closed'; close: 'eof' | 'error' | 'probe-timeout' | 'truncated' | 'signoff' } // ended after host online with no sign-off, or one that names no reason and no cap
  | { kind: 'connect-refused' } // a refused TCP connect
  | { kind: 'unreachable' } // any other connect failure, a timeout, a reply that did not decode
  | { kind: 'empty-signoff' } // a sign-off with no TLVs
  | { kind: 'cookie-refused' } // closed after the server's FLAP sign-on frame and before host online, with no sign-off
  | { kind: 'session-cap' } // a sign-off with TLV 0x08
  | { kind: 'signed-off'; reason: number } // a sign-off with TLV 0x09
  | { kind: 'refused'; failure: SignOnFailure } // the server refused the source's login, or a sign-on step answered with an error
  | { kind: 'local' }; // the client closed the connection itself
export type ReconnectDecision = { retry: true; delayMs: number } | { retry: false; reason: SignOffReason };
export interface ReconnectPolicy {
  /** `drop`: the online session's BOS connection ended (attempt 1); `attempt`: a reconnect attempt failed (attempt 2 on). `onlineAt` is when the session last came online. */
  next(input: { phase: 'drop' | 'attempt'; evidence: DropEvidence; attempt: number; onlineAt: number; now: number }): ReconnectDecision;
}

/** `failures` counts the consecutive failures from 1, the drop itself being the first; `random` is from -1 to 1. */
export function backoffDelay(failures: number, random: number): number {
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, failures - 1));
  const floored = failures >= BACKOFF_FLOOR_AFTER_FAILURES ? Math.max(raw, BACKOFF_FLOOR_MS) : raw;
  return Math.round(floored * (1 + BACKOFF_JITTER * random));
}

/** A sign-off with a reason ends the session; the session cap and a refusal end it only when an attempt meets them. */
export function desktopReconnectPolicy(random: () => number): ReconnectPolicy {
  return {
    next({ phase, evidence, attempt }) {
      if (evidence.kind === 'signed-off') return { retry: false, reason: { kind: 'signed-off-by-server' } };
      if (phase === 'attempt' && evidence.kind === 'session-cap') return { retry: false, reason: { kind: 'too-many-sessions' } };
      if (phase === 'attempt' && evidence.kind === 'refused') return { retry: false, reason: evidence.failure };
      return { retry: true, delayMs: backoffDelay(attempt, random()) };
    },
  };
}

export function dropEvidence(close: CloseInfo, hostOnline: boolean): DropEvidence {
  switch (close.kind) {
    case 'signoff': {
      const reason = close.truncated ? undefined : tlvU8(close.tlvs, SIGNOFF_TLV_DISCONNECT_REASON);
      if (reason !== undefined) return { kind: 'signed-off', reason };
      // The session cap writes the code as one byte, the login limiter as two.
      if ((tlvU16(close.tlvs, LOGIN_TLV_ERROR) ?? tlvU8(close.tlvs, LOGIN_TLV_ERROR)) !== undefined) return { kind: 'session-cap' };
      if (close.truncated) return { kind: 'closed', close: 'truncated' };
      return close.tlvs.length === 0 ? { kind: 'empty-signoff' } : { kind: 'closed', close: 'signoff' };
    }
    case 'eof':
    case 'error':
      return hostOnline ? { kind: 'closed', close: close.kind } : { kind: 'cookie-refused' };
    case 'probe-timeout':
      return { kind: 'closed', close: 'probe-timeout' };
    case 'local':
      return { kind: 'local' };
  }
}
