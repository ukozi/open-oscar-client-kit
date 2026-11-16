import { describe, expect, it } from 'vitest';
import { NOTICE_FLIGHT_MS, PACE_MARGIN_MS, RateGovernor, checkRate } from '../../../src/wire/rate.js';
import type { RateClassParams } from '../../../src/wire/rate.js';

const CLASS3: RateClassParams = {
  id: 3,
  windowSize: 20,
  clearLevel: 5100,
  alertLevel: 5000,
  limitLevel: 4000,
  disconnectLevel: 3000,
  currentLevel: 6000,
  maxLevel: 6000,
};

function governor(marginMs?: number) {
  let t = 1_000_000;
  const g = new RateGovernor({ now: () => t, marginMs });
  g.seed({ ...CLASS3 });
  return { g, advance: (ms: number) => (t += ms) };
}

function small(over: Partial<RateClassParams>): RateClassParams {
  return { id: 1, windowSize: 4, maxLevel: 1000, clearLevel: 100, disconnectLevel: 5, limitLevel: 20, alertLevel: 40, currentLevel: 0, ...over };
}

describe('checkRate, rows from the server test table', () => {
  const rows: [string, RateClassParams, number, number, boolean, string, number][] = [
    ['limited and back over clear', small({ clearLevel: 10, disconnectLevel: 2, limitLevel: 5, alertLevel: 8 }), 9, 50, true, 'clear', 19],
    ['limited and still under clear', small({ clearLevel: 50, disconnectLevel: 10, limitLevel: 20, alertLevel: 30 }), 10, 30, true, 'limited', 15],
    ['under disconnect', small({}), 1, 10, false, 'disconnect', 3],
    ['under disconnect while limited', small({}), 1, 10, true, 'disconnect', 3],
    ['under limit', small({ limitLevel: 40, alertLevel: 60 }), 10, 20, false, 'limited', 12],
    ['under alert', small({}), 20, 30, false, 'alert', 22],
    ['at or over alert', small({}), 39, 50, false, 'clear', 41],
    ['clamped to max', small({ maxLevel: 100, clearLevel: 80, disconnectLevel: 20, limitLevel: 40, alertLevel: 60 }), 95, 9999, false, 'clear', 100],
  ];
  it.each(rows)('%s', (_name, params, level, elapsed, limited, status, next) => {
    expect(checkRate(params, level, elapsed, limited)).toEqual({ status, level: next });
  });
});

