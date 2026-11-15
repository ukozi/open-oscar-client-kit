import { describe, expect, it } from 'vitest';
import { OscarDecodeError } from '../../../src/wire/bytes.js';
import {
  CAP_CHAT, CAP_DIRECT_IM, CAP_GET_FILE, CAP_SEND_FILE, ICBM_CLIENT_ERR, MAX_OFFER_BYTES, RDV_CANCEL_DECLINED, RDV_CANCEL_ELSEWHERE,
  RDV_CANCEL_TIMEOUT, RDV_TLV_PORT, RDV_TLV_RDV_IP, RDV_TLV_REQUESTER_IP, RDV_TLV_USE_PROXY, RDV_TLV_VERIFIED_IP, RDV_TYPE_ACCEPT,
} from '../../../src/wire/constants.js';
import { DIRECT_IM_CAPABILITY, GET_FILE_CAPABILITY } from '../../../src/model/buddy-list.js';
import { encodeChatInvite, parseInvite } from '../../../src/wire/icbm.js';
import {
  capabilityOf, decodeClientError, encodeDirectImProposal, encodeFileProposal, encodeGetFileProposal, encodeRendezvousAccept, encodeRendezvousCancel, parseRendezvous, serviceOf,
} from '../../../src/wire/rendezvous.js';
import type { FileDescription, RendezvousService } from '../../../src/wire/rendezvous.js';
import { capabilityUuid } from '../../../src/wire/oservice.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv } from '../../../src/wire/tlv.js';
import type { Tlv } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors, vector as named } from '../../support/vectors.js';
import { toHex, vector as roomVector } from './room-kit.js';

const v = loadVectors('hand-rendezvous.json');
const rooms = loadVectors('hand-rooms.json');
const COOKIE = 0x0102030405060708n;

const PROPOSAL = 'send-file proposal, relay address';
const COUNTER = 'send-file counter-offer, sequence 2';
const ACCEPT_IN = 'send-file accept to client';
const CANCEL_IN = 'send-file cancel to client, reason 1';
const PROPOSAL_OUT = 'send-file proposal to host, to bob, one file';
const ACCEPT_OUT = 'send-file accept to host, to Alice';
const CANCEL_OUT = 'send-file cancel to host, to Alice, reason 1';
const CLIENT_ERROR = 'client error body, channel 2, from Alice, code 1';
const DIRECT_IM_OLDER = 'direct-im proposal, 5.1 shape';
const DIRECT_IM_LATER = 'direct-im proposal, 5.9 shape';
const DIRECT_IM_OUT = 'direct-im proposal to host, to bob';
const GET_FILE_OLDER = 'get-file proposal, 5.1 shape';
const GET_FILE_LATER = 'get-file proposal, 5.9 shape';
const GET_FILE_OUT = 'get-file proposal to host, to bob';

// The cookie, channel 2 and the user info of Alice come before the TLVs.
const HEAD_BYTES = 42;
const FRAGMENT_HEAD_BYTES = 26;

function toClient(fragment: Uint8Array): Uint8Array {
  return Uint8Array.from([...bytesOf(v, PROPOSAL).subarray(0, HEAD_BYTES), ...encodeTlvs([tlv.bytes(0x0005, fragment)])]);
}

function fragmentOf(name: string): Uint8Array {
  return bytesOf(v, name).slice(HEAD_BYTES + 4);
}

function proposalWith(inner: readonly Tlv[]): Uint8Array {
  return toClient(Uint8Array.from([...fragmentOf(PROPOSAL).subarray(0, FRAGMENT_HEAD_BYTES), ...encodeTlvs(inner)]));
}

// The TLVs of a message to the host come after the cookie, the channel and the recipient.
function tlvsToHost(body: Uint8Array): Tlv[] {
  return decodeTlvs(body.subarray(10 + 1 + (body[10] ?? 0)));
}

