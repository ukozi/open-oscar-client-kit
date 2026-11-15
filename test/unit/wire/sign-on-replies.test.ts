import { describe, expect, it } from 'vitest';
import { decodePresence } from '../../../src/wire/buddy.js';
import { decodeHostAck, decodeIcbmError, decodeIcbmParams } from '../../../src/wire/icbm.js';
import { decodeLocateRights } from '../../../src/wire/locate.js';
import { decodeHostOnline } from '../../../src/wire/oservice.js';
import { decodeUserInfo } from '../../../src/wire/snac.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const v = loadVectors('hand-session.json');
const oservice = loadVectors('oservice.json');
const icbm = loadVectors('icbm.json');
const snac = loadVectors('snac.json');

describe('replies read during sign-on', () => {
  it('host online lists the food groups', () => {
    expect(decodeHostOnline(bytesOf(oservice, 'host online body for BOS'))).toEqual([0x18, 0x10, 0x03, 0x13, 0x04, 0x15, 0x02, 0x01, 0x09, 0x0a, 0x06, 0x08, 0x0b]);
  });
  it('locate rights give the signature limit, or nothing', () => {
    expect(decodeLocateRights(bytesOf(v, 'locate rights reply body'))).toEqual({ maxSignatureLength: 1000 });
    expect(decodeLocateRights(new Uint8Array(0))).toEqual({});
  });
  it('icbm parameters give the advertised message length', () => {
    expect(decodeIcbmParams(bytesOf(v, 'icbm parameter reply body'))).toEqual({ maxSlots: 100, flags: 3, maxIncomingLength: 512, maxSourceEvil: 999, maxDestinationEvil: 999, minInterval: 0 });
  });
});

describe('IM replies', () => {
  it('host ack', () => {
    expect(decodeHostAck(bytesOf(icbm, 'host ack body'))).toEqual({ cookie: 0x1122334455667788n, channel: 1, screenName: 'alice' });
  });
  it('errors, with and without a subcode', () => {
    expect(decodeIcbmError(bytesOf(v, 'icbm error body, sender blocks recipient'))).toEqual({ code: 0x0010 });
    expect(decodeIcbmError(bytesOf(snac, 'error body, code 4'))).toEqual({ code: 4 });
    expect(decodeIcbmError(bytesOf(snac, 'error body, code 4 with subcode 0x000F'))).toEqual({ code: 4, subcode: 0x000f });
  });
});

describe('presence fields of a user info block', () => {
  const fields = (name: string) => decodePresence(decodeUserInfo(bytesOf(v, name), 0).info);
  it('away, idle, signed-on time and warn level', () => {
    expect(fields('buddy arrived body, away and idle')).toEqual({ away: true, signedOnAt: 1790000000, idleMinutes: 12, warnLevel: 100 });
  });
  it('an arrival with no idle value has none', () => {
    expect(fields('buddy arrived body, plain')).toEqual({ away: false, signedOnAt: 1790000000, warnLevel: 0 });
  });
  it('a departure carries only the name', () => {
    expect(fields('buddy departed body, display name')).toEqual({ away: false, warnLevel: 0 });
  });
});
