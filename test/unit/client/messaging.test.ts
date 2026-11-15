import { describe, expect, it } from 'vitest';
import { parseAimHtml } from '../../../src/client/aim-html.js';
import { BosLink } from '../../../src/client/bos-link.js';
import { OscarError } from '../../../src/client/errors.js';
import { Messaging, encodedImLength, imFailureReason, truncateToFit, warnRefusalKind } from '../../../src/client/messaging.js';
import type { MessagingDeps } from '../../../src/client/messaging.js';
import { ByteReader, ByteWriter, fromHex, toHex } from '../../../src/wire/bytes.js';
import { FLAP_MAX_PAYLOAD } from '../../../src/wire/constants.js';
import { decodeImFragments } from '../../../src/wire/icbm.js';
import { decodeRateParamsReply } from '../../../src/wire/rate.js';
import { encodeUserInfo } from '../../../src/wire/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, hasTlv, tlv } from '../../../src/wire/tlv.js';
import type { Tlv } from '../../../src/wire/tlv.js';
import type { BuddyPresence, IncomingIm } from '../../../src/model/buddy-list.js';
import type { RichText } from '../../../src/model/rich-text.js';
import { captureLog, ManualTimers } from '../../fake/oscar-client.js';
import { StubConn } from '../../fake/stub-conn.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const oservice = loadVectors('oservice.json');
const icbm = loadVectors('icbm.json');

function make(over: Partial<MessagingDeps> = {}) {
  const timers = new ManualTimers();
  const conn = new StubConn(timers);
  const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captureLog().log });
  link.seedRates(decodeRateParamsReply(bytesOf(oservice, 'rate params reply body, default classes, OService 1')));
  const ims: IncomingIm[] = [];
  const messaging = new Messaging({
    now: timers.now,
    log: captureLog().log,
    imLimit: () => 512,
    emit: (im) => ims.push(im),
    emitTyping: () => {},
    emitAutoResponse: () => {},
    decide: () => 'send',
    emitAnswered: () => {},
    variables: (to) => ({ name: to, date: '10/5/2026', time: '9:42 AM' }),
    noticeSender: null,
    presenceOf: () => undefined,
    ...over,
  });
  // Answers the last 0x04/0x06 written, on its request id.
  const reply = (subtype: number, body: Uint8Array): void => {
    const last = conn.sent.filter((s) => s.family === 4 && s.subtype === 6).at(-1);
    conn.deliver({ family: 4, subtype, body, requestId: last?.requestId ?? -1 });
  };
  return { timers, conn, link, messaging, ims, reply };
}

// 0x01/0x0A: code, then class 3's 30-byte record with the given current level
const notice = (code: number, level: number): Uint8Array => {
  const b = Buffer.alloc(32);
  b.writeUInt16BE(code, 0); b.writeUInt16BE(3, 2);
  for (const [i, n] of [20, 5100, 5000, 4000, 3000, level, 6000].entries()) b.writeUInt32BE(n, 4 + i * 4);
  return b;
};

// The first SNAC written, read as a message to host: cookie, channel, recipient, TLVs, text fragments.
function firstIm(conn: StubConn) {
  const r = new ByteReader(conn.sent[0]?.body ?? new Uint8Array(0));
  const cookie = r.u64();
  const channel = r.u16();
  const to = r.str8();
  const tlvs = decodeTlvs(r.rest());
  return { cookie, channel, to, tlvs, fragments: decodeImFragments(findTlv(tlvs, 0x02) ?? new Uint8Array(0)) };
}