function fragmentToHost(body: Uint8Array): Uint8Array {
  const fragment = findTlv(tlvsToHost(body), 0x0005);
  if (!fragment) throw new Error('no fragment');
  return fragment;
}

const ip = (a: number, b: number, c: number, d: number): Uint8Array => Uint8Array.of(a, b, c, d);
const ONE_FILE: FileDescription = { multiple: false, count: 1, totalBytes: 90112, name: 'budget.xls' };

describe('the constants of file services', () => {
  it('names the capabilities, the accept type, the cancel reasons and the size limit', () => {
    expect(toHex(CAP_SEND_FILE)).toBe('094613434c7f11d18222444553540000');
    expect(toHex(CAP_DIRECT_IM)).toBe('094613454c7f11d18222444553540000');
    expect(toHex(CAP_GET_FILE)).toBe('094613484c7f11d18222444553540000');
    expect([RDV_TYPE_ACCEPT, RDV_CANCEL_TIMEOUT, RDV_CANCEL_ELSEWHERE, ICBM_CLIENT_ERR]).toEqual([2, 2, 3, 0x000b]);
    expect(MAX_OFFER_BYTES).toBe(4294967295);
  });

  it('maps each capability to its service and back', () => {
    const pairs: [RendezvousService, Uint8Array][] = [['send-file', CAP_SEND_FILE], ['direct-im', CAP_DIRECT_IM], ['get-file', CAP_GET_FILE]];
    for (const [service, capability] of pairs) {
      expect(serviceOf(capability)).toBe(service);
      expect(capabilityOf(service)).toEqual(capability);
    }
    expect(serviceOf(CAP_CHAT)).toBeNull();
    expect(serviceOf(CAP_SEND_FILE.subarray(0, 15))).toBeNull();
  });
});

