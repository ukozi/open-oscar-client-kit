import { describe, expect, it } from 'vitest';
import { isPlainObject } from '../../../src/model/plain.js';
import { DEFAULT_IDLE_SETTINGS, isIdleSettings, parseIdleSettings } from '../../../src/model/idle-settings.js';

class Held {
  constructor(values: object) {
    Object.assign(this, values);
  }
}

describe('isPlainObject', () => {
  it('takes an object literal and one of no prototype, and nothing else', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const value of [null, undefined, 0, 'x', true, [], [1], new Date(0), new Map(), new Held({}), Object.create({})]) {
      expect(isPlainObject(value), String(value)).toBe(false);
    }
  });
});

describe('the validators read objects alike', () => {
  it('a value of a class of its own is no idle setting', () => {
    expect(isIdleSettings({ ...DEFAULT_IDLE_SETTINGS })).toBe(true);
    expect(isIdleSettings(new Held(DEFAULT_IDLE_SETTINGS))).toBe(false);
    expect(parseIdleSettings(new Held({ ...DEFAULT_IDLE_SETTINGS, autoAway: true }))).toEqual(DEFAULT_IDLE_SETTINGS);
  });
});
