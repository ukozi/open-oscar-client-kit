import { describe, expect, it } from 'vitest';
import { guardTimers, offerAllowed } from '../../../src/client/guard.js';
import { captureLog } from '../../fake/oscar-client.js';
import { ManualTimers } from '../../fake/oscar-client.js';

describe('guardTimers', () => {
  it('hands a throw in a timer callback to onThrow and runs the timers after it', async () => {
    const manual = new ManualTimers();
    const seen: unknown[] = [];
    const ran: string[] = [];
    const timers = guardTimers(manual.api, (error) => seen.push(error));
    timers.setTimeout(() => {
      throw new Error('first');
    }, 10);
    timers.setTimeout(() => ran.push('second'), 20);
    await manual.advance(30);
    expect(seen.map((error) => (error as Error).message)).toEqual(['first']);
    expect(ran).toEqual(['second']);
  });

  it('runs a callback that does not throw, with the arguments it was given', async () => {
    const manual = new ManualTimers();
    const seen: unknown[] = [];
    const got: number[] = [];
    const timers = guardTimers(manual.api, (error) => seen.push(error));
    timers.setTimeout((a: number, b: number) => got.push(a, b), 5, 1, 2);
    await manual.advance(5);
    expect([got, seen]).toEqual([[1, 2], []]);
  });

  it('cancels with clearTimeout of the returned id', async () => {
    const manual = new ManualTimers();
    const ran: string[] = [];
    const timers = guardTimers(manual.api, () => {});
    const id = timers.setTimeout(() => ran.push('cancelled'), 10);
    timers.clearTimeout(id);
    await manual.advance(20);
    expect([ran, manual.pending()]).toEqual([[], []]);
  });

  it('lets a throw out where onThrow throws it again', async () => {
    const manual = new ManualTimers();
    const timers = guardTimers(manual.api, (error) => {
      throw error;
    });
    timers.setTimeout(() => {
      throw new Error('escapes');
    }, 10);
    await expect(manual.advance(10)).rejects.toThrow('escapes');
  });
});

describe('offerAllowed', () => {
  it('a rule that gives a promise that rejects drops the offer, and the rejection has a handler', async () => {
    const unhandled: unknown[] = [];
    const hear = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', hear);
    try {
      const captured = captureLog();
      const rule = (() => Promise.reject(new Error('no'))) as unknown as (from: string) => boolean;
      expect(offerAllowed(rule, 'Cathy', captured.log, 'file')).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(captured.lines.map((l) => l.msg)).toEqual(['the rule for file offers gave a value that is not true or false, and the offer is dropped']);
      expect(captured.text()).not.toContain('Cathy');
    } finally {
      process.off('unhandledRejection', hear);
    }
  });

  it('a thenable whose then throws drops the offer with no throw', () => {
    const captured = captureLog();
    const rule = (() => ({
      // biome-ignore lint/suspicious/noThenProperty: the test gives a thenable to the rule.
      then() {
        throw new Error('no');
      },
    })) as unknown as (from: string) => boolean;
    expect(offerAllowed(rule, 'Cathy', captured.log, 'direct im')).toBe(false);
  });
});
