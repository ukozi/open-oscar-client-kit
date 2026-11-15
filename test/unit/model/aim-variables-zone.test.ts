import { describe, expect, it, vi } from 'vitest';
import { aimVariableValues } from '../../../src/model/aim-variables.js';

const at = Date.UTC(2026, 9, 26, 3, 30);
const US = { locale: 'en-US', hour12: true } as const;

describe('aimVariableValues in a time zone', () => {
  it('writes the date and the time where the zone is', () => {
    expect(aimVariableValues('bob', at, { ...US, timeZone: 'America/New_York' })).toEqual({ name: 'bob', date: '10/25/2026', time: '11:30 PM' });
    expect(aimVariableValues('bob', at, { ...US, timeZone: 'Asia/Tokyo' })).toEqual({ name: 'bob', date: '10/26/2026', time: '12:30 PM' });
  });

  it('writes a 24-hour clock in the zone too', () => {
    expect(aimVariableValues('bob', at, { locale: 'en-GB', hour12: false, timeZone: 'Asia/Tokyo' })).toEqual({ name: 'bob', date: '26/10/2026', time: '12:30' });
  });

  it('takes an unknown zone as none', () => {
    expect(aimVariableValues('bob', at, { ...US, timeZone: 'Not/AZone' })).toEqual(aimVariableValues('bob', at, US));
    expect(aimVariableValues('bob', at, { ...US, timeZone: '' })).toEqual(aimVariableValues('bob', at, US));
  });

  it('keeps each zone apart after an unknown one was asked for', () => {
    aimVariableValues('bob', at, { ...US, timeZone: 'Not/AZone' });
    expect(aimVariableValues('bob', at, { ...US, timeZone: 'Asia/Tokyo' }).time).toBe('12:30 PM');
    expect(aimVariableValues('bob', at, { ...US, timeZone: 'America/New_York' }).time).toBe('11:30 PM');
  });

  it('keeps only the formats used lately, however many spellings of a zone arrive', () => {
    const built = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      aimVariableValues('bob', at, { ...US, timeZone: 'Europe/Paris' });
      aimVariableValues('bob', at, { ...US, timeZone: 'America/New_York' });
      const spellings = Array.from({ length: 512 }, (_, bits) =>
        [...'asiatokyo'].map((letter, i) => (bits & (1 << i) ? letter.toUpperCase() : letter)).join('').replace(/^(.{4})/, '$1/'),
      );
      for (const [i, zone] of spellings.entries()) {
        expect(aimVariableValues('bob', at, { ...US, timeZone: zone }).time).toBe('12:30 PM');
        if (i % 16 === 0) aimVariableValues('bob', at, { ...US, timeZone: 'America/New_York' });
      }
      built.mockClear();
      expect(aimVariableValues('bob', at, { ...US, timeZone: 'America/New_York' }).time).toBe('11:30 PM');
      expect(built).not.toHaveBeenCalled();
      expect(aimVariableValues('bob', at, { ...US, timeZone: 'Europe/Paris' }).time).toBe('4:30 AM');
      expect(built).toHaveBeenCalledTimes(2);
    } finally {
      built.mockRestore();
    }
  });
});
