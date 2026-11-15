import { createHash } from 'node:crypto';
import { ByteReader } from './bytes.js';
import {
  BUCP_CHALLENGE_REQUEST,
  BUCP_CHALLENGE_RESPONSE,
  BUCP_LOGIN_REQUEST,
  BUCP_LOGIN_RESPONSE,
  FAMILY_BUCP,
  LOGIN_ERR_BAD_PASSWORD,
  LOGIN_ERR_DELETED,
  LOGIN_ERR_EXPIRED,
  LOGIN_ERR_INVALID_ACCOUNT,
  LOGIN_ERR_RATE_LIMITED,
  LOGIN_ERR_SUSPENDED,
  LOGIN_ERR_SUSPENDED_AGE,
  LOGIN_ERR_UNKNOWN_NAME,
  LOGIN_HASH_SUFFIX,
  LOGIN_TLV_CLIENT_ID,
  LOGIN_TLV_COOKIE,
  LOGIN_TLV_ERROR,
  LOGIN_TLV_MULTI_CONN,
  LOGIN_TLV_PASSWORD_HASH,
  LOGIN_TLV_RECONNECT_HERE,
  LOGIN_TLV_SCREEN_NAME,
  LOGIN_TLV_SSL_STATE,
  LOGIN_TLV_TOKEN_TTL,
  REQUEST_TIMEOUT_MS,
  TOKEN_TTL_MAX_SECONDS,
} from './constants.js';
import { isTlsError, parseHostPort } from './connection.js';
import type { CloseInfo, OscarConnection } from './connection.js';
import type { Snac } from './snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvStr, tlvU16, tlvU8 } from './tlv.js';
import type { Tlv } from './tlv.js';
import type { StateReason, TimerApi } from './types.js';

export function md5Available(): boolean {
  try {
    createHash('md5').update('probe').digest();
    return true;
  } catch {
    return false;
  }
}

export function strongHash(password: string, key: string): Uint8Array {
  const inner = createHash('md5').update(password, 'utf8').digest();
  return new Uint8Array(createHash('md5').update(key, 'utf8').update(inner).update(LOGIN_HASH_SUFFIX, 'utf8').digest());
}

// An ICQ UIN is all Nd digits, as state/user.go:98-108 IsUIN reads unicode.IsDigit.
export function isUin(screenName: string): boolean {
  return /^\p{Nd}+$/u.test(screenName);
}

// 0x0008 is LoginErrDeletedAccount and LoginErrICQUserErr (wire/snacs.go:123, 131): for a UIN, no such account.
export function loginErrorReason(code: number, screenName?: string): StateReason {
  switch (code) {
    case LOGIN_ERR_UNKNOWN_NAME:
    case LOGIN_ERR_INVALID_ACCOUNT:
      return 'unknown-name';
    case LOGIN_ERR_BAD_PASSWORD:
      return 'bad-password';
    case LOGIN_ERR_RATE_LIMITED:
      return 'login-rate-limited';
    case LOGIN_ERR_DELETED:
      return screenName !== undefined && isUin(screenName) ? 'unknown-name' : 'suspended';
    case LOGIN_ERR_EXPIRED:
    case LOGIN_ERR_SUSPENDED:
    case LOGIN_ERR_SUSPENDED_AGE:
      return 'suspended';
    default:
      return 'network';
  }
}

export type LoginResult =
  | { ok: true; host: string; port: number; cookie: Uint8Array; ssl: boolean; screenName?: string }
  | { ok: false; reason: StateReason; code?: number; detail: string; loginSent?: boolean };

// state/cookie.go hmacToken: a u16 length, then the signed payload, which opens with the expiry in Unix seconds.
export function readOosCookieExpiry(cookie: Uint8Array): number | null {
  if (cookie.length < 6) return null;
  const r = new ByteReader(cookie);
  const dataLen = r.u16();
  if (dataLen < 4 || dataLen > cookie.length - 2) return null;
  return r.u32() * 1000;
}

function failure(code: number, screenName?: string): LoginResult {
  return {
    ok: false,
    reason: loginErrorReason(code, screenName),
    code,
    detail: `login error 0x${code.toString(16).padStart(4, '0')}`,
  };
}

export function parseLoginReply(tlvs: readonly Tlv[], defaultPort: number, screenName?: string): LoginResult {
  const code = tlvU16(tlvs, LOGIN_TLV_ERROR);
  if (code !== undefined) return failure(code, screenName);
  const where = tlvStr(tlvs, LOGIN_TLV_RECONNECT_HERE);
  const cookie = findTlv(tlvs, LOGIN_TLV_COOKIE);
  if (!where || !cookie || cookie.length === 0) {
    return { ok: false, reason: 'network', detail: 'login reply had no address or cookie' };
  }
  const name = tlvStr(tlvs, LOGIN_TLV_SCREEN_NAME);
  return {
    ok: true,
    ...parseHostPort(where, defaultPort),
    cookie,
    ssl: (tlvU8(tlvs, LOGIN_TLV_SSL_STATE) ?? 0) !== 0,
    ...(name ? { screenName: name } : {}),
  };
}

