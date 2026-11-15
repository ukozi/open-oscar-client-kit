import { describe, expect, it } from 'vitest';
import { readUserInfoUpdate } from '../../../src/client/user-info.js';
import { OscarDecodeError, concatBytes } from '../../../src/wire/bytes.js';
import { CAP_CHAT, CAP_MOBILE_CLIENT, CAP_UTF8_MESSAGES } from '../../../src/wire/constants.js';
import { decodeUserInfo, encodeUserInfo } from '../../../src/wire/snac.js';
import { tlv } from '../../../src/wire/tlv.js';
import type { Tlv } from '../../../src/wire/tlv.js';
import { otherInstances } from '../../../src/model/instances.js';

const UTF8 = '0946134E-4C7F-11D1-8222-444553540000';
const CHAT = '748F2420-6287-11D1-8222-444553540000';

const block = (tlvs: Tlv[]): Uint8Array => encodeUserInfo({ name: 'Alice', warning: 0, tlvs });
const concat = (...blocks: Uint8Array[]): Uint8Array => concatBytes(blocks);
const withTlv = (bytes: Uint8Array, replacement: Tlv): Uint8Array => {
  const { info } = decodeUserInfo(bytes, 0);
  return encodeUserInfo({ ...info, tlvs: info.tlvs.map((t) => (t.tag === replacement.tag ? replacement : t)) });
};
const withInstance = (bytes: Uint8Array, instance: number): Uint8Array => withTlv(bytes, tlv.u8(0x14, instance));

const session = block([
  tlv.str(0x100a, '127.0.0.1'),
  tlv.u16(0x01, 0x0010),
  tlv.u32(0x06, 0),
  tlv.bytes(0x0d, concatBytes([CAP_UTF8_MESSAGES, CAP_CHAT, CAP_MOBILE_CLIENT])),
]);
const a = block([
  tlv.str(0x100a, '127.0.0.1'),
  tlv.u8(0x14, 1),
  tlv.bytes(0x0d, concatBytes([CAP_UTF8_MESSAGES, CAP_CHAT])),
  tlv.u16(0x01, 0x0030),
  tlv.u32(0x06, 0x0100),
  tlv.u16(0x04, 5),
  tlv.u32(0x03, 1_793_000_000),
]);
const b = block([
  tlv.str(0x100a, '127.0.0.1'),
  tlv.u8(0x14, 2),
  tlv.bytes(0x0d, concatBytes([CAP_UTF8_MESSAGES, CAP_CHAT, CAP_MOBILE_CLIENT])),
  tlv.u16(0x01, 0x0090),
  tlv.u32(0x06, 0),
  tlv.u32(0x03, 1_793_000_100),
]);

describe('readUserInfoUpdate', () => {
  it('reads each instance', () => {
    const snap = readUserInfoUpdate(concat(session, a, b), { at: 5, multiInstance: true, mobileAdvertised: true });
    expect(snap.instances[0]).toEqual({ instance: 1, flags: 0x30, status: 0x100, capabilities: [UTF8, CHAT], externalIp: '127.0.0.1',
      idleMinutes: 5, signedOnAt: 1_793_000_000_000, away: true, invisible: true, mobile: false });
    expect([snap.self?.instance, snap.selfMatches, otherInstances(snap)?.map((i) => i.instance)]).toEqual([2, 1, [1]]);
    expect([snap.at, snap.multiInstance, snap.session.instance, snap.session.capabilities?.length]).toEqual([5, true, null, 3]);
  });

  it('finds no self when two blocks match, or when the client is not mobile', () => {
    const two = readUserInfoUpdate(concat(session, b, withInstance(b, 3)), { at: 5, multiInstance: true, mobileAdvertised: true });
    expect([two.self, two.selfMatches, otherInstances(two)]).toEqual([null, 2, null]);
    const desk = readUserInfoUpdate(concat(session, a, b), { at: 5, multiInstance: true, mobileAdvertised: false });
    expect([desk.self, desk.selfMatches]).toEqual([null, 0]);
  });

  it('never takes a block from another address for self', () => {
    const elsewhere = withTlv(b, tlv.str(0x100a, '127.0.0.9'));
    const snap = readUserInfoUpdate(concat(session, a, elsewhere), { at: 5, multiInstance: true, mobileAdvertised: true });
    expect([snap.self, snap.selfMatches, snap.instances[1]?.externalIp]).toEqual([null, 0, '127.0.0.9']);
  });

  it('reads a version 1 reply as the session block alone', () => {
    const one = readUserInfoUpdate(session, { at: 5, multiInstance: false, mobileAdvertised: true });
    expect([one.multiInstance, one.instances, one.self, otherInstances(one)]).toEqual([false, [], null, null]);
  });

  it('refuses a capability list that is not whole UUIDs', () => {
    const torn = withTlv(b, tlv.bytes(0x0d, CAP_MOBILE_CLIENT.subarray(0, 15)));
    expect(() => readUserInfoUpdate(concat(session, torn), { at: 5, multiInstance: true, mobileAdvertised: true })).toThrow(OscarDecodeError);
  });
});
