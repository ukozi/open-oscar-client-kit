import { describe, expect, it } from 'vitest';
import { AUTO_AWAY_CHOICES, DEFAULT_IDLE_SETTINGS, IDLE_REPORT_CHOICES, idleAfterSeconds, isIdleSettings, parseIdleSettings } from '../../../src/model/idle-settings.js';
import type { IdleSettings } from '../../../src/model/idle-settings.js';

const CHOSEN: IdleSettings = { reportAfterMinutes: 'never', autoAway: true, autoAwayAfterMinutes: 60, autoAwayMessage: 'brb' };

describe('the choices', () => {
  it('Report me idle after is 5, 10, 15 or 30 minutes or Never, and Set me away after 5, 10, 15, 30 or 60 minutes', () => {
    expect(IDLE_REPORT_CHOICES).toEqual([5, 10, 15, 30, 'never']);
    expect(AUTO_AWAY_CHOICES).toEqual([5, 10, 15, 30, 60]);
  });

  it('the defaults are 10 minutes, off, 15 minutes and the default text', () => {
    expect(DEFAULT_IDLE_SETTINGS).toEqual({ reportAfterMinutes: 10, autoAway: false, autoAwayAfterMinutes: 15, autoAwayMessage: null });
  });
});

describe('parseIdleSettings', () => {
  it('reads the defaults from nothing, from what is not an object and from an empty object', () => {
    for (const value of [undefined, null, 'x', {}]) expect(parseIdleSettings(value)).toEqual(DEFAULT_IDLE_SETTINGS);
  });

  it('keeps a valid value, and shares nothing with the defaults', () => {
    expect(parseIdleSettings({ ...CHOSEN })).toEqual(CHOSEN);
    expect(parseIdleSettings(undefined)).not.toBe(DEFAULT_IDLE_SETTINGS);
  });

  it('keeps each valid key and reads each invalid one as its default', () => {
    expect(parseIdleSettings({ reportAfterMinutes: 7 }).reportAfterMinutes).toBe(10);
    expect(parseIdleSettings({ reportAfterMinutes: null }).reportAfterMinutes).toBe(10);
    expect(parseIdleSettings({ reportAfterMinutes: 'never' }).reportAfterMinutes).toBe('never');
    expect(parseIdleSettings({ autoAwayAfterMinutes: 'x' }).autoAwayAfterMinutes).toBe(15);
    expect(parseIdleSettings({ autoAway: 'yes' }).autoAway).toBe(false);
    expect(parseIdleSettings({ autoAwayMessage: ' brb ' }).autoAwayMessage).toBeNull();
    expect(parseIdleSettings({ autoAwayMessage: '' }).autoAwayMessage).toBeNull();
    expect(parseIdleSettings({ reportAfterMinutes: 30 })).toEqual({ ...DEFAULT_IDLE_SETTINGS, reportAfterMinutes: 30 });
  });
});

describe('isIdleSettings', () => {
  it('accepts the defaults and a value with every key chosen', () => {
    expect(isIdleSettings(DEFAULT_IDLE_SETTINGS)).toBe(true);
    expect(isIdleSettings({ reportAfterMinutes: 'never', autoAway: true, autoAwayAfterMinutes: 60, autoAwayMessage: 'brb' })).toBe(true);
  });

  it.each<[string, unknown]>([
    ['7 minutes', { ...DEFAULT_IDLE_SETTINGS, reportAfterMinutes: 7 }],
    ['null minutes', { ...DEFAULT_IDLE_SETTINGS, reportAfterMinutes: null }],
    ['45 auto-away minutes', { ...DEFAULT_IDLE_SETTINGS, autoAwayAfterMinutes: 45 }],
    ['an auto-away that is not a boolean', { ...DEFAULT_IDLE_SETTINGS, autoAway: 'yes' }],
    ['a message with a space before it', { ...DEFAULT_IDLE_SETTINGS, autoAwayMessage: ' brb' }],
    ['an empty message', { ...DEFAULT_IDLE_SETTINGS, autoAwayMessage: '' }],
    ['a fifth key', { ...DEFAULT_IDLE_SETTINGS, extra: true }],
    ['a missing key', { reportAfterMinutes: 10, autoAway: false, autoAwayAfterMinutes: 15 }],
    ['what is not an object', 'x'],
    ['null', null],
  ])('refuses %s', (_case, value) => {
    expect(isIdleSettings(value)).toBe(false);
  });
});

describe('idleAfterSeconds', () => {
  it('is the minutes in seconds, and null under Never', () => {
    expect([5, 10, 15, 30].map((minutes) => idleAfterSeconds({ ...DEFAULT_IDLE_SETTINGS, reportAfterMinutes: minutes as 5 | 10 | 15 | 30 }))).toEqual([300, 600, 900, 1800]);
    expect(idleAfterSeconds({ ...DEFAULT_IDLE_SETTINGS, reportAfterMinutes: 'never' })).toBeNull();
  });
});
