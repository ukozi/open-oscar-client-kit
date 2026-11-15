import { OscarDecodeError } from '../wire/bytes.js';
import { ODC_FLAG_AUTO, ODC_FLAG_HELLO } from '../wire/constants.js';
import { decodeOdcHeader, decodeOdcMessage, encodeOdcHeader, encodeOdcMessage, odcHeaderLength, odcKind, odcTextBytes } from '../wire/odc.js';
import type { OdcHeader } from '../wire/odc.js';
import type { Logger, TimerApi } from '../wire/types.js';
import type { DirectAttachment, DirectMessage, DirectPart, OutgoingDirectMessage } from '../model/direct-im.js';
import { ByteStore } from './byte-store.js';
import { parseAimHtml, richTextToAimHtml } from './aim-html.js';
import { PeerClosedError } from './peer-link.js';
import type { PeerLink } from './peer-link.js';

export type OdcFailure = 'peer-closed' | 'bad-cookie' | 'bad-frame' | 'too-large';

export class OdcError extends Error {
  readonly failure: OdcFailure | 'not-open';

  constructor(failure: OdcFailure | 'not-open', options?: ErrorOptions) {
    super(failure, options);
    this.name = 'OdcError';
    this.failure = failure;
  }
}

export type OdcSessionDeps = {
  link: PeerLink;
  cookie: bigint;
  self: string;
  log: Logger;
  timers: TimerApi;
  maxMessageBytes: number;
  maxAttachments: number;
  /** The most bytes of text in one message that comes: the bytes before the binary section. */
  maxTextBytes: number;
  /** The most payload bytes that the connection brings. The frame that passes the limit is the last frame. */
  maxSessionBytes: number;
  /** null: a send waits until the peer shows the cookie. */
  sendUnverifiedAfterMs: number | null;
  onVerified(): void;
  onMessage(message: Omit<DirectMessage, 'id' | 'from' | 'at'>): void;
  onTyping(state: 'typing' | 'typed' | 'idle'): void;
  /** One time. 'closed' is a close that this side asked for. */
  onEnd(why: OdcFailure | 'closed'): void;
};

const WRITE_MAX_BYTES = 32 * 1024;
const READ_MAX_BYTES = 64 * 1024;
const HEAD_BYTES = 6;
// The length of the BINARY tag.
const BINARY_TAG_BYTES = 8;

type Waiting = { payload: Uint8Array; resolve: () => void; reject: (error: OdcError) => void };

