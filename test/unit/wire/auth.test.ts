import { describe, expect, it } from 'vitest';
import { toHex } from '../../../src/wire/bytes.js';
import { loginErrorReason, md5Available, parseLoginReply, strongHash } from '../../../src/wire/auth.js';
import { decodeTlvs, encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';

const auth = loadVectors('auth.json');

describe('strong hash', () => {
  it('matches every hash vector, the two from the server test suite included', () => {
    const rows = auth.vectors.filter((v) => v.name.startsWith('strong hash'));
    expect(rows).toHaveLength(3);
    for (const v of rows) {
      expect(toHex(strongHash(v.inputs?.['password'] ?? 'missing', v.inputs?.['key'] ?? 'missing'))).toBe(v.hex);
    }
  });

  it('pins the two values as they appear in wire/user_test.go', () => {
    expect(vector(auth, 'strong hash, empty password and key').hex).toBe('1fa2b6995984b01468a37c7742900ac9');
    expect(vector(auth, 'strong hash, password123 and authkey456').hex).toBe('b90791cccb5c5771bdcbc93982f79484');
  });

  it('finds MD5 on this Node build', () => {
    expect(md5Available()).toBe(true);
  });
});

describe('login bodies', () => {
  it('builds the login request the server expects', () => {
    const body = encodeTlvs([
      tlv.str(0x01, 'botone'),
      tlv.bytes(0x25, strongHash('password123', 'authkey456')),
      tlv.str(0x03, 'Chimr'),
      tlv.u8(0x4a, 0x01),
    ]);
    expect(toHex(body)).toBe(vector(auth, 'login request body').hex);
    expect(toHex(encodeTlvs([tlv.str(0x01, 'botone')]))).toBe(vector(auth, 'challenge request body').hex);
  });

  it('parses a success reply', () => {
    const got = parseLoginReply(decodeTlvs(bytesOf(auth, 'login success body')), 5190);
    expect(got).toMatchObject({ ok: true, host: 'oscar.example.net', port: 5190, ssl: false });
    expect(got.ok && toHex(got.cookie)).toBe('0001020304050607');
    expect(parseLoginReply(decodeTlvs(bytesOf(auth, 'login success body on the SSL listener')), 5190)).toMatchObject({
      ok: true,
      port: 5193,
      ssl: true,
    });
  });

  it('keeps the screen name of a success reply, and only when the reply has one', () => {
    const body = decodeTlvs(bytesOf(auth, 'login success body'));
    expect(parseLoginReply(body, 5190)).toMatchObject({ ok: true, screenName: 'botone' });
    const unnamed = parseLoginReply(body.filter((t) => t.tag !== 0x01), 5190);
    expect(unnamed.ok).toBe(true);
    expect(unnamed).not.toHaveProperty('screenName');
    expect(parseLoginReply([...body.filter((t) => t.tag !== 0x01), tlv.str(0x01, '')], 5190)).not.toHaveProperty('screenName');
  });

  it('parses failure replies in both limiter shapes', () => {
    expect(parseLoginReply(decodeTlvs(bytesOf(auth, 'login failure body, bad password')), 5190)).toMatchObject({
      ok: false,
      reason: 'bad-password',
      code: 5,
    });
    expect(parseLoginReply(decodeTlvs(bytesOf(auth, 'limiter body, SNAC shape')), 5190)).toMatchObject({
      ok: false,
      reason: 'login-rate-limited',
    });
  });

  it('treats a reply with no address or cookie as a network fault', () => {
    expect(parseLoginReply([tlv.str(0x01, 'botone')], 5190)).toMatchObject({ ok: false, reason: 'network' });
    expect(parseLoginReply([tlv.str(0x05, 'h:1'), tlv.empty(0x06)], 5190)).toMatchObject({ ok: false, reason: 'network' });
  });
});

describe('loginErrorReason', () => {
  const rows: [number, string][] = [
    [0x0001, 'unknown-name'],
    [0x0007, 'unknown-name'],
    [0x0005, 'bad-password'],
    [0x001d, 'login-rate-limited'],
    [0x0008, 'suspended'],
    [0x0009, 'suspended'],
    [0x0011, 'suspended'],
    [0x0022, 'suspended'],
    [0x0006, 'network'],
    [0x0018, 'network'],
  ];
  it.each(rows)('0x%s -> %s', (code, want) => {
    expect(loginErrorReason(code)).toBe(want);
  });

  // 0x0008 is also LoginErrICQUserErr (wire/snacs.go:131): for a UIN, the ICQ spelling of an unknown name.
  it('reads 0x0008 as an unknown name when the screen name is a UIN', () => {
    expect(loginErrorReason(0x0008, '123456789')).toBe('unknown-name');
    expect(loginErrorReason(0x0008, '1')).toBe('unknown-name');
    expect(loginErrorReason(0x0008, 'botone')).toBe('suspended');
    expect(loginErrorReason(0x0008, 'bot123')).toBe('suspended');
    expect(loginErrorReason(0x0008, '')).toBe('suspended');
    expect(loginErrorReason(0x0008)).toBe('suspended');
    expect(loginErrorReason(0x0011, '123456789')).toBe('suspended');
    expect(loginErrorReason(0x0001, '123456789')).toBe('unknown-name');
  });

  it('carries the signed-on name into a parsed failure reply', () => {
    const body = encodeTlvs([tlv.str(0x01, '123456789'), tlv.u16(0x08, 0x0008)]);
    expect(parseLoginReply(decodeTlvs(body), 5190, '123456789')).toMatchObject({
      ok: false,
      reason: 'unknown-name',
      code: 8,
    });
    expect(parseLoginReply(decodeTlvs(body), 5190, 'botone')).toMatchObject({ ok: false, reason: 'suspended' });
    expect(parseLoginReply(decodeTlvs(body), 5190)).toMatchObject({ ok: false, reason: 'suspended' });
  });
});
