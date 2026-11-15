import { describe, expect, it } from 'vitest';
import { OscarDecodeError, fromHex } from '../../../src/wire/bytes.js';
import { decodeNavInfo, encodeCreateRoom } from '../../../src/wire/chatnav.js';
import { RDV_FRAGMENT_MIN_BYTES } from '../../../src/wire/constants.js';
import {
  encodeChatInvite, encodeChatInviteCancel, encodeChatInviteFragment, parseInvite, parseInviteCancel,
} from '../../../src/wire/icbm.js';
import { decodeServiceResponse } from '../../../src/wire/oservice.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv } from '../../../src/wire/tlv.js';
import { toHex, vector, vectorHex } from './room-kit.js';
import { bytesOf, loadVectors, vector as named } from '../../support/vectors.js';

const v = loadVectors('hand-rooms.json');
const COOKIE = 0x0102030405060708n;
const ROOM = { exchange: 4, cookie: '4-0-Chimr Dev-Room' } as const;

const CREATE = 'create room body, exchange 4, name Chimr Dev-Room';
const NAV_INFO = 'nav info body, exchange 4, cookie 4-0-Chimr Dev-Room';
const INVITE = 'invitation to host, cookie 0102030405060708, to bob, room 4-0-Chimr Dev-Room';
const DECLINE_OUT = 'decline to host, cookie 0102030405060708, to Alice';
const DECLINE_IN = 'decline to client, cookie 0102030405060708, from Alice';

// cookie, channel 2 and Alice's user info: what precedes the TLVs of a 0x04/0x07 body
const HEAD_BYTES = 42;
const FRAGMENT_AT = HEAD_BYTES + 4;

function head(): Uint8Array {
  return vector('inviteSnac').subarray(0, HEAD_BYTES);
}

function toClient(fragment: Uint8Array): Uint8Array {
  return Uint8Array.from([...head(), ...encodeTlvs([tlv.bytes(0x0005, fragment)])]);
}

function declineFragment(): Uint8Array {
  return bytesOf(v, DECLINE_IN).slice(FRAGMENT_AT);
}

// the TLVs of a 0x04/0x06 body: after the cookie, the channel and the recipient
function tlvsToHost(body: Uint8Array) {
  return decodeTlvs(body.subarray(10 + 1 + (body[10] ?? 0)));
}

describe('room names on ChatNav', () => {
  it('sends the room name as given', () => {
    expect(toHex(encodeCreateRoom({ exchange: 4, name: 'Chimr Dev-Room' }))).toBe(named(v, CREATE).hex);
  });

  it("reads the room's name from its own TLV, with its capitals", () => {
    expect(decodeNavInfo(bytesOf(v, NAV_INFO))).toEqual({
      exchange: 4, cookie: '4-0-Chimr Dev-Room', name: 'Chimr Dev-Room', createdAt: 0x66000000, maxOccupancy: 100,
    });
  });

  it("falls back to the cookie's name, case kept, when the room carries no name TLV", () => {
    const hex = named(v, NAV_INFO).hex;
    const blockAt = hex.indexOf('0000020008') + 6;
    // the room up to its TLV count, the count set to 0, under an outer TLV 0x04 of the new length
    const room = fromHex(`${hex.slice(8, blockAt)}0000`);
    const body = encodeTlvs([tlv.bytes(0x0004, room)]);
    expect(decodeNavInfo(body)).toEqual({ exchange: 4, cookie: '4-0-Chimr Dev-Room', name: 'Chimr Dev-Room' });
  });
});

describe('room invitations', () => {
  it("the proposal fragment is the reference's byte for byte", () => {
    expect(toHex(encodeChatInviteFragment(COOKIE, { exchange: 4, cookie: '4-0-testroom' }, 'Join me in this chat.'))).toBe(
      vectorHex('inviteFragment'),
    );
  });

  it('the invitation is the cookie, channel 2, the recipient, the fragment and the acknowledgement request', () => {
    expect(toHex(encodeChatInvite(COOKIE, 'bob', ROOM, 'Join me in this room.'))).toBe(named(v, INVITE).hex);
  });

  it('an invitation reads back through parseInvite', () => {
    const body = toClient(encodeChatInviteFragment(0x1122334455667788n, ROOM, 'café <B>now</B>'));
    expect(parseInvite(body)).toMatchObject({
      room: { exchange: 4, name: 'chimr dev-room' },
      roomCookie: '4-0-Chimr Dev-Room',
      cookie: 0x1122334455667788n,
      html: 'caf&#233; <B>now</B>',
    });
  });

  it('the decline is a cancel of that cookie with the reason "declined"', () => {
    expect(toHex(encodeChatInviteCancel(COOKIE, 'Alice'))).toBe(named(v, DECLINE_OUT).hex);
  });

  it('reads a decline: who sent it and which invitation', () => {
    expect(parseInviteCancel(bytesOf(v, DECLINE_IN))).toEqual({ from: 'alice', fromDisplay: 'Alice', cookie: COOKIE });
  });

  it.each<[string, () => Uint8Array]>([
    ['a proposal', () => vector('inviteSnac')],
    ['another capability', () => toClient(declineFragment().fill(0x09, 10, 26))],
    ['a fragment of 25 bytes', () => toClient(declineFragment().subarray(0, 25))],
    ['a channel 1 message', () => {
      const body = bytesOf(v, DECLINE_IN).slice();
      body[9] = 0x01;
      return body;
    }],
    ['a body cut inside the user info', () => bytesOf(v, DECLINE_IN).subarray(0, 20)],
    ['no TLV 0x0005', () => bytesOf(v, DECLINE_IN).subarray(0, HEAD_BYTES)],
  ])('parseInviteCancel ignores %s', (_label, body) => {
    expect(parseInviteCancel(body())).toBeNull();
  });

  it('parseInvite ignores a decline', () => {
    expect(parseInvite(bytesOf(v, DECLINE_IN))).toBeNull();
  });

  it('both channel 2 bodies carry a TLV 0x05 of at least 26 bytes', () => {
    for (const body of [encodeChatInvite(COOKIE, 'bob', ROOM, ''), encodeChatInviteCancel(COOKIE, 'bob')]) {
      expect(findTlv(tlvsToHost(body), 0x0005)?.length).toBeGreaterThanOrEqual(RDV_FRAGMENT_MIN_BYTES);
    }
  });
});

describe('the service response', () => {
  it('reads where a service connection goes and the cookie to present', () => {
    const body = vector('serviceResponse');
    expect(decodeServiceResponse(body, 5190)).toEqual({
      host: '127.0.0.1',
      port: 5190,
      cookie: Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd),
      ssl: false,
    });
    const withoutAddress = encodeTlvs(decodeTlvs(body).filter((t) => t.tag !== 0x0005));
    expect(withoutAddress.length).toBe(body.length - 18);
    expect(() => decodeServiceResponse(withoutAddress, 5190)).toThrow(OscarDecodeError);
  });
});
