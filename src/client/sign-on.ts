import { bucpLogin, strongHash } from '../wire/auth.js';
import type { LoginResult } from '../wire/auth.js';
import { decodePresence } from '../wire/buddy.js';
import { toHex } from '../wire/bytes.js';
import { encodeClassIds } from '../wire/chatroom.js';
import { decideRedirect, openConnection } from '../wire/connection.js';
import type { CloseInfo, ConnectionLimits, OscarConnection } from '../wire/connection.js';
import {
  CAP_BUDDY_ICON,
  CAP_CHAT,
  CAP_DIRECT_IM,
  CAP_MOBILE_CLIENT,
  CAP_GET_FILE,
  CAP_SEND_FILE,
  CAP_UTF8_MESSAGES,
  FAMILY_ICBM,
  FAMILY_LOCATE,
  FAMILY_OSERVICE,
  FOOD_GROUP_VERSION,
  LOCATE_SET_INFO,
  LOGIN_ERR_DELETED,
  MULTI_CONN_RECENT,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_CLIENT_VERSIONS,
  OSERVICE_EVIL_NOTIFICATION,
  OSERVICE_HOST_ONLINE,
  OSERVICE_IDLE_NOTIFICATION,
  OSERVICE_MULTI_INSTANCE_VERSION,
  OSERVICE_RATE_PARAMS_QUERY,
  OSERVICE_RATE_PARAMS_REPLY,
  OSERVICE_RATE_PARAMS_SUB_ADD,
  OSERVICE_SET_USER_INFO_FIELDS,
  OSERVICE_USER_INFO_QUERY,
  OSERVICE_USER_INFO_UPDATE,
  REQUEST_TIMEOUT_MS,
  SERVER_REQUEST_ID,
  USER_STATUS_INVISIBLE,
} from '../wire/constants.js';
import { ICBM_PARAM_QUERY, ICBM_PARAM_REPLY, decodeIcbmParams } from '../wire/icbm.js';
import { LOCATE_RIGHTS_QUERY, LOCATE_RIGHTS_REPLY, decodeLocateRights, encodeLocateInfo } from '../wire/locate.js';
import { decodeEvilNotification, decodeHostOnline, decodeHostVersions, encodeClientOnline, encodeClientVersions, encodeIdle, encodeStatus, userStatus } from '../wire/oservice.js';
import { decodeRateParamsReply } from '../wire/rate.js';
import { decodeUserInfo, userFlags } from '../wire/snac.js';
import type { Snac } from '../wire/snac.js';
import type { Logger, TimerApi } from '../wire/types.js';
import type { UserInfoSnapshot } from '../model/instances.js';
import type { RichText } from '../model/rich-text.js';
import type { SelfInfo, SignOnFailure } from '../model/session.js';
import type { BosLink } from './bos-link.js';
import { FALLBACK_CLIENT_ID } from './client-id.js';
import { connectionTls, redirectMode } from './connect-options.js';
import { OscarError, SignOnError } from './errors.js';
import type { LoginBudget } from './login-budget.js';
import { encodedLocateLength, locateText } from './profiles.js';
import { dropEvidence } from './reconnect.js';
import { readUserInfoUpdate } from './user-info.js';

// The 256-byte login cookie holds 202 bytes of screen name plus client ID; past that the server closes the auth connection unanswered.
export const LOGIN_COOKIE_NAME_BUDGET = 202;

