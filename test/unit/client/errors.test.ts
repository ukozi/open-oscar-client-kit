import { describe, expect, it } from 'vitest';
import { OscarError, SignOnError } from '../../../src/client/errors.js';

describe('typed errors', () => {
  it('carry their typed value and name it in the message, without any payload text', () => {
    const e = new OscarError({ kind: 'refused', code: 0x10 });
    expect([e instanceof Error, e.name, e.info, e.message]).toEqual([true, 'OscarError', { kind: 'refused', code: 0x10 }, 'refused (0x0010)']);
    expect(new OscarError({ kind: 'local', code: 'message-too-long' }).message).toBe('local (message-too-long)');
    expect(new OscarError({ kind: 'timeout', rateLimited: false }).message).toBe('timeout');
    const s = new SignOnError({ kind: 'account-unavailable', code: 0x11 });
    expect([s.name, s.failure, s.message]).toEqual(['SignOnError', { kind: 'account-unavailable', code: 0x11 }, 'account-unavailable (0x0011)']);
    expect(new SignOnError({ kind: 'unreachable' }).message).toBe('unreachable');
  });
});
