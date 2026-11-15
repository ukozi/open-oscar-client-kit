import { describe, expect, it } from 'vitest';
import { OdcError, OdcSession } from '../../../src/client/odc-session.js';
import type { OdcFailure, OdcSessionDeps } from '../../../src/client/odc-session.js';
import { PeerClosedError } from '../../../src/client/peer-link.js';
import type { PeerLink } from '../../../src/client/peer-link.js';
import type { DirectMessage, OutgoingPicture } from '../../../src/model/direct-im.js';
import {
  DIRECT_IM_MAX_ATTACHMENTS, DIRECT_IM_MAX_MESSAGE_BYTES, DIRECT_IM_MAX_SESSION_BYTES, DIRECT_IM_MAX_TEXT_BYTES, ODC_FLAG_AUTO, ODC_FLAG_HELLO, ODC_FLAG_TYPED, ODC_FLAG_TYPING,
  ODC_FLAG_TYPING_NOTICE, ODC_HEADER_BYTES,
} from '../../../src/wire/constants.js';
import { decodeOdcHeader, decodeOdcMessage, encodeOdcHeader, encodeOdcMessage, odcKind, odcTextBytes } from '../../../src/wire/odc.js';
import { ManualTimers, captureLog, waitFor } from '../../fake/oscar-client.js';

const COOKIE = 0x0102030405060708n;
const OTHER_COOKIE = 0x1112131415161718n;
const WRITE_MAX = 32 * 1024;
const READ_MAX = 64 * 1024;

// One end of a connection in memory. `sent` holds each write of this end.
class MemoryLink implements PeerLink {
  readonly sent: Uint8Array[] = [];
  peer!: MemoryLink;
  // The byte count that the reads of this end took.
  taken = 0;
  largestReadSome = 0;
  // The most bytes that one readSome gives.
  pieceMax = Number.POSITIVE_INFINITY;
  // Each readSome gives the same array again, with new bytes in it.
  reused: Uint8Array | null = null;
  private inbox: Uint8Array[] = [];
  private buffered = 0;
  private ended = false;
  private shut = false;
  private wake: (() => void) | null = null;

  get closed(): boolean {
    return this.shut;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.shut || this.peer.shut) return Promise.reject(new PeerClosedError());
    const copy = bytes.slice();
    this.sent.push(copy);
    if (copy.length > 0) this.peer.put(copy);
    return Promise.resolve();
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.buffered < n) {
      if (this.ended) throw new PeerClosedError();
      await this.more();
    }
    return this.take(n);
  }

  async readSome(max: number): Promise<Uint8Array | null> {
    this.largestReadSome = Math.max(this.largestReadSome, max);
    while (this.buffered === 0) {
      if (this.shut) throw new PeerClosedError();
      if (this.ended) return null;
      await this.more();
    }
    const piece = this.take(Math.min(max, this.buffered, this.pieceMax));
    if (!this.reused || piece.length > this.reused.length) return piece;
    this.reused.set(piece);
    return this.reused.subarray(0, piece.length);
  }

  close(): void {
    if (this.shut) return;
    this.shut = true;
    this.ended = true;
    this.inbox = [];
    this.buffered = 0;
    this.woken();
    this.peer.end();
  }

  private put(bytes: Uint8Array): void {
    if (this.shut) return;
    this.inbox.push(bytes);
    this.buffered += bytes.length;
    this.woken();
  }

  private end(): void {
    this.ended = true;
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
      const chunk = this.inbox[0] as Uint8Array;
      const part = Math.min(chunk.length, n - at);
      out.set(chunk.subarray(0, part), at);
      at += part;
      if (part === chunk.length) this.inbox.shift();
      else this.inbox[0] = chunk.subarray(part);
    }
    this.buffered -= n;
    this.taken += n;
    return out;
  }
}

