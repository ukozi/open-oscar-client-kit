import {
  ADMIN_ERR,
  ADMIN_ERROR_INVALID,
  ADMIN_ERROR_LENGTH,
  ADMIN_ERROR_NOT_SAME,
  ADMIN_INFO_CHANGE,
  ADMIN_INFO_QUERY,
  ADMIN_REQUEST_TIMEOUT_MS,
  FAMILY_ADMIN,
  decodeAdminReply,
  encodeAdminEmailQuery,
  encodeAdminFormat,
} from '../wire/admin.js';
import type { AdminReply } from '../wire/admin.js';
import { ByteReader, OscarDecodeError } from '../wire/bytes.js';
import { ConnectionClosedError, RequestTimeoutError, openConnection } from '../wire/connection.js';
import type { ConnectionLimits, OscarConnection } from '../wire/connection.js';
import { FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, OSERVICE_CLIENT_VERSIONS, OSERVICE_SERVICE_REQUEST } from '../wire/constants.js';
import { encodeClientOnline, encodeClientVersions } from '../wire/oservice.js';
import type { Logger, TimerApi } from '../wire/types.js';
import type { CommandError } from '../model/session.js';
import type { BosLink } from './bos-link.js';
import { OscarError } from './errors.js';
import { serviceResolver } from './service.js';
import { connectionTls } from './connect-options.js';
import type { ServerAddress } from './sign-on.js';

export type AccountConnection = Pick<OscarConnection, 'request' | 'send' | 'close' | 'onClose'>;

export type AccountStep = 'service' | 'connect' | 'versions' | 'request';

export type AccountDeps = {
  log: Logger;
  now: () => number;
  timers: TimerApi;
  limits?: ConnectionLimits;
  renamed(name: string): void;
  /** Opens the Admin connection with TLS. `caFile` names a PEM file of the certificates to trust. The default is plain TCP. */
  tls?: { caFile?: string };
  /** Goes to each host that the server advertises for Admin, also a loopback or unroutable one. A pinned address comes first. The default is false. */
  followRedirects?: boolean;
  open?: (grant: { host: string; port: number; cookie: Uint8Array }) => Promise<AccountConnection>;
};

type AccountOp = 'format' | 'email';
type AccountReason = Extract<CommandError, { kind: 'account' }>['reason'];

const FAMILIES = [FAMILY_OSERVICE, FAMILY_ADMIN];

const connectionLost = (): OscarError => new OscarError({ kind: 'connection-lost' });

class AdminRefusal extends Error {
  constructor(
    readonly reason: AccountReason,
    readonly code: number | undefined,
  ) {
    super(`admin refused (${reason})`);
    this.name = 'AdminRefusal';
  }
}

function changeRefusal(code: number): AccountReason {
  if (code === ADMIN_ERROR_NOT_SAME) return 'not-same';
  if (code === ADMIN_ERROR_INVALID || code === ADMIN_ERROR_LENGTH) return 'invalid';
  return 'not-offered';
}

function adminErrCode(body: Uint8Array): number | undefined {
  return body.length >= 2 ? new ByteReader(body).u16() : undefined;
}

/** Each request opens an Admin connection of its own, whose SNACs wait in BOS's rate classes: the server counts them against BOS. */
export class Account {
  private epoch = 0;
  private readonly connections = new Set<AccountConnection>();
  private readonly aborts = new Set<(error: OscarError) => void>();
  private formatting: Promise<string> | null = null;
  private reading: Promise<string | null> | null = null;

  constructor(private readonly deps: AccountDeps) {}

  format(link: BosLink, server: ServerAddress, name: string, pin?: ServerAddress): Promise<string> {
    if (this.formatting) return Promise.reject(new OscarError({ kind: 'local', code: 'busy' }));
    const running = this.run(link, server, 'format', ADMIN_INFO_CHANGE, encodeAdminFormat(name), (reply) => {
      if (reply.error !== undefined) throw new AdminRefusal(changeRefusal(reply.error), reply.error);
      // An empty TLV 0x01 is no name: renamed('') writes '' over the self info and the remembered entry.
      if (reply.screenName === undefined || reply.screenName === '') throw new OscarDecodeError('change reply with neither a name nor a code');
      this.deps.renamed(reply.screenName);
      return reply.screenName;
    }, pin).finally(() => {
      if (this.formatting === running) this.formatting = null;
    });
    this.formatting = running;
    return running;
  }

  email(link: BosLink, server: ServerAddress, pin?: ServerAddress): Promise<string | null> {
    if (this.reading) return this.reading;
    const running = this.run(link, server, 'email', ADMIN_INFO_QUERY, encodeAdminEmailQuery(), (reply) => {
      if (reply.email === undefined) throw new OscarDecodeError('info reply without an email (TLV 0x11)');
      return reply.email;
    }, pin).finally(() => {
      if (this.reading === running) this.reading = null;
    });
    this.reading = running;
    return running;
  }

