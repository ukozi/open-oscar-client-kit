import { createHash } from 'node:crypto';
import {
  BART_CLEAR_HASH,
  BART_DOWNLOAD,
  BART_DOWNLOAD_REPLY,
  BART_ERR,
  BART_FLAG_CUSTOM,
  BART_FLAG_UNKNOWN,
  BART_TYPE_BUDDY_ICON,
  BART_UPLOAD,
  BART_UPLOAD_REPLY,
  FAMILY_BART,
  decodeBartDownloadReply,
  decodeBartNotice,
  decodeBartUploadReply,
  encodeBartDownload,
  encodeBartUpload,
  isClearHash,
  userIcon,
} from '../wire/bart.js';
import type { BartId } from '../wire/bart.js';
import { toHex } from '../wire/bytes.js';
import { requestService } from '../wire/chatnav.js';
import { ConnectionClosedError, RequestTimeoutError, openConnection } from '../wire/connection.js';
import type { ConnectionLimits, OscarConnection } from '../wire/connection.js';
import {
  BUDDY_ARRIVED,
  FAMILY_BUDDY,
  FAMILY_ICBM,
  FAMILY_LOCATE,
  FAMILY_OSERVICE,
  ICBM_MSG_TO_CLIENT,
  OSERVICE_BART_REPLY,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_CLIENT_VERSIONS,
  OSERVICE_USER_INFO_UPDATE,
} from '../wire/constants.js';
import { decodeImToClient } from '../wire/icbm.js';
import { LOCATE_USER_INFO_REPLY, decodeUserInfoReply } from '../wire/locate.js';
import { encodeClientOnline, encodeClientVersions } from '../wire/oservice.js';
import { decodeSnacError, decodeUserInfo } from '../wire/snac.js';
import type { Snac, UserInfo } from '../wire/snac.js';
import type { Logger, TimerApi } from '../wire/types.js';
import { acceptIcon, isIconHash, isOwnIcon } from '../model/icon.js';
import { normalizeScreenName } from '../model/screen-name.js';
import type { BosLink } from './bos-link.js';
import { OscarError } from './errors.js';
import type { Feedbag } from './feedbag.js';
import { serviceResolver } from './service.js';
import { connectionTls } from './connect-options.js';
import type { ServerAddress } from './sign-on.js';

export interface IconStore {
  get(hash: string): Promise<Uint8Array | null>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
  remove(hash: string): Promise<void>;
}

export function memoryIconStore(): IconStore {
  const held = new Map<string, Uint8Array>();
  return {
    get: async (hash) => held.get(hash) ?? null,
    put: async (hash, bytes) => {
      held.set(hash, bytes);
    },
    remove: async (hash) => {
      held.delete(hash);
    },
  };
}

export type IconChange = { screenName: string; hash: string | null };

/** Where the client learns icons: from buddies and the user's own info only, also from IMs, Locate replies and rooms, or from nowhere. */
export type IconsFrom = 'buddies' | 'everyone' | 'none';

export const ICON_REQUEST_TIMEOUT_MS = 10_000;

/** The server writes an unreadable frame for an icon near 64 KiB: Icons leaves alone a hash suspected over this many lost connections. */
export const ICON_LOST_CONNECTION_LIMIT = 2;

export type IconRoute = { onBos: boolean; server: ServerAddress; pin?: ServerAddress };

export type IconConnection = Pick<OscarConnection, 'request' | 'close' | 'onClose'>;

export type IconsDeps = {
  log: Logger;
  now: () => number;
  timers: TimerApi;
  store: IconStore;
  limits?: ConnectionLimits;
  from: () => IconsFrom;
  /** Opens the icon service connection with TLS. `caFile` names a PEM file of the certificates to trust. The default is plain TCP. */
  tls?: { caFile?: string };
  /** Goes to each host that the server advertises for the icon service, also a loopback or unroutable one. `IconRoute.pin` comes first. The default is false. */
  followRedirects?: boolean;
  /** The user's own screen name, or null before sign-on. */
  self: () => string | null;
  emit(change: IconChange): void;
  connect?: (link: BosLink, route: IconRoute) => Promise<IconConnection>;
};

