import { describe, expect, it } from 'vitest';
import { backoffDelay } from '../../../src/client/reconnect.js';

describe('backoffDelay', () => {
  it.each([[1, 2_000], [2, 4_000], [3, 60_000], [5, 60_000], [6, 64_000], [7, 120_000], [20, 120_000]])(
    'the delay doubles from 2 s, is at least 60 s from the third failure, and never exceeds 144 s: %i failures',
    (failures, ms) => {
      expect(backoffDelay(failures, 0)).toBe(ms);
      expect(backoffDelay(failures, 1)).toBe(Math.round(ms * 1.2));
      expect(backoffDelay(failures, -1)).toBe(Math.round(ms * 0.8));
      expect(backoffDelay(failures, 1)).toBeLessThanOrEqual(144_000);
    },
  );

  it('rounds a varied delay to whole milliseconds', () => {
    expect(backoffDelay(1, 0.33333)).toBe(2_133);
  });
});
