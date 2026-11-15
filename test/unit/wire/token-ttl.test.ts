import { describe, expect, it } from 'vitest';
import { bucpLogin, readOosCookieExpiry } from '../../../src/wire/auth.js';
import type { LoginResult } from '../../../src/wire/auth.js';
import { ByteWriter, fromHex, toHex } from '../../../src/wire/bytes.js';
import type { OscarConnection } from '../../../src/wire/connection.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv } from '../../../src/wire/tlv.js';
import { ManualTimers, waitFor } from '../../fake/oscar-client.js';
import { StubConn } from '../../fake/stub-conn.js';
import type { SentSnac } from '../../fake/stub-conn.js';

const HASH = new Uint8Array(16);

function begin(extra: { tokenTtlSeconds?: number }): { conn: StubConn; result: Promise<LoginResult> } {
  const timers = new ManualTimers();
  const conn = new StubConn(timers);
  const result = bucpLogin(conn as unknown as OscarConnection, timers.api, 'Alice', 5190, () => HASH, { clientId: 'Chimr', multiConn: 0x01, ...extra });
  return { conn, result };
}

function challenge(conn: StubConn): void {
  conn.deliver({ family: 0x17, subtype: 0x07, body: new ByteWriter().str16('authkey456').toBytes() });
}

function refuse(conn: StubConn, code: number): void {
  conn.deliver({ family: 0x17, subtype: 0x03, body: encodeTlvs([tlv.u16(0x08, code)]) });
}

async function loginSent(conn: StubConn): Promise<SentSnac> {
  await waitFor(() => conn.sent.some((s) => s.family === 0x17 && s.subtype === 0x02), 'the login request');
  const sent = conn.sent.find((s) => s.family === 0x17 && s.subtype === 0x02);
  if (!sent) throw new Error('no login request');
  return sent;
}

// The login request written after the challenge; a refusal then ends the exchange.
async function loginWith(extra: { tokenTtlSeconds?: number }): Promise<SentSnac> {
  const { conn, result } = begin(extra);
  challenge(conn);
  const sent = await loginSent(conn);
  refuse(conn, 0x05);
  await result;
  return sent;
}

describe('bucpLogin', () => {
  it('asks for a lifetime only when given one', async () => {
    const sent = await loginWith({ tokenTtlSeconds: 1_209_600 });
    expect(toHex(findTlv(decodeTlvs(sent.body), 0x133a) ?? new Uint8Array(0))).toBe('00127500');
    expect(findTlv(decodeTlvs((await loginWith({})).body), 0x133a)).toBeUndefined();
  });

  it('puts the lifetime after the multi-conn TLV', async () => {
    const tags = decodeTlvs((await loginWith({ tokenTtlSeconds: 60 })).body).map((t) => t.tag);
    expect(tags).toEqual([0x01, 0x25, 0x03, 0x4a, 0x133a]);
  });

  it('refuses a lifetime outside 1 s to 365 days, sending nothing', async () => {
    for (const bad of [0, 31_536_001, 1.5]) {
      const { conn, result } = begin({ tokenTtlSeconds: bad });
      await expect(result).rejects.toThrow(RangeError);
      expect(conn.sent).toEqual([]);
    }
    for (const good of [1, 31_536_000]) {
      const sent = await loginWith({ tokenTtlSeconds: good });
      expect(findTlv(decodeTlvs(sent.body), 0x133a)).toBeDefined();
    }
  });

  it('says whether the login request went out', async () => {
    const early = begin({});
    refuse(early.conn, 0x1d);
    expect(await early.result).toMatchObject({ ok: false, reason: 'login-rate-limited', code: 0x1d, loginSent: false });

    const late = begin({});
    challenge(late.conn);
    await loginSent(late.conn);
    refuse(late.conn, 0x1d);
    expect(await late.result).toMatchObject({ ok: false, reason: 'login-rate-limited', code: 0x1d, loginSent: true });
  });

  it('reads the expiry of an open-oscar-server cookie', () => {
    const cookie = new Uint8Array(256);
    cookie.set(fromHex('00166adf02400010'), 0);
    expect(readOosCookieExpiry(cookie)).toBe(1_793_000_000_000);
    expect(readOosCookieExpiry(new Uint8Array(5))).toBeNull();
    expect(readOosCookieExpiry(fromHex('00026adf0240'))).toBeNull();
    expect(readOosCookieExpiry(fromHex('00046adf0240'))).toBe(1_793_000_000_000);
    expect(readOosCookieExpiry(fromHex('00056adf0240'))).toBeNull();
  });
});
