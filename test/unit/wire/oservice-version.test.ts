import { describe, expect, it } from 'vitest';
import { ByteWriter, fromHex, toHex } from '../../../src/wire/bytes.js';
import { CAP_MOBILE_CLIENT } from '../../../src/wire/constants.js';
import { decodeHostVersions, encodeClientOnline, encodeClientVersions } from '../../../src/wire/oservice.js';
import { decodeRateParamsReply } from '../../../src/wire/rate.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

describe('OService version', () => {
  it('announces version 4 for OService only', () => {
    expect(toHex(encodeClientVersions([1, 2, 3, 4, 0x13], (f) => (f === 1 ? 4 : 1)))).toBe('0001000400020001000300010004000100130001');
    expect(toHex(encodeClientVersions([1, 2]))).toBe('0001000100020001');
    expect(toHex(encodeClientOnline([1], () => 4))).toBe('0001000401100629');
  });

  it('reads the host versions', () => {
    expect([...decodeHostVersions(fromHex('0001000400020001'))]).toEqual([
      [1, 4],
      [2, 1],
    ]);
  });

  it('defines CapMobileClient', () => {
    expect(toHex(CAP_MOBILE_CLIENT)).toBe('094613234c7f11d18222444553540000');
  });

  it('reads 35-byte rate records above version 1', () => {
    const body = new ByteWriter()
      .u16(1)
      .u16(1)
      .u32(80)
      .u32(2500)
      .u32(2000)
      .u32(1500)
      .u32(800)
      .u32(6000)
      .u32(6000)
      .u32(1_793_000_000)
      .u8(0)
      .u16(1)
      .u16(1)
      .u16(1)
      .u16(0x0e)
      .toBytes();
    const reply = decodeRateParamsReply(body, 4);
    expect(reply.classes).toEqual([
      { id: 1, windowSize: 80, clearLevel: 2500, alertLevel: 2000, limitLevel: 1500, disconnectLevel: 800, currentLevel: 6000, maxLevel: 6000 },
    ]);
    expect(reply.classOf(1, 0x0e)).toBe(1);
    expect(decodeRateParamsReply(bytesOf(loadVectors('oservice.json'), 'rate params reply body, default classes, OService 1')).classes).toHaveLength(5);
  });
});