export type Credentials = { screenName: string; password: string };
export type ServerAddress = { host: string; port: number };
export type BosTicket = { host: string; port: number; cookie: Uint8Array };
/** `screenName` is TLV 0x01 of the login reply, when it has one. */
export type LoggedIn = BosTicket & { screenName?: string };
export type Warned = { level: number; by: string | null };
export type Restore = { away: RichText | null; invisible: boolean; systemIdleSeconds: () => number; idleAfterSeconds: number | null };
export type PreOnlinePlan = { invisible: boolean; reportIdle: boolean };
export type BringUpHooks = {
  loadFeedbag(): Promise<void>;
  useFeedbag(): Promise<void>;
  hostOnline?(families: number[]): void;
  preOnline?(userInfo: UserInfoSnapshot | null): Promise<PreOnlinePlan> | PreOnlinePlan;
  awayWrite?(limits: { awayAndProfileBytes: number }): Promise<void>;
};
export type SignOnDeps = {
  log: Logger;
  now: () => number;
  timers: TimerApi;
  budget: LoginBudget;
  /** TLV 0x03 of the login request. The default is `FALLBACK_CLIENT_ID`. */
  clientId?: string;
  /** The capabilities written to the Locate profile. The default is `[CAP_UTF8_MESSAGES, CAP_CHAT]`. */
  capabilities?: readonly Uint8Array[];
  /** Adds `CAP_SEND_FILE` to the capabilities written, one time. A function is read at each write. The default adds nothing. */
  sendFile?: boolean | (() => boolean);
  /** Adds `CAP_DIRECT_IM` to the capabilities written, one time. A function is read at each write. The default adds nothing. */
  directIm?: boolean | (() => boolean);
  /** Adds `CAP_GET_FILE` to the capabilities written, one time. A function is read at each write. The default adds nothing. */
  getFile?: boolean | (() => boolean);
  /** Adds `CAP_BUDDY_ICON` to the capabilities written, one time. The default adds nothing. */
  buddyIcon?: boolean;
  /** The OService version asked for on BOS. The server can grant less. The default is 1. */
  oserviceVersion?: number;
  /** The login cookie lifetime asked for (TLV 0x133A), from 1 to `TOKEN_TTL_MAX_SECONDS`. The default asks for none. */
  tokenTtlSeconds?: number;
  /** Where the BOS connection goes, whatever host the login reply names. The default follows a routable advertised host. */
  pinRedirects?: ServerAddress;
  /** The local address that the login and BOS connections bind, so the server sees that source. Service connections do not bind. The default lets the system choose. */
  localAddress?: string;
  /** Opens the login, BOS and service connections with TLS. `caFile` names a PEM file of the certificates to trust. The default is plain TCP. */
  tls?: { caFile?: string };
  /** Goes to each host that the server advertises, also a loopback or unroutable one. `pinRedirects` comes first. The default is false. */
  followRedirects?: boolean;
  /** Gives the names to watch at each connect, which go out in 0x03/0x04 in place of the server's list. The default is the server's list. */
  sessionBuddies?: () => readonly string[];
  /** Writes each BOS send at once, with no pacing, when the user info of the account at a connect carries user flag 0x0400. The default is false. */
  botFlagExempt?: boolean;
  limits?: ConnectionLimits;
  emitSelf?: (self: SelfInfo) => void;
  emitWarned?: (warned: Warned) => void;
  emitUserInfo?: (snapshot: UserInfoSnapshot) => void;
};

export const BOS_FOOD_GROUPS: readonly number[] = [0x0001, 0x0002, 0x0003, 0x0004, 0x0013];
export const BART_FOOD_GROUP = 0x0010;

const DEFAULT_CAPABILITIES: readonly Uint8Array[] = [CAP_UTF8_MESSAGES, CAP_CHAT];
const MOBILE_CLIENT_HEX = toHex(CAP_MOBILE_CLIENT);
const OSERVICE_HOST_VERSIONS = 0x0018;
const SNAC_ERROR = 0x0001;
const DEFAULT_IM_BYTES = 512;
const DEFAULT_AWAY_AND_PROFILE_BYTES = 1000;
export const INVISIBLE_TIMEOUT_MS = 15_000;

type InvisibleWait = { on: boolean; armed: boolean; settle(error?: Error): void };

const isOn = (on: boolean | (() => boolean) | undefined): boolean => (typeof on === 'function' ? on() : on === true);
const capabilityKey = (caps: readonly Uint8Array[]): string => caps.map(toHex).join();

export function parseSelfInfo(body: Uint8Array): SelfInfo {
  const { info } = decodeUserInfo(body, 0);
  const { signedOnAt, warnLevel } = decodePresence(info);
  return { screenName: info.name, signedOnAt: (signedOnAt ?? 0) * 1000, warnLevel, invisible: (userStatus(info) & USER_STATUS_INVISIBLE) !== 0 };
}

async function ask(link: BosLink, family: number, subtype: number, replySubtype: number, body?: Uint8Array): Promise<Uint8Array> {
  const reply = await link.requestMatching(
    family,
    subtype,
    body,
    REQUEST_TIMEOUT_MS,
    (snac) => snac.family === family && (snac.subtype === replySubtype || snac.subtype === SNAC_ERROR),
  );
  if (reply.subtype === replySubtype) return reply.body;
  const code = reply.body.length >= 2 ? ((reply.body[0] ?? 0) << 8) | (reply.body[1] ?? 0) : 0;
  throw new OscarError({ kind: 'refused', code });
}

function idleSeconds(restore: Restore): number | null {
  const after = restore.idleAfterSeconds;
  if (after === null) return null;
  const seconds = Math.floor(restore.systemIdleSeconds());
  return seconds >= after ? seconds : null;
}

