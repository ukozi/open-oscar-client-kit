import net from 'node:net';
import type { Logger, TimerApi } from '../wire/types.js';

export const PEER_CONNECT_TIMEOUT_MS = 15_000;
// The socket stops reading while this many bytes wait for the reader.
const READ_AHEAD_MAX_BYTES = 1024 * 1024;

export class PeerClosedError extends Error {
  constructor(message = 'the peer connection is closed') {
    super(message);
    this.name = 'PeerClosedError';
  }
}

export type PeerLink = {
  write(bytes: Uint8Array): Promise<void>;
  /** Exactly n bytes, or it rejects with PeerClosedError when the peer closes first. */
  read(n: number): Promise<Uint8Array>;
  /** Up to max bytes, at least one; null at a clean end. */
  readSome(max: number): Promise<Uint8Array | null>;
  close(): void;
  readonly closed: boolean;
};

class SocketLink implements PeerLink {
  private chunks: Buffer[] = [];
  private buffered = 0;
  // No more bytes come from the socket.
  private ended = false;
  // The peer sent its end mark and no error came.
  private clean = false;
  private shut = false;
  private wake: (() => void) | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      if (this.buffered >= READ_AHEAD_MAX_BYTES) socket.pause();
      this.woken();
    });
    socket.on('end', () => {
      this.clean = true;
      this.ended = true;
      this.woken();
    });
    // The close event follows an error.
    socket.on('error', () => {});
    socket.on('close', () => {
      this.ended = true;
      this.shut = true;
      this.woken();
    });
  }

  get closed(): boolean {
    return this.shut;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.shut || this.socket.destroyed || this.socket.writableEnded) return Promise.reject(new PeerClosedError());
    if (bytes.length === 0) return Promise.resolve();
    // The callback runs when the system has the bytes, so a slow peer slows the writer.
    return new Promise((resolve, reject) => {
      this.socket.write(bytes, (error) => (error ? reject(new PeerClosedError()) : resolve()));
    });
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.buffered < n) {
      if (this.ended) throw new PeerClosedError();
      await this.more();
    }
    return this.take(n);
  }

  async readSome(max: number): Promise<Uint8Array | null> {
    while (this.buffered === 0) {
      if (this.ended && this.clean) return null;
      if (this.ended) throw new PeerClosedError();
      await this.more();
    }
    return this.take(Math.min(max, this.buffered));
  }

  close(): void {
    if (this.shut) return;
    this.shut = true;
    this.ended = true;
    this.clean = false;
    this.chunks = [];
    this.buffered = 0;
    this.socket.destroy();
    this.woken();
  }

  private woken(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private more(): Promise<void> {
    if (this.wake) return Promise.reject(new Error('a read is in progress'));
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const chunk = this.chunks[0] as Buffer;
      const part = Math.min(chunk.length, n - at);
      out.set(chunk.subarray(0, part), at);
      at += part;
      if (part === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(part);
    }
    this.buffered -= n;
    if (this.buffered < READ_AHEAD_MAX_BYTES && this.socket.isPaused()) this.socket.resume();
    return out;
  }
}

export function openPeerLink(o: { host: string; port: number; log: Logger; timers: TimerApi; connectTimeoutMs?: number }): Promise<PeerLink> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: o.host, port: o.port });
    socket.setNoDelay(true);
    const failed = (reason: string): void => {
      o.timers.clearTimeout(timer);
      socket.destroy();
      o.log.debug('a peer connection did not open', { port: o.port, reason });
      reject(new PeerClosedError(`the peer connection did not open: ${reason}`));
    };
    const refused = (): void => failed('refused');
    const timer = o.timers.setTimeout(() => failed('timeout'), o.connectTimeoutMs ?? PEER_CONNECT_TIMEOUT_MS);
    socket.on('error', () => {});
    socket.once('error', refused);
    socket.once('connect', () => {
      o.timers.clearTimeout(timer);
      socket.off('error', refused);
      o.log.debug('a peer connection opened', { port: o.port });
      resolve(new SocketLink(socket));
    });
  });
}
