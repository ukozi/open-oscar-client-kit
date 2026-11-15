import { describe, expect, it } from 'vitest';
import { guardTimers } from '../../../src/client/guard.js';
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
