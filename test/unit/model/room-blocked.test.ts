import { describe, expect, it } from 'vitest';
import { roomLineBlocked } from '../../../src/model/knock.js';
import type { Privacy } from '../../../src/model/privacy.js';

const privacy = (over: Partial<Privacy> = {}): Privacy => ({ mode: 'block-list', allow: [], block: ['mallory'], ...over });

describe('roomLineBlocked', () => {
  it('is true for a sender on the Block list, whatever the case or spacing of the name', () => {
    expect(roomLineBlocked(privacy(), 'Mallory')).toBe(true);
    expect(roomLineBlocked(privacy(), 'MAL lory')).toBe(true);
  });

  it('is false for a sender who is not on it', () => {
    expect(roomLineBlocked(privacy(), 'Bob')).toBe(false);
  });

  it('does not take a stranger for blocked under "Block everyone" or "Allow only my buddies"', () => {
    expect(roomLineBlocked({ mode: 'block-all', allow: [], block: [] }, 'Bob')).toBe(false);
    expect(roomLineBlocked({ mode: 'allow-buddies', allow: [], block: [] }, 'Bob')).toBe(false);
    expect(roomLineBlocked({ mode: 'allow-list', allow: ['alice'], block: [] }, 'Bob')).toBe(false);
  });

  it('reads the deny items whatever the mode', () => {
    expect(roomLineBlocked(privacy({ mode: 'allow-all' }), 'Mallory')).toBe(true);
    expect(roomLineBlocked(privacy({ mode: 'block-all' }), 'Mallory')).toBe(true);
  });
});