describe('RateGovernor against class 3', () => {
  it('never holds anything before it is seeded', () => {
    const g = new RateGovernor({ now: () => 0 });
    expect([g.waitMs(), g.sent(), g.status(), g.troubledWithin(1000)]).toEqual([0, 'clear', 'clear', false]);
    g.dropped();
    expect(g.waitMs()).toBe(0);
  });

  it('lets three sends through with no wait, then asks for a wait that keeps the level 33 above the alert line', () => {
    const { g, advance } = governor();
    for (let i = 0; i < 3; i++) {
      expect(g.waitMs()).toBe(0);
      expect(g.sent()).toBe('clear');
    }
    // The margin: 250 ms is 13 of level in a window of 20, and 20 more for the rounding. Level is 5144 after three sends; 20 * 5033 - 19 * 5144 = 2924 ms
    expect(PACE_MARGIN_MS).toBe(250);
    expect(g.waitMs()).toBe(2924);
    advance(2924);
    expect(g.waitMs()).toBe(0);
    expect(g.sent()).toBe('clear');
  });

  it('settles at one send every five seconds and never raises an alert', () => {
    const { g, advance } = governor();
    const waits: number[] = [];
    for (let i = 0; i < 40; i++) {
      const wait = g.waitMs();
      waits.push(wait);
      advance(wait);
      expect(g.sent()).toBe('clear');
    }
    for (const wait of waits.slice(10)) {
      expect(wait).toBeGreaterThanOrEqual(4900);
      expect(wait).toBeLessThanOrEqual(5100);
    }
  });

  it('models what the server does to a client that ignores it: seven accepted, the eighth dropped, about 26 s to recover', () => {
    const { g, advance } = governor();
    const statuses: string[] = [];
    for (let i = 0; i < 8; i++) statuses.push(g.sent());
    expect(statuses).toEqual(['clear', 'clear', 'clear', 'alert', 'alert', 'alert', 'alert', 'limited']);
    // level is 3977; 20 * 5133 - 19 * 3977 = 27097 ms
    expect(g.waitMs()).toBe(27_097);
    advance(27_097);
    expect(g.waitMs()).toBe(0);
    expect(g.sent()).toBe('clear');
  });

  it('dropped() holds sends until the clear level is reachable', () => {
    const { g, advance } = governor();
    g.sent();
    g.dropped();
    expect(g.status()).toBe('limited');
    // 20 * 5133 - 19 * 3999 = 26679 ms
    expect(g.waitMs()).toBe(26_679);
    advance(10_000);
    expect(g.waitMs()).toBe(16_679);
    expect(g.troubledWithin(30_000)).toBe(true);
    advance(21_000);
    expect(g.troubledWithin(30_000)).toBe(false);
  });

  it('follows server notices', () => {
    const { g } = governor();
    expect(g.notice(3, { ...CLASS3, currentLevel: 3900 })).toBe('limited');
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3900);
    expect(g.notice(4, { ...CLASS3, currentLevel: 5100 })).toBe('clear');
    expect(g.notice(2, { ...CLASS3, currentLevel: 4500 })).toBe('alert');
    expect(g.troubledWithin(1)).toBe(true);
    expect(g.notice(1, { ...CLASS3, limitLevel: 5000, alertLevel: 5500, clearLevel: 5600, currentLevel: 6000 })).toBe('clear');
  });

  it('a margin of 0 ms keeps only the margin for the rounding, and a margin of 1000 ms moves the first wait by 1000 ms more and each wait after it by 50 ms more', () => {
    const none = governor(0);
    const wide = governor(1000);
    for (let i = 0; i < 3; i++) {
      none.g.sent();
      wide.g.sent();
    }
    expect([none.g.waitMs(), wide.g.waitMs()]).toEqual([2664, 3664]);
    none.advance(2664);
    wide.advance(3664);
    none.g.sent();
    wide.g.sent();
    expect([none.g.waitMs(), wide.g.waitMs()]).toEqual([5020, 5070]);
    expect(governor(-5).g.waitMs()).toBe(0);
  });

  it('a margin that is not a number paces as the default margin', () => {
    const odd = governor(Number.NaN);
    for (let i = 0; i < 3; i++) odd.g.sent();
    expect(odd.g.waitMs()).toBe(2924);
  });

  it('a notice with a level inside the margin of the model keeps the time of the last send', () => {
    const near = governor();
    const far = governor();
    for (let i = 0; i < 3; i++) {
      near.g.sent();
      far.g.sent();
    }
    near.advance(1000);
    far.advance(1000);
    // The model has 5144. The margin is 33, thus 5111 is not far below.
    near.g.notice(2, { ...CLASS3, currentLevel: 5111 });
    expect(near.g.waitMs()).toBe(20 * 5033 - 19 * 5111 - 1000);
    // 5110 is far below: the wait counts from the notice.
    far.g.notice(2, { ...CLASS3, currentLevel: 5110 });
    expect(far.g.waitMs()).toBe(20 * 5033 - 19 * 5110);
  });

  it('never asks for a level above the maximum of the class', () => {
    let t = 0;
    const g = new RateGovernor({ now: () => t, marginMs: 100_000 });
    g.seed({ ...CLASS3 });
    g.sent();
    // Level is 5700. The line plus the margin is above 6000, thus the target is 6000: 20 * 6000 - 19 * 5700 = 11700 ms.
    expect(g.waitMs()).toBe(11_700);
    t += 11_700;
    expect(g.waitMs()).toBe(0);
  });

  it('after an alert notice it waits for the alert level and the margin, as the server ends an alert at the alert level', () => {
    const { g, advance } = governor();
    for (let i = 0; i < 3; i++) g.sent();
    advance(2924);
    g.sent();
    // One second later the server reports that one more send now is under the alert line. Its level is the level of the model, thus the time of the last send stays.
    advance(1000);
    expect(g.notice(2, { ...CLASS3, currentLevel: 5033 })).toBe('clear');
    // 20 * 5033 - 19 * 5033 = 5033 ms after the last send.
    expect(g.waitMs()).toBe(4033);
    advance(4033);
    expect(g.sent()).toBe('clear');
    expect(g.waitMs()).toBe(5033);
  });

  it.each([
    // The margin of a window of 80 is 4 + 80 = 84 of level. 80 * 2084 - 79 * 1990 = 9510 ms. With no margin: 2790 ms.
    ['class 1, clear level 2500', 9510, 2790, { id: 1, windowSize: 80, clearLevel: 2500, alertLevel: 2000, limitLevel: 1500, disconnectLevel: 800, currentLevel: 6000, maxLevel: 6000 }],
    ['class 2, clear level 3000', 9510, 2790, { id: 2, windowSize: 80, clearLevel: 3000, alertLevel: 2000, limitLevel: 1500, disconnectLevel: 1000, currentLevel: 6000, maxLevel: 6000 }],
  ] as [string, number, number, RateClassParams][])('%s: an alert notice at level 1990 makes the wait %i ms, not the wait for the clear level', (_name, withMargin, withNone, p) => {
    let t = 1_000_000;
    const g = new RateGovernor({ now: () => t });
    const none = new RateGovernor({ now: () => t, marginMs: 0 });
    g.seed({ ...p });
    none.seed({ ...p });
    t += 60_000;
    g.notice(2, { ...p, currentLevel: 1990 });
    none.notice(2, { ...p, currentLevel: 1990 });
    expect(g.waitMs()).toBe(withMargin);
    // With a margin of 0 ms the margin for the rounding stays: 80 of level. That is 6400 ms more than with no margin at all.
    expect(none.waitMs()).toBe(withNone + 80 * 80);
    t += withMargin;
    expect(g.sent()).toBe('clear');
    // Each wait after it: 80 * 2084 - 79 * 2084 = 2084 ms, 84 ms more than with no margin at all.
    expect(g.waitMs()).toBe(2084);
  });

  it('after a limit notice it waits for the clear level, and a clear notice ends that wait', () => {
    const { g } = governor();
    g.notice(2, { ...CLASS3, currentLevel: 5990 });
    expect(g.waitMs()).toBe(0);
    g.notice(3, { ...CLASS3, currentLevel: 3999 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3999);
    g.notice(4, { ...CLASS3, currentLevel: 3999 });
    expect(g.waitMs()).toBe(20 * 5033 - 19 * 3999);
  });

  it('an alert or a limit notice with a level far below the model counts the time from the notice: another session sent', () => {
    const { g, advance } = governor();
    advance(3_600_000);
    // The model has 6000 and its last send was an hour ago. The sends that made 4886 were not.
    g.notice(2, { ...CLASS3, currentLevel: 4886 });
    expect(g.waitMs()).toBe(20 * 5033 - 19 * 4886);
    advance(3_600_000);
    g.notice(3, { ...CLASS3, currentLevel: 3500 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3500);
  });

  it('a limit notice far below the model does not count a send that was on its way: the model counts the send on top of the notice level', () => {
    const { g } = governor();
    g.sent();
    // Another session took the server to 3977. The server dropped the send of this client after that, and a dropped send moves the level: 3977 * 19 / 20 = 3778.
    g.notice(3, { ...CLASS3, currentLevel: 3977 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3778);
  });

  it('counts each send of the last NOTICE_FLIGHT_MS on top of a limit notice, the first with no time before it, and the wait runs from the last of them', () => {
    expect(NOTICE_FLIGHT_MS).toBe(2000);
    const { g, advance } = governor();
    g.sent();
    advance(100);
    g.sent();
    advance(100);
    g.sent();
    advance(300);
    g.notice(3, { ...CLASS3, currentLevel: 3977 });
    // 3977 -> 3778, then (3778 * 19 + 100) / 20 = 3594, then (3594 * 19 + 100) / 20 = 3419. The last send was 300 ms before the notice.
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3419 - 300);
  });

  it('a limit notice counts no send that is older than NOTICE_FLIGHT_MS', () => {
    const { g, advance } = governor();
    g.sent();
    advance(NOTICE_FLIGHT_MS);
    g.notice(3, { ...CLASS3, currentLevel: 3977 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3977);
    const other = governor();
    other.g.sent();
    other.advance(NOTICE_FLIGHT_MS - 1);
    other.g.notice(3, { ...CLASS3, currentLevel: 3977 });
    expect(other.g.waitMs()).toBe(20 * 5133 - 19 * 3778 - (NOTICE_FLIGHT_MS - 1));
  });

  it('a limit notice with the level of a model that its own sends limited counts the sends on their way again: the pacing prevents this case', () => {
    const { g } = governor();
    for (let i = 0; i < 2; i++) g.sent();
    g.notice(2, { ...CLASS3, currentLevel: 4200 });
    for (let i = 0; i < 2; i++) g.sent();
    // 4200 -> 3990 -> 3790 in the model. The model cannot know that 3790 has the four sends, and it counts them on top: 3790 -> 3600 -> 3420 -> 3249 -> 3086.
    expect(g.status()).toBe('limited');
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3790);
    g.notice(3, { ...CLASS3, currentLevel: 3790 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3086);
  });

  it('a limit notice near the level of a model that was not limited counts the time from the notice, and the sends on their way', () => {
    const { g, advance } = governor();
    g.notice(2, { ...CLASS3, currentLevel: 4010 });
    advance(3600);
    // Another session sent 3600 ms after the alert: (4010 * 19 + 3600) / 20 = 3989. The time before that send does not count again.
    g.notice(3, { ...CLASS3, currentLevel: 3989 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3989);
  });

  it('while limited, an alert or a limit notice with a level above the model has the sends on their way counted on top again', () => {
    const { g, advance } = governor();
    g.sent();
    advance(577);
    g.sent();
    advance(122);
    // 4190 -> 3980, then (3980 * 19 + 577) / 20 = 3809.
    g.notice(3, { ...CLASS3, currentLevel: 4190 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3809 - 122);
    advance(845);
    // The server made this notice at the first send, and it dropped the second after that. 4027 -> 3825, then (3825 * 19 + 577) / 20 = 3662.
    g.notice(2, { ...CLASS3, currentLevel: 4027 });
    expect(g.status()).toBe('limited');
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3662 - 967);
    advance(155);
    g.notice(3, { ...CLASS3, currentLevel: 4027 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3662 - 1122);
  });

  it('while limited, a notice that has the level of the notice before it changes nothing', () => {
    const { g, advance } = governor();
    g.sent();
    advance(500);
    // 4171 -> 3962 in the model, and the send was 500 ms before the notice.
    g.notice(3, { ...CLASS3, currentLevel: 4171 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3962 - 500);
    advance(1000);
    g.notice(2, { ...CLASS3, currentLevel: 4171 });
    expect(g.status()).toBe('limited');
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3962 - 1500);
    advance(1000);
    g.notice(3, { ...CLASS3, currentLevel: 4171 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3962 - 2500);
  });

  it('while limited, a notice with a level a small quantity above the model counts the time from the notice', () => {
    const { g, advance } = governor();
    g.sent();
    advance(500);
    g.notice(3, { ...CLASS3, currentLevel: 4156 });
    advance(1000);
    g.notice(2, { ...CLASS3, currentLevel: 4156 });
    // 4156 -> 3948 in the model, and the send was 1500 ms before.
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3948 - 1500);
    advance(2800);
    // Another session sent after the alert notice, and the server is limited at 3962. The level is near 3948, but the time of 3948 is not the time of 3962.
    g.notice(3, { ...CLASS3, currentLevel: 3962 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3962);
  });

  it('after a send or a dropped send, a notice with the level of the notice before it is a new level', () => {
    const { g, advance } = governor();
    g.notice(3, { ...CLASS3, currentLevel: 3900 });
    g.dropped();
    advance(5000);
    g.notice(3, { ...CLASS3, currentLevel: 3900 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3900);
    const other = governor();
    other.g.notice(3, { ...CLASS3, currentLevel: 5200 });
    other.g.sent();
    expect(other.g.status()).toBe('limited');
    other.advance(100);
    // The model was limited at 4940 after its send. 5200 -> 4940 again, and the send was 100 ms before the notice.
    other.g.notice(3, { ...CLASS3, currentLevel: 5200 });
    expect(other.g.waitMs()).toBe(20 * 5133 - 19 * 4940 - 100);
  });

  it('while limited, a notice with a level a small quantity below the model counts the time from the notice', () => {
    const { g, advance } = governor();
    g.notice(3, { ...CLASS3, currentLevel: 3900 });
    advance(1000);
    // The sends that made 3890 came after the level of the model. The time before them does not count again.
    g.notice(2, { ...CLASS3, currentLevel: 3890 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3890);
    advance(1000);
    g.notice(3, { ...CLASS3, currentLevel: 3889 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3889);
  });

  it('a limit that the server reports before a send, then an alert, then the limit from another session: the wait runs from the last notice', () => {
    const { g, advance } = governor();
    advance(1000);
    g.sent();
    advance(500);
    // The server is not limited: its level is 4171 and one more send goes below the limit. 4171 -> 3962 in the model.
    g.notice(3, { ...CLASS3, currentLevel: 4171 });
    advance(1000);
    g.notice(2, { ...CLASS3, currentLevel: 4171 });
    advance(2500);
    // Another session sent 100 ms before this notice, and the server is limited at 3947. It is back 20 * 5100 - 19 * 3947 = 27007 ms after that send.
    g.notice(3, { ...CLASS3, currentLevel: 3947 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3947);
    expect(g.waitMs()).toBeGreaterThanOrEqual(27007 - 100);
  });

  it('while limited, a notice with a level a small quantity below the model has the sends on their way counted on top', () => {
    const { g, advance } = governor();
    g.sent();
    advance(500);
    g.notice(3, { ...CLASS3, currentLevel: 4171 });
    advance(400);
    // 3950 is 12 below the 3962 of the model. 3950 * 19 / 20 = 3752, and the send was 900 ms before this notice.
    g.notice(3, { ...CLASS3, currentLevel: 3950 });
    expect(g.waitMs()).toBe(20 * 5133 - 19 * 3752 - 900);
  });

  it('an alert notice far below the model counts no send on top: the server reports the next change of status', () => {
    const { g } = governor();
    g.sent();
    g.notice(2, { ...CLASS3, currentLevel: 4886 });
    expect(g.waitMs()).toBe(20 * 5033 - 19 * 4886);
  });

  // The server of the tests: it counts each send at its arrival, and reports a change of status with the level.
  function serverOf(p: RateClassParams) {
    const state = { level: p.currentLevel, lastAt: 0, limited: false, status: 'clear', lowest: p.currentLevel, dropped: 0, disconnected: false };
    return {
      state,
      arrive(at: number): number | null {
        const check = checkRate(p, state.level, Math.max(0, at - state.lastAt), state.limited);
        state.lastAt = Math.max(state.lastAt, at);
        state.level = check.level;
        state.limited = check.status === 'limited';
        state.lowest = Math.min(state.lowest, check.level);
        if (check.status === 'limited') state.dropped++;
        if (check.status === 'disconnect') state.disconnected = true;
        if (check.status === state.status) return null;
        state.status = check.status;
        return ({ clear: 4, alert: 2, limited: 3, disconnect: null } as const)[check.status];
      },
    };
  }

  const CLASSES: RateClassParams[] = [
    CLASS3,
    { id: 1, windowSize: 80, clearLevel: 2500, alertLevel: 2000, limitLevel: 1500, disconnectLevel: 800, currentLevel: 6000, maxLevel: 6000 },
    { id: 5, windowSize: 10, clearLevel: 5500, alertLevel: 5300, limitLevel: 4200, disconnectLevel: 3000, currentLevel: 8000, maxLevel: 8000 },
  ];
  const runs = CLASSES.flatMap((p) => [0, 250, 4000].flatMap((jitter) => [true, false].map((clears): [number, number, boolean, RateClassParams] => [p.id, jitter, clears, p])));

  it.each(runs)('class %i, sends that arrive up to %i ms late, clear notices %s: 2000 sends never reach the limit, and no wait is long', (_id, jitter, clears, p) => {
    for (let seed = 1; seed <= 5; seed++) {
      let x = seed;
      const random = (): number => {
        x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
        return x / 2_147_483_648;
      };
      let t = 1_000_000;
      const g = new RateGovernor({ now: () => t });
      g.seed({ ...p });
      const server = serverOf(p);
      server.state.lastAt = t;
      let longest = 0;
      let alerts = 0;
      for (let i = 0; i < 2000; i++) {
        // At random times the client is idle, and then a burst follows.
        if (random() < 0.02) t += 60_000;
        const wait = g.waitMs();
        longest = Math.max(longest, wait);
        t += wait;
        g.sent();
        const late = Math.floor(random() * (jitter + 1));
        const code = server.arrive(t + late);
        if (code === 2) alerts++;
        if (code !== null && (code !== 4 || clears)) g.notice(code, { ...p, currentLevel: server.state.level });
      }
      const where = `seed ${seed}`;
      expect([where, server.state.dropped, server.state.disconnected]).toEqual([where, 0, false]);
      expect([where, server.state.lowest >= p.limitLevel]).toEqual([where, true]);
      // Arrival times inside the margin cause no alert at all.
      if (jitter <= PACE_MARGIN_MS) expect([where, alerts]).toEqual([where, 0]);
      // The longest wait: from the lowest level that the jitter can leave, back to the alert level plus the margin.
      const margin = Math.ceil(PACE_MARGIN_MS / p.windowSize) + p.windowSize;
      const bound = (p.alertLevel + margin) * p.windowSize - (p.alertLevel - Math.ceil((2 * jitter) / p.windowSize) - 2 * p.windowSize) * (p.windowSize - 1);
      expect([where, longest <= bound, longest, bound]).toEqual([where, true, longest, bound]);
    }
  });

  it('can be seeded by a notice alone', () => {
    const g = new RateGovernor({ now: () => 50 });
    expect(g.notice(3, { ...CLASS3, currentLevel: 3900 })).toBe('limited');
    expect(g.waitMs()).toBeGreaterThan(20_000);
  });
});