// A message to client: cookie, channel 1, the sender's user info block, then TLV 0x02 when there is text.
function imBody(name: string, fragments: { charset: number; bytes: Uint8Array }[], extraTlvs: Tlv[] = []): Uint8Array {
  const data = new ByteWriter().u8(5).u8(1).u16(3).bytes(Uint8Array.of(1, 1, 2));
  for (const f of fragments) data.u8(1).u8(1).u16(4 + f.bytes.length).u16(f.charset).u16(0).bytes(f.bytes);
  const tlvs = fragments.length > 0 ? [tlv.bytes(0x02, data.toBytes()), ...extraTlvs] : extraTlvs;
  return new ByteWriter()
    .u64(0x0102030405060708n)
    .u16(1)
    .bytes(encodeUserInfo({ name, warning: 0, tlvs: [tlv.u16(0x01, 0x0010)] }))
    .bytes(encodeTlvs(tlvs))
    .toBytes();
}

describe('encodedImLength', () => {
  it.each([
    [[{ text: 'hello' }], 5],
    [[{ text: 'a<' }], 5],                       // a&lt;
    [[{ text: 'hi', bold: true }], 9],           // <B>hi</B>
    [[{ text: 'é' }], 2],                        // UTF-16BE
    [[{ text: '🙂' }], 4],                       // a surrogate pair
    [[{ text: 'hi 🙂', bold: true }], 24],       // every character of <B>hi 🙂</B> costs two bytes
  ] as [RichText, number][])('%j is %i bytes', (body, n) => {
    expect(encodedImLength(body)).toBe(n);
  });
});

describe('truncateToFit', () => {
  const units = (body: RichText): number => body.reduce((n, run) => n + run.text.length, 0);

  it('shortens a body to the longest prefix that fits and keeps its formatting', () => {
    const cut = truncateToFit([{ text: 'a'.repeat(600), bold: true }], 512);
    expect(cut).toHaveLength(1);
    expect(cut[0]?.bold).toBe(true);
    expect('a'.repeat(600).startsWith(cut[0]?.text ?? 'x')).toBe(true);
    expect(encodedImLength(cut)).toBeLessThanOrEqual(512);
    expect(encodedImLength([{ text: `${cut[0]?.text ?? ''}a`, bold: true }])).toBeGreaterThan(512);
  });

  it('never cuts a surrogate pair', () => {
    const cut = truncateToFit([{ text: '😀'.repeat(300) }], 512);
    expect(units(cut) % 2).toBe(0);
    expect(cut).toEqual([{ text: '😀'.repeat(units(cut) / 2) }]);
    expect(encodedImLength(cut)).toBeLessThanOrEqual(512);
    expect(encodedImLength([{ text: '😀'.repeat(units(cut) / 2 + 1) }])).toBeGreaterThan(512);
    // An odd limit in units: one unit of room is left over, and half a pair must not fill it.
    const odd = truncateToFit([{ text: `a${'😀'.repeat(300)}` }], 512);
    expect(odd).toEqual([{ text: `a${'😀'.repeat(127)}` }]);
  });

  it('drops whole runs that do not fit and returns a fitting body unchanged', () => {
    const fitting: RichText = [{ text: 'hi ' }, { text: 'there', bold: true, color: '#ff0000' }];
    expect(truncateToFit(fitting, 512)).toEqual(fitting);
    // The first run takes 510 bytes; the tags of the second alone take seven more.
    const body: RichText = [{ text: 'a'.repeat(510) }, { text: 'bbb', bold: true }, { text: 'c', italic: true }];
    expect(truncateToFit(body, 512)).toEqual([{ text: 'a'.repeat(510) }]);
    // A cut inside the second run keeps the first whole and the second's formatting.
    const two: RichText = [{ text: 'a'.repeat(500) }, { text: 'bbbbbbbbbb', bold: true }, { text: 'c' }];
    expect(truncateToFit(two, 512)).toEqual([{ text: 'a'.repeat(500) }, { text: 'bbbbb', bold: true }]);
    expect(truncateToFit([{ text: 'hello' }], 0)).toEqual([]);
  });
});

