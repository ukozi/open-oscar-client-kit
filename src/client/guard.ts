import type { Logger, TimerApi } from '../wire/types.js';

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

/** True only when the rule gives true. A throw, or a value that is not true or false, gives false and a warning. */
export function offerAllowed(rule: (from: string) => boolean, from: string, log: Logger, kind: 'file' | 'direct im'): boolean {
  let answer: unknown;
  try {
    answer = rule(from);
  } catch (error) {
    log.warn(`the rule for ${kind} offers threw, and the offer is dropped`, { error: error instanceof Error ? error.name : typeof error });
    return false;
  }
  if (answer === true) return true;
  ignoreRejection(answer);
  if (answer !== false) log.warn(`the rule for ${kind} offers gave a value that is not true or false, and the offer is dropped`);
  return false;
}

// A rule that is async gives a promise. Its rejection gets a handler, so that the runtime does not stop.
function ignoreRejection(answer: unknown): void {
  try {
    const then = (answer as { then?: unknown } | null)?.then;
    if (typeof then === 'function') then.call(answer, undefined, () => {});
  } catch {
    // The offer is dropped already.
  }
}
