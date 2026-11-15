import { describe, expect, it } from 'vitest';
import { SKIPPED_SENDERS_MAX, SkipCounter, skippedSender } from '../../../src/client/skips.js';
import { ByteWriter } from '../../../src/wire/bytes.js';
import type { Snac } from '../../../src/wire/snac.js';
import { encodeUserInfo } from '../../../src/wire/snac.js';
import { encodeTlvs, tlv } from '../../../src/wire/tlv.js';

const snac = (family: number, subtype: number, body: Uint8Array): Snac => ({ family, subtype, flags: 0, requestId: 0, body });

const userInfo = (name: string): Uint8Array => encodeUserInfo({ name, warning: 0, tlvs: [tlv.u16(0x01, 0x0010)] });

// A message to client: cookie, channel 1, the sender's user info block, then no TLVs.
const imBody = (name: string): Uint8Array => new ByteWriter().u64(0x0102030405060708n).u16(1).bytes(userInfo(name)).bytes(encodeTlvs([])).toBytes();

// Typing and client error: cookie, channel, name, then a u16.
const namedBody = (name: string): Uint8Array => new ByteWriter().u64(0n).u16(1).str8(name).u16(2).toBytes();

describe('skippedSender', () => {
  it.each([
    ['a message to client', 4, 0x07, imBody('Bob')],
    ['a client error', 4, 0x0b, namedBody('Bob')],
    ['a typing event', 4, 0x14, namedBody('Bob')],
    ['an arrival', 3, 0x0b, userInfo('Bob')],
    ['a departure', 3, 0x0c, userInfo('Bob')],
    ['a user info reply', 2, 0x06, userInfo('Bob')],
  ] as [string, number, number, Uint8Array][])('reads the name from %s', (_what, family, subtype, body) => {
    expect(skippedSender(snac(family, subtype, body))).toBe('Bob');
  });

  it('reads nothing from a body cut short', () => {
    expect(skippedSender(snac(4, 0x07, Uint8Array.of(1, 2, 3)))).toBeNull();
    expect(skippedSender(snac(4, 0x14, Uint8Array.of(1, 2, 3)))).toBeNull();
    expect(skippedSender(snac(3, 0x0b, new Uint8Array(0)))).toBeNull();
    // The name's length runs past the end.
    expect(skippedSender(snac(4, 0x14, new ByteWriter().u64(0n).u16(1).u8(9).bytes(Uint8Array.of(66, 111, 98)).toBytes()))).toBeNull();
  });

  it('reads nothing from a SNAC that carries no sender', () => {
    expect(skippedSender(snac(4, 0x06, imBody('Bob')))).toBeNull();
    expect(skippedSender(snac(1, 0x0f, userInfo('Bob')))).toBeNull();
  });

  it('reads the name from an invitation that ends after it', () => {
    expect(skippedSender(snac(4, 0x07, new ByteWriter().u64(0n).u16(2).str8('Mallory').toBytes()))).toBe('Mallory');
  });
});

describe('SkipCounter', () => {
  it('counts per sender under the normalised name', () => {
    const counter = new SkipCounter();
    counter.add('Bob');
    counter.add('b O b');
    counter.add('Alice');
    expect([...counter.snapshot()]).toEqual([['bob', 2], ['alice', 1]]);
  });

  it('counts a sender it could not read under the empty name', () => {
    const counter = new SkipCounter();
    counter.add(null);
    counter.add(null);
    expect([...counter.snapshot()]).toEqual([['', 2]]);
  });

  it('keeps at most SKIPPED_SENDERS_MAX names and counts the rest together', () => {
    const counter = new SkipCounter();
    for (let i = 0; i <= SKIPPED_SENDERS_MAX; i++) counter.add(`sender${i}`);
    counter.add('sender0');
    const held = counter.snapshot();
    expect(SKIPPED_SENDERS_MAX).toBe(1_000);
    expect(held.size).toBe(1_001);
    expect([held.get('*'), held.get('sender0'), held.get(`sender${SKIPPED_SENDERS_MAX}`)]).toEqual([1, 2, undefined]);
  });

  it('counts a new name past the cap under * and an unknown sender under the empty name', () => {
    const counter = new SkipCounter();
    for (let i = 0; i < SKIPPED_SENDERS_MAX; i++) counter.add(`sender${i}`);
    counter.add('late');
    counter.add('later');
    counter.add(null);
    const held = counter.snapshot();
    expect([held.size, held.get('*'), held.get(''), held.get('late')]).toEqual([SKIPPED_SENDERS_MAX + 2, 2, 1, undefined]);
  });

  it('does not let a sender named * or empty take a place', () => {
    const counter = new SkipCounter();
    for (let i = 0; i < SKIPPED_SENDERS_MAX; i++) counter.add(`sender${i}`);
    counter.add('*');
    counter.add('  ');
    counter.add('late');
    const held = counter.snapshot();
    expect([held.size, held.get('*'), held.get('')]).toEqual([SKIPPED_SENDERS_MAX + 2, 2, 1]);
  });

  it('hands out a snapshot that later counts do not change', () => {
    const counter = new SkipCounter();
    counter.add('Bob');
    const before = counter.snapshot();
    counter.add('Bob');
    expect(before.get('bob')).toBe(1);
    expect(counter.snapshot().get('bob')).toBe(2);
  });
});
