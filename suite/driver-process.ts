import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as text from './text.js';
import { LineSplitter, ProtocolError, encodeLine, parseDriverLine } from './protocol.js';
import type { Command, DriverEvent, Reply } from './protocol.js';

type Pending = {
  op: string;
  resolve(reply: Reply): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type Waiter = { match(e: DriverEvent): boolean; resolve(e: DriverEvent): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Distribute<T> = T extends { id: number } ? Omit<T, 'id'> : never;

export class DriverProcess {
  private readonly child: ChildProcess;
  private readonly splitter = new LineSplitter();
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Set<Waiter>();
  private seen: DriverEvent[] = [];
  private err = '';
  private failure = '';
  private exit: { code: number | null; signal: string | null } | null = null;
  private nextId = 1;

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.splitter.push(chunk)) this.onLine(line);
    });
    child.stderr?.on('data', (chunk: string) => {
      this.err += chunk;
    });
    child.stdin?.on('error', () => {});
    child.on('error', (error) => this.onExit(null, null, error.message));
    child.on('close', (code, signal) => this.onExit(code, signal));
  }

  static start(command: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): DriverProcess {
    const [file, ...args] = command;
    if (!file) throw new TypeError(text.DRIVER_COMMAND_EMPTY);
    return new DriverProcess(spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] }));
  }

  request(cmd: Distribute<Command>, timeoutMs = 10_000): Promise<Reply> {
    if (this.exit) return Promise.reject(new Error(this.exitMessage()));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(text.NO_REPLY(cmd.op, timeoutMs)));
      }, timeoutMs);
      this.pending.set(id, { op: cmd.op, resolve, reject, timer });
      this.child.stdin?.write(encodeLine({ id, ...cmd } as Command));
    });
  }

  nextEvent(match: (e: DriverEvent) => boolean, timeoutMs: number): Promise<DriverEvent> {
    const found = this.seen.find(match);
    if (found) return Promise.resolve(found);
    if (this.exit) return Promise.reject(new Error(this.exitMessage()));
    return new Promise<DriverEvent>((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(text.NO_EVENT(timeoutMs)));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  markSeen(): void {
    this.seen = [];
  }

  events(): readonly DriverEvent[] {
    return this.seen;
  }

  stderr(): string {
    return this.err;
  }

  exited(): { code: number | null; signal: string | null } | null {
    return this.exit;
  }

  async close(): Promise<void> {
    if (this.exit) return;
    const closed = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    this.request({ op: 'exit' }, 2000).catch(() => {});
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await closed;
    clearTimeout(kill);
  }

  private onLine(line: string): void {
    let parsed: Reply | DriverEvent;
    try {
      parsed = parseDriverLine(line);
    } catch (error) {
      this.err += `${error instanceof ProtocolError ? `${error.name}: ${error.message}` : String(error)}\n`;
      return;
    }
    if ('event' in parsed) {
      this.seen.push(parsed);
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(parsed)) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(parsed);
      }
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    pending.resolve(parsed);
  }

  private onExit(code: number | null, signal: string | null, failure?: string): void {
    if (this.exit) return;
    this.exit = { code, signal };
    if (failure) {
      this.failure = failure;
      this.err += `${failure}\n`;
    }
    const error = new Error(this.exitMessage());
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private exitMessage(): string {
    if (this.failure) return text.NOT_STARTED(this.failure);
    const { code, signal } = this.exit ?? { code: null, signal: null };
    return code === null ? text.EXITED_SIGNAL(signal ?? 'unknown') : text.EXITED_CODE(code);
  }
}