function closeResult(info: CloseInfo, screenName?: string): LoginResult {
  if (info.kind === 'signoff') {
    // The server's per-IP isBUCP tag picks this bare shape or the SNAC one (server/oscar/server.go:415-452).
    const code = tlvU16(info.tlvs, LOGIN_TLV_ERROR) ?? tlvU8(info.tlvs, LOGIN_TLV_ERROR);
    if (code !== undefined) return failure(code, screenName);
  }
  if (info.kind === 'error' && isTlsError(info.error)) return { ok: false, reason: 'tls', detail: info.error.message };
  return { ok: false, reason: 'network', detail: `auth connection closed (${info.kind})` };
}

type AuthEvent = { snac: Snac } | { closed: CloseInfo } | { timeout: true };

function eventQueue(
  conn: OscarConnection,
  timers: TimerApi,
  timeoutMs: number,
): { next: () => Promise<AuthEvent>; stop: () => void } {
  const events: AuthEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (e: AuthEvent): void => {
    events.push(e);
    wake?.();
  };
  const offSnac = conn.onSnac((snac) => push({ snac }));
  const offClose = conn.onClose((closed) => push({ closed }));
  return {
    async next() {
      if (events.length === 0) {
        const timer = timers.setTimeout(() => push({ timeout: true }), timeoutMs);
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
        timers.clearTimeout(timer);
      }
      return events.shift() ?? { timeout: true };
    },
    stop() {
      offSnac();
      offClose();
    },
  };
}

export async function bucpLogin(
  conn: OscarConnection,
  timers: TimerApi,
  screenName: string,
  defaultPort: number,
  hashFor: (key: string) => Promise<Uint8Array> | Uint8Array,
  login: { clientId: string; multiConn: number; tokenTtlSeconds?: number },
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<LoginResult> {
  const ttl = login.tokenTtlSeconds;
  if (ttl !== undefined && !(Number.isInteger(ttl) && ttl >= 1 && ttl <= TOKEN_TTL_MAX_SECONDS)) {
    conn.destroy();
    throw new RangeError(`tokenTtlSeconds must be a whole number from 1 to ${TOKEN_TTL_MAX_SECONDS}`);
  }
  // A local guard: only FLAP auth panics on a short name (server/oscar/server.go:448), BUCP answers 0x0001.
  if (Buffer.byteLength(screenName, 'utf8') < 2) {
    conn.destroy();
    return { ok: false, reason: 'unknown-name', detail: 'screen name too short' };
  }
  const queue = eventQueue(conn, timers, timeoutMs);
  let sentLogin = false;
  const ended = (result: LoginResult): LoginResult => (result.ok ? result : { ...result, loginSent: sentLogin });
  try {
    conn.send(FAMILY_BUCP, BUCP_CHALLENGE_REQUEST, encodeTlvs([tlv.str(LOGIN_TLV_SCREEN_NAME, screenName)]));
    for (;;) {
      const event = await queue.next();
      if ('timeout' in event) return ended({ ok: false, reason: 'network', detail: 'login timed out' });
      if ('closed' in event) return ended(closeResult(event.closed, screenName));
      const { snac } = event;
      if (snac.family !== FAMILY_BUCP) continue;
      if (snac.subtype === BUCP_LOGIN_RESPONSE) return ended(parseLoginReply(decodeTlvs(snac.body), defaultPort, screenName));
      if (snac.subtype !== BUCP_CHALLENGE_RESPONSE || sentLogin) continue;
      const key = new ByteReader(snac.body).str16();
      const hash = await hashFor(key);
      sentLogin = true;
      const tlvs = [
        tlv.str(LOGIN_TLV_SCREEN_NAME, screenName),
        tlv.bytes(LOGIN_TLV_PASSWORD_HASH, hash),
        tlv.str(LOGIN_TLV_CLIENT_ID, login.clientId),
        tlv.u8(LOGIN_TLV_MULTI_CONN, login.multiConn),
      ];
      // TLV 0x133A only when asked for: the server can then mint a login cookie valid for up to a year.
      if (ttl !== undefined) tlvs.push(tlv.u32(LOGIN_TLV_TOKEN_TTL, ttl));
      conn.send(FAMILY_BUCP, BUCP_LOGIN_REQUEST, encodeTlvs(tlvs));
    }
  } catch (error) {
    return ended({ ok: false, reason: 'network', detail: (error as Error).message });
  } finally {
    queue.stop();
    conn.destroy();
  }
}