  bosLost(): void {
    this.cut();
  }

  reset(): void {
    this.cut();
  }

  private cut(): void {
    this.epoch++;
    this.formatting = null;
    this.reading = null;
    for (const conn of [...this.connections]) {
      this.connections.delete(conn);
      conn.close();
    }
    for (const abort of [...this.aborts]) abort(connectionLost());
  }

  private async run<T>(
    link: BosLink,
    server: ServerAddress,
    op: AccountOp,
    subtype: number,
    body: Uint8Array,
    read: (reply: AdminReply) => T,
    pin?: ServerAddress,
  ): Promise<T> {
    const { log, now } = this.deps;
    const epoch = this.epoch;
    let step: AccountStep = 'service';
    let family = FAMILY_OSERVICE;
    let current = OSERVICE_SERVICE_REQUEST;
    let conn: AccountConnection | null = null;
    let abort: (error: OscarError) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = reject;
    });
    aborted.catch(() => {});
    this.aborts.add(abort);
    const within = <V>(work: Promise<V>): Promise<V> => Promise.race([work, aborted]);
    const at = (next: AccountStep): void => {
      step = next;
      log.debug('account request', { step, op });
    };
    try {
      at('service');
      const grant = await within(serviceResolver(link, server, now, { pin, tls: this.deps.tls, follow: this.deps.followRedirects })(FAMILY_ADMIN));
      at('connect');
      conn = await within(this.open(grant, epoch));
      const off = conn.onClose(() => abort(connectionLost()));
      try {
        at('versions');
        current = OSERVICE_CLIENT_VERSIONS;
        await within(link.paced(FAMILY_OSERVICE, OSERVICE_CLIENT_VERSIONS));
        await within(conn.request(FAMILY_OSERVICE, OSERVICE_CLIENT_VERSIONS, encodeClientVersions(FAMILIES), ADMIN_REQUEST_TIMEOUT_MS));
        await within(link.paced(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE));
        conn.send(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, encodeClientOnline(FAMILIES));
        at('request');
        family = FAMILY_ADMIN;
        current = subtype;
        await within(link.paced(FAMILY_ADMIN, subtype));
        const reply = await within(conn.request(FAMILY_ADMIN, subtype, body, ADMIN_REQUEST_TIMEOUT_MS));
        if (epoch !== this.epoch) throw connectionLost();
        if (reply.subtype === ADMIN_ERR) throw new AdminRefusal('not-offered', adminErrCode(reply.body));
        return read(decodeAdminReply(reply.body));
      } finally {
        off();
      }
    } catch (error) {
      const named = this.failure(link, step, family, current, error);
      const failure = named ?? connectionLost();
      if (epoch === this.epoch) {
        const info = failure.info;
        // A refused service's code (0x01/0x01) tells a server built without Admin from one that refuses it off BOS.
        const code = error instanceof AdminRefusal ? error.code : serviceRefusalCode(error) ?? ('code' in info ? info.code : undefined);
        log.warn('account request failed', {
          op, step, kind: info.kind, ...(code === undefined ? {} : { code }), ...(named === null ? { error: errorKind(error) } : {}),
        });
      }
      throw failure;
    } finally {
      this.aborts.delete(abort);
      if (conn && this.connections.delete(conn)) conn.close();
    }
  }

  private open(grant: { host: string; port: number; cookie: Uint8Array }, epoch: number): Promise<AccountConnection> {
    const { log, now, timers, limits } = this.deps;
    const where = { host: grant.host, port: grant.port, cookie: grant.cookie };
    const opening = this.deps.open
      ? this.deps.open(where)
      : openConnection({ ...where, ...connectionTls(this.deps.tls), label: 'admin', log, now, timers, ...limits });
    return opening.then((conn) => {
      if (epoch !== this.epoch) {
        conn.close();
        throw connectionLost();
      }
      this.connections.add(conn);
      return conn;
    });
  }

  private failure(link: BosLink, step: AccountStep, family: number, subtype: number, error: unknown): OscarError | null {
    if (error instanceof AdminRefusal) return new OscarError({ kind: 'account', reason: error.reason });
    if (error instanceof OscarError) return error;
    if (step === 'connect') return connectionLost();
    const name = error instanceof Error ? error.name : '';
    if (step === 'service' && (name === 'ServiceRefusedError' || name === 'RedirectRefusedError')) {
      return new OscarError({ kind: 'account', reason: 'not-offered' });
    }
    if (error instanceof RequestTimeoutError) return new OscarError({ kind: 'timeout', rateLimited: link.isLimited(family, subtype) });
    if (error instanceof OscarDecodeError) return new OscarError({ kind: 'refused', code: 0 });
    if (error instanceof ConnectionClosedError) return connectionLost();
    return null;
  }
}

function serviceRefusalCode(error: unknown): number | undefined {
  if (!(error instanceof Error) || error.name !== 'ServiceRefusedError' || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

// The class of an error and never its message: a message can quote what it was about.
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