function pair(): [MemoryLink, MemoryLink] {
  const a = new MemoryLink();
  const b = new MemoryLink();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function content(bytes: number, seed = 7): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

function header(flags: number, payloadBytes: number, cookie = COOKIE, screenName = 'bob'): Uint8Array {
  return encodeOdcHeader({ cookie, payloadBytes, encoding: 0, flags, screenName });
}

function frame(flags: number, payload: Uint8Array = new Uint8Array(0), cookie = COOKIE): Uint8Array {
  return joined([header(flags, payload.length, cookie), payload]);
}

function picture(bytes: Uint8Array, name = 'n.png'): OutgoingPicture {
  return { name, bytes, width: 4, height: 3 };
}

function pause(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Heard = Omit<DirectMessage, 'id' | 'from' | 'at'>;
type Side = {
  session: OdcSession;
  link: MemoryLink;
  clock: ManualTimers;
  verified: number;
  messages: Heard[];
  typing: string[];
  ends: (OdcFailure | 'closed')[];
};

function side(link: MemoryLink, over: Partial<OdcSessionDeps> = {}, self = 'alice'): Side {
  const clock = new ManualTimers();
  const out: Side = { session: undefined as unknown as OdcSession, link, clock, verified: 0, messages: [], typing: [], ends: [] };
  out.session = new OdcSession({
    link,
    cookie: COOKIE,
    self,
    log: captureLog().log,
    timers: clock.api,
    maxMessageBytes: DIRECT_IM_MAX_MESSAGE_BYTES,
    maxAttachments: DIRECT_IM_MAX_ATTACHMENTS,
    maxTextBytes: DIRECT_IM_MAX_TEXT_BYTES,
    maxSessionBytes: DIRECT_IM_MAX_SESSION_BYTES,
    sendUnverifiedAfterMs: null,
    onVerified: () => {
      out.verified += 1;
    },
    onMessage: (message) => {
      out.messages.push(message);
    },
    onTyping: (state) => {
      out.typing.push(state);
    },
    onEnd: (why) => {
      out.ends.push(why);
    },
    ...over,
  });
  return out;
}

// A session on one end. The test is the peer and holds the other end.
function alone(over: Partial<OdcSessionDeps> = {}): Side & { peer: MemoryLink } {
  const [a, b] = pair();
  const s = side(a, over);
  s.session.start();
  return Object.assign(s, { peer: b });
}

// Each frame that one end wrote, from its writes in order.
function framesOf(link: MemoryLink): { flags: number; cookie: bigint; payload: Uint8Array; kind: string }[] {
  const all = joined(link.sent);
  const out = [];
  let at = 0;
  while (at < all.length) {
    const h = decodeOdcHeader(all.subarray(at, at + ODC_HEADER_BYTES));
    const payload = all.subarray(at + ODC_HEADER_BYTES, at + ODC_HEADER_BYTES + h.payloadBytes);
    out.push({ flags: h.flags, cookie: h.cookie, payload, kind: odcKind(h) });
    at += ODC_HEADER_BYTES + h.payloadBytes;
  }
  return out;
}

async function failure(sending: Promise<void>): Promise<unknown> {
  const error = await sending.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OdcError);
  return (error as OdcError).failure;
}

describe('OdcSession: the hello and the cookie', () => {
  it('start writes a 76-byte hello with the cookie before any read', () => {
    const [a] = pair();
    const s = side(a);
    s.session.start();
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]).toHaveLength(76);
    expect(decodeOdcHeader(a.sent[0] as Uint8Array)).toEqual(
      { cookie: COOKIE, payloadBytes: 0, encoding: 0, flags: ODC_FLAG_HELLO, screenName: 'alice' },
    );
    expect(a.taken).toBe(0);
    expect(s.session.verified).toBe(false);
  });

  it('two sessions back to back: both verified after the hellos, onVerified one time each', async () => {
    const [a, b] = pair();
    const alice = side(a);
    const bob = side(b, {}, 'bob');
    alice.session.start();
    bob.session.start();
    await waitFor(() => alice.session.verified && bob.session.verified, 'both verified');
    await alice.session.send({ pictures: [picture(content(10))] });
    await waitFor(() => bob.messages.length === 1, 'the message');
    expect([alice.verified, bob.verified]).toEqual([1, 1]);
    expect([alice.ends, bob.ends]).toEqual([[], []]);
  });

  it('a frame with another cookie ends bad-cookie; its picture reached no onMessage', async () => {
    const s = alone();
    await s.peer.write(frame(0, encodeOdcMessage('', [{ id: 1, ...picture(content(137)) }]), OTHER_COOKIE));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-cookie']);
    expect(s.messages).toEqual([]);
    expect(s.verified).toBe(0);
    expect(s.session.verified).toBe(false);
    expect(s.link.taken).toBe(ODC_HEADER_BYTES);
    expect(s.link.closed).toBe(true);
  });

  it('a frame with another cookie after the right one ends bad-cookie', async () => {
    const s = alone();
    await s.peer.write(frame(ODC_FLAG_HELLO));
    await s.peer.write(frame(0, encodeOdcMessage('', [{ id: 1, ...picture(content(137)) }]), OTHER_COOKIE));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-cookie']);
    expect(s.messages).toEqual([]);
  });

  it('the first four bytes "OFT2" end bad-frame', async () => {
    const s = alone();
    const bytes = frame(ODC_FLAG_HELLO);
    bytes.set(ascii('OFT2'));
    await s.peer.write(bytes);
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-frame']);
    expect(s.verified).toBe(0);
    expect(s.link.closed).toBe(true);
  });

  it.each([75, 257])('a header length of %i ends bad-frame', async (length) => {
    const s = alone();
    const bytes = frame(ODC_FLAG_HELLO);
    bytes[4] = length >> 8;
    bytes[5] = length & 0xff;
    await s.peer.write(bytes);
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['bad-frame']);
  });

  it('a header of 80 bytes is read whole, and the next frame follows it', async () => {
    const s = alone();
    const long = joined([header(ODC_FLAG_HELLO, 0), new Uint8Array(4)]);
    long[5] = 80;
    await s.peer.write(joined([long, frame(0, ascii('hi'))]));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.parts).toEqual([{ kind: 'text', body: [{ text: 'hi' }] }]);
    expect(s.ends).toEqual([]);
  });

  it('a clean end from the peer ends peer-closed', async () => {
    const s = alone();
    await s.peer.write(frame(ODC_FLAG_HELLO));
    s.peer.close();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['peer-closed']);
    expect(await failure(s.session.send({ pictures: [picture(content(5))] }))).toBe('not-open');
  });

  it('an end in the middle of a header ends peer-closed', async () => {
    const s = alone();
    await s.peer.write(frame(ODC_FLAG_HELLO).subarray(0, 40));
    s.peer.close();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['peer-closed']);
    expect(s.verified).toBe(0);
  });

  it('a second hello does not call onVerified again', async () => {
    const s = alone();
    await s.peer.write(joined([frame(ODC_FLAG_HELLO), frame(ODC_FLAG_HELLO), frame(0, ascii('hi'))]));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.verified).toBe(1);
  });
});