describe('Messaging.send', () => {
  it('sends on channel 1 with the acknowledgement and store requests and resolves on the acknowledgement', async () => {
    const { timers, conn, link, messaging, reply } = make();
    const sent = messaging.send(link, 'bob', [{ text: 'hi', bold: true }], 512);
    await timers.advance(0);
    const im = firstIm(conn);
    expect([im.channel, im.to, hasTlv(im.tlvs, 0x03), hasTlv(im.tlvs, 0x06), hasTlv(im.tlvs, 0x04)]).toEqual([1, 'bob', true, true, false]);
    expect(im.fragments).toEqual([{ charset: 0, text: new Uint8Array(Buffer.from('<B>hi</B>')) }]);
    expect(im.cookie).not.toBe(0n);
    reply(0x0c, new ByteWriter().u64(im.cookie).u16(1).str8('bob').toBytes());
    await expect(sent).resolves.toEqual({ id: im.cookie.toString(16).padStart(16, '0'), stored: true });
  });

  it('sends an HTML body as it is, with no limit but one frame', async () => {
    const html = `<A HREF="https://example.com"><B>x</B></A> &lt; ${'a'.repeat(600)}`;
    const { timers, conn, link, messaging } = make();
    void messaging.send(link, 'bob', { html }, 512).catch(() => {});
    await timers.advance(0);
    expect(firstIm(conn).fragments).toEqual([{ charset: 0, text: new Uint8Array(Buffer.from(html)) }]);
    const most = FLAP_MAX_PAYLOAD - 512;
    const over = make();
    await expect(over.messaging.send(over.link, 'bob', { html: 'a'.repeat(most + 1) }, 512)).rejects.toMatchObject({ info: { kind: 'local', code: 'message-too-long' } });
    await over.timers.advance(0);
    expect(over.conn.sent).toHaveLength(0);
    const fits = make();
    void fits.messaging.send(fits.link, 'bob', { html: 'a'.repeat(most) }, 512).catch(() => {});
    await fits.timers.advance(0);
    expect(fits.conn.sent).toHaveLength(1);
  });

  it('with when-offline asks for storage only for a recipient whose presence is offline', async () => {
    const offline = { screenName: 'bob', online: false } as BuddyPresence;
    const cases: [BuddyPresence | undefined, boolean][] = [[undefined, false], [{ ...offline, online: true }, false], [offline, true]];
    for (const [presence, stored] of cases) {
      const { timers, conn, link, messaging, reply } = make({ presenceOf: () => presence });
      const sent = messaging.send(link, 'bob', [{ text: 'hi' }], 512, { store: 'when-offline', automatic: true });
      await timers.advance(0);
      const im = firstIm(conn);
      expect([hasTlv(im.tlvs, 0x06), hasTlv(im.tlvs, 0x04)]).toEqual([stored, true]);
      reply(0x0c, new ByteWriter().u64(im.cookie).u16(1).str8('bob').toBytes());
      await expect(sent).resolves.toEqual({ id: im.cookie.toString(16).padStart(16, '0'), stored });
    }
  });

  it('with when-offline sends once more with the same cookie and the storage request after error 0x0004, and only once', async () => {
    const { timers, conn, link, messaging, reply } = make();
    const sent = messaging.send(link, 'bob', [{ text: 'hi' }], 512, { store: 'when-offline' });
    const refusal = sent.then(() => undefined, (e: OscarError) => e.info);
    await timers.advance(0);
    reply(0x01, new ByteWriter().u16(0x0004).toBytes());
    await timers.advance(0);
    const ims = conn.sent.filter((s) => s.family === 4 && s.subtype === 6).map((s) => decodeTlvs(s.body.subarray(8 + 2 + 1 + 3)));
    expect(ims.map((tlvs) => hasTlv(tlvs, 0x06))).toEqual([false, true]);
    expect(conn.sent.map((s) => toHex(s.body.subarray(0, 8)))).toEqual([toHex(conn.sent[0]?.body.subarray(0, 8) ?? new Uint8Array(0)), toHex(conn.sent[0]?.body.subarray(0, 8) ?? new Uint8Array(0))]);
    reply(0x01, new ByteWriter().u16(0x0004).toBytes());
    expect(await refusal).toEqual({ kind: 'refused', code: 0x0004 });
    await timers.advance(0);
    expect(conn.sent).toHaveLength(2);
  });

  it('with when-offline does not report a refused copy as sent when the link closes before the second copy is written', async () => {
    const { timers, conn, link, messaging, reply } = make();
    const failure = messaging.send(link, 'bob', [{ text: 'hi' }], 512, { store: 'when-offline' }).then(() => undefined, (e: OscarError) => e);
    await timers.advance(0);
    reply(0x01, new ByteWriter().u16(0x0004).toBytes());
    conn.closeWith({ kind: 'eof', clean: false });
    await timers.advance(0);
    const error = await failure;
    expect(conn.sent.filter((s) => s.family === 4 && s.subtype === 6)).toHaveLength(1);
    expect(error?.info.kind).toBe('connection-lost');
    expect(error?.sent).toBeUndefined();
  });

  it('with when-offline reports the second copy as sent when the link closes after it is written', async () => {
    const { timers, conn, link, messaging, reply } = make();
    const failure = messaging.send(link, 'bob', [{ text: 'hi' }], 512, { store: 'when-offline' }).then(() => undefined, (e: OscarError) => e);
    await timers.advance(0);
    reply(0x01, new ByteWriter().u16(0x0004).toBytes());
    await timers.advance(0);
    expect(conn.sent.filter((s) => s.family === 4 && s.subtype === 6)).toHaveLength(2);
    conn.closeWith({ kind: 'eof', clean: false });
    await timers.advance(0);
    const error = await failure;
    expect(error?.info.kind).toBe('connection-lost');
    expect(error?.sent).toBe(true);
  });

  it('sends text with any non-ASCII character as UTF-16BE, surrogate pairs kept', async () => {
    const { timers, conn, link, messaging } = make();
    void messaging.send(link, 'bob', [{ text: 'é🙂' }], 512).catch(() => {});
    await timers.advance(0);
    const [fragment] = firstIm(conn).fragments;
    expect([fragment?.charset, toHex(fragment?.text ?? new Uint8Array(0))]).toEqual([2, '00e9d83dde42']);
  });

  it('counts the limit in encoded bytes and sends nothing over it', async () => {
    const { timers, conn, link, messaging } = make();
    const over = async (body: RichText) => messaging.send(link, 'bob', body, 512).then(() => 'sent', (e: OscarError) => e.info);
    expect(await over([{ text: 'a'.repeat(513) }])).toEqual({ kind: 'local', code: 'message-too-long' });
    expect(await over([{ text: 'é'.repeat(257) }])).toEqual({ kind: 'local', code: 'message-too-long' });
    expect(await over([{ text: 'a'.repeat(506), bold: true }])).toEqual({ kind: 'local', code: 'message-too-long' }); // 513 with markup
    await timers.advance(0);
    expect(conn.sent).toHaveLength(0);
    void messaging.send(link, 'bob', [{ text: 'a'.repeat(512) }], 512).catch(() => {});
    void messaging.send(link, 'bob', [{ text: 'é'.repeat(256) }], 512).catch(() => {});
    await timers.advance(0);
    expect(conn.sent).toHaveLength(2);
  });

  it.each([
    ['0010', { kind: 'refused', code: 0x10 }, { reason: 'youBlocked' }],
    ['000400080002000f', { kind: 'refused', code: 4, subcode: 0x0f }, { reason: 'offlineInboxFull' }],
    ['0004', { kind: 'refused', code: 4 }, { reason: 'unavailable' }],
    ['000e', { kind: 'refused', code: 0x0e }, { reason: 'other', code: 0x0e }],
  ])('maps the server error %s', async (hex, info, failure) => {
    const { timers, link, messaging, reply } = make();
    let error: unknown;
    messaging.send(link, 'bob', [{ text: 'x' }], 512).catch((e: unknown) => (error = e));
    await timers.advance(0);
    reply(0x01, fromHex(hex));
    await timers.advance(0);
    expect((error as OscarError).info).toEqual(info);
    expect(imFailureReason(error)).toEqual(failure);
  });

  // A relayed 0x04/0x14 or 0x04/0x0B keeps the request id the peer chose (icbm.go:518-560), which can be a waiting IM's.
  const ack = (cookie: bigint): Uint8Array => new ByteWriter().u64(cookie).u16(1).str8('bob').toBytes();
  const relayedTyping = new ByteWriter().u64(0n).u16(1).str8('carol').u16(2).toBytes();
  const relayedClientError = new ByteWriter().u64(7n).u16(1).str8('carol').u16(1).toBytes();
  function pending() {
    const made = make();
    const outcome: { done: boolean; error?: unknown } = { done: false };
    made.messaging.send(made.link, 'bob', [{ text: 'x' }], 512).then(
      () => { outcome.done = true; },
      (e: unknown) => { outcome.done = true; outcome.error = e; },
    );
    return { ...made, outcome };
  }

  it("stays pending through a relayed SNAC that carries the send's request id, and resolves on the acknowledgement after it", async () => {
    const { timers, conn, reply, outcome } = pending();
    await timers.advance(0);
    reply(0x14, relayedTyping);
    reply(0x0b, relayedClientError);
    await timers.advance(0);
    expect(outcome).toEqual({ done: false });
    reply(0x0c, ack(firstIm(conn).cookie));
    await timers.advance(0);
    expect(outcome).toEqual({ done: true });
  });

  it('does not take an acknowledgement with another cookie, or one too short to read, for its own', async () => {
    const { timers, conn, reply, outcome } = pending();
    await timers.advance(0);
    reply(0x0c, ack(firstIm(conn).cookie ^ 1n));
    reply(0x0c, new Uint8Array(3));
    await timers.advance(0);
    expect(outcome).toEqual({ done: false });
    reply(0x0c, ack(firstIm(conn).cookie));
    await timers.advance(0);
    expect(outcome).toEqual({ done: true });
  });

  it('fails as unconfirmed at 15 s when only a relayed SNAC came on the request id', async () => {
    const { timers, reply, outcome } = pending();
    await timers.advance(0);
    reply(0x14, relayedTyping);
    await timers.advance(14_999);
    expect(outcome).toEqual({ done: false });
    await timers.advance(1);
    expect(imFailureReason(outcome.error)).toEqual({ reason: 'unconfirmed' });
  });

  it('refuses with code 0 on a server error too short to carry a code', async () => {
    const { timers, reply, outcome } = pending();
    await timers.advance(0);
    reply(0x01, new Uint8Array(1));
    await timers.advance(0);
    expect((outcome.error as OscarError).info).toEqual({ kind: 'refused', code: 0 });
  });

  it('fails as unconfirmed 15 s after release, and as rate limited when the class was reported limited', async () => {
    const a = make();
    let error: unknown;
    a.messaging.send(a.link, 'bob', [{ text: 'x' }], 512).catch((e: unknown) => (error = e));
    await a.timers.advance(14_999);
    expect(error).toBeUndefined();
    await a.timers.advance(1);
    expect(imFailureReason(error)).toEqual({ reason: 'unconfirmed' });

    const b = make();
    b.messaging.send(b.link, 'bob', [{ text: 'x' }], 512).catch((e: unknown) => (error = e));
    await b.timers.advance(0);
    b.conn.deliver({ family: 1, subtype: 0x0a, body: notice(3, 3977) });
    await b.timers.advance(15_000);
    expect(imFailureReason(error)).toEqual({ reason: 'rateLimited' });
  });

  it('maps a lost connection', () => {
    expect(imFailureReason(new OscarError({ kind: 'connection-lost' }))).toEqual({ reason: 'connectionLost' });
    expect(imFailureReason(new OscarError({ kind: 'not-signed-on' }))).toEqual({ reason: 'connectionLost' });
    expect(imFailureReason(new Error('x'))).toEqual({ reason: 'other' });
  });
});

