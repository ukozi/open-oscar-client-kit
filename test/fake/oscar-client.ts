import net from 'node:net';
import tls from 'node:tls';
import { strongHash } from '../../src/wire/auth.js';
import { ByteReader } from '../../src/wire/bytes.js';
import { FlapDecoder, encodeFlap, encodeSignonPayload } from '../../src/wire/flap.js';
import { encodeServiceRequest } from '../../src/wire/oservice.js';
import type { FlapFrame } from '../../src/wire/flap.js';
import { decodeSnac, encodeSnac } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { Logger, TimerApi } from '../../src/wire/types.js';

// Manual time outruns real sockets. After each fired timer, give loopback I/O a moment to land.
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

export async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export class ManualTimers {
  private t = 1_800_000_000_000;
  private nextId = 1;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();

  readonly api: TimerApi = {
    setTimeout: ((fn: () => void, ms?: number) => {
      const id = this.nextId++;
      this.queue.set(id, { at: this.t + (ms ?? 0), fn });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id?: number) => {
      if (id !== undefined) this.queue.delete(id);
    }) as unknown as typeof clearTimeout,
  };

  now = (): number => this.t;

  pending(): number[] {
    return [...this.queue.values()].map((e) => e.at - this.t).sort((a, b) => a - b);
  }

  /** Moves the clock forward and runs no timer. A timer that is due runs at the next advance. */
  skip(ms: number): void {
    this.t += ms;
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.queue) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.queue.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await tick();
    }
    this.t = end;
    await tick();
  }
}

export type LogLine = { level: keyof Logger; msg: string; fields?: Record<string, unknown> | undefined };

export function captureLog(): { log: Logger; lines: LogLine[]; text: () => string } {
  const lines: LogLine[] = [];
  const at = (level: keyof Logger) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  return {
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    lines,
    text: () =>
      lines
        .map((l) => `${l.level} ${l.msg} ${JSON.stringify(l.fields ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
        .join('\n'),
  };
}

// A port for plain TCP, or a port and the certificate to trust for TLS.
export type RawTarget = number | { port: number; ca: string };

export class RawClient {
  readonly frames: FlapFrame[] = [];
  // The frames decoded from each 'data' event, in order: which frames reached the client in one read.
  readonly reads: FlapFrame[][] = [];
  closed = false;
  private readonly decoder = new FlapDecoder();
  private seq = 0;
  private taken = 0;
  private serviceRequestId = 0x5e000000;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      const read = this.decoder.push(new Uint8Array(chunk));
      this.reads.push(read);
      this.frames.push(...read);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      const last = this.decoder.end();
      if (last) this.frames.push(last);
      this.closed = true;
    });
  }

  static async connect(target: RawTarget): Promise<RawClient> {
    const socket =
      typeof target === 'number' ? net.connect({ host: '127.0.0.1', port: target }) : tls.connect({ host: '127.0.0.1', port: target.port, ca: target.ca });
    const client = new RawClient(socket);
    await client.nextFrame();
    return client;
  }

  // A service connection: the cookie of a service response (or of a login) in TLV 0x06 of the sign-on
  // frame. Resolves on the first frame the server sends after it, left unread, or on the close.
  static async service(target: RawTarget, cookie: Uint8Array): Promise<RawClient> {
    const client = await RawClient.connect(target);
    client.signon([tlv.bytes(0x06, cookie)]);
    await waitFor(() => client.frames.length > client.taken || client.closed, 'the first frame of a service connection');
    return client;
  }

  // 0x01/0x04 on this (BOS) connection. Resolves with the cookie (TLV 0x06) of the 0x01/0x05 that
  // answers it; rejects when the answer is anything else or the connection closes first. It finds
  // the answer by its request id and does not take it from what nextFrame hands out.
  async requestService(family: number, roomInfo?: Uint8Array): Promise<Uint8Array> {
    const snac = await this.askService(family, roomInfo ? { useSsl: false, roomInfo } : { useSsl: false });
    const cookie = snac.family === 0x01 && snac.subtype === 0x05 ? findTlv(decodeTlvs(snac.body), 0x06) : undefined;
    if (!cookie) throw new Error(`service request refused: SNAC 0x${snac.family.toString(16)}/0x${snac.subtype.toString(16)}`);
    return cookie;
  }

  // 0x01/0x04 on this (BOS) connection. Resolves with the SNAC that answers it, whatever it is.
  async askService(family: number, req: { useSsl: boolean; roomInfo?: Uint8Array }): Promise<Snac> {
    const requestId = this.serviceRequestId++;
    const answer = (): Snac | undefined => {
      for (const frame of this.frames) {
        if (frame.type !== 2) continue;
        const snac = decodeSnac(frame.payload);
        if (snac.requestId === requestId) return snac;
      }
      return undefined;
    };
    this.snac(0x01, 0x04, requestId, encodeServiceRequest(family, req));
    await waitFor(() => answer() !== undefined || this.closed, 'the service response');
    const snac = answer();
    if (!snac) throw new Error('connection closed with no service response');
    return snac;
  }

  async nextFrame(): Promise<FlapFrame> {
    await waitFor(() => this.frames.length > this.taken || this.closed, 'a frame');
    const frame = this.frames[this.taken];
    if (!frame) throw new Error('connection closed with no frame');
    this.taken++;
    return frame;
  }

  async nextSnac(): Promise<Snac> {
    return decodeSnac((await this.nextFrame()).payload);
  }

  async untilClosed(): Promise<void> {
    await waitFor(() => this.closed, 'close');
  }

  signon(tlvs: Tlv[] = []): void {
    this.socket.write(encodeFlap(1, this.seq++, encodeSignonPayload(tlvs)));
  }

  snac(family: number, subtype: number, requestId: number, body?: Uint8Array): void {
    this.socket.write(encodeFlap(2, this.seq++, encodeSnac({ family, subtype, requestId }, body)));
  }

  close(): void {
    this.socket.destroy();
  }

  static async login(target: RawTarget, name: string, password: string, multiConn = 0x03): Promise<{ tlvs: Tlv[]; client: RawClient }> {
    const client = await RawClient.connect(target);
    client.signon();
    client.snac(0x17, 0x06, 1, encodeTlvs([tlv.str(0x01, name)]));
    const challenge = await client.nextSnac();
    if (challenge.subtype !== 0x07) return { tlvs: decodeTlvs(challenge.body), client };
    const key = new ByteReader(challenge.body).str16();
    client.snac(
      0x17,
      0x02,
      2,
      encodeTlvs([tlv.str(0x01, name), tlv.bytes(0x25, strongHash(password, key)), tlv.str(0x03, 'raw'), tlv.u8(0x4a, multiConn)]),
    );
    return { tlvs: decodeTlvs((await client.nextSnac()).body), client };
  }

  static async signOn(target: RawTarget, name: string, password: string, multiConn = 0x03): Promise<RawClient> {
    const { tlvs, client: auth } = await RawClient.login(target, name, password, multiConn);
    auth.close();
    const cookie = findTlv(tlvs, 0x06);
    if (!cookie) throw new Error('login failed');
    const bos = await RawClient.connect(target);
    bos.signon([tlv.bytes(0x06, cookie)]);
    await bos.nextSnac();
    bos.snac(0x13, 0x07, 1);
    bos.snac(1, 0x02, 2);
    bos.snac(1, 0x0e, 3);
    for (;;) if ((await bos.nextSnac()).subtype === 0x0f) return bos;
  }
}

// Waits on loopback I/O, not the clock: each round is a connection to the test server and its signon frame back.
export async function settle(port: number, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) (await RawClient.connect(port)).close();
}
