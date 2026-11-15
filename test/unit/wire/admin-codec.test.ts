import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ERR,
  ADMIN_INFO_CHANGE,
  ADMIN_INFO_CHANGE_REPLY,
  ADMIN_INFO_QUERY,
  ADMIN_INFO_REPLY,
  decodeAdminReply,
  encodeAdminEmailQuery,
  encodeAdminFormat,
} from '../../../src/wire/admin.js';
import { OscarDecodeError, toHex } from '../../../src/wire/bytes.js';
import { decodeSnacError } from '../../../src/wire/snac.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const v = loadVectors('hand-admin.json');

const REPLY_VECTORS = [
  'admin change reply body, success, Chimr Dev 2',
  'admin change reply body, failure 0x0001',
  'admin info reply body, email dev2@example.com',
  'admin info reply body, no email',
];

// The 17 runtime exports: 14 constants and 3 functions.
const EXPORTS = [
  'ADMIN_ERR',
  'ADMIN_ERROR_INVALID',
  'ADMIN_ERROR_LENGTH',
  'ADMIN_ERROR_NOT_SAME',
  'ADMIN_INFO_CHANGE',
  'ADMIN_INFO_CHANGE_REPLY',
  'ADMIN_INFO_QUERY',
  'ADMIN_INFO_REPLY',
  'ADMIN_REQUEST_TIMEOUT_MS',
  'ADMIN_TLV_EMAIL',
  'ADMIN_TLV_ERROR',
  'ADMIN_TLV_SCREEN_NAME',
  'ADMIN_TLV_URL',
  'FAMILY_ADMIN',
  'decodeAdminReply',
  'encodeAdminEmailQuery',
  'encodeAdminFormat',
];

describe('the Admin codec', () => {
  it('encodes the email query as TLV 0x0011 of length 0 with no count', () => {
    expect(toHex(encodeAdminEmailQuery())).toBe(toHex(bytesOf(v, 'admin email query body')));
    // It takes no argument: there is no email change.
    expect(encodeAdminEmailQuery.length).toBe(0);
  });

  it('encodes the format request as TLV 0x0001 holding the name in UTF-8', () => {
    expect(toHex(encodeAdminFormat('Chimr Dev 2'))).toBe(toHex(bytesOf(v, 'admin format body, Chimr Dev 2')));
    // é is two bytes in UTF-8: the TLV's length counts bytes.
    expect(toHex(encodeAdminFormat('Bé b'))).toBe(`00010005${Buffer.from('Bé b', 'utf8').toString('hex')}`);
    expect(toHex(encodeAdminFormat('é'))).toBe('00010002c3a9');
  });

  it('decodes a format reply that carries the name', () => {
    const reply = decodeAdminReply(bytesOf(v, 'admin change reply body, success, Chimr Dev 2'));
    expect(reply).toEqual({ permissions: 3, screenName: 'Chimr Dev 2' });
    expect('error' in reply).toBe(false);
    expect('email' in reply).toBe(false);
  });

  it('decodes a format reply that carries an error code and an empty URL', () => {
    const reply = decodeAdminReply(bytesOf(v, 'admin change reply body, failure 0x0001'));
    expect(reply).toEqual({ permissions: 3, error: 0x0001 });
    expect('screenName' in reply).toBe(false);
  });

  it('decodes an email reply with an address, and an empty one as none', () => {
    expect(decodeAdminReply(bytesOf(v, 'admin info reply body, email dev2@example.com'))).toEqual({ permissions: 3, email: 'dev2@example.com' });
    expect(decodeAdminReply(bytesOf(v, 'admin info reply body, no email'))).toEqual({ permissions: 3, email: null });
  });

  it('decodes AdminErr as its code', () => {
    expect(decodeSnacError(bytesOf(v, 'admin err body, code 8')).code).toBe(0x0008);
  });

  it('throws on a reply cut short', () => {
    for (const name of REPLY_VECTORS) {
      const body = bytesOf(v, name);
      for (let n = 0; n < body.length; n++) {
        expect(() => decodeAdminReply(body.subarray(0, n)), `${name}, ${n} of ${body.length} bytes`).toThrow(OscarDecodeError);
      }
    }
    const err = bytesOf(v, 'admin err body, code 8');
    for (const n of [0, 1]) expect(() => decodeSnacError(err.subarray(0, n))).toThrow(OscarDecodeError);
    // A TLV 0x08 under the two bytes of its code.
    expect(() => decodeAdminReply(Uint8Array.of(0x00, 0x03, 0x00, 0x01, 0x00, 0x08, 0x00, 0x01, 0x00))).toThrow(OscarDecodeError);
  });

  it('exports exactly the names, with no encoder for a password, a registration status, an email change or a confirmation', async () => {
    const mod = await import('../../../src/wire/admin.js');
    const names = Object.keys(mod).sort();
    expect(names).toEqual([...EXPORTS].sort());
    for (const name of names) expect(name).not.toMatch(/password|confirm|registration|status|delete/i);
    // No subtype is 0x07/0x06, the confirm request; only ADMIN_ERROR_INVALID, an error code, holds 6.
    for (const subtype of [ADMIN_ERR, ADMIN_INFO_QUERY, ADMIN_INFO_REPLY, ADMIN_INFO_CHANGE, ADMIN_INFO_CHANGE_REPLY]) expect(subtype).not.toBe(0x0006);
    const sixes = Object.entries(mod).filter(([, value]) => value === 0x0006).map(([name]) => name);
    expect(sixes).toEqual(['ADMIN_ERROR_INVALID']);
    const functions = Object.entries(mod).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort();
    expect(functions).toEqual(['decodeAdminReply', 'encodeAdminEmailQuery', 'encodeAdminFormat']);
    // The module names neither TLV 0x12 (the old password) nor TLV 0x13 (the registration status).
    const source = readFileSync(fileURLToPath(new URL('../../../src/wire/admin.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/0x0012|0x0013/i);
    // The format encoder writes TLV 0x0001 whatever it is given; only the email query writes TLV 0x0011.
    expect(encodeAdminFormat.length).toBe(1);
    for (const name of ['Chimr Dev 2', '', 'A']) expect(toHex(encodeAdminFormat(name).subarray(0, 2))).toBe('0001');
  });
});
