import * as text from './text.js';

export const PROTOCOL_VERSION = 1;

export type SignOnErrorKind =
  | 'wrong-password'
  | 'unknown-screen-name'
  | 'login-rate-limited'
  | 'too-many-sessions'
  | 'unreachable'
  | 'refused'
  | 'other';

export type Command =
  | { id: number; op: 'signOn'; host: string; port: number; screenName: string; password: string }
  | { id: number; op: 'sendIm'; to: string; text: string }
  | { id: number; op: 'buddies' }
  | { id: number; op: 'signOff' }
  | { id: number; op: 'exit' };

export type DriverBuddy = { screenName: string; online: boolean; away: boolean };

export type Reply =
  | { id: number; ok: true; buddies?: DriverBuddy[] }
  | { id: number; ok: false; error: string };

export type DriverEvent =
  | { event: 'online' }
  | { event: 'im'; from: string; text: string }
  | { event: 'buddy'; screenName: string; online: boolean; away: boolean }
  | { event: 'warned'; level: number }
  | { event: 'rateLimited'; limited: boolean }
  | { event: 'reconnecting'; attempt: number; inMs: number }
  | { event: 'signedOff'; reason: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function encodeLine(value: Command | Reply | DriverEvent): string {
  return `${JSON.stringify(value)}\n`;
}

export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split('\n');
    this.rest = parts.pop() ?? '';
    return parts.filter((line) => line !== '');
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const EVENT_FIELDS: Record<string, Record<string, 'string' | 'number' | 'boolean'>> = {
  online: {},
  im: { from: 'string', text: 'string' },
  buddy: { screenName: 'string', online: 'boolean', away: 'boolean' },
  warned: { level: 'number' },
  rateLimited: { limited: 'boolean' },
  reconnecting: { attempt: 'number', inMs: 'number' },
  signedOff: { reason: 'string' },
};

const isBuddyList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      isRecord(item) &&
      typeof item.screenName === 'string' &&
      typeof item.online === 'boolean' &&
      typeof item.away === 'boolean',
  );

export function parseDriverLine(line: string): Reply | DriverEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError(text.NOT_JSON(line));
  }
  if (!isRecord(value)) throw new ProtocolError(text.NOT_OBJECT(line));
  if (typeof value.event === 'string') {
    const fields = EVENT_FIELDS[value.event];
    if (!fields) throw new ProtocolError(text.UNKNOWN_EVENT(value.event));
    for (const [name, type] of Object.entries(fields)) {
      if (typeof value[name] !== type) throw new ProtocolError(text.EVENT_FIELD(value.event, name, type));
    }
    return value as DriverEvent;
  }
  if (typeof value.id !== 'number' || typeof value.ok !== 'boolean') {
    throw new ProtocolError(text.NEITHER(line));
  }
  if (!value.ok && typeof value.error !== 'string') throw new ProtocolError(text.FAILED_NEEDS_ERROR);
  if (value.ok && value.buddies !== undefined && !isBuddyList(value.buddies)) {
    throw new ProtocolError(text.BAD_BUDDIES);
  }
  return value as Reply;
}