function joined(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** One Direct IM connection. It sends nothing but the hello before the cookie rule lets it. */
export class OdcSession {
  private readonly queue: Waiting[] = [];
  private started = false;
  private ended = false;
  private shown = false;
  // The time for an unverified send came.
  private waited = false;
  private writing = false;
  // The payload bytes of each frame that came.
  private received = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OdcSessionDeps) {}

  /** The peer showed the cookie of the offer. */
  get verified(): boolean {
    return this.shown;
  }

  /** Writes the hello and starts to read. */
  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    const d = this.deps;
    const hello = encodeOdcHeader({ cookie: d.cookie, payloadBytes: 0, encoding: 0, flags: ODC_FLAG_HELLO, screenName: d.self });
    d.link.write(hello).catch(() => {
      this.finish('peer-closed');
    });
    if (d.sendUnverifiedAfterMs !== null) {
      this.timer = d.timers.setTimeout(() => {
        this.timer = null;
        this.waited = true;
        void this.pump();
      }, d.sendUnverifiedAfterMs);
    }
    void this.reads();
  }

  /** Resolves when the frame is written. It rejects with OdcError, or RangeError for a picture that has no valid size. */
  send(message: OutgoingDirectMessage): Promise<void> {
    if (this.ended) return Promise.reject(new OdcError('not-open'));
    let payload: Uint8Array;
    try {
      // A BINARY tag in the text ends the text for the reader.
      const html = richTextToAimHtml(message.body ?? []).replace(/<(?=binary>)/gi, '&lt;');
      payload = encodeOdcMessage(html, message.pictures.map((picture, index) => ({ id: index + 1, ...picture })));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new RangeError('the message has no valid form'));
    }
    if (payload.length > this.deps.maxMessageBytes) return Promise.reject(new OdcError('too-large'));
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      void this.pump();
    });
  }

  close(): void {
    this.finish('closed');
  }

  private finish(why: OdcFailure | 'closed'): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer);
    this.timer = null;
    this.deps.link.close();
    for (const waiting of this.queue.splice(0)) waiting.reject(new OdcError('not-open'));
    this.deps.log.debug('a direct im connection ended', { why, verified: this.shown });
    this.told('onEnd', () => this.deps.onEnd(why));
  }

  // A throw from the host does not stop the session.
  private told(name: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.deps.log.warn('a direct im listener threw', { listener: name, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  private async pump(): Promise<void> {
    if (this.writing || this.ended || !this.started || !(this.shown || this.waited)) return;
    this.writing = true;
    const { link, cookie, self, log } = this.deps;
    while (!this.ended) {
      const next = this.queue.shift();
      if (!next) break;
      const { payload } = next;
      try {
        await link.write(encodeOdcHeader({ cookie, payloadBytes: payload.length, encoding: 0, flags: 0, screenName: self }));
        for (let from = 0; from < payload.length; from += WRITE_MAX_BYTES) {
          if (this.ended) throw new PeerClosedError();
          await link.write(payload.subarray(from, from + WRITE_MAX_BYTES));
        }
      } catch (error) {
        next.reject(new OdcError(this.ended ? 'not-open' : 'peer-closed', { cause: error }));
        this.finish('peer-closed');
        break;
      }
      log.debug('a direct im frame went out', { payloadBytes: payload.length, verified: this.shown });
      next.resolve();
    }
    this.writing = false;
  }

  private async reads(): Promise<void> {
    try {
      while (!this.ended) {
        await this.frame();
        if (!this.ended && this.received > this.deps.maxSessionBytes) throw new OdcError('too-large');
      }
    } catch (error) {
      if (error instanceof OdcError && error.failure !== 'not-open') this.finish(error.failure);
      else if (error instanceof PeerClosedError) this.finish('peer-closed');
      else if (error instanceof OscarDecodeError) this.finish('bad-frame');
      else {
        this.deps.log.warn('a direct im read failed', { error: error instanceof Error ? error.name : 'unknown' });
        this.finish('bad-frame');
      }
    }
  }

  private async frame(): Promise<void> {
    const d = this.deps;
    const head = await d.link.read(HEAD_BYTES);
    const length = odcHeaderLength(head);
    const rest = await d.link.read(length - HEAD_BYTES);
    if (this.ended) return;
    const header = decodeOdcHeader(joined([head, rest], length));
    const kind = odcKind(header);
    d.log.debug('a direct im frame came', { kind, flags: header.flags, encoding: header.encoding, payloadBytes: header.payloadBytes });
    if (header.cookie !== d.cookie) throw new OdcError('bad-cookie');
    if (!this.shown) {
      this.shown = true;
      if (this.timer !== null) d.timers.clearTimeout(this.timer);
      this.timer = null;
      this.told('onVerified', () => d.onVerified());
      void this.pump();
    }
    if (header.payloadBytes > d.maxMessageBytes) throw new OdcError('too-large');
    const payload = await this.payload(header.payloadBytes, kind === 'message');
    if (this.ended) return;
    this.received += header.payloadBytes;
    if (kind === 'hello') return;
    if (kind !== 'message') {
      this.told('onTyping', () => d.onTyping(kind));
      return;
    }
    const message = this.message(header, payload);
    if (message.parts.length === 0 && message.attachments.length === 0 && !message.damaged) return;
    this.told('onMessage', () => d.onMessage(message));
  }

  // The buffer grows with the bytes that come. The declared length is only its limit.
  // The text is measured when its limit and one BINARY tag are there, before the remaining bytes come.
  private async payload(bytes: number, keep: boolean): Promise<Uint8Array> {
    const store = new ByteStore(keep ? bytes : 0);
    const enough = Math.min(bytes, this.deps.maxTextBytes + BINARY_TAG_BYTES);
    let measured = !keep;
    let have = 0;
    for (;;) {
      if (!measured && have >= enough) {
        measured = true;
        if (odcTextBytes(store.bytes().subarray(0, enough)) > this.deps.maxTextBytes) throw new OdcError('too-large');
      }
      if (have >= bytes) break;
      const piece = await this.deps.link.readSome(Math.min(READ_MAX_BYTES, bytes - have));
      if (piece === null) throw new PeerClosedError();
      if (keep) store.add(piece);
      have += piece.length;
    }
    return store.bytes();
  }

  private message(header: OdcHeader, payload: Uint8Array): Omit<DirectMessage, 'id' | 'from' | 'at'> {
    const decoded = decodeOdcMessage(payload, header.encoding, this.deps.maxAttachments);
    const attachments: DirectAttachment[] = decoded.binaries.map((binary) => ({ id: binary.id, name: '', bytes: binary.bytes.slice() }));
    const named = new Set<number>();
    const parts: DirectPart[] = [];
    for (const segment of decoded.segments) {
      if ('text' in segment) {
        const body = parseAimHtml(segment.text);
        if (body.some((run) => run.text !== '')) parts.push({ kind: 'text', body });
        continue;
      }
      const index = segment.image.id === null ? -1 : attachments.findIndex((attachment) => attachment.id === segment.image.id);
      const attachment = attachments[index];
      if (!attachment) {
        parts.push({ kind: 'missing' });
        continue;
      }
      if (!named.has(index)) attachment.name = segment.image.name;
      named.add(index);
      parts.push({ kind: 'attachment', index });
    }
    return {
      autoResponse: (header.flags & ODC_FLAG_AUTO) !== 0,
      parts,
      attachments,
      unreferenced: attachments.length - named.size,
      damaged: decoded.damaged,
    };
  }
}
