import { describe, expect, it } from 'vitest';
import { PUBLIC_ROOM_NAME_MAX, checkTypedRoomName, isValidRoomName, parseRoomId, rosterSpelling, roomConversationId, roomKey, sameRoom } from '../../../src/model/room.js';

describe('room names', () => {
  it.each([
    ['chimr-lobby', true], ['Dev Room 2', true], ['a', true], ['x'.repeat(100), true], ['~!@#$%^&*()', true],
    ['', false], ['x'.repeat(101), false], [' lobby', false], ['lobby ', false], ['café', false], ['room\u{1F600}', false], ['tab\tname', false], ['line\nbreak', false],
  ])('%j is valid: %s', (name, valid) => {
    expect(isValidRoomName(name)).toBe(valid);
  });
});

describe('a typed room name', () => {
  it('stops a public room at 50 characters and a Buddy Chat at 100', () => {
    expect(PUBLIC_ROOM_NAME_MAX).toBe(50);
    expect(checkTypedRoomName('x'.repeat(50), 5)).toBeNull();
    expect(checkTypedRoomName('x'.repeat(51), 5)).toBe('too-long');
    expect(checkTypedRoomName('x'.repeat(100), 4)).toBeNull();
    expect(checkTypedRoomName('x'.repeat(101), 4)).toBe('too-long');
  });
  it('refuses what isValidRoomName refuses, on either exchange', () => {
    for (const name of ['', ' lobby', 'café']) for (const exchange of [4, 5] as const) expect(checkTypedRoomName(name, exchange)).not.toBeNull();
  });
  it('takes every printable ASCII character, on either exchange: none fails a join', () => {
    for (let code = 0x21; code <= 0x7e; code++) {
      const c = String.fromCharCode(code);
      for (const exchange of [4, 5] as const) {
        expect(checkTypedRoomName(c, exchange)).toBeNull();
        expect(checkTypedRoomName(`a${c}b`, exchange)).toBeNull();
      }
    }
    expect(checkTypedRoomName('a b', 5)).toBeNull();
  });
  it('says which problem a name has', () => {
    for (const exchange of [4, 5] as const) {
      expect(checkTypedRoomName('', exchange)).toBe('empty');
      expect(checkTypedRoomName('café', exchange)).toBe('characters');
      expect(checkTypedRoomName('room\u{1F600}', exchange)).toBe('characters');
      expect(checkTypedRoomName('tab\tname', exchange)).toBe('characters');
      expect(checkTypedRoomName(' lobby', exchange)).toBe('spaces');
      expect(checkTypedRoomName('lobby ', exchange)).toBe('spaces');
    }
  });
  it('leaves saved rooms to isValidRoomName: a long public room is still a valid name', () => {
    expect(isValidRoomName('x'.repeat(51))).toBe(true);
    expect(parseRoomId({ exchange: 5, name: 'x'.repeat(51) })).toEqual({ exchange: 5, name: 'x'.repeat(51) });
  });
});

describe('room identity', () => {
  it('is the exchange and the name without regard to ASCII case', () => {
    expect(sameRoom({ exchange: 4, name: 'Dev Room' }, { exchange: 4, name: 'dev room' })).toBe(true);
    expect(roomConversationId({ exchange: 4, name: 'Dev Room' })).toBe(roomConversationId({ exchange: 4, name: 'DEV ROOM' }));
  });
  it('keeps the same name on the two exchanges apart', () => {
    expect(sameRoom({ exchange: 4, name: 'lobby' }, { exchange: 5, name: 'lobby' })).toBe(false);
    expect(roomKey({ exchange: 4, name: 'lobby' })).not.toBe(roomKey({ exchange: 5, name: 'lobby' }));
  });
  it('keeps inner spaces: two names that differ only by a space are two rooms', () => {
    expect(sameRoom({ exchange: 4, name: 'dev room' }, { exchange: 4, name: 'devroom' })).toBe(false);
  });
  it('never collides with an IM conversation id', () => {
    expect(roomConversationId({ exchange: 4, name: 'im:bob' }).startsWith('im:')).toBe(false);
  });
});

describe('parseRoomId', () => {
  it('takes exchange 4 or 5 with a valid name and nothing else', () => {
    expect(parseRoomId({ exchange: 5, name: 'chimr-lobby' })).toEqual({ exchange: 5, name: 'chimr-lobby' });
    for (const value of [null, 'x', [], { exchange: 6, name: 'a' }, { exchange: '4', name: 'a' }, { exchange: 4, name: '' }, { exchange: 4, name: ' a' }, { exchange: 4 }]) {
      expect(parseRoomId(value)).toBeNull();
    }
  });
  it('returns an object of its own with only the two fields', () => {
    const given = { exchange: 4, name: 'a', extra: 1 };
    const parsed = parseRoomId(given);
    expect(parsed).toEqual({ exchange: 4, name: 'a' });
    expect(parsed).not.toBe(given);
  });
});

describe('rosterSpelling', () => {
  const occupants = ['Alice', 'Bo B', 'carol'];
  it('gives how the roster spells the name, whatever the spelling given', () => {
    expect(rosterSpelling(occupants, 'bob')).toBe('Bo B');
    expect(rosterSpelling(occupants, 'CAROL')).toBe('carol');
  });
  it('gives undefined when nobody in the room is them', () => {
    expect(rosterSpelling(occupants, 'dave')).toBeUndefined();
    expect(rosterSpelling([], 'alice')).toBeUndefined();
  });
});
