import { describe, expect, it } from 'vitest';
import { backoffDelay, desktopReconnectPolicy, dropEvidence } from '../../../src/client/reconnect.js';
import type { DropEvidence } from '../../../src/client/reconnect.js';
import { FlapDecoder } from '../../../src/wire/flap.js';
import { decodeTlvs, tlv } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const flap = loadVectors('flap.json');
const signoff = (name: string) => {
  const [frame] = new FlapDecoder().push(bytesOf(flap, name));
  return { kind: 'signoff' as const, clean: true as const, tlvs: decodeTlvs(frame?.payload ?? new Uint8Array(0)), truncated: false };
};

const desktop = desktopReconnectPolicy(() => 0);
const next = (phase: 'drop' | 'attempt', evidence: DropEvidence) => desktop.next({ phase, evidence, attempt: phase === 'drop' ? 1 : 2, onlineAt: 0, now: 0 });
const retry = (attempt: number) => ({ retry: true, delayMs: backoffDelay(attempt, 0) });

describe('desktopReconnectPolicy', () => {
  it('ends the session on a sign-off with a reason, after a drop and after an attempt', () => {
    const evidence: DropEvidence = { kind: 'signed-off', reason: 1 };
    expect([next('drop', evidence), next('attempt', evidence)]).toEqual([
      { retry: false, reason: { kind: 'signed-off-by-server' } },
      { retry: false, reason: { kind: 'signed-off-by-server' } },
    ]);
  });

  it('retries the session cap after a drop and stops on it after an attempt', () => {
    const evidence: DropEvidence = { kind: 'session-cap' };
    expect([next('drop', evidence), next('attempt', evidence)]).toEqual([retry(1), { retry: false, reason: { kind: 'too-many-sessions' } }]);
  });

  it('retries a refusal after a drop and stops with its failure after an attempt', () => {
    const wrong: DropEvidence = { kind: 'refused', failure: { kind: 'wrong-password' } };
    const step: DropEvidence = { kind: 'refused', failure: { kind: 'refused', code: 0x0d } };
    expect([next('drop', wrong), next('attempt', wrong), next('attempt', step)]).toEqual([
      retry(1),
      { retry: false, reason: { kind: 'wrong-password' } },
      { retry: false, reason: { kind: 'refused', code: 0x0d } },
    ]);
  });

  const others: DropEvidence[] = [
    { kind: 'closed', close: 'eof' },
    { kind: 'closed', close: 'error' },
    { kind: 'closed', close: 'probe-timeout' },
    { kind: 'closed', close: 'truncated' },
    { kind: 'closed', close: 'signoff' },
    { kind: 'connect-refused' },
    { kind: 'unreachable' },
    { kind: 'empty-signoff' },
    { kind: 'cookie-refused' },
    { kind: 'local' },
  ];
  it.each(others)('retries %j after a drop and after an attempt', (evidence) => {
    expect([next('drop', evidence), next('attempt', evidence)]).toEqual([retry(1), retry(2)]);
  });

  it("waits the attempt's backoff, varied by one random draw per retry", () => {
    const draws = [0.5, -1];
    const policy = desktopReconnectPolicy(() => draws.shift() ?? 0);
    const closed: DropEvidence = { kind: 'closed', close: 'eof' };
    expect(policy.next({ phase: 'drop', evidence: closed, attempt: 1, onlineAt: 0, now: 0 })).toEqual({ retry: true, delayMs: backoffDelay(1, 0.5) });
    expect(policy.next({ phase: 'attempt', evidence: { kind: 'session-cap' }, attempt: 2, onlineAt: 0, now: 0 }).retry).toBe(false);
    expect(policy.next({ phase: 'attempt', evidence: closed, attempt: 3, onlineAt: 0, now: 0 })).toEqual({ retry: true, delayMs: backoffDelay(3, -1) });
  });
});

describe('dropEvidence', () => {
  it('reads each sign-off frame form', () => {
    expect(dropEvidence(signoff('signoff after a server-side close, sequence 101'), true)).toEqual({ kind: 'signed-off', reason: 1 });
    expect(dropEvidence(signoff('signoff when five instances are already online, sequence 101'), true)).toEqual({ kind: 'session-cap' });
    expect(dropEvidence(signoff('signoff from the login limiter, sequence 101'), true)).toEqual({ kind: 'session-cap' });
    expect(dropEvidence(signoff('empty signoff, sequence 102'), true)).toEqual({ kind: 'empty-signoff' });
    expect(dropEvidence({ kind: 'signoff', clean: true, tlvs: [], truncated: true }, true)).toEqual({ kind: 'closed', close: 'truncated' });
    expect(dropEvidence({ kind: 'signoff', clean: true, tlvs: [tlv.u8(0x09, 1)], truncated: true }, true)).toEqual({ kind: 'closed', close: 'truncated' });
  });

  it('reads a sign-off whose TLVs name no reason and no cap as a close, not an empty sign-off', () => {
    const kick = signoff('signoff after a server-side close, sequence 101');
    const urlOnly = { ...kick, tlvs: kick.tlvs.filter((t) => t.tag !== 0x09) };
    expect(urlOnly.tlvs.map((t) => t.tag)).toEqual([0x0b]);
    expect([dropEvidence(urlOnly, true), dropEvidence(urlOnly, false)]).toEqual([
      { kind: 'closed', close: 'signoff' },
      { kind: 'closed', close: 'signoff' },
    ]);
  });

  it('reads a sign-off the same before host online', () => {
    expect(dropEvidence(signoff('signoff when five instances are already online, sequence 101'), false)).toEqual({ kind: 'session-cap' });
    expect(dropEvidence(signoff('empty signoff, sequence 102'), false)).toEqual({ kind: 'empty-signoff' });
  });

  it('reads a close with no sign-off before host online as a refused cookie', () => {
    const error = new Error('read ECONNRESET');
    expect(dropEvidence({ kind: 'eof', clean: false }, false)).toEqual({ kind: 'cookie-refused' });
    expect(dropEvidence({ kind: 'eof', clean: false }, true)).toEqual({ kind: 'closed', close: 'eof' });
    expect(dropEvidence({ kind: 'error', clean: false, error }, false)).toEqual({ kind: 'cookie-refused' });
    expect(dropEvidence({ kind: 'error', clean: false, error }, true)).toEqual({ kind: 'closed', close: 'error' });
  });

  it('reads a probe timeout as closed and a close of its own as local', () => {
    expect(dropEvidence({ kind: 'probe-timeout', clean: false }, true)).toEqual({ kind: 'closed', close: 'probe-timeout' });
    expect(dropEvidence({ kind: 'local', clean: true }, true)).toEqual({ kind: 'local' });
    expect(dropEvidence({ kind: 'local', clean: true }, false)).toEqual({ kind: 'local' });
  });
});
