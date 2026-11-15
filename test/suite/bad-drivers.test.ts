import { describe, expect, it } from 'vitest';
import { runSuite } from '../../suite/runner.js';
import * as text from '../../suite/text.js';

const driver = (name: string, ...args: string[]): string[] => ['node', `test/suite/drivers/${name}`, ...args];

describe('bad drivers', () => {
  it('fails a driver that retries a wrong password', async () => {
    const { results } = await runSuite({ driver: driver('retry-loop.mjs'), only: ['wrong-password'] });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toContain('5 logins');
  });

  it('fails a driver that reconnects without a back-off', async () => {
    const { results } = await runSuite({ driver: driver('no-backoff.mjs'), only: ['reconnect'] });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toContain(text.BACKOFF_TOO_SHORT(50));
  });

  it('fails a driver that reports a back-off and reconnects at once', async () => {
    const { results } = await runSuite({ driver: driver('no-backoff.mjs', '2000'), only: ['reconnect'] });
    expect(results[0]?.ok).toBe(false);
    const [before, after] = text.RECONNECTED_EARLY(0).split(' 0 ');
    expect(results[0]?.reason).toContain(before);
    expect(results[0]?.reason).toContain(after);
  });

  it('fails a driver that sends a burst without pacing', async () => {
    const { results } = await runSuite({ driver: driver('no-pacing.mjs'), only: ['burst'] });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toContain(text.DISCONNECTED);
  });

  it('fails a driver that replies ok to a wrong password', async () => {
    const { results } = await runSuite({ driver: driver('echo-ok.mjs'), only: ['wrong-password'] });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toBe('signOn replied ok, not an error');
  });

  it('fails a driver that replies ok to sendIm and sends nothing', async () => {
    const { results } = await runSuite({ driver: driver('no-send.mjs'), only: ['send-im'] });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toBe('the peer did not receive the IM within 5 s');
    expect(text.NO_PEER_IM(2500)).toBe('the peer did not receive the IM within 2.5 s');
  }, 30_000);

  it('fails a driver that crashes and goes on to the next scenario', async () => {
    const { results } = await runSuite({ driver: driver('crash-mid.mjs'), only: ['sign-on', 'send-im'] });
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0]?.reason).toContain('driver exited with code');
    expect(results[1]?.reason).toContain('driver exited with code');
  });

  it('fails a driver that prints a line that is not JSON', async () => {
    const { results } = await runSuite({ driver: driver('bad-json.mjs'), only: ['sign-on'] });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toContain('ProtocolError');
  }, 30_000);
});
