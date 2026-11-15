import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readOosCookieExpiry } from '../../src/wire/auth.js';
import type { FakeOscarServer } from './oscar-server.js';

export type ClientLoginRequest = { screenName: string; devId: string; tokenType: string };
export type ClientLoginFake = { url: string; requests: ClientLoginRequest[]; stop(): Promise<void> };

const MULTI_SESSION = 0x01;
const DEFAULT_TTL_SECONDS = 86_400;
const WRONG_CREDENTIALS = { response: { statusCode: 330, statusText: 'invalid screen name or password', statusDetailCode: 3011 } };

// server/webapi/auth_handler.go ClientLogin.
export async function startClientLoginFake(server: FakeOscarServer): Promise<ClientLoginFake> {
  const requests: ClientLoginRequest[] = [];
  const web = http.createServer((req, res) => {
    const answer = (status: number, body?: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/auth/clientLogin') {
      answer(404);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // As Go's ParseForm, a body that is not form-encoded is not read.
      const encoded = (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
      const form = new URLSearchParams(encoded ? Buffer.concat(chunks).toString('utf8') : '');
      const s = form.get('s') ?? '';
      const devId = form.get('devId') ?? '';
      const tokenType = form.get('tokenType') ?? '';
      requests.push({ screenName: s, devId, tokenType });
      if (!server.checkPassword(s, form.get('pwd') ?? '') || server.atSessionCap(s, MULTI_SESSION)) {
        answer(401, WRONG_CREDENTIALS);
        return;
      }
      const ttl = Number(tokenType) || DEFAULT_TTL_SECONDS;
      const cookie = server.issueCookie(s, { multiConn: MULTI_SESSION, ttlSeconds: ttl, clientId: devId });
      // The cookie's expiry less its lifetime is the server's own clock.
      const hostTime = (readOosCookieExpiry(cookie) ?? 0) / 1000 - ttl;
      const token = { a: Buffer.from(cookie).toString('base64url'), expiresIn: String(ttl) };
      answer(200, {
        response: { statusCode: 200, statusText: 'Ok', data: { token, loginId: s, screenName: s, sessionSecret: 'x', hostTime, tokenExpiresIn: ttl } },
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    web.once('error', reject);
    web.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    url: `http://127.0.0.1:${(web.address() as AddressInfo).port}`,
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        web.closeAllConnections();
        web.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
