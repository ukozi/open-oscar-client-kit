import { createInterface } from 'node:readline';
import { SignOnFailedError, signOn } from '../lib/index.js';
import type { Session } from '../lib/index.js';
import { encodeLine } from './protocol.js';
import type { Command, DriverEvent, Reply, SignOnErrorKind } from './protocol.js';
import * as text from './text.js';

const KINDS: readonly string[] = [
  'wrong-password',
  'unknown-screen-name',
  'login-rate-limited',
  'too-many-sessions',
  'unreachable',
  'refused',
] satisfies SignOnErrorKind[];

const write = (value: Reply | DriverEvent): void => {
  process.stdout.write(encodeLine(value));
};

let session: Session | undefined;

async function handle(cmd: Command): Promise<Reply> {
  const { id } = cmd;
  try {
    switch (cmd.op) {
      case 'signOn': {
        session = await signOn({
          screenName: cmd.screenName,
          password: cmd.password,
          app: text.DRIVER_APP,
          server: { host: cmd.host, port: cmd.port },
        });
        forward(session);
        // The session was already online before the listeners existed.
        setImmediate(() => write({ event: 'online' }));
        return { id, ok: true };
      }
      case 'sendIm':
        await need().sendIm(cmd.to, cmd.text);
        return { id, ok: true };
      case 'buddies':
        return {
          id,
          ok: true,
          buddies: need()
            .buddies()
            .map(({ screenName, online, away }) => ({ screenName, online, away })),
        };
      case 'signOff':
        await need().signOff();
        return { id, ok: true };
      case 'exit':
        await session?.signOff().catch(() => {});
        return { id, ok: true };
      default:
        return { id, ok: false, error: 'other' };
    }
  } catch (error) {
    const kind = error instanceof SignOnFailedError && KINDS.includes(error.kind) ? error.kind : 'other';
    return { id, ok: false, error: kind };
  }
}

function hasId(value: unknown): value is { id: number } {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number';
}

function need(): Session {
  if (!session) throw new Error(text.NOT_SIGNED_ON);
  return session;
}

function forward(s: Session): void {
  s.on('online', () => write({ event: 'online' }));
  s.on('im', (im) => write({ event: 'im', from: im.from, text: im.text }));
  s.on('buddy', (b) => write({ event: 'buddy', screenName: b.screenName, online: b.online, away: b.away }));
  s.on('warned', (w) => write({ event: 'warned', level: w.level }));
  s.on('rateLimited', (r) => write({ event: 'rateLimited', limited: r.limited }));
  s.on('reconnecting', (r) => write({ event: 'reconnecting', attempt: r.attempt, inMs: r.inMs }));
  s.on('signedOff', (o) => write({ event: 'signedOff', reason: o.reason }));
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    process.stderr.write(`${text.NOT_JSON(line)}\n`);
    continue;
  }
  if (!hasId(value)) {
    process.stderr.write(`${text.NO_COMMAND(line)}\n`);
    continue;
  }
  const cmd = value as Command;
  const reply = await handle(cmd);
  if (cmd.op === 'exit') process.stdout.write(encodeLine(reply), () => process.exit(0));
  else write(reply);
}
