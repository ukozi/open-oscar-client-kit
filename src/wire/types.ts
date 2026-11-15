export type LogFn = (msg: string, f?: Record<string, unknown>) => void;
export type Logger = { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn };

export type TimerApi = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

export type RoomRef = { exchange: 4 | 5; name: string };

export type StateReason =
  | 'bad-password'
  | 'unknown-name'
  | 'suspended'
  | 'login-rate-limited'
  | 'redirect-unroutable'
  | 'disconnected-by-server'
  | 'md5-unavailable'
  | 'network'
  | 'tls'
  | 'unauthenticated-server';

export type SendPriority = 'reply' | 'control' | 'notice';
export type SendReceipt = { id: string; storedOffline: boolean };
// A redirect after the redirect rule; the cookie lasts 60 s and `expiresAt` is on the session clock, in ms.
export type ServiceGrant = { host: string; port: number; cookie: Uint8Array; pinned: boolean; expiresAt: number };
export type SendErrorCode =
  | 'rate-limited'
  | 'not-online'
  | 'recipient-unavailable'
  | 'room-not-joined'
  | 'too-long'
  | 'closed';

export class OscarSendError extends Error {
  readonly code: SendErrorCode;

  constructor(code: SendErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'OscarSendError';
    this.code = code;
  }
}

export type SnacIn = { family: number; subtype: number; requestId: number; body: Uint8Array };
export type LinkClose = { clean: boolean };
export interface SnacLink {
  send(family: number, subtype: number, body: Uint8Array): number;
  request(family: number, subtype: number, body: Uint8Array, timeoutMs?: number): Promise<SnacIn>;
  onSnac(fn: (snac: SnacIn) => void): () => void;
  onClose(fn: (info: LinkClose) => void): () => void;
  close(): void;
}
export type RoomErrorCode = 'no-such-room' | 'too-long' | 'not-online' | 'unavailable';
export class OscarRoomError extends Error {
  readonly code: RoomErrorCode;
  constructor(code: RoomErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'OscarRoomError';
    this.code = code;
  }
}
