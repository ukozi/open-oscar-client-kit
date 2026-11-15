import type { OscarConnection } from '../wire/connection.js';
import { SignOn } from './sign-on.js';
import type { BosTicket, Credentials, ServerAddress, SignOnDeps } from './sign-on.js';

export type IssuedTicket = {
  ticket: BosTicket;
  source: 'bucp' | 'stored' | 'adapter';
  obtainedAt: number;
  expiresAt: number | null;
  /** TLV 0x01 of the login reply, when it has one. The server echoes the name sent; the formatted name is in self info once online. */
  screenName?: string;
};
export type TicketRequest = { reconnect: boolean; track(conn: OscarConnection): void };
/** Asked once at every connect; rejects with `SignOnError`. */
export interface TicketSource {
  ticket(request: TicketRequest): Promise<IssuedTicket>;
}
export type BucpTicketOptions = SignOnDeps & { credentials: Credentials; server: ServerAddress; readExpiry?: (cookie: Uint8Array) => number | null };
export type StoredTicketSource = TicketSource & { readonly current: IssuedTicket; replace(next: IssuedTicket): void };

export function bucpTicketSource(opts: BucpTicketOptions): TicketSource {
  const { credentials, server, readExpiry, ...deps } = opts;
  const signOn = new SignOn(deps);
  return {
    async ticket(request) {
      const { screenName, ...ticket } = await signOn.login(credentials, server, request.track);
      return {
        ticket,
        source: 'bucp',
        obtainedAt: deps.now(),
        expiresAt: readExpiry?.(ticket.cookie) ?? null,
        ...(screenName === undefined ? {} : { screenName }),
      };
    },
  };
}

export function storedTicketSource(initial: IssuedTicket): StoredTicketSource {
  let current = initial;
  return {
    get current() {
      return current;
    },
    replace(next) {
      current = next;
    },
    async ticket() {
      return current;
    },
  };
}

export function adapterTicketSource(issue: (request: TicketRequest) => Promise<IssuedTicket>): TicketSource {
  return { ticket: (request) => issue(request) };
}
