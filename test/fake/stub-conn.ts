import type { BosConn } from '../../src/client/bos-link.js';
import { ConnectionClosedError, RequestTimeoutError } from '../../src/wire/connection.js';
import type { CloseInfo } from '../../src/wire/connection.js';
import { REQUEST_TIMEOUT_MS } from '../../src/wire/constants.js';
import type { Snac } from '../../src/wire/snac.js';
import type { ManualTimers } from './oscar-client.js';

export type SentSnac = { family: number; subtype: number; body: Uint8Array; requestId: number; at: number };
type Pending = { resolve: (s: Snac) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

// An OscarConnection without a socket: it records each write, and the test feeds it SNACs.
export class StubConn implements BosConn {
  isOpen = true;
  readonly sent: SentSnac[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly snacListeners: ((snac: Snac) => void)[] = [];
  private readonly closeListeners: ((info: CloseInfo) => void)[] = [];
  private nextRequestId = 1;
  private closed: CloseInfo | null = null;

  constructor(private readonly timers: ManualTimers) {}

  send(family: number, subtype: number, body: Uint8Array = new Uint8Array(0)): number {
    const requestId = this.nextRequestId++;
    if (!this.closed) this.sent.push({ family, subtype, body, requestId, at: this.timers.now() });
    return requestId;
  }

  request(family: number, subtype: number, body?: Uint8Array, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Snac> {
    if (this.closed) return Promise.reject(new ConnectionClosedError(this.closed));
    return new Promise<Snac>((resolve, reject) => {
      const requestId = this.send(family, subtype, body);
      const timer = this.timers.api.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RequestTimeoutError());
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  deliver(snac: { family: number; subtype: number; body?: Uint8Array; requestId?: number }): void {
    const full: Snac = {
      family: snac.family,
      subtype: snac.subtype,
      flags: 0,
      requestId: snac.requestId ?? 0,
      body: snac.body ?? new Uint8Array(0),
    };
    const waiter = this.pending.get(full.requestId);
    if (waiter) {
      this.pending.delete(full.requestId);
      this.timers.api.clearTimeout(waiter.timer);
      waiter.resolve(full);
    }
    for (const fn of [...this.snacListeners]) fn(full);
  }

  closeWith(info: CloseInfo): void {
    if (this.closed) return;
    this.closed = info;
    this.isOpen = false;
    const error = new ConnectionClosedError(info);
    for (const waiter of this.pending.values()) {
      this.timers.api.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const fn of [...this.closeListeners]) fn(info);
  }

  onSnac(fn: (snac: Snac) => void): () => void {
    this.snacListeners.push(fn);
    return () => {
      const i = this.snacListeners.indexOf(fn);
      if (i >= 0) this.snacListeners.splice(i, 1);
    };
  }

  onClose(fn: (info: CloseInfo) => void): () => void {
    if (this.closed) {
      fn(this.closed);
      return () => {};
    }
    this.closeListeners.push(fn);
    return () => {
      const i = this.closeListeners.indexOf(fn);
      if (i >= 0) this.closeListeners.splice(i, 1);
    };
  }

  close(): void {
    this.closeWith({ kind: 'local', clean: true });
  }

  destroy(info: CloseInfo = { kind: 'local', clean: true }): void {
    this.closeWith(info);
  }
}