function imBytesOf(body: Uint8Array): number {
  try {
    return decodeIcbmParams(body).maxIncomingLength || DEFAULT_IM_BYTES;
  } catch {
    return DEFAULT_IM_BYTES;
  }
}

export function loginFailure(result: Extract<LoginResult, { ok: false }>): SignOnFailure {
  switch (result.reason) {
    case 'unknown-name':
      return { kind: 'unknown-screen-name' };
    case 'bad-password':
      return { kind: 'wrong-password' };
    case 'suspended':
      return { kind: 'account-unavailable', code: result.code ?? LOGIN_ERR_DELETED };
    case 'login-rate-limited':
      // The login limiter answers before the challenge; a 0x1D after it is the instance cap.
      return result.loginSent ? { kind: 'too-many-sessions' } : { kind: 'login-rate-limited' };
    default:
      return result.code === undefined ? { kind: 'unreachable' } : { kind: 'refused', code: result.code };
  }
}

export function classifyBosClose(info: CloseInfo): 'signed-off-by-server' | 'too-many-sessions' | 'dropped' {
  const evidence = dropEvidence(info, true);
  if (evidence.kind === 'signed-off') return 'signed-off-by-server';
  return evidence.kind === 'session-cap' ? 'too-many-sessions' : 'dropped';
}

export class SignOn {
  private selfInfo: SelfInfo | null = null;
  private readonly invisibleWaits = new Set<InvisibleWait>();
  private idle = false;
  private granted = 1;
  private latest: { body: Uint8Array; snapshot: UserInfoSnapshot } | null = null;
  private written: string | null = null;

  constructor(private readonly deps: SignOnDeps) {}

  get self(): SelfInfo | null {
    return this.selfInfo;
  }

  get idleReported(): boolean {
    return this.idle;
  }

  get userInfo(): UserInfoSnapshot | null {
    return this.latest?.snapshot ?? null;
  }

  handle(snac: Snac): boolean {
    if (snac.family !== FAMILY_OSERVICE) return false;
    if (snac.subtype === OSERVICE_USER_INFO_UPDATE) {
      const self = this.setSelf(parseSelfInfo(snac.body));
      for (const wait of [...this.invisibleWaits]) if (wait.armed && wait.on === self.invisible) wait.settle();
      // The server's own updates carry the session block alone, so only replies to a query list the instances.
      if ((snac.requestId & SERVER_REQUEST_ID) === 0) this.readUserInfo(snac.body);
      return true;
    }
    if (snac.subtype === OSERVICE_EVIL_NOTIFICATION) {
      const warned = decodeEvilNotification(snac.body);
      if (this.selfInfo) {
        this.selfInfo = { ...this.selfInfo, warnLevel: warned.level };
        this.deps.emitSelf?.(this.selfInfo);
      }
      this.deps.emitWarned?.(warned);
      return true;
    }
    return false;
  }

  reset(): void {
    this.selfInfo = null;
    this.idle = false;
    this.dropped();
  }

  dropped(): void {
    this.granted = 1;
    this.latest = null;
    this.written = null;
    for (const wait of [...this.invisibleWaits]) wait.settle(new OscarError({ kind: 'connection-lost' }));
  }

  async queryUserInfo(link: BosLink): Promise<UserInfoSnapshot> {
    return this.readUserInfo(await ask(link, FAMILY_OSERVICE, OSERVICE_USER_INFO_QUERY, OSERVICE_USER_INFO_UPDATE));
  }

  /** Writes the capabilities again, and no profile or away, on the online link. */
  async writeCapabilities(link: BosLink): Promise<void> {
    await link.send(FAMILY_LOCATE, LOCATE_SET_INFO, this.locateInfo({}));
  }

  /** True when the capabilities differ from the last ones written. */
  get capabilitiesChanged(): boolean {
    return this.written !== null && this.written !== capabilityKey(this.capabilities());
  }

  private locateInfo(info: { profile?: string; away?: string }): Uint8Array {
    const capabilities = this.capabilities();
    this.written = capabilityKey(capabilities);
    return encodeLocateInfo({ capabilities, ...info });
  }

  private capabilities(): readonly Uint8Array[] {
    const caps = this.deps.capabilities ?? DEFAULT_CAPABILITIES;
    const held = new Set(caps.map(toHex));
    const services = [
      ...(isOn(this.deps.sendFile) ? [CAP_SEND_FILE] : []), ...(isOn(this.deps.directIm) ? [CAP_DIRECT_IM] : []),
      ...(isOn(this.deps.getFile) ? [CAP_GET_FILE] : []), ...(this.deps.buddyIcon === true ? [CAP_BUDDY_ICON] : []),
    ];
    const added = services.filter((cap) => !held.has(toHex(cap)));
    return added.length === 0 ? caps : [...caps, ...added];
  }