describe('parseRendezvous', () => {
  it('reads a file proposal the relay rewrote', () => {
    const m = parseRendezvous(bytesOf(v, PROPOSAL));
    expect(m).toMatchObject({ service: 'send-file', type: 'propose', sequence: 1, useProxy: false,
      address: { ip: '203.0.113.7', port: 5190 }, file: { multiple: false, count: 1, totalBytes: 90112, name: 'budget.xls' } });
    expect(m).toMatchObject({ from: 'alice', fromDisplay: 'Alice', cookie: COOKIE, cancelReason: null, invitation: null });
  });

  it('prefers the verified address, then the requester address, then the rendezvous address', () => {
    const rdv = tlv.bytes(RDV_TLV_RDV_IP, ip(192, 0, 2, 1));
    const requester = tlv.bytes(RDV_TLV_REQUESTER_IP, ip(192, 0, 2, 2));
    const verified = tlv.bytes(RDV_TLV_VERIFIED_IP, ip(192, 0, 2, 3));
    const port = tlv.u16(RDV_TLV_PORT, 4443);
    expect(parseRendezvous(proposalWith([rdv, requester, verified, port]))?.address).toEqual({ ip: '192.0.2.3', port: 4443 });
    expect(parseRendezvous(proposalWith([rdv, requester, port]))?.address).toEqual({ ip: '192.0.2.2', port: 4443 });
    expect(parseRendezvous(proposalWith([rdv, port]))?.address).toEqual({ ip: '192.0.2.1', port: 4443 });
  });

  it('gives no address for 0.0.0.0, for port 0, for a missing port and for a short address', () => {
    const rdv = tlv.bytes(RDV_TLV_RDV_IP, ip(192, 0, 2, 1));
    const port = tlv.u16(RDV_TLV_PORT, 4443);
    expect(parseRendezvous(proposalWith([tlv.bytes(RDV_TLV_RDV_IP, ip(0, 0, 0, 0)), port]))?.address).toBeNull();
    expect(parseRendezvous(proposalWith([rdv, tlv.u16(RDV_TLV_PORT, 0)]))?.address).toBeNull();
    expect(parseRendezvous(proposalWith([rdv]))?.address).toBeNull();
    expect(parseRendezvous(proposalWith([tlv.bytes(RDV_TLV_RDV_IP, Uint8Array.of(192, 0, 2)), port]))?.address).toBeNull();
    expect(parseRendezvous(proposalWith([port]))?.address).toBeNull();
  });

  it('does not fall back to a lower address when the verified address is 0.0.0.0', () => {
    const inner = [tlv.bytes(RDV_TLV_RDV_IP, ip(192, 0, 2, 1)), tlv.bytes(RDV_TLV_VERIFIED_IP, ip(0, 0, 0, 0)), tlv.u16(RDV_TLV_PORT, 4443)];
    expect(parseRendezvous(proposalWith(inner))?.address).toBeNull();
  });

  it('reads a counter-offer: sequence 2, an address, no file block', () => {
    expect(parseRendezvous(bytesOf(v, COUNTER))).toMatchObject({
      service: 'send-file', type: 'propose', sequence: 2, address: { ip: '198.51.100.9', port: 4443 }, file: null, cookie: COOKIE,
    });
  });

  it('reads accept and cancel with its reason', () => {
    expect(parseRendezvous(bytesOf(v, ACCEPT_IN))).toEqual({
      from: 'alice', fromDisplay: 'Alice', cookie: COOKIE, service: 'send-file', type: 'accept',
      sequence: null, address: null, useProxy: false, cancelReason: null, file: null, invitation: null,
    });
    expect(parseRendezvous(bytesOf(v, CANCEL_IN))).toMatchObject({ type: 'cancel', cancelReason: RDV_CANCEL_DECLINED, cookie: COOKIE });
    const timedOut = Uint8Array.from([...fragmentOf(CANCEL_IN).subarray(0, FRAGMENT_HEAD_BYTES), ...encodeTlvs([tlv.u16(0x000b, RDV_CANCEL_TIMEOUT)])]);
    expect(parseRendezvous(toClient(timedOut))).toMatchObject({ type: 'cancel', cancelReason: RDV_CANCEL_TIMEOUT });
    expect(parseRendezvous(toClient(fragmentOf(CANCEL_IN).subarray(0, FRAGMENT_HEAD_BYTES)))).toMatchObject({ type: 'cancel', cancelReason: null });
  });

  it('reads the proxy flag and the invitation text', () => {
    const m = parseRendezvous(proposalWith([tlv.u16(0x000a, 1), tlv.empty(RDV_TLV_USE_PROXY), tlv.str(0x000c, 'the <B>budget</B>')]));
    expect(m).toMatchObject({ useProxy: true, invitation: 'the <B>budget</B>', address: null, file: null });
  });

  it('reads the other two services', () => {
    for (const capability of [CAP_DIRECT_IM, CAP_GET_FILE]) {
      const fragment = fragmentOf(ACCEPT_IN);
      fragment.set(capability, 10);
      expect(parseRendezvous(toClient(fragment))?.service).toBe(serviceOf(capability));
    }
  });

  // Hand vectors: the tags are the ones each client version writes, and the bytes are not a capture.
  it('reads a 5.1-shaped proposal (tags 000a 000f 0003 0005) and a 5.9-shaped one (0002 0016 0003 0005 0017)', () => {
    const tagsOf = (name: string): number[] => decodeTlvs(fragmentOf(name).subarray(FRAGMENT_HEAD_BYTES)).map((one) => one.tag);
    expect(tagsOf(DIRECT_IM_OLDER)).toEqual([0x000a, 0x000f, 0x0003, 0x0005]);
    expect(tagsOf(DIRECT_IM_LATER)).toEqual([0x000a, 0x000f, 0x0002, 0x0016, 0x0003, 0x0005, 0x0017]);
    for (const name of [DIRECT_IM_OLDER, DIRECT_IM_LATER]) {
      expect(named(v, name).note).toMatch(/^Hand-assembled/);
      expect(parseRendezvous(bytesOf(v, name))).toEqual({
        from: 'alice', fromDisplay: 'Alice', cookie: COOKIE, service: 'direct-im', type: 'propose', sequence: 1,
        address: { ip: '203.0.113.7', port: 5190 }, useProxy: false, cancelReason: null, file: null, invitation: null,
      });
    }
  });

  // Hand vectors of an assumed layout: the tags of a Direct IM proposal and no file block.
  it('reads a 5.1-shaped Get File proposal (tags 000a 000f 0003 0005) and a 5.9-shaped one (0002 0016 0003 0005 0017)', () => {
    const tagsOf = (name: string): number[] => decodeTlvs(fragmentOf(name).subarray(FRAGMENT_HEAD_BYTES)).map((one) => one.tag);
    expect(tagsOf(GET_FILE_OLDER)).toEqual([0x000a, 0x000f, 0x0003, 0x0005]);
    expect(tagsOf(GET_FILE_LATER)).toEqual([0x000a, 0x000f, 0x0002, 0x0016, 0x0003, 0x0005, 0x0017]);
    for (const name of [GET_FILE_OLDER, GET_FILE_LATER]) {
      expect(named(v, name).note).toContain('assembled from the assumed layout');
      expect(parseRendezvous(bytesOf(v, name))).toEqual({
        from: 'alice', fromDisplay: 'Alice', cookie: COOKIE, service: 'get-file', type: 'propose', sequence: 1,
        address: { ip: '203.0.113.7', port: 5190 }, useProxy: false, cancelReason: null, file: null, invitation: null,
      });
    }
  });

  it('returns null for a chat invitation, an unknown capability and a 25-byte fragment', () => {
    expect(parseRendezvous(roomVector('inviteSnac'))).toBeNull();
    expect(parseRendezvous(toClient(fragmentOf(ACCEPT_IN).fill(0x77, 10, 26)))).toBeNull();
    expect(parseRendezvous(toClient(fragmentOf(ACCEPT_IN).subarray(0, 25)))).toBeNull();
  });

  it('returns null for an unknown type, another channel, a cut body and a body with no fragment', () => {
    const odd = fragmentOf(ACCEPT_IN);
    odd[1] = 0x09;
    expect(parseRendezvous(toClient(odd))).toBeNull();
    const channel1 = bytesOf(v, ACCEPT_IN).slice();
    channel1[9] = 0x01;
    expect(parseRendezvous(channel1)).toBeNull();
    expect(parseRendezvous(bytesOf(v, ACCEPT_IN).subarray(0, 20))).toBeNull();
    expect(parseRendezvous(bytesOf(v, ACCEPT_IN).subarray(0, HEAD_BYTES))).toBeNull();
    expect(parseRendezvous(new Uint8Array(0))).toBeNull();
  });

  it('reads a file block that is cut or has no end byte without an error', () => {
    const noEnd = Uint8Array.from([0, 1, 0, 1, 0, 0, 0, 5, ...Buffer.from('a.txt')]);
    expect(parseRendezvous(proposalWith([tlv.bytes(0x2711, noEnd)]))?.file).toEqual({ multiple: false, count: 1, totalBytes: 5, name: 'a.txt' });
    expect(parseRendezvous(proposalWith([tlv.bytes(0x2711, noEnd.subarray(0, 7))]))?.file).toBeNull();
    const latin1 = Uint8Array.from([0, 1, 0, 1, 0, 0, 0, 5, 0x63, 0x61, 0x66, 0xe9, 0]);
    expect(parseRendezvous(proposalWith([tlv.bytes(0x2711, latin1)]))?.file?.name).toBe('café');
  });
});