describe('OdcSession: frames that arrive', () => {
  it('a picture of 137 bytes arrives: parts [attachment 0], attachments[0].bytes equal, unreferenced 0, damaged false', async () => {
    const [a, b] = pair();
    const alice = side(a);
    const bob = side(b, {}, 'bob');
    alice.session.start();
    bob.session.start();
    const bytes = content(137);
    await alice.session.send({ pictures: [picture(bytes, 'n-16.png')] });
    await waitFor(() => bob.messages.length === 1, 'the message');
    const message = bob.messages[0] as Heard;
    expect(message.parts).toEqual([{ kind: 'attachment', index: 0 }]);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]?.bytes).toEqual(bytes);
    expect(message.attachments[0]?.name).toBe('n-16.png');
    expect(message.unreferenced).toBe(0);
    expect(message.damaged).toBe(false);
    expect(message.autoResponse).toBe(false);
  });

  it('text, a picture and text arrive as three parts in order', async () => {
    const s = alone();
    const data = content(9);
    const payload = joined([
      ascii('<B>before</B><IMG SRC="a.png" ID="1" WIDTH="2" HEIGHT="2" DATASIZE="9">after<BINARY><DATA ID="1" SIZE="9">'),
      data,
      ascii('</DATA></BINARY>'),
    ]);
    await s.peer.write(frame(0, payload));
    await waitFor(() => s.messages.length === 1, 'the message');
    const message = s.messages[0] as Heard;
    expect(message.parts).toEqual([
      { kind: 'text', body: [{ text: 'before', bold: true }] },
      { kind: 'attachment', index: 0 },
      { kind: 'text', body: [{ text: 'after' }] },
    ]);
    expect(message.attachments).toEqual([{ id: 1, name: 'a.png', bytes: data }]);
  });

  it('a body and a picture that one session sends arrive at the other in order', async () => {
    const [a, b] = pair();
    const alice = side(a);
    const bob = side(b, {}, 'bob');
    alice.session.start();
    bob.session.start();
    await alice.session.send({ body: [{ text: 'look <BINARY> é', italic: true }], pictures: [picture(content(20))] });
    await waitFor(() => bob.messages.length === 1, 'the message');
    expect(bob.messages[0]?.parts).toEqual([
      { kind: 'text', body: [{ text: 'look <BINARY> é', italic: true }] },
      { kind: 'attachment', index: 0 },
    ]);
    expect(bob.messages[0]?.damaged).toBe(false);
  });

  it('a typing notice calls onTyping("typing") and no onMessage', async () => {
    const s = alone();
    await s.peer.write(frame(ODC_FLAG_TYPING_NOTICE | ODC_FLAG_TYPING));
    await waitFor(() => s.typing.length === 1, 'the notice');
    await s.peer.write(joined([frame(ODC_FLAG_TYPING_NOTICE | ODC_FLAG_TYPED), frame(ODC_FLAG_TYPING_NOTICE)]));
    await waitFor(() => s.typing.length === 3, 'the notices');
    expect(s.typing).toEqual(['typing', 'typed', 'idle']);
    expect(s.messages).toEqual([]);
    expect(s.verified).toBe(1);
  });

  it('a typing notice with a payload hands on nothing, and the next frame is read', async () => {
    const s = alone();
    const data = encodeOdcMessage('', [{ id: 1, ...picture(content(50)) }]);
    await s.peer.write(joined([frame(ODC_FLAG_TYPING_NOTICE | ODC_FLAG_TYPING, data), frame(0, ascii('hi'))]));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.attachments).toEqual([]);
    expect(s.typing).toEqual(['typing']);
  });

  it('a message that keeps the hello bits is a message: its text and its picture are handed on', async () => {
    const s = alone();
    const data = encodeOdcMessage('hi', [{ id: 1, ...picture(content(50)) }]);
    await s.peer.write(joined([frame(ODC_FLAG_HELLO), frame(ODC_FLAG_HELLO, data)]));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.attachments.length).toBe(1);
    expect(s.verified).toBe(1);
  });

  it('a message frame with the auto flag is an auto response', async () => {
    const s = alone();
    await s.peer.write(frame(ODC_FLAG_AUTO, ascii('away')));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.autoResponse).toBe(true);
  });

  it('a message frame with nothing in it calls no onMessage', async () => {
    const s = alone();
    await s.peer.write(joined([frame(0), frame(0, ascii('<HTML><BODY></BODY></HTML>')), frame(0, ascii('hi'))]));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.parts).toEqual([{ kind: 'text', body: [{ text: 'hi' }] }]);
    expect(s.verified).toBe(1);
  });

  it.each([
    ['16 MiB + 1', DIRECT_IM_MAX_MESSAGE_BYTES + 1],
    ['2 GB', 0x8000_0000],
    ['4 GB - 1', 0xffff_ffff],
  ])('a header that declares %s ends too-large, and nothing was read past the header', async (_name, declared) => {
    const s = alone();
    await s.peer.write(joined([header(0, declared), content(4096)]));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['too-large']);
    expect(s.link.taken).toBe(ODC_HEADER_BYTES);
    expect(s.link.largestReadSome).toBe(0);
    expect(s.messages).toEqual([]);
    expect(s.link.closed).toBe(true);
  });

  it('a payload of exactly maxMessageBytes is read', async () => {
    const s = alone({ maxMessageBytes: 2 });
    await s.peer.write(frame(0, ascii('hi')));
    await waitFor(() => s.messages.length === 1, 'the message');
    await s.peer.write(frame(0, ascii('hi!')));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['too-large']);
    expect(s.messages).toHaveLength(1);
  });

  it('a text of exactly maxTextBytes is read, with and without a picture after it', async () => {
    const withPicture = encodeOdcMessage('hello', [{ id: 1, ...picture(content(300 * 1024)) }]);
    const s = alone({ maxTextBytes: odcTextBytes(withPicture) });
    await s.peer.write(frame(0, ascii('a'.repeat(odcTextBytes(withPicture)))));
    await s.peer.write(frame(0, withPicture));
    await waitFor(() => s.messages.length === 2, 'the messages');
    expect(s.messages[1]?.attachments[0]?.bytes).toEqual(content(300 * 1024));
    expect(s.ends).toEqual([]);
  });

  it('a text over maxTextBytes ends too-large with no onMessage, and the remaining bytes of the frame are not read', async () => {
    const s = alone({ maxTextBytes: 1024 });
    await s.peer.write(frame(0, ascii('a'.repeat(4 * 1024 * 1024))));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['too-large']);
    expect(s.messages).toEqual([]);
    expect(s.link.taken).toBeLessThanOrEqual(ODC_HEADER_BYTES + 1024 + 8 + READ_MAX);
  });

  it('a text over maxTextBytes before a binary section ends too-large', async () => {
    const payload = encodeOdcMessage('hello', [{ id: 1, ...picture(content(64)) }]);
    const s = alone({ maxTextBytes: odcTextBytes(payload) - 1 });
    await s.peer.write(frame(0, payload));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['too-large']);
    expect(s.messages).toEqual([]);
  });

  it('more IMG tags than maxAttachments give no more parts than the limit, and the message is damaged', async () => {
    const s = alone({ maxAttachments: 2 });
    await s.peer.write(frame(0, ascii('<img>'.repeat(1000))));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.parts).toEqual([{ kind: 'missing' }, { kind: 'missing' }]);
    expect(s.messages[0]?.damaged).toBe(true);
  });

  it('the frame that passes maxSessionBytes is handed on, and then the session ends too-large', async () => {
    const s = alone({ maxSessionBytes: 10 });
    await s.peer.write(joined([frame(0, ascii('12345')), frame(0, ascii('67890')), frame(0, ascii('x')), frame(0, ascii('never'))]));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['too-large']);
    expect(s.messages.map((message) => message.parts)).toEqual(['12345', '67890', 'x'].map((text) => [{ kind: 'text', body: [{ text }] }]));
  });

  it('the payload of a typing notice and of a message with nothing in it count for maxSessionBytes', async () => {
    const s = alone({ maxSessionBytes: 10 });
    await s.peer.write(joined([frame(ODC_FLAG_TYPING_NOTICE | ODC_FLAG_TYPING, content(6)), frame(0, ascii('<B></B>')), frame(0, ascii('never'))]));
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['too-large']);
    expect(s.messages).toEqual([]);
  });

  it('a peer that declares 10 MB and sends 1 KB then closes ends peer-closed with no onMessage', async () => {
    const s = alone();
    await s.peer.write(joined([header(0, 10 * 1024 * 1024), content(1024)]));
    await pause();
    expect(s.ends).toEqual([]);
    s.peer.close();
    await waitFor(() => s.ends.length === 1, 'the end');
    expect(s.ends).toEqual(['peer-closed']);
    expect(s.messages).toEqual([]);
    expect(s.link.taken).toBe(ODC_HEADER_BYTES + 1024);
    expect(s.link.largestReadSome).toBeLessThanOrEqual(READ_MAX);
  });

  it('a payload of 300 KB is read in pieces of at most 64 KB', async () => {
    const s = alone();
    const data = content(300 * 1024);
    await s.peer.write(frame(0, encodeOdcMessage('', [{ id: 1, ...picture(data) }])));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.attachments[0]?.bytes).toEqual(data);
    expect(s.link.largestReadSome).toBeLessThanOrEqual(READ_MAX);
    expect(s.link.largestReadSome).toBeGreaterThan(0);
  });

  it('a payload of 300 KB that comes one byte at a time arrives whole, and the session keeps no piece', async () => {
    const s = alone();
    s.link.pieceMax = 1;
    s.link.reused = new Uint8Array(1);
    const data = content(300 * 1024);
    await s.peer.write(frame(0, encodeOdcMessage('', [{ id: 1, ...picture(data) }])));
    await waitFor(() => s.messages.length === 1, 'the message', 20_000);
    expect(s.messages[0]?.damaged).toBe(false);
    expect(s.messages[0]?.attachments[0]?.bytes).toEqual(data);
    expect(s.ends).toEqual([]);
  }, 30_000);

  it('a DATA block that declares more than what follows: the message is damaged and has no attachment', async () => {
    const s = alone();
    await s.peer.write(frame(0, ascii('<IMG SRC="a.png" ID="1"><BINARY><DATA ID="1" SIZE="4294967295">0123456789')));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]).toMatchObject({ parts: [{ kind: 'missing' }], attachments: [], unreferenced: 0, damaged: true });
    expect(s.ends).toEqual([]);
  });

  it('more binaries than maxAttachments: the message is damaged, and the rest are not handed on', async () => {
    const s = alone({ maxAttachments: 2 });
    const pictures = [1, 2, 3].map((id) => ({ id, ...picture(content(8, id)) }));
    await s.peer.write(frame(0, encodeOdcMessage('', pictures)));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.parts).toEqual([{ kind: 'attachment', index: 0 }, { kind: 'attachment', index: 1 }]);
    expect(s.messages[0]?.attachments).toHaveLength(2);
    expect(s.messages[0]?.damaged).toBe(true);
  });

  it('an IMG with SRC="http://203.0.113.9/x.gif" and no ID gives one missing part and no attachment', async () => {
    const s = alone();
    await s.peer.write(frame(0, ascii('<IMG SRC="http://203.0.113.9/x.gif">')));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]).toMatchObject({ parts: [{ kind: 'missing' }], attachments: [], unreferenced: 0, damaged: false });
  });

  it('an IMG whose ID names no binary gives a missing part', async () => {
    const s = alone();
    const payload = joined([ascii('<IMG SRC="a.png" ID="2"><BINARY><DATA ID="1" SIZE="3">'), content(3), ascii('</DATA></BINARY>')]);
    await s.peer.write(frame(0, payload));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.parts).toEqual([{ kind: 'missing' }]);
    expect(s.messages[0]?.unreferenced).toBe(1);
  });

  it('a binary no IMG names: parts [], unreferenced 1', async () => {
    const s = alone();
    await s.peer.write(frame(0, joined([ascii('<BINARY><DATA ID="1" SIZE="3">'), content(3), ascii('</DATA></BINARY>')])));
    await waitFor(() => s.messages.length === 1, 'the message');
    expect(s.messages[0]?.parts).toEqual([]);
    expect(s.messages[0]?.unreferenced).toBe(1);
    expect(s.messages[0]?.damaged).toBe(false);
  });

  it('markup in the text becomes text runs only', async () => {
    const s = alone();
    await s.peer.write(frame(0, ascii('<script>alert(1)</script><A HREF="file:///etc/passwd">x</A>')));
    await waitFor(() => s.messages.length === 1, 'the message');
    const runs = s.messages[0]?.parts.flatMap((part) => (part.kind === 'text' ? part.body : []));
    expect(runs?.every((run) => run.link === undefined)).toBe(true);
    expect(s.messages[0]?.parts.every((part) => part.kind === 'text')).toBe(true);
  });

  it('an attachment is a copy, apart from the bytes of the other attachments', async () => {
    const s = alone();
    const pictures = [1, 2].map((id) => ({ id, ...picture(content(8, id)) }));
    await s.peer.write(frame(0, encodeOdcMessage('', pictures)));
    await waitFor(() => s.messages.length === 1, 'the message');
    const [first, second] = s.messages[0]?.attachments ?? [];
    expect(first?.bytes.buffer).not.toBe(second?.bytes.buffer);
    expect(first?.bytes.byteLength).toBe(first?.bytes.buffer.byteLength);
  });

  it('a throw from onMessage does not end the session', async () => {
    let calls = 0;
    const s = alone({
      onMessage: () => {
        calls += 1;
        throw new Error('listener');
      },
    });
    await s.peer.write(joined([frame(0, ascii('one')), frame(0, ascii('two'))]));
    await waitFor(() => calls === 2, 'two calls');
    expect(s.ends).toEqual([]);
  });
});

