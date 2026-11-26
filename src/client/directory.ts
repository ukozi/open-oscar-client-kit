import { ByteReader, OscarDecodeError } from '../wire/bytes.js';
import { ConnectionClosedError, RequestTimeoutError, openConnection } from '../wire/connection.js';
import type { ConnectionLimits, OscarConnection } from '../wire/connection.js';
import { FAMILY_LOCATE, FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, OSERVICE_CLIENT_VERSIONS } from '../wire/constants.js';
import {
  LOCATE_ERR,
  LOCATE_GET_DIR_INFO,
  LOCATE_GET_DIR_REPLY,
  LOCATE_SET_DIR_INFO,
  LOCATE_SET_DIR_REPLY,
  LOCATE_SET_KEYWORD_INFO,
  LOCATE_SET_KEYWORD_REPLY,
} from '../wire/locate.js';
import {
  FAMILY_ODIR,
  MAX_INTERESTS,
  ODIR_ERR,
  ODIR_INFO_QUERY,
  ODIR_KEYWORD_LIST_QUERY,
  decodeGetDirReply,
  decodeInfoReply,
  decodeKeywordListReply,
  encodeGetDirInfo,
  encodeInterestSearch,
  encodeNameSearch,
  encodeSetDirInfo,
  encodeSetKeywordInfo,
} from '../wire/odir.js';
import type { DirListing, DirResult, KeywordGroup } from '../wire/odir.js';
import { ServiceRefusedError, encodeClientOnline, encodeClientVersions } from '../wire/oservice.js';
import type { Snac } from '../wire/snac.js';
import type { Logger, TimerApi } from '../wire/types.js';
import type { BosLink } from './bos-link.js';
import { OscarError } from './errors.js';
import { serviceResolver, serviceVersions } from './service.js';
import { connectionTls } from './connect-options.js';
import type { ServerAddress } from './sign-on.js';

export const DIRECTORY_REQUEST_TIMEOUT_MS = 15_000;

export type DirectoryConnection = Pick<OscarConnection, 'request' | 'send' | 'close' | 'onClose'>;

export type DirectoryDeps = {
  log: Logger;
  now: () => number;
  timers: TimerApi;
  limits?: ConnectionLimits;
  pin?: ServerAddress;
  /** Opens the ODir connection with TLS. `caFile` names a PEM file of the certificates to trust. The default is plain TCP. */
  tls?: { caFile?: string };
  /** Goes to each host that the server advertises for ODir, also a loopback or unroutable one. `pin` comes first. The default is false. */
  followRedirects?: boolean;
  open?: (grant: { host: string; port: number; cookie: Uint8Array }) => Promise<DirectoryConnection>;
};

/** The server refused the ODir service: it has no directory, for the rest of the session. */
export class NoDirectoryError extends Error {
  constructor() {
    super('the server has no directory');
    this.name = 'NoDirectoryError';
  }
}

const FAMILIES = [FAMILY_OSERVICE, FAMILY_ODIR];
const NO_DIRECTORY_CODES = new Set([0x0008, 0x0005]);
const ODIR_SEARCH_OK = 0x0005;
const LOCATE_SET_DIR_OK = 0x0001;

const connectionLost = (): OscarError => new OscarError({ kind: 'connection-lost' });
const invalid = (): OscarError => new OscarError({ kind: 'local', code: 'invalid-argument' });

