import { describe, expect, it } from 'vitest';
import { createLoginBudget, defaultLoginBudget } from '../../../src/client/login-budget.js';
import { ManualTimers } from '../../fake/oscar-client.js';

describe('createLoginBudget', () => {
  it('staggers logins 2 s apart and allows 8 per minute', async () => {
    const timers = new ManualTimers();
    const budget = createLoginBudget({ now: timers.now, timers: timers.api });
    const start = timers.now();
    const granted: number[] = [];
    for (let i = 0; i < 10; i++) void budget.take().then(() => granted.push(timers.now() - start));
    await timers.advance(0);
    expect(granted).toEqual([0]);
    await timers.advance(59_999);
    expect(granted).toEqual([0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000]);
    await timers.advance(2001);
    expect(granted).toEqual([0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000, 60_000, 62_000]);
  });

  it('grants at once after a quiet spell', async () => {
    const timers = new ManualTimers();
    const budget = createLoginBudget({ now: timers.now, timers: timers.api });
    await budget.take();
    await timers.advance(5000);
    let granted = false;
    void budget.take().then(() => (granted = true));
    await timers.advance(0);
    expect(granted).toBe(true);
  });

  it('shares one default budget across the process', async () => {
    const again = await import('../../../src/client/login-budget.js');
    expect(again.defaultLoginBudget).toBe(defaultLoginBudget);
  });
});
