import { LOGIN_BUDGET_PER_MINUTE, LOGIN_STAGGER_MS } from '../wire/constants.js';
import type { TimerApi } from '../wire/types.js';

export type LoginBudget = { take(): Promise<void> };

type Timer = ReturnType<typeof setTimeout>;

// The server allows 10 auth connections per minute per source address, shared by every account behind it.
export function createLoginBudget(
  opts: { perMinute?: number; staggerMs?: number; now?: () => number; timers?: TimerApi } = {},
): LoginBudget {
  const perMinute = opts.perMinute ?? LOGIN_BUDGET_PER_MINUTE;
  const staggerMs = opts.staggerMs ?? LOGIN_STAGGER_MS;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? { setTimeout, clearTimeout };
  const grants: number[] = [];
  const waiting: (() => void)[] = [];
  let timer: Timer | null = null;

  const pump = (): void => {
    timer = null;
    while (waiting.length > 0) {
      const t = now();
      while (grants.length > 0 && (grants[0] ?? 0) <= t - 60_000) grants.shift();
      const last = grants[grants.length - 1];
      let wait = last === undefined ? 0 : last + staggerMs - t;
      if (grants.length >= perMinute) wait = Math.max(wait, (grants[0] ?? 0) + 60_000 - t);
      if (wait > 0) {
        timer = timers.setTimeout(pump, wait);
        return;
      }
      grants.push(t);
      waiting.shift()?.();
    }
  };

  return {
    take() {
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (timer === null) pump();
      });
    },
  };
}

export const defaultLoginBudget: LoginBudget = createLoginBudget();
