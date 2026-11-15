import { describe, expect, it } from 'vitest';
import { decodePresence } from '../../../src/wire/buddy.js';
import { tlv } from '../../../src/wire/tlv.js';

describe('decodePresence mobile', () => {
  it('reads the wireless flag', () => {
    expect(decodePresence({ name: 'bob', warning: 0, tlvs: [tlv.u16(1, 0x0090)] })).toEqual({ away: false, warnLevel: 0, mobile: true });
  });

  it('leaves the key out without the flag', () => {
    const result = decodePresence({ name: 'bob', warning: 0, tlvs: [tlv.u16(1, 0x0010)] });
    expect('mobile' in result).toBe(false);
  });

  it('reads the wireless flag beside away', () => {
    expect(decodePresence({ name: 'bob', warning: 0, tlvs: [tlv.u16(1, 0x00b0)] })).toEqual({ away: true, warnLevel: 0, mobile: true });
  });
});
