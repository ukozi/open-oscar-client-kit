import type { ServerAddress } from './sign-on.js';
import type { IssuedTicket } from './tickets.js';

export const CLIENT_LOGIN_TIMEOUT_MS = 10_000;

export type ClientLoginOptions = {
  url: string;
  screenName: string;
  password: string;
  devId: string;
  bos: ServerAddress;
  tokenTtlSeconds?: number;
  now?: () => number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};
export type ClientLoginResult =
  | { ok: true; ticket: IssuedTicket; screenName: string }
  | { ok: false; code: 'wrong-credentials' | 'refused' | 'unreachable'; status: number | null };

type Token = { cookie: Uint8Array; expiresIn: number; screenName: string | undefined };

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export async function clientLogin(opts: ClientLoginOptions): Promise<ClientLoginResult> {
  const form = new URLSearchParams({ s: opts.screenName, pwd: opts.password, devId: opts.devId, f: 'json' });
  if (opts.tokenTtlSeconds !== undefined) form.set('tokenType', String(opts.tokenTtlSeconds));
  const signal = AbortSignal.timeout(opts.timeoutMs ?? CLIENT_LOGIN_TIMEOUT_MS);
  let response: Response;
  try {
    // A redirect is not followed, so the password goes to the URL given and nowhere else.
    response = await (opts.fetch ?? fetch)(`${opts.url.replace(/\/+$/, '')}/auth/clientLogin`, { method: 'POST', body: form, redirect: 'manual', signal });
  } catch {
    return unreachable(null);
  }
  const status = response.status;
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (status === 401) return { ok: false, code: 'wrong-credentials', status };
    return status >= 400 && status < 500 ? { ok: false, code: 'refused', status } : unreachable(status);
  }
  let token: Token | null;
  try {
    token = readToken(await response.json());
  } catch {
    return unreachable(status);
  }
  if (!token) return unreachable(status);
  const at = (opts.now ?? Date.now)();
  return {
    ok: true,
    ticket: { ticket: { host: opts.bos.host, port: opts.bos.port, cookie: token.cookie }, source: 'adapter', obtainedAt: at, expiresAt: at + token.expiresIn * 1000 },
    screenName: token.screenName ?? opts.screenName,
  };
}

function unreachable(status: number | null): ClientLoginResult {
  return { ok: false, code: 'unreachable', status };
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function readToken(body: unknown): Token | null {
  const data = field(field(body, 'response'), 'data');
  const a = field(field(data, 'token'), 'a');
  const expiresIn = wholeSeconds(field(field(data, 'token'), 'expiresIn'));
  if (typeof a !== 'string' || !BASE64URL.test(a) || expiresIn === null) return null;
  const cookie = new Uint8Array(Buffer.from(a, 'base64url'));
  if (cookie.length === 0) return null;
  const screenName = field(data, 'screenName');
  return { cookie, expiresIn, screenName: typeof screenName === 'string' && screenName !== '' ? screenName : undefined };
}

// The server writes the lifetime as a decimal string.
function wholeSeconds(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}