function errorCode(body: Uint8Array): number {
  return body.length >= 2 ? new ByteReader(body).u16() : 0;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// Listing and interests go over Locate on BOS. Search and the keyword list go over an ODir connection opened at first
// use, as Icons opens its icon connection. A service request refused as unsupported (0x0008) or unavailable (0x0005)
// means no directory for the session, and later ODir calls throw NoDirectoryError at once.
export class Directory {
  private known: boolean | null = null;
  private service: DirectoryConnection | null = null;
  private opening: Promise<DirectoryConnection> | null = null;
  private readonly aborts = new Set<(error: OscarError) => void>();
  private epoch = 0;

  constructor(private readonly deps: DirectoryDeps) {}

  available(): boolean | null {
    return this.known;
  }

  async keywords(link: BosLink, server: ServerAddress): Promise<KeywordGroup[]> {
    const reply = await this.ask(link, server, ODIR_KEYWORD_LIST_QUERY, new Uint8Array(0));
    return this.read(() => decodeKeywordListReply(reply.body));
  }

  async searchByName(link: BosLink, server: ServerAddress, first: string, last: string): Promise<DirResult[]> {
    if (first.trim() === '' && last.trim() === '') throw invalid();
    return this.search(link, server, encodeNameSearch(first, last));
  }

  async searchByInterest(link: BosLink, server: ServerAddress, keyword: string): Promise<DirResult[]> {
    if (keyword === '') throw invalid();
    return this.search(link, server, encodeInterestSearch(keyword));
  }

  async ownListing(link: BosLink, screenName: string): Promise<DirListing> {
    const reply = await this.locate(link, LOCATE_GET_DIR_INFO, LOCATE_GET_DIR_REPLY, encodeGetDirInfo(screenName));
    const decoded = this.read(() => decodeGetDirReply(reply.body));
    if (!decoded.ok) throw new OscarError({ kind: 'refused', code: 0 });
    return decoded.listing;
  }

  async setListing(link: BosLink, listing: DirListing): Promise<void> {
    const reply = await this.locate(link, LOCATE_SET_DIR_INFO, LOCATE_SET_DIR_REPLY, encodeSetDirInfo(listing));
    const result = this.read(() => new ByteReader(reply.body).u16());
    if (result !== LOCATE_SET_DIR_OK) throw new OscarError({ kind: 'refused', code: result });
  }

  async setInterests(link: BosLink, interests: readonly string[]): Promise<void> {
    if (interests.length > MAX_INTERESTS) throw invalid();
    await this.locate(link, LOCATE_SET_KEYWORD_INFO, LOCATE_SET_KEYWORD_REPLY, encodeSetKeywordInfo(interests));
  }

  bosLost(): void {
    this.cut();
  }

  close(): void {
    this.cut();
    this.known = null;
  }

  private cut(): void {
    this.epoch++;
    const conn = this.service;
    this.service = null;
    this.opening = null;
    conn?.close();
    for (const abort of [...this.aborts]) abort(connectionLost());
  }

  private async search(link: BosLink, server: ServerAddress, body: Uint8Array): Promise<DirResult[]> {
    const reply = await this.ask(link, server, ODIR_INFO_QUERY, body);
    const { status, results } = this.read(() => decodeInfoReply(reply.body));
    if (status !== ODIR_SEARCH_OK) throw new OscarError({ kind: 'refused', code: status });
    return results;
  }

  // A reply that does not decode is a refusal with no code, never with its bytes.
  private read<T>(decode: () => T): T {
    try {
      return decode();
    } catch (error) {
      if (error instanceof OscarDecodeError || error instanceof RangeError) {
        this.deps.log.warn('a directory reply could not be read', { error: errorKind(error) });
        throw new OscarError({ kind: 'refused', code: 0 });
      }
      throw error;
    }
  }

  private async locate(link: BosLink, subtype: number, replySubtype: number, body: Uint8Array): Promise<Snac> {
    const reply = await link.requestMatching(
      FAMILY_LOCATE,
      subtype,
      body,
      DIRECTORY_REQUEST_TIMEOUT_MS,
      (snac) => snac.family === FAMILY_LOCATE && (snac.subtype === replySubtype || snac.subtype === LOCATE_ERR),
    );
    if (reply.subtype === LOCATE_ERR) throw new OscarError({ kind: 'refused', code: errorCode(reply.body) });
    return reply;
  }

  private async ask(link: BosLink, server: ServerAddress, subtype: number, body: Uint8Array): Promise<Snac> {
    if (this.known === false) throw new NoDirectoryError();
    const epoch = this.epoch;
    let abort: (error: OscarError) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = reject;
    });
    aborted.catch(() => {});
    this.aborts.add(abort);
    try {
      const conn = await Promise.race([this.connection(link, server), aborted]);
      await Promise.race([link.paced(FAMILY_ODIR, subtype), aborted]);
      const reply = await Promise.race([conn.request(FAMILY_ODIR, subtype, body, DIRECTORY_REQUEST_TIMEOUT_MS), aborted]);
      if (epoch !== this.epoch) throw connectionLost();
      if (reply.subtype === ODIR_ERR) throw new OscarError({ kind: 'refused', code: errorCode(reply.body) });
      return reply;
    } catch (error) {
      if (error instanceof OscarError) throw error;
      if (error instanceof ConnectionClosedError) throw connectionLost();
      if (error instanceof RequestTimeoutError) throw new OscarError({ kind: 'timeout', rateLimited: link.isLimited(FAMILY_ODIR, subtype) });
      throw error;
    } finally {
      this.aborts.delete(abort);
    }
  }

  private connection(link: BosLink, server: ServerAddress): Promise<DirectoryConnection> {
    if (this.service) return Promise.resolve(this.service);
    if (this.opening) return this.opening;
    const epoch = this.epoch;
    const opening = this.connect(link, server, epoch)
      .then(
        (conn) => {
          if (epoch !== this.epoch) {
            conn.close();
            throw connectionLost();
          }
          this.known = true;
          this.service = conn;
          conn.onClose(() => {
            if (this.service === conn) this.service = null;
          });
          return conn;
        },
        (error: unknown) => {
          if (epoch !== this.epoch) throw connectionLost();
          if (error instanceof ServiceRefusedError && NO_DIRECTORY_CODES.has(error.code)) {
            this.known = false;
            this.deps.log.info('the server has no directory', { code: error.code });
            throw new NoDirectoryError();
          }
          this.deps.log.warn('the directory connection could not be opened', {
            error: errorKind(error),
            ...(error instanceof ServiceRefusedError ? { code: error.code } : {}),
          });
          if (error instanceof ServiceRefusedError) throw new OscarError({ kind: 'refused', code: error.code });
          if (error instanceof OscarError) throw error;
          throw connectionLost();
        },
      )
      .finally(() => {
        if (this.opening === opening) this.opening = null;
      });
    this.opening = opening;
    return opening;
  }

  private async connect(link: BosLink, server: ServerAddress, epoch: number): Promise<DirectoryConnection> {
    const { log, now, timers, limits, pin, tls, followRedirects: follow } = this.deps;
    const grant = await serviceResolver(link, server, now, { pin, tls, follow })(FAMILY_ODIR);
    if (epoch !== this.epoch) throw connectionLost();
    const where = { host: grant.host, port: grant.port, cookie: grant.cookie };
    const conn = await (this.deps.open ? this.deps.open(where) : openConnection({ ...where, ...connectionTls(tls), label: 'odir', log, now, timers, ...limits }));
    try {
      await link.paced(FAMILY_OSERVICE, OSERVICE_CLIENT_VERSIONS);
      await conn.request(FAMILY_OSERVICE, OSERVICE_CLIENT_VERSIONS, encodeClientVersions(FAMILIES, serviceVersions(link)), DIRECTORY_REQUEST_TIMEOUT_MS);
      await link.paced(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE);
      conn.send(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, encodeClientOnline(FAMILIES, serviceVersions(link)));
    } catch (error) {
      conn.close();
      throw error;
    }
    return conn;
  }
}
