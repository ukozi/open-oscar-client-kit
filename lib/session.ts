import { clientIdFor } from '../src/client/client-id.js';
import { OscarError, SignOnError } from '../src/client/errors.js';
import { OscarClient } from '../src/client/oscar-client.js';
import type { OscarClientOptions } from '../src/client/oscar-client.js';
import { desktopReconnectPolicy } from '../src/client/reconnect.js';
import type { ReconnectPolicy } from '../src/client/reconnect.js';
import { richTextToAimHtml } from '../src/client/aim-html.js';
import type { BuddyPresence } from '../src/model/buddy-list.js';
import { normalizeScreenName } from '../src/model/screen-name.js';
import { APP_NAME_INVALID, IM_EMPTY, SIGN_ON_FAILED } from './text.js';
import { VERSION } from './version.js';

export type SignOnOptions = {
  screenName: string;
  password: string;
  app: string;
  server: { host: string; port: number };
  reconnect?: boolean;
};
export type Im = { from: string; text: string; html: string; autoResponse: boolean; at: number };
export type Buddy = { screenName: string; group: string; online: boolean; away: boolean; idleSince: number | null };
export type SessionEvents = {
  im: Im;
  buddy: Buddy;
  warned: { level: number; by: string | null };
  rateLimited: { limited: boolean };
  reconnecting: { attempt: number; inMs: number };
  online: Record<string, never>;
  signedOff: { reason: string };
};

export class SignOnFailedError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(SIGN_ON_FAILED(kind));
    this.name = 'SignOnFailedError';
    this.kind = kind;
  }
}

const APP_NAME = /^[\x20-\x7e]{1,64}$/;
type Listeners = { [E in keyof SessionEvents]: Set<(payload: SessionEvents[E]) => void> };

const giveUp: ReconnectPolicy = { next: () => ({ retry: false, reason: { kind: 'unreachable' } }) };

// Only openSession makes a Session, so the constructor stays out of the public API.
let createSession: (client: OscarClient, screenName: string) => Session;

export class Session {
  readonly screenName: string;
  readonly #client: OscarClient;
  readonly #listeners: Listeners = {
    im: new Set(),
    buddy: new Set(),
    warned: new Set(),
    rateLimited: new Set(),
    reconnecting: new Set(),
    online: new Set(),
    signedOff: new Set(),
  };
  #wasOnline = false;

  static {
    createSession = (client, screenName) => new Session(client, screenName);
  }

  private constructor(client: OscarClient, screenName: string) {
    this.#client = client;
    this.screenName = screenName;
    this.#attach();
  }

  on<E extends keyof SessionEvents>(event: E, listener: (payload: SessionEvents[E]) => void): () => void {
    const set: Set<(payload: SessionEvents[E]) => void> = this.#listeners[event];
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  async sendIm(to: string, text: string): Promise<void> {
    if (text === '') throw new TypeError(IM_EMPTY);
    await this.#client.sendIm(to, [{ text }]);
  }

  buddies(): Buddy[] {
    return this.#client
      .buddyList()
      .groups.flatMap((group) =>
        group.buddies.map((buddy) => toBuddy(buddy.screenName, group.name, this.#client.presenceOf(buddy.screenName))),
      );
  }

  signOff(): Promise<void> {
    return this.#client.signOff();
  }

  #attach(): void {
    const client = this.#client;
    client.on('im', (im) => {
      if (im.serverNotice) return;
      this.#emit('im', {
        from: im.from,
        text: im.body.map((run) => run.text).join(''),
        html: richTextToAimHtml(im.body),
        autoResponse: im.autoResponse,
        at: im.at,
      });
    });
    client.on('presence', (presence) => {
      this.#emit('buddy', toBuddy(presence.screenName, this.#groupOf(presence.screenName), presence));
    });
    client.on('warned', (warned) => this.#emit('warned', warned));
    client.on('rate', (rate) => this.#emit('rateLimited', rate));
    client.on('state', ({ state, reason, reconnect }) => {
      if (state === 'online') {
        this.#wasOnline = true;
        this.#emit('online', {});
      } else if (state === 'reconnecting' && reconnect) {
        this.#emit('reconnecting', { attempt: reconnect.attempt, inMs: Math.round(reconnect.nextRetryAt - Date.now()) });
      } else if (state === 'offline' && this.#wasOnline) {
        this.#wasOnline = false;
        this.#emit('signedOff', { reason: reason?.kind ?? 'signed-off' });
      }
    });
  }

  #groupOf(screenName: string): string {
    const name = normalizeScreenName(screenName);
    const group = this.#client
      .buddyList()
      .groups.find((g) => g.buddies.some((buddy) => normalizeScreenName(buddy.screenName) === name));
    return group?.name ?? '';
  }

  #emit<E extends keyof SessionEvents>(event: E, payload: SessionEvents[E]): void {
    const set: Set<(payload: SessionEvents[E]) => void> = this.#listeners[event];
    for (const listener of [...set]) {
      try {
        const result: unknown = listener(payload);
        if (result instanceof Promise) result.catch(warn);
      } catch (error) {
        warn(error);
      }
    }
  }
}

function warn(error: unknown): void {
  process.emitWarning(error instanceof Error ? error : new Error(String(error)));
}

function toBuddy(screenName: string, group: string, presence: BuddyPresence | undefined): Buddy {
  return {
    screenName,
    group,
    online: presence?.online ?? false,
    away: presence?.away ?? false,
    idleSince: presence?.idleSince ?? null,
  };
}

export async function openSession(options: SignOnOptions, clientOptions: Partial<OscarClientOptions> = {}): Promise<Session> {
  if (!APP_NAME.test(options.app)) throw new TypeError(APP_NAME_INVALID);
  const random = (): number => Math.random() * 2 - 1;
  const client = new OscarClient({
    clientId: clientIdFor(`${options.app} (open-oscar-client-kit)`, VERSION, process.platform),
    reconnect: options.reconnect === false ? giveUp : desktopReconnectPolicy(random),
    random,
    ...clientOptions,
  });
  const session = createSession(client, options.screenName);
  try {
    await client.signOn({ screenName: options.screenName, password: options.password }, options.server);
  } catch (error) {
    if (error instanceof SignOnError) throw new SignOnFailedError(error.failure.kind);
    if (error instanceof OscarError && error.info.kind === 'local' && error.info.code === 'invalid-screen-name') {
      throw new SignOnFailedError('invalid-screen-name');
    }
    throw error;
  }
  return session;
}