/** An icon's hash is an MD5. */
const ICON_HASH_BYTES = 16;

type Entry = { name: string; wanted: string | null; shown: string | null };
type Failure = { kind: string; bytes: number };
type Noticed = { upload: Promise<void> | null };
type OwnSet = { hex: string; bytes: Uint8Array; noticed(result: Noticed): void; fail(error: Error): void };
type ItemInfo = { flags: number; hash: Uint8Array };
type Undo = { key: string; failed: string; previous: ItemInfo };

const quiet = (): void => {};
const isUploadReply = (snac: Snac): boolean => snac.family === FAMILY_BART && (snac.subtype === BART_UPLOAD_REPLY || snac.subtype === BART_ERR);
const isDownloadReply = (snac: Snac): boolean => snac.family === FAMILY_BART && (snac.subtype === BART_DOWNLOAD_REPLY || snac.subtype === BART_ERR);
const connectionLost = (): OscarError => new OscarError({ kind: 'connection-lost' });

export class Icons {
  private readonly entries = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<boolean>>();
  private readonly discarded = new Set<string>();
  private uploads = new Map<string, Promise<void>>();
  private changing = false;
  private pendingSet: OwnSet | null = null;
  private undo: Undo | null = null;
  private suspects = new Set<string>();
  private readonly strikes = new Map<string, number>();
  private route: IconRoute | null = null;
  private service: IconConnection | null = null;
  private opening: Promise<IconConnection> | null = null;
  private epoch = 0;

  constructor(private readonly deps: IconsDeps) {}

  connected(route: IconRoute): void {
    this.route = route;
    for (const entry of this.entries.values()) {
      if (entry.shown !== entry.wanted) entry.wanted = entry.shown;
    }
  }