describe('warnRefusalKind', () => {
  it('names a warn refusal', () => {
    expect(warnRefusalKind(new OscarError({ kind: 'refused', code: 13 }))).toBe('not-allowed');
    expect(warnRefusalKind(new OscarError({ kind: 'refused', code: 4 }))).toBe('not-available');
    expect(warnRefusalKind(new OscarError({ kind: 'refused', code: 8 }))).toBe('other');
    expect(warnRefusalKind(new OscarError({ kind: 'timeout', rateLimited: false }))).toBe('other');
    expect(warnRefusalKind(new Error('x'))).toBe('other');
  });
});

describe('Messaging.handle', () => {
  const deliver = ({ messaging, link }: { messaging: Messaging; link: BosLink }, body: Uint8Array) =>
    messaging.handle(link, { family: 4, subtype: 7, flags: 0, requestId: 0x80000000, body });

  it('delivers an IM as RichText with the sender as the server wrote it', () => {
    const m = make();
    const { ims, timers } = m;
    expect(deliver(m, bytesOf(icbm, 'message to client body'))).toBe(true);
    expect(ims).toEqual([{ from: 'Alice', body: [{ text: 'hi' }], autoResponse: false, at: timers.now(), offline: false, serverNotice: false }]);
  });

  it('flags an auto-response', () => {
    const m = make();
    const { ims } = m;
    deliver(m, bytesOf(icbm, 'message to client body, auto-response from an away sender'));
    expect([ims[0]?.autoResponse, ims[0]?.body]).toEqual([true, [{ text: 'brb' }]]);
  });

  it.each([
    ['charset 0 over UTF-8 bytes', 0, Buffer.from('café', 'utf8'), 'café'],
    ['charset 0 over Latin-1 bytes', 0, Buffer.from('café', 'latin1'), 'café'],
    ['charset 3', 3, Buffer.from('café', 'latin1'), 'café'],
    ['charset 2 with a surrogate pair', 2, fromHex('00e9d83dde42'), 'é🙂'],
    ['an unknown charset over UTF-8 bytes', 0x99, Buffer.from('привет', 'utf8'), 'привет'],
    ['an unknown charset over Latin-1 bytes', 0x99, Buffer.from('café', 'latin1'), 'café'],
  ] as [string, number, Uint8Array, string][])('decodes by declared charset and never drops a message: %s', (_n, charset, bytes, text) => {
    const m = make();
    const { ims } = m;
    deliver(m, imBody('Bob', [{ charset, bytes }]));
    expect(ims.map((im) => im.body)).toEqual([[{ text }]]);
  });

  it('joins several text fragments and keeps formatting', () => {
    const m = make();
    const { ims } = m;
    deliver(m, imBody('Bob', [{ charset: 0, bytes: Buffer.from('<B>a') }, { charset: 0, bytes: Buffer.from('b</B> c') }]));
    expect(ims[0]?.body).toEqual([{ text: 'ab', bold: true }, { text: ' c' }]);
  });

  it('with wireDetail adds the cookie as 16 hex digits and the joined HTML before the parse', () => {
    const m = make({ wireDetail: true });
    deliver(m, imBody('Bob', [{ charset: 0, bytes: Buffer.from('<B>a') }, { charset: 0, bytes: Buffer.from('b</B> &amp;') }]));
    expect(m.ims[0]?.wire).toEqual({ cookie: '0102030405060708', html: '<B>ab</B> &amp;' });
    expect(m.ims[0]?.body).toEqual([{ text: 'ab', bold: true }, { text: ' &' }]);
  });

  it('with wireDetail decodes the HTML by its charset', () => {
    const m = make({ wireDetail: true });
    deliver(m, imBody('Bob', [{ charset: 2, bytes: fromHex('00e9d83dde42') }]));
    expect(m.ims[0]?.wire).toEqual({ cookie: '0102030405060708', html: 'é🙂' });
  });

  it.each([
    ['off', { wireDetail: false }],
    ['not set', {}],
  ] as const)('with wireDetail %s the IM has no wire key', (_label, over) => {
    const m = make(over);
    deliver(m, imBody('Bob', [{ charset: 0, bytes: Buffer.from('hi') }]));
    expect(m.ims).toHaveLength(1);
    expect('wire' in (m.ims[0] as object)).toBe(false);
  });

  it('ignores channel 2 and a channel 1 message with no text TLV', () => {
    const m = make();
    const { ims } = m;
    expect(deliver(m, bytesOf(icbm, 'message to client body, channel 2 chat invitation'))).toBe(true);
    expect(deliver(m, imBody('Bob', []))).toBe(true);
    expect(ims).toEqual([]);
  });

  it('leaves every other SNAC to the other services', () => {
    const { ims, messaging, link } = make();
    expect(messaging.handle(link, { family: 4, subtype: 0x0c, flags: 0, requestId: 1, body: new Uint8Array(0) })).toBe(false);
    expect(messaging.handle(link, { family: 3, subtype: 7, flags: 0, requestId: 1, body: new Uint8Array(0) })).toBe(false);
    expect(ims).toEqual([]);
  });

  it('throws on a body it cannot read', () => {
    const m = make();
    expect(() => deliver(m, bytesOf(icbm, 'message to client body').subarray(0, 12))).toThrow();
  });
});

