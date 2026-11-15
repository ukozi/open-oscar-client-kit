import { describe, expect, it } from 'vitest';
import { ByteWriter } from '../../../src/wire/bytes.js';
import { ICBM_CHANNEL_RENDEZVOUS } from '../../../src/wire/constants.js';
import { decodeClientError, encodeGetFileProposal, offeredFolder, parseRendezvous } from '../../../src/wire/rendezvous.js';
import type { RendezvousMessage } from '../../../src/wire/rendezvous.js';
import { encodeUserInfo } from '../../../src/wire/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const v = loadVectors('aim-rendezvous.json');
const RELAY = { ip: '203.0.113.7', port: 5190 };

// The vectors hold the fragment only. The test puts the head of a channel 2 message from Alice before it.
function read(name: string): RendezvousMessage | null {
  const sender = encodeUserInfo({ name: 'Alice', warning: 0, tlvs: [] });
  const fragment = encodeTlvs([tlv.bytes(0x0005, bytesOf(v, name))]);
  return parseRendezvous(new ByteWriter().u64(0n).u16(ICBM_CHANNEL_RENDEZVOUS).bytes(sender).bytes(fragment).toBytes());
}

const PROPOSALS: readonly [string, bigint, RendezvousMessage['file'], string | null][] = [
  ['5.1 proposal, one file', 0x3333363044444200n, { multiple: false, count: 1, totalBytes: 1513, name: 'README.txt' }, null],
  ['5.1 proposal, one file of 12 MB', 0x3333363246394300n, { multiple: false, count: 1, totalBytes: 12027554, name: 'IMG_0495.jpeg' }, null],
  ['5.1 proposal, a folder', 0x3333363144463800n, { multiple: true, count: 3, totalBytes: 231353, name: 'Manufacturing\\*' }, null],
  ['5.9 proposal, one file', 0x36e47b30dc010000n, { multiple: false, count: 1, totalBytes: 7750, name: 'notes-01.txt' }, '<HTML>'],
  ['5.9 proposal, one file, long name', 0x08467d30060a0000n, { multiple: false, count: 1, totalBytes: 18518232, name: 'Program_Installer_Build_1.0.10.exe' }, '<HTML>'],
  ['5.9 proposal, one file, a program', 0xfb2f7e3024040000n, { multiple: false, count: 1, totalBytes: 2598120, name: 'setup0001.exe' }, '<HTML>'],
  ['5.9 proposal, a folder', 0x50a37c30713f0000n, { multiple: true, count: 16, totalBytes: 1030852, name: 'aimex' }, '<HTML>'],
];

describe('the messages that AIM 5.1 and AIM 5.9 sent', () => {
  it.each(PROPOSALS)('reads "%s"', (name, cookie, file, invitation) => {
    expect(read(name)).toEqual({
      from: 'alice', fromDisplay: 'Alice', cookie, service: 'send-file', type: 'propose', sequence: 1, address: RELAY, useProxy: false,
      cancelReason: null, file, invitation,
    });
  });

  it('reads the counter-offer: sequence 2, the address, no file block', () => {
    expect(read('counter-offer after the recipient connected')).toMatchObject({
      cookie: 0x19968105f3f769a2n, service: 'send-file', type: 'propose', sequence: 2, address: RELAY, useProxy: false, file: null, invitation: null,
    });
  });

  it('reads the accept of 5.9', () => {
    expect(read('5.9 accept')).toMatchObject({ cookie: 0x36e47b30dc010000n, service: 'send-file', type: 'accept', sequence: null, address: null, file: null });
  });

  it('reads the client error that declines: channel 2, code 3', () => {
    expect(decodeClientError(bytesOf(v, 'client error body, decline'))).toEqual({
      cookie: 0xe939786d68a545f6n, channel: 2, screenName: 'test name 2', code: 3,
    });
  });

  it('no vector holds a name from the capture', () => {
    const text = v.vectors.map((one) => Buffer.from(one.hex, 'hex').toString('latin1')).join('\n');
    expect(text).not.toMatch(/dev [12]|probe|travolta|Messenger|aim5/i);
  });
});

describe('the folder of an offer', () => {
  it('an offer of one file names no folder', () => {
    expect(offeredFolder({ multiple: false, count: 1, totalBytes: 1513, name: 'README.txt' })).toBeNull();
    expect(offeredFolder({ multiple: false, count: 1, totalBytes: 1, name: 'odd\\*' })).toBeNull();
  });

  it('the folder of 5.1 is the name before the backslash and the star', () => {
    expect(offeredFolder(read('5.1 proposal, a folder')?.file ?? null)).toBe('Manufacturing');
  });

  it('the folder of 5.9 is the name', () => {
    expect(offeredFolder(read('5.9 proposal, a folder')?.file ?? null)).toBe('aimex');
  });

  it('an offer of several files with no name, or with no file block, names no folder', () => {
    expect(offeredFolder({ multiple: true, count: 2, totalBytes: 33, name: '' })).toBeNull();
    expect(offeredFolder({ multiple: true, count: 2, totalBytes: 33, name: '\\*' })).toBeNull();
    expect(offeredFolder(null)).toBeNull();
  });

  it('keeps the folders of a name that has more than one', () => {
    expect(offeredFolder({ multiple: true, count: 2, totalBytes: 33, name: 'Plans\\2026\\*' })).toBe('Plans\\2026');
  });
});

describe('the Get File proposal of AIM 5.1', () => {
  it('reads as a get-file proposal with the sequence 1 and the address of the relay', () => {
    expect(read('5.1 get file proposal')).toMatchObject({ service: 'get-file', type: 'propose', sequence: 1, address: RELAY, cookie: 0x3335464237434400n });
  });

  it('encodeGetFileProposal writes the same tag 0x2711 as AIM 5.1, byte for byte', () => {
    const theirs = findTlv(decodeTlvs(bytesOf(v, '5.1 get file proposal').subarray(26)), 0x2711);
    expect(theirs).toEqual(Uint8Array.of(0x00, 0x12, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0));
    const body = encodeGetFileProposal(1n, 'bob', { sequence: 1, address: RELAY });
    const fragment = findTlv(decodeTlvs(body.subarray(8 + 2 + 1 + 3)), 0x0005);
    expect(fragment).toBeDefined();
    expect(findTlv(decodeTlvs((fragment ?? new Uint8Array(0)).subarray(26)), 0x2711)).toEqual(theirs);
  });
});