  see(link: BosLink, snac: Snac): void {
    if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_BART_REPLY) {
      this.noticed(link, snac.body);
      return;
    }
    if (this.deps.from() === 'none') return;
    try {
      const info = this.userInfoOf(snac);
      if (info) this.announced(link, info.name, userIcon(info));
    } catch {
      // A body that does not decode announces nothing.
    }
  }

  /** A room session often has no icon, so a user info with no icon id changes nothing here. */
  seenUser(link: BosLink, info: UserInfo): void {
    if (this.deps.from() === 'none') return;
    const id = userIcon(info);
    if (id === null) return;
    const self = this.deps.self();
    if (self !== null && normalizeScreenName(info.name) === normalizeScreenName(self)) return;
    this.announced(link, info.name, id);
  }

  private userInfoOf(snac: Snac): UserInfo | null {
    if (snac.family === FAMILY_BUDDY && snac.subtype === BUDDY_ARRIVED) return decodeUserInfo(snac.body, 0).info;
    if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_USER_INFO_UPDATE) return decodeUserInfo(snac.body, 0).info;
    if (this.deps.from() !== 'everyone') return null;
    if (snac.family === FAMILY_LOCATE && snac.subtype === LOCATE_USER_INFO_REPLY) return decodeUserInfoReply(snac.body).info;
    if (snac.family === FAMILY_ICBM && snac.subtype === ICBM_MSG_TO_CLIENT) {
      const { sender } = decodeImToClient(snac.body);
      // A stored IM names its sender and says nothing more: that is not a sender with no icon.
      return sender.tlvs.length > 0 ? sender : null;
    }
    return null;
  }

  iconOf(screenName: string): string | null {
    if (this.deps.from() === 'none') return null;
    return this.entries.get(normalizeScreenName(screenName))?.shown ?? null;
  }

  bosLost(): void {
    this.epoch++;
    for (const hex of this.suspects) {
      const count = (this.strikes.get(hex) ?? 0) + 1;
      this.strikes.set(hex, count);
      if (count === ICON_LOST_CONNECTION_LIMIT) this.deps.log.warn('an icon is left alone: connections were lost while it was asked for', { hash: hex });
    }
    this.suspects = new Set();
    this.inFlight = new Map();
    this.uploads = new Map();
    this.pendingSet?.fail(connectionLost());
    this.closeService();
  }

  reset(): void {
    this.epoch++;
    this.suspects = new Set();
    this.strikes.clear();
    this.inFlight = new Map();
    this.uploads = new Map();
    this.pendingSet?.fail(connectionLost());
    this.closeService();
    this.entries.clear();
    this.route = null;
  }

  async setOwn(link: BosLink, feedbag: Feedbag, self: string, bytes: Uint8Array): Promise<void> {
    if (!isOwnIcon(bytes)) throw new OscarError({ kind: 'local', code: 'invalid-argument' });
    if (this.changing) throw new OscarError({ kind: 'local', code: 'busy' });
    this.changing = true;
    try {
      const epoch = this.epoch;
      const copy = Uint8Array.from(bytes);
      const hash = new Uint8Array(createHash('md5').update(copy).digest());
      const hex = toHex(hash);
      this.discarded.delete(hex);
      const key = normalizeScreenName(self);
      const before = this.undo?.key === key ? this.undo.previous : (feedbag.iconInfo() ?? { flags: 0x00, hash: BART_CLEAR_HASH });
      const heldBefore = (await this.cached(hex)) !== null;
      await this.deps.store.put(hex, copy);
      try {
        await this.place(link, feedbag, { hex, hash, bytes: copy });
        if (epoch !== this.epoch) throw new OscarError({ kind: 'connection-lost' });
      } catch (error) {
        const shown = [...this.entries.values()].some((entry) => entry.shown === hex);
        if (!heldBefore && !shown) await this.deps.store.remove(hex).catch(quiet);
        await this.putBack(link, feedbag, { key, failed: hex, previous: before }, epoch);
        throw error;
      }
      if (this.undo?.key === key) this.undo = null;
      let entry = this.entries.get(key);
      if (!entry) {
        entry = { name: self, wanted: null, shown: null };
        this.entries.set(key, entry);
      }
      entry.wanted = hex;
      this.show(entry, this.discarded.has(hex) ? null : hex);
    } finally {
      this.changing = false;
    }
  }

  async clearOwn(link: BosLink, feedbag: Feedbag, self: string): Promise<void> {
    if (this.changing) throw new OscarError({ kind: 'local', code: 'busy' });
    this.changing = true;
    try {
      if (!(await feedbag.setIcon(link, { flags: 0x00, hash: BART_CLEAR_HASH }))) return;
      const key = normalizeScreenName(self);
      if (this.undo?.key === key) this.undo = null;
      const entry = this.entries.get(key);
      if (!entry) return;
      entry.wanted = null;
      this.show(entry, null);
    } finally {
      this.changing = false;
    }
  }

  async resume(link: BosLink, feedbag: Feedbag, self: string): Promise<void> {
    const undo = this.undo;
    if (!undo || undo.key !== normalizeScreenName(self) || this.changing) return;
    await this.writeBack(link, feedbag, undo);
  }

  // The item can name a hash whose bytes the server never got. The server still holds the previous icon's, so naming that asks for no upload.
  private async putBack(link: BosLink, feedbag: Feedbag, undo: Undo, epoch: number): Promise<void> {
    if (this.entries.get(undo.key)?.wanted === undo.failed) return;
    if (toHex(undo.previous.hash) === undo.failed) return;
    this.undo = undo;
    if (epoch !== this.epoch) return;
    await this.writeBack(link, feedbag, undo);
  }

  private async writeBack(link: BosLink, feedbag: Feedbag, undo: Undo): Promise<void> {
    const named = feedbag.iconInfo();
    if (named === null || toHex(named.hash) !== undo.failed) {
      if (this.undo === undo) this.undo = null;
      return;
    }
    try {
      await feedbag.setIcon(link, undo.previous);
      if (this.undo === undo) this.undo = null;
    } catch (error) {
      this.deps.log.warn('the previous icon could not be written back', failureFields(error));
    }
  }

  private async place(link: BosLink, feedbag: Feedbag, icon: { hex: string; hash: Uint8Array; bytes: Uint8Array }): Promise<void> {
    const wait: OwnSet = { hex: icon.hex, bytes: icon.bytes, noticed: quiet, fail: quiet };
    const notice = new Promise<Noticed>((resolve, reject) => {
      wait.noticed = resolve;
      wait.fail = reject;
    });
    notice.catch(quiet);
    // Before the write goes out: the server can write its notice in front of the write's confirmation.
    this.pendingSet = wait;
    try {
      await feedbag.setIcon(link, { flags: BART_FLAG_CUSTOM, hash: icon.hash });
      const timer = this.deps.timers.setTimeout(() => wait.fail(new OscarError({ kind: 'timeout', rateLimited: false })), ICON_REQUEST_TIMEOUT_MS);
      let noticed: Noticed;
      try {
        noticed = await notice;
      } finally {
        this.deps.timers.clearTimeout(timer);
      }
      if (noticed.upload) await noticed.upload;
    } finally {
      if (this.pendingSet === wait) this.pendingSet = null;
    }
  }

  // 0x01/0x21: what the server says of an icon item that was just written, and its asking for the bytes.
  private noticed(link: BosLink, body: Uint8Array): void {
    let id: BartId;
    try {
      id = decodeBartNotice(body);
    } catch {
      return;
    }
    if (id.type !== BART_TYPE_BUDDY_ICON || id.hash.length !== ICON_HASH_BYTES) return;
    const hex = toHex(id.hash);
    const set = this.pendingSet?.hex === hex ? this.pendingSet : null;
    if ((id.flags & BART_FLAG_UNKNOWN) === 0) {
      set?.noticed({ upload: null });
      return;
    }
    if (!set) {
      void this.uploadCached(link, hex);
      return;
    }
    const upload = this.upload(link, hex, set.bytes);
    upload.catch(quiet);
    set.noticed({ upload });
  }

  private async uploadCached(link: BosLink, hex: string): Promise<void> {
    const epoch = this.epoch;
    const bytes = await this.cached(hex);
    if (bytes === null || epoch !== this.epoch) return;
    try {
      await this.upload(link, hex, bytes);
    } catch (error) {
      if (epoch === this.epoch) this.deps.log.warn('an icon upload failed', { hash: hex, bytes: bytes.length, ...failureFields(error) });
    }
  }

  private upload(link: BosLink, hex: string, bytes: Uint8Array): Promise<void> {
    const running = this.uploads.get(hex);
    if (running) return running;
    const started = this.sendUpload(link, bytes).finally(() => {
      if (this.uploads.get(hex) === started) this.uploads.delete(hex);
    });
    this.uploads.set(hex, started);
    return started;
  }

  private async sendUpload(link: BosLink, bytes: Uint8Array): Promise<void> {
    const reply = await this.ask(link, BART_UPLOAD, encodeBartUpload(BART_TYPE_BUDDY_ICON, bytes), isUploadReply, false);
    if (reply.subtype === BART_ERR) throw new OscarError({ kind: 'refused', code: decodeSnacError(reply.body).code });
    const { code } = decodeBartUploadReply(reply.body);
    if (code !== 0) throw new OscarError({ kind: 'refused', code });
  }

  private async ask(link: BosLink, subtype: number, body: Uint8Array, accept: (snac: Snac) => boolean, low: boolean): Promise<Snac> {
    const route = this.route;
    if (!route) throw connectionLost();
    if (route.onBos) return link.requestMatching(FAMILY_BART, subtype, body, ICON_REQUEST_TIMEOUT_MS, accept, { low });
    const conn = await this.connection(link, route);
    // The icon connection runs on the BOS instance: its SNACs count against the rate classes of BOS.
    await link.paced(FAMILY_BART, subtype, { low });
    try {
      // Nothing but the reply carries the request's id on this connection: the server relays nobody's SNACs here.
      return await conn.request(FAMILY_BART, subtype, body, ICON_REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ConnectionClosedError) throw connectionLost();
      if (error instanceof RequestTimeoutError) throw new OscarError({ kind: 'timeout', rateLimited: link.isLimited(FAMILY_BART, subtype) });
      throw error;
    }
  }

  private connection(link: BosLink, route: IconRoute): Promise<IconConnection> {
    if (this.service) return Promise.resolve(this.service);
    if (this.opening) return this.opening;
    const epoch = this.epoch;
    const connect = this.deps.connect ?? ((l: BosLink, r: IconRoute) => this.connect(l, r));
    const opening = connect(link, route)
      .then(
        (conn) => {
          if (epoch !== this.epoch) {
            conn.close();
            throw connectionLost();
          }
          this.service = conn;
          conn.onClose(() => {
            if (this.service === conn) this.service = null;
          });
          return conn;
        },
        (error: unknown) => {
          if (epoch === this.epoch) this.deps.log.warn('the icon connection could not be opened', failureFields(error));
          throw connectionLost();
        },
      )
      .finally(() => {
        if (this.opening === opening) this.opening = null;
      });
    this.opening = opening;
    return opening;
  }

  // Client versions, which the server answers, then client online, which it does not, before anything else goes out.
  private async connect(link: BosLink, route: IconRoute): Promise<IconConnection> {
    const { log, now, timers, limits, tls, followRedirects: follow } = this.deps;
    const grant = await requestService(serviceResolver(link, route.server, now, { pin: route.pin, tls, follow }), { foodGroup: FAMILY_BART, screenName: '' });
    const conn = await openConnection({ host: grant.host, port: grant.port, cookie: grant.cookie, ...connectionTls(tls), label: 'bart', log, now, timers, ...limits });
    const families = [FAMILY_OSERVICE, FAMILY_BART];
    try {
      await link.paced(FAMILY_OSERVICE, OSERVICE_CLIENT_VERSIONS);
      await conn.request(FAMILY_OSERVICE, OSERVICE_CLIENT_VERSIONS, encodeClientVersions(families), ICON_REQUEST_TIMEOUT_MS);
      await link.paced(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE);
      conn.send(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, encodeClientOnline(families));
    } catch (error) {
      conn.close();
      throw error;
    }
    return conn;
  }

  private closeService(): void {
    const conn = this.service;
    this.service = null;
    this.opening = null;
    conn?.close();
  }

  async discard(hash: string): Promise<void> {
    if (!isIconHash(hash)) return;
    if (!this.discarded.has(hash)) this.deps.log.warn('an icon that could not be shown was discarded', { hash });
    this.discarded.add(hash);
    for (const entry of [...this.entries.values()]) {
      if (entry.shown === hash) this.show(entry, null);
    }
    try {
      await this.deps.store.remove(hash);
    } catch (error) {
      this.deps.log.warn('a discarded icon could not be taken out of the cache', { hash, error: errorKind(error) });
    }
  }

  private announced(link: BosLink, name: string, id: BartId | null): void {
    const key = normalizeScreenName(name);
    let entry = this.entries.get(key);
    if (id === null || isClearHash(id.hash) || id.hash.length !== ICON_HASH_BYTES) {
      if (!entry) return;
      entry.name = name;
      entry.wanted = null;
      this.show(entry, null);
      return;
    }
    // The server does not hold the bytes yet: the update that follows the upload decides.
    if ((id.flags & BART_FLAG_UNKNOWN) !== 0) return;
    const hex = toHex(id.hash);
    if (this.undo?.key === key && this.undo.failed === hex) return;
    if (!entry) {
      entry = { name, wanted: null, shown: null };
      this.entries.set(key, entry);
    }
    entry.name = name;
    if (entry.wanted === hex) return;
    entry.wanted = hex;
    if (this.discarded.has(hex) || (this.strikes.get(hex) ?? 0) >= ICON_LOST_CONNECTION_LIMIT) {
      this.show(entry, null);
      return;
    }
    this.resolve(link, key, name, id, hex);
  }

  private show(entry: Entry, hash: string | null): void {
    if (entry.shown === hash) return;
    entry.shown = hash;
    this.deps.emit({ screenName: entry.name, hash });
  }

  private resolve(link: BosLink, key: string, name: string, id: BartId, hex: string): void {
    const epoch = this.epoch;
    void this.obtain(link, name, id, hex).then((accepted) => {
      if (epoch !== this.epoch) return;
      const entry = this.entries.get(key);
      if (!entry || entry.wanted !== hex) return;
      this.show(entry, accepted && !this.discarded.has(hex) ? hex : null);
    });
  }

  private obtain(link: BosLink, name: string, id: BartId, hex: string): Promise<boolean> {
    const running = this.inFlight.get(hex);
    if (running) return running;
    const started = this.load(link, name, id, hex).finally(() => {
      if (this.inFlight.get(hex) === started) this.inFlight.delete(hex);
    });
    this.inFlight.set(hex, started);
    return started;
  }

  private async load(link: BosLink, name: string, id: BartId, hex: string): Promise<boolean> {
    const epoch = this.epoch;
    const cached = await this.cached(hex);
    if (cached !== null && acceptIcon(cached) !== null) return true;
    if (epoch !== this.epoch || this.discarded.has(hex)) return false;
    const failure = await this.download(link, name, id, hex, epoch);
    if (failure === null) return true;
    if (epoch === this.epoch) this.deps.log.warn('an icon download failed', failure);
    return false;
  }

  private async cached(hex: string): Promise<Uint8Array | null> {
    try {
      return await this.deps.store.get(hex);
    } catch (error) {
      this.deps.log.warn('the icon cache could not be read', { hash: hex, error: errorKind(error) });
      return null;
    }
  }

  private async download(link: BosLink, name: string, id: BartId, hex: string, epoch: number): Promise<Failure | null> {
    // A reply the server cannot frame ends the connection that carries it; only on BOS does the hash become a suspect.
    const suspects = this.route?.onBos === true ? this.suspects : null;
    suspects?.add(hex);
    let reply: Snac;
    try {
      reply = await this.ask(link, BART_DOWNLOAD, encodeBartDownload(name, id), isDownloadReply, true);
    } catch (error) {
      const kind = failureKind(error);
      if (kind !== 'connection-lost') suspects?.delete(hex);
      return { kind, bytes: 0 };
    }
    if (reply.family !== FAMILY_BART || reply.subtype !== BART_DOWNLOAD_REPLY) {
      suspects?.delete(hex);
      return { kind: 'refused', bytes: 0 };
    }
    let data: Uint8Array;
    try {
      const decoded = decodeBartDownloadReply(reply.body);
      suspects?.delete(hex);
      if (toHex(decoded.id.hash) !== hex) return { kind: 'other-hash', bytes: decoded.data.length };
      data = decoded.data;
    } catch {
      // A reply cut short is what a frame with a wrapped length starts with: it stays a suspect.
      return { kind: 'malformed', bytes: reply.body.length };
    }
    // What the server answers for a hash it holds nothing under.
    if (data.length === 0) return { kind: 'empty', bytes: 0 };
    if (acceptIcon(data) === null) return { kind: 'not-an-icon', bytes: data.length };
    if (epoch !== this.epoch) return { kind: 'connection-lost', bytes: data.length };
    if (this.discarded.has(hex)) return { kind: 'discarded', bytes: data.length };
    try {
      await this.deps.store.put(hex, data);
    } catch (error) {
      return { kind: `cache-${errorKind(error)}`, bytes: data.length };
    }
    if (this.discarded.has(hex)) {
      await this.deps.store.remove(hex).catch(() => {});
      return { kind: 'discarded', bytes: data.length };
    }
    return null;
  }
}

function failureKind(error: unknown): string {
  if (!(error instanceof OscarError)) return errorKind(error);
  return error.info.kind === 'local' ? error.info.code : error.info.kind;
}

function failureFields(error: unknown): { kind: string; code?: number | string } {
  if (!(error instanceof OscarError)) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return typeof code === 'number' || typeof code === 'string' ? { kind: errorKind(error), code } : { kind: errorKind(error) };
  }
  const info = error.info;
  return 'code' in info ? { kind: info.kind, code: info.code } : { kind: info.kind };
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
