import type { TimerApi } from '../wire/types.js';

export type GuardSite = { kind: 'timer' } | { kind: 'task'; task: string } | { kind: 'listener'; event: string } | { kind: 'sign-on' };

/** Runs each callback under a try/catch whose catch is `onThrow`; the timers go on after a throw. */
export function guardTimers(timers: TimerApi, onThrow: (error: unknown) => void): TimerApi {
  const guarded = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    timers.setTimeout(() => {
      try {
        callback(...args);
      } catch (error) {
        onThrow(error);
      }
    }, ms);
  return { setTimeout: guarded as unknown as typeof setTimeout, clearTimeout: (id) => timers.clearTimeout(id) };
}