describe('OdcSession: send', () => {
  it('send before the peer spoke, sendUnverifiedAfterMs null: nothing but the hello is written; the frame goes out once the peer hello arrives', async () => {
    const s = alone();
    let done = false;
    const sending = s.session.send({ pictures: [picture(content(137))] }).then(() => {
      done = true;
    });
    await pause();
    await s.clock.advance(600_000);
    expect(s.link.sent).toHaveLength(1);
    expect(done).toBe(false);
    await s.peer.write(frame(ODC_FLAG_HELLO));
    await sending;
    const frames = framesOf(s.link);
    expect(frames.map((f) => f.kind)).toEqual(['hello', 'message']);
    expect(frames[1]?.cookie).toBe(COOKIE);
    expect(decodeOdcMessage(frames[1]?.payload as Uint8Array, 0, 16).binaries[0]?.bytes).toEqual(content(137));
  });

  it('send before the peer spoke, sendUnverifiedAfterMs 3000: the frame is written at 3000 ms and not at 2999', async () => {
    const s = alone({ sendUnverifiedAfterMs: 3000 });
    let done = false;
    const sending = s.session.send({ pictures: [picture(content(137))] }).then(() => {
      done = true;
    });
    await s.clock.advance(2999);
    expect(s.link.sent).toHaveLength(1);
    expect(done).toBe(false);
    await s.clock.advance(1);
    await sending;
    expect(framesOf(s.link).map((f) => f.kind)).toEqual(['hello', 'message']);
    expect(s.session.verified).toBe(false);
    expect(s.verified).toBe(0);
  });

  it('sendUnverifiedAfterMs 3000 counts from start, so a send after it goes at once', async () => {
    const s = alone({ sendUnverifiedAfterMs: 3000 });
    await s.clock.advance(3000);
    await s.session.send({ pictures: [picture(content(137))] });
    expect(framesOf(s.link)).toHaveLength(2);
  });

  it('a peer that shows the cookie before 3000 ms gets the frame at once, and no timer stays', async () => {
    const s = alone({ sendUnverifiedAfterMs: 3000 });
    const sending = s.session.send({ pictures: [picture(content(137))] });
    await s.peer.write(frame(ODC_FLAG_HELLO));
    await sending;
    expect(framesOf(s.link)).toHaveLength(2);
    expect(s.clock.pending()).toEqual([]);
  });

  it.each([null, 3000])('send to a peer whose first frame has another cookie rejects, and the picture was never written (%s)', async (after) => {
    const s = alone({ sendUnverifiedAfterMs: after });
    const sending = s.session.send({ pictures: [picture(content(137))] });
    const outcome = failure(sending);
    await s.peer.write(frame(ODC_FLAG_HELLO, new Uint8Array(0), OTHER_COOKIE));
    expect(await outcome).toBe('not-open');
    await s.clock.advance(10_000);
    expect(s.ends).toEqual(['bad-cookie']);
    expect(s.link.sent).toHaveLength(1);
    expect(s.clock.pending()).toEqual([]);
  });

  it('send of a payload over maxMessageBytes rejects too-large and writes nothing', async () => {
    const s = alone({ maxMessageBytes: 1000 });
    await s.peer.write(frame(ODC_FLAG_HELLO));
    await waitFor(() => s.session.verified, 'verified');
    expect(await failure(s.session.send({ pictures: [picture(content(1000))] }))).toBe('too-large');
    expect(s.link.sent).toHaveLength(1);
    expect(s.ends).toEqual([]);
    await s.session.send({ pictures: [picture(content(100))] });
    expect(framesOf(s.link)).toHaveLength(2);
  });

  it('two sends keep their order', async () => {
    const s = alone();
    const first = s.session.send({ pictures: [picture(content(200 * 1024, 1))] });
    const second = s.session.send({ body: [{ text: 'second' }], pictures: [] });
    const third = s.session.send({ pictures: [picture(content(40, 3))] });
    await s.peer.write(frame(ODC_FLAG_HELLO));
    await Promise.all([first, second, third]);
    const frames = framesOf(s.link);
    expect(frames.map((f) => f.kind)).toEqual(['hello', 'message', 'message', 'message']);
    expect(decodeOdcMessage(frames[1]?.payload as Uint8Array, 0, 16).binaries[0]?.bytes).toEqual(content(200 * 1024, 1));
    expect(Buffer.from(frames[2]?.payload as Uint8Array).toString('latin1')).toBe('second');
    expect(decodeOdcMessage(frames[3]?.payload as Uint8Array, 0, 16).binaries[0]?.bytes).toEqual(content(40, 3));
  });

  it('a picture of 200 KB goes out in writes of at most 32 KB', async () => {
    const s = alone();
    await s.peer.write(frame(ODC_FLAG_HELLO));
    await s.session.send({ pictures: [picture(content(200 * 1024))] });
    expect(Math.max(...s.link.sent.map((write) => write.length))).toBeLessThanOrEqual(WRITE_MAX);
    expect(s.link.sent.length).toBeGreaterThan(7);
  });

  it('a sent picture has the ids 1 and 2 in order, and the header has encoding 0 and the payload length', async () => {
    const s = alone();
    await s.peer.write(frame(ODC_FLAG_HELLO));
    await s.session.send({ pictures: [picture(content(5, 1), 'a.png'), picture(content(6, 2), 'b.gif')] });
    const all = joined(s.link.sent);
    const h = decodeOdcHeader(all.subarray(ODC_HEADER_BYTES, 2 * ODC_HEADER_BYTES));
    expect(h).toMatchObject({ cookie: COOKIE, encoding: 0, flags: 0, screenName: 'alice' });
    expect(h.payloadBytes).toBe(all.length - 2 * ODC_HEADER_BYTES);
    const message = decodeOdcMessage(all.subarray(2 * ODC_HEADER_BYTES), 0, 16);
    expect(message.binaries.map((binary) => binary.id)).toEqual([1, 2]);
    expect(message.segments).toEqual([{ image: { id: 1, name: 'a.png' } }, { image: { id: 2, name: 'b.gif' } }]);
  });

  it('a send that waits when the peer closes rejects not-open', async () => {
    const s = alone();
    const outcome = failure(s.session.send({ pictures: [picture(content(137))] }));
    s.peer.close();
    expect(await outcome).toBe('not-open');
    expect(s.ends).toEqual(['peer-closed']);
    expect(s.link.sent).toHaveLength(1);
  });

  it('a write that fails rejects the send peer-closed and ends the session one time', async () => {
    const s = alone({ sendUnverifiedAfterMs: 0 });
    await s.clock.advance(0);
    const realWrite = s.link.write.bind(s.link);
    let writes = 0;
    s.link.write = (bytes) => (++writes > 1 ? Promise.reject(new PeerClosedError()) : realWrite(bytes));
    const first = failure(s.session.send({ pictures: [picture(content(137))] }));
    const second = failure(s.session.send({ pictures: [picture(content(137))] }));
    expect(await first).toBe('peer-closed');
    expect(await second).toBe('not-open');
    expect(s.ends).toEqual(['peer-closed']);
    expect(s.link.closed).toBe(true);
  });

  it('close ends the session closed, one time; a send after it rejects not-open', async () => {
    const s = alone({ sendUnverifiedAfterMs: 3000 });
    await s.peer.write(frame(ODC_FLAG_HELLO));
    await waitFor(() => s.session.verified, 'verified');
    s.session.close();
    s.session.close();
    await pause();
    expect(s.ends).toEqual(['closed']);
    expect(s.link.closed).toBe(true);
    expect(await failure(s.session.send({ pictures: [picture(content(5))] }))).toBe('not-open');
    expect(s.link.sent).toHaveLength(1);
    expect(s.clock.pending()).toEqual([]);
  });

  it('close with a send that waits rejects it not-open, and nothing is written later', async () => {
    const s = alone({ sendUnverifiedAfterMs: 3000 });
    const outcome = failure(s.session.send({ pictures: [picture(content(137))] }));
    s.session.close();
    expect(await outcome).toBe('not-open');
    await s.clock.advance(5000);
    expect(s.link.sent).toHaveLength(1);
    expect(s.ends).toEqual(['closed']);
  });

  it('close before start ends closed and start then does nothing', async () => {
    const [a] = pair();
    const s = side(a);
    s.session.close();
    s.session.start();
    await pause();
    expect(s.ends).toEqual(['closed']);
    expect(a.sent).toEqual([]);
  });
});