  // handle() can have read this reply already, and a query returns that same snapshot.
  private readUserInfo(body: Uint8Array): UserInfoSnapshot {
    if (this.latest?.body === body) return this.latest.snapshot;
    const snapshot = readUserInfoUpdate(body, {
      at: this.deps.now(),
      multiInstance: this.granted >= OSERVICE_MULTI_INSTANCE_VERSION,
      mobileAdvertised: this.capabilities().some((cap) => toHex(cap) === MOBILE_CLIENT_HEX),
    });
    this.latest = { body, snapshot };
    this.deps.emitUserInfo?.(snapshot);
    return snapshot;
  }

  /** Resolves on the next self info that carries the new status; a liveness reply read meanwhile still carries the old one. */
  setInvisible(link: BosLink, on: boolean, timeoutMs: number = INVISIBLE_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait: InvisibleWait = {
        on,
        armed: false,
        settle: (error) => {
          if (!this.invisibleWaits.delete(wait)) return;
          if (timer !== undefined) this.deps.timers.clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        },
      };
      this.invisibleWaits.add(wait);
      link.send(FAMILY_OSERVICE, OSERVICE_SET_USER_INFO_FIELDS, encodeStatus(on)).then(
        () => {
          if (!this.invisibleWaits.has(wait)) return;
          wait.armed = true;
          timer = this.deps.timers.setTimeout(() => {
            this.deps.log.warn('the status write was not confirmed', { kind: 'timeout', invisible: on });
            wait.settle(new OscarError({ kind: 'timeout', rateLimited: link.isLimited(FAMILY_OSERVICE, OSERVICE_SET_USER_INFO_FIELDS) }));
          }, timeoutMs);
        },
        (error: Error) => wait.settle(error),
      );
    });
  }

  async reportIdle(link: BosLink, seconds: number): Promise<void> {
    await link.send(FAMILY_OSERVICE, OSERVICE_IDLE_NOTIFICATION, encodeIdle(seconds));
    this.idle = seconds > 0;
  }

  renamed(name: string): void {
    if (this.selfInfo) this.setSelf({ ...this.selfInfo, screenName: name });
  }

  // The server repeats self info in every liveness reply; only a change is news.
  private setSelf(next: SelfInfo): SelfInfo {
    const held = this.selfInfo;
    this.selfInfo = next;
    if (!held || held.screenName !== next.screenName || held.signedOnAt !== next.signedOnAt || held.warnLevel !== next.warnLevel || held.invisible !== next.invisible) {
      this.deps.emitSelf?.(next);
    }
    return next;
  }

  /** Call in the turn the BOS connection opened in, so host online is not missed. */
  async bringUp(
    link: BosLink,
    hooks: BringUpHooks,
    profile: RichText = [],
    restore?: Restore,
  ): Promise<{ self: SelfInfo; imBytes: number; awayAndProfileBytes: number; oserviceVersion: number; userFlags: number }> {
    const hostOnline = await link.waitFor(FAMILY_OSERVICE, OSERVICE_HOST_ONLINE, REQUEST_TIMEOUT_MS);
    const offered = decodeHostOnline(hostOnline.body);
    hooks.hostOnline?.(offered);
    const families = [...BOS_FOOD_GROUPS];
    if (offered.includes(BART_FOOD_GROUP)) families.push(BART_FOOD_GROUP);
    this.deps.log.debug('announcing food groups', { families });
    const asked = this.deps.oserviceVersion ?? 1;
    const versionOf = (family: number): number => (family === FAMILY_OSERVICE ? asked : FOOD_GROUP_VERSION);
    const hostVersions = await ask(link, FAMILY_OSERVICE, OSERVICE_CLIENT_VERSIONS, OSERVICE_HOST_VERSIONS, encodeClientVersions(families, versionOf));
    const oserviceVersion = Math.min(asked, decodeHostVersions(hostVersions).get(FAMILY_OSERVICE) ?? 1);
    this.granted = oserviceVersion;
    link.oserviceVersion = oserviceVersion;

    link.seedRates(decodeRateParamsReply(await ask(link, FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_QUERY, OSERVICE_RATE_PARAMS_REPLY), oserviceVersion));
    await link.send(FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_SUB_ADD, encodeClassIds(link.rateClassIds()));

    const rights = decodeLocateRights(await ask(link, FAMILY_LOCATE, LOCATE_RIGHTS_QUERY, LOCATE_RIGHTS_REPLY));
    const awayAndProfileBytes = rights.maxSignatureLength ?? DEFAULT_AWAY_AND_PROFILE_BYTES;
    const fits = encodedLocateLength(profile) <= awayAndProfileBytes;
    if (!fits) this.deps.log.warn('the profile is over the limit and was not sent', { limit: awayAndProfileBytes });
    const away = restore?.away ? { away: locateText(restore.away) } : {};
    await link.send(
      FAMILY_LOCATE,
      LOCATE_SET_INFO,
      this.locateInfo({ profile: fits ? locateText(profile) : '', ...away }),
    );

    const imBytes = imBytesOf(await ask(link, FAMILY_ICBM, ICBM_PARAM_QUERY, ICBM_PARAM_REPLY));

    await hooks.loadFeedbag();
    await hooks.useFeedbag();

    // Nothing the watchers can see goes out before the plan's invisible write.
    const userInfo = oserviceVersion >= OSERVICE_MULTI_INSTANCE_VERSION ? await this.queryUserInfo(link) : null;
    const plan = hooks.preOnline
      ? await hooks.preOnline(userInfo)
      : { invisible: restore?.invisible ?? false, reportIdle: restore !== undefined && this.idle };
    if (plan.invisible) await this.setInvisible(link, true, REQUEST_TIMEOUT_MS);
    await hooks.awayWrite?.({ awayAndProfileBytes });
    const idle = plan.reportIdle && restore ? idleSeconds(restore) : null;
    if (idle !== null) await link.send(FAMILY_OSERVICE, OSERVICE_IDLE_NOTIFICATION, encodeIdle(idle));
    this.idle = idle !== null;

    await link.send(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, encodeClientOnline(families, versionOf));
    const selfInfo = await ask(link, FAMILY_OSERVICE, OSERVICE_USER_INFO_QUERY, OSERVICE_USER_INFO_UPDATE);
    const self = this.setSelf(parseSelfInfo(selfInfo));
    return { self, imBytes, awayAndProfileBytes, oserviceVersion, userFlags: userFlags(decodeUserInfo(selfInfo, 0).info) };
  }

  async login(credentials: Credentials, server: ServerAddress, track: (conn: OscarConnection) => void): Promise<LoggedIn> {
    await this.deps.budget.take();
    const conn = await this.open({ host: server.host, port: server.port, label: 'auth', localAddress: this.deps.localAddress }, track);
    // The password goes to the hash and nowhere else: not to the log, not into an error.
    const result = await bucpLogin(
      conn,
      this.deps.timers,
      credentials.screenName,
      server.port,
      (key) => strongHash(credentials.password, key),
      { clientId: this.deps.clientId ?? FALLBACK_CLIENT_ID, multiConn: MULTI_CONN_RECENT, tokenTtlSeconds: this.deps.tokenTtlSeconds },
    );
    if (!result.ok) throw new SignOnError(loginFailure(result));
    const pin = this.deps.pinRedirects;
    const mode = redirectMode(pin, this.deps.followRedirects);
    const where = decideRedirect(mode, { ...(pin ?? server), tls: this.deps.tls !== undefined }, { host: result.host, port: result.port, ssl: result.ssl });
    if (where.refused) throw new SignOnError({ kind: 'unreachable' });
    const { screenName } = result;
    return { host: where.host, port: where.port, cookie: result.cookie, ...(screenName === undefined ? {} : { screenName }) };
  }

  openBos(ticket: BosTicket, track: (conn: OscarConnection) => void): Promise<OscarConnection> {
    return this.open({ host: ticket.host, port: ticket.port, cookie: ticket.cookie, label: 'bos', localAddress: this.deps.localAddress }, track);
  }

  private async open(
    where: { host: string; port: number; cookie?: Uint8Array; label: string; localAddress?: string | undefined },
    track: (conn: OscarConnection) => void,
  ): Promise<OscarConnection> {
    const { log, now, timers, limits } = this.deps;
    let conn: OscarConnection;
    try {
      conn = await openConnection({ ...where, ...connectionTls(this.deps.tls), log, now, timers, ...limits });
    } catch (error) {
      log.warn('could not open the connection', { conn: where.label, error: (error as Error).message });
      const refused = (error as { code?: unknown } | null)?.code === 'ECONNREFUSED';
      throw new SignOnError({ kind: 'unreachable' }, refused ? { kind: 'connect-refused' } : { kind: 'unreachable' }, { cause: error });
    }
    track(conn);
    return conn;
  }
}