describe('the auto-response sent, and addresses written as text', () => {
  const sentHtml = (conn: StubConn): string[] =>
    conn.sent.filter((s) => s.family === 4 && s.subtype === 6).map((s) => {
      const r = new ByteReader(s.body);
      r.u64();
      r.u16();
      r.str8();
      return decodeImFragments(findTlv(decodeTlvs(r.rest()), 0x02) ?? new Uint8Array(0))
        .map((f) => (f.charset === 2 ? Buffer.from(f.text).swap16().toString('utf16le') : Buffer.from(f.text).toString('latin1')))
        .join('');
    });

  async function answered(away: RichText): Promise<string[]> {
    const m = make();
    m.messaging.setAway(away);
    m.messaging.handle(m.link, { family: 4, subtype: 7, flags: 0, requestId: 0x80000000, body: imBody('Bob', [{ charset: 0, bytes: Buffer.from('hi') }]) });
    await m.timers.advance(0);
    return sentHtml(m.conn);
  }

  it('leaves a token inside an address as typed, puts in the one outside it, and links nothing', async () => {
    const html = await answered([{ text: 'see www.example.com/~%n, %n' }]);
    expect(html).toHaveLength(1);
    expect(parseAimHtml(html[0] ?? '').map((run) => run.text).join('')).toBe('see www.example.com/~%n, Bob');
    expect(html[0]).not.toMatch(/<A/i);
    expect(html.filter((each) => /www\.example\.com\/~Bob/.test(each))).toEqual([]);
  });

  it('sends an address written as text with no link', async () => {
    const html = await answered([{ text: 'see www.example.net' }]);
    expect(html).toEqual(['see www.example.net']);
  });
});

describe('the senders answered in an away period', () => {
  it('are kept normalised, once each, through an edit and until the away ends', () => {
    const { messaging } = make();
    messaging.setAway([{ text: 'out' }]);
    messaging.markAnswered('Bob Smith');
    messaging.restoreAnswered(['Carol', 'bobsmith', ' ']);
    expect(messaging.answeredSenders()).toEqual(['bobsmith', 'carol']);
    messaging.setAway([{ text: 'back at two' }]);
    expect(messaging.answeredSenders()).toEqual(['bobsmith', 'carol']);
    messaging.setAway(null);
    expect(messaging.answeredSenders()).toEqual([]);
  });
});
