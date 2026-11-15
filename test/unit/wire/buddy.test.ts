import { describe, expect, it } from 'vitest';
import { decodePresence } from '../../../src/wire/buddy.js';
import { concatBytes } from '../../../src/wire/bytes.js';
import { CAP_CHAT, CAP_SEND_FILE, CAP_UTF8_MESSAGES, USER_INFO_CAPABILITIES } from '../../../src/wire/constants.js';
import { capabilityUuid } from '../../../src/wire/oservice.js';
import { tlv } from '../../../src/wire/tlv.js';
import type { Tlv } from '../../../src/wire/tlv.js';
import { SEND_FILE_CAPABILITY } from '../../../src/model/buddy-list.js';

const FLAGS = tlv.u16(1, 0x0010);
const presenceOf = (...tlvs: Tlv[]) => decodePresence({ name: 'bob', warning: 0, tlvs: [FLAGS, ...tlvs] });

describe('decodePresence capabilities', () => {
  it('gives undefined capabilities when tag 0x0D is absent, and [] never', () => {
    const absent = presenceOf();
    expect(absent.capabilities).toBeUndefined();
    expect('capabilities' in absent).toBe(false);
    const empty = presenceOf(tlv.bytes(USER_INFO_CAPABILITIES, new Uint8Array(0)));
    expect(empty.capabilities).toBeUndefined();
    expect('capabilities' in empty).toBe(false);
  });

  it('lists each capability of tag 0x0D as an uppercase id with dashes, in order', () => {
    const caps = [CAP_UTF8_MESSAGES, CAP_CHAT, CAP_SEND_FILE];
    const { capabilities } = presenceOf(tlv.bytes(USER_INFO_CAPABILITIES, concatBytes(caps)));
    expect(capabilities).toEqual(caps.map(capabilityUuid));
    expect(capabilities?.at(-1)).toBe(SEND_FILE_CAPABILITY);
  });

  it('ignores the bytes after the last whole capability', () => {
    const torn = concatBytes([CAP_SEND_FILE, CAP_CHAT.subarray(0, 15)]);
    expect(presenceOf(tlv.bytes(USER_INFO_CAPABILITIES, torn)).capabilities).toEqual([SEND_FILE_CAPABILITY]);
    expect(presenceOf(tlv.bytes(USER_INFO_CAPABILITIES, CAP_CHAT.subarray(0, 15))).capabilities).toBeUndefined();
  });
});