describe('the builders of file services', () => {
  it('encodeFileProposal writes the hand vector byte for byte', () => {
    const body = encodeFileProposal(COOKIE, 'bob', { sequence: 1, address: { ip: '203.0.113.7', port: 5190 }, file: ONE_FILE });
    expect(toHex(body)).toBe(named(v, PROPOSAL_OUT).hex);
  });

  it('round-trips encodeFileProposal for one file and for three files of 3 GB in total', () => {
    const address = { ip: '203.0.113.7', port: 5190 };
    const three: FileDescription = { multiple: true, count: 3, totalBytes: 3 * 1024 ** 3, name: 'holiday' };
    for (const [sequence, file] of [[1, ONE_FILE], [2, three]] as const) {
      const body = encodeFileProposal(0x1122334455667788n, 'bob', { sequence, address, file, invitation: 'for you' });
      expect(parseRendezvous(toClient(fragmentToHost(body)))).toEqual({
        from: 'alice', fromDisplay: 'Alice', cookie: 0x1122334455667788n, service: 'send-file', type: 'propose',
        sequence, address, useProxy: false, cancelReason: null, file, invitation: 'for you',
      });
    }
  });

  it('a proposal carries an empty tag 0x0F in the fragment and an empty tag 0x03 beside it', () => {
    const body = encodeFileProposal(COOKIE, 'bob', { sequence: 1, address: { ip: '203.0.113.7', port: 5190 }, file: ONE_FILE });
    expect(findTlv(tlvsToHost(body), 0x0003)).toEqual(new Uint8Array(0));
    expect(findTlv(decodeTlvs(fragmentToHost(body).subarray(FRAGMENT_HEAD_BYTES)), 0x000f)).toEqual(new Uint8Array(0));
  });

  it('encodeFileProposal refuses a total over the limit, a count of 0 and an address that is not IPv4', () => {
    const address = { ip: '203.0.113.7', port: 5190 };
    const build = (file: FileDescription, at = address) => () => encodeFileProposal(COOKIE, 'bob', { sequence: 1, address: at, file });
    expect(build({ ...ONE_FILE, totalBytes: MAX_OFFER_BYTES })).not.toThrow();
    expect(build({ ...ONE_FILE, totalBytes: MAX_OFFER_BYTES + 1 })).toThrow(RangeError);
    expect(build({ ...ONE_FILE, totalBytes: -1 })).toThrow(RangeError);
    expect(build({ ...ONE_FILE, count: 0 })).toThrow(RangeError);
    expect(build(ONE_FILE, { ip: '::1', port: 5190 })).toThrow(RangeError);
    expect(build(ONE_FILE, { ip: '203.0.113.256', port: 5190 })).toThrow(RangeError);
    expect(build(ONE_FILE, { ip: '203.0.113.7', port: 65536 })).toThrow(RangeError);
  });

  it('encodeDirectImProposal parses back: service direct-im, sequence 1, address 203.0.113.7:5190, file null', () => {
    const address = { ip: '203.0.113.7', port: 5190 };
    const body = encodeDirectImProposal(0x1122334455667788n, 'bob', { sequence: 1, address });
    expect(parseRendezvous(toClient(fragmentToHost(body)))).toEqual({
      from: 'alice', fromDisplay: 'Alice', cookie: 0x1122334455667788n, service: 'direct-im', type: 'propose',
      sequence: 1, address, useProxy: false, cancelReason: null, file: null, invitation: null,
    });
    const counter = encodeDirectImProposal(COOKIE, 'bob', { sequence: 2, address: { ip: '198.51.100.9', port: 4443 } });
    expect(parseRendezvous(toClient(fragmentToHost(counter)))).toMatchObject({ sequence: 2, address: { ip: '198.51.100.9', port: 4443 }, file: null });
  });

  it('the proposal carries no tag 0x2711 and its capability is 09461345-4C7F-11D1-8222-444553540000', () => {
    const body = encodeDirectImProposal(COOKIE, 'bob', { sequence: 1, address: { ip: '203.0.113.7', port: 5190 } });
    const fragment = fragmentToHost(body);
    const inner = decodeTlvs(fragment.subarray(FRAGMENT_HEAD_BYTES));
    expect(inner.map((one) => one.tag)).toEqual([0x000a, 0x000f, 0x0002, 0x0016, 0x0003, 0x0005, 0x0017]);
    expect(findTlv(inner, 0x2711)).toBeUndefined();
    expect(capabilityUuid(fragment.subarray(10, 26))).toBe(DIRECT_IM_CAPABILITY);
    expect(DIRECT_IM_CAPABILITY).toBe('09461345-4C7F-11D1-8222-444553540000');
    expect(toHex(fragment.subarray(0, 10))).toBe('00000102030405060708');
    expect(findTlv(inner, 0x000f)).toEqual(new Uint8Array(0));
    expect(findTlv(tlvsToHost(body), 0x0003)).toEqual(new Uint8Array(0));
  });

  it('encodeDirectImProposal writes the hand vector byte for byte', () => {
    const body = encodeDirectImProposal(COOKIE, 'bob', { sequence: 1, address: { ip: '203.0.113.7', port: 5190 } });
    expect(toHex(body)).toBe(named(v, DIRECT_IM_OUT).hex);
  });

  it('encodeDirectImProposal refuses an address that is not IPv4 and a port out of range', () => {
    const build = (address: { ip: string; port: number }) => () => encodeDirectImProposal(COOKIE, 'bob', { sequence: 1, address });
    expect(build({ ip: '0.0.0.0', port: 5190 })).not.toThrow();
    expect(build({ ip: '::1', port: 5190 })).toThrow(RangeError);
    expect(build({ ip: '203.0.113.256', port: 5190 })).toThrow(RangeError);
    expect(build({ ip: '203.0.113.7', port: 65536 })).toThrow(RangeError);
  });

  it('encodeGetFileProposal parses back: service get-file, sequence 1, address 203.0.113.7:5190, and the block of tag 0x2711', () => {
    const address = { ip: '203.0.113.7', port: 5190 };
    const body = encodeGetFileProposal(0x1122334455667788n, 'bob', { sequence: 1, address });
    expect(parseRendezvous(toClient(fragmentToHost(body)))).toEqual({
      from: 'alice', fromDisplay: 'Alice', cookie: 0x1122334455667788n, service: 'get-file', type: 'propose',
      sequence: 1, address, useProxy: false, cancelReason: null, file: { multiple: false, count: 1, totalBytes: 0, name: '' }, invitation: null,
    });
    const counter = encodeGetFileProposal(COOKIE, 'bob', { sequence: 2, address: { ip: '198.51.100.9', port: 4443 } });
    expect(parseRendezvous(toClient(fragmentToHost(counter)))).toMatchObject({ sequence: 2, address: { ip: '198.51.100.9', port: 4443 } });
  });

  it('the proposal carries tag 0x2711 last, and its capability is 09461348-4C7F-11D1-8222-444553540000', () => {
    const body = encodeGetFileProposal(COOKIE, 'bob', { sequence: 1, address: { ip: '203.0.113.7', port: 5190 } });
    const fragment = fragmentToHost(body);
    const inner = decodeTlvs(fragment.subarray(FRAGMENT_HEAD_BYTES));
    expect(inner.map((one) => one.tag)).toEqual([0x000a, 0x000f, 0x0002, 0x0016, 0x0003, 0x0005, 0x0017, 0x2711]);
    expect(toHex(findTlv(inner, 0x2711) ?? new Uint8Array(0))).toBe('001200010000000000000000');
    expect(capabilityUuid(fragment.subarray(10, 26))).toBe(GET_FILE_CAPABILITY);
    expect(GET_FILE_CAPABILITY).toBe('09461348-4C7F-11D1-8222-444553540000');
    expect(toHex(fragment.subarray(0, 10))).toBe('00000102030405060708');
    expect(findTlv(inner, 0x000f)).toEqual(new Uint8Array(0));
    expect(findTlv(tlvsToHost(body), 0x0003)).toEqual(new Uint8Array(0));
  });

  it('encodeGetFileProposal writes the hand vector byte for byte', () => {
    const body = encodeGetFileProposal(COOKIE, 'bob', { sequence: 1, address: { ip: '203.0.113.7', port: 5190 } });
    expect(toHex(body)).toBe(named(v, GET_FILE_OUT).hex);
    expect(named(v, GET_FILE_OUT).note).toContain('tag 0x2711 as AIM 5.1 writes it');
  });

  it('encodeGetFileProposal refuses an address that is not IPv4 and a port out of range', () => {
    const build = (address: { ip: string; port: number }) => () => encodeGetFileProposal(COOKIE, 'bob', { sequence: 1, address });
    expect(build({ ip: '0.0.0.0', port: 5190 })).not.toThrow();
    expect(build({ ip: '::1', port: 5190 })).toThrow(RangeError);
    expect(build({ ip: '203.0.113.256', port: 5190 })).toThrow(RangeError);
    expect(build({ ip: '203.0.113.7', port: 65536 })).toThrow(RangeError);
  });

  it('encodeRendezvousAccept writes the 26-byte head with type 2 and no acknowledgement request', () => {
    expect(toHex(encodeRendezvousAccept(COOKIE, 'Alice', 'send-file'))).toBe(named(v, ACCEPT_OUT).hex);
    const other = fragmentToHost(encodeRendezvousAccept(COOKIE, 'Alice', 'direct-im'));
    expect(other.subarray(10, 26)).toEqual(CAP_DIRECT_IM);
  });

  it('encodeRendezvousCancel writes the full 26-byte head and tag 0x0B', () => {
    const body = encodeRendezvousCancel(COOKIE, 'Alice', 'send-file', RDV_CANCEL_DECLINED);
    expect(toHex(body)).toBe(named(v, CANCEL_OUT).hex);
    const fragment = fragmentToHost(encodeRendezvousCancel(COOKIE, 'Alice', 'get-file', RDV_CANCEL_TIMEOUT));
    expect(toHex(fragment.subarray(0, FRAGMENT_HEAD_BYTES))).toBe(`00010102030405060708${toHex(CAP_GET_FILE)}`);
    expect(decodeTlvs(fragment.subarray(FRAGMENT_HEAD_BYTES))).toEqual([tlv.u16(0x000b, RDV_CANCEL_TIMEOUT)]);
  });

  it('decodeClientError reads cookie, channel 2, the name and the code', () => {
    expect(decodeClientError(bytesOf(v, CLIENT_ERROR))).toEqual({ cookie: COOKIE, channel: 2, screenName: 'Alice', code: 1 });
    expect(() => decodeClientError(bytesOf(v, CLIENT_ERROR).subarray(0, 12))).toThrow(OscarDecodeError);
  });
});

describe('the chat codec beside the file codec', () => {
  it('parseInvite still reads the chat vectors unchanged', () => {
    expect(parseInvite(roomVector('inviteSnac'))).toMatchObject({ from: 'alice', room: { exchange: 4, name: 'testroom' } });
    expect(parseInvite(bytesOf(v, PROPOSAL))).toBeNull();
    const invite = rooms.vectors.find((entry) => entry.name.startsWith('invitation to host'));
    const room = { exchange: 4, cookie: invite?.name.split('room ')[1] ?? '' } as const;
    expect(toHex(encodeChatInvite(COOKIE, 'bob', room, 'Join me in this room.'))).toBe(invite?.hex);
  });

  it('every hand vector says it is hand-assembled', () => {
    for (const entry of v.vectors) expect(entry.note).toMatch(/^Hand-assembled/);
  });
});
