import { afterEach, describe, expect, it } from 'vitest';
import { parseAimHtml } from '../../src/client/aim-html.js';
import type { OscarError } from '../../src/client/errors.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { ByteReader } from '../../src/wire/bytes.js';
import { CHAT_MSG_TLV_TEXT, CHAT_TLV_MESSAGE, FLAP_MAX_PAYLOAD, ICBM_TLV_AUTO_RESPONSE, ICBM_TLV_IM_DATA } from '../../src/wire/constants.js';
import { decodeImFragments } from '../../src/wire/icbm.js';
import { encodeImText } from '../../src/wire/text.js';
import { decodeTlvs, findTlv, hasTlv, tlvStr } from '../../src/wire/tlv.js';
import type { RoomId } from '../../src/model/room.js';
import type { RichText } from '../../src/model/rich-text.js';
import { imRoundTrip, makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord } from '../fake/oscar-server.js';

const ROOM: RoomId = { exchange: 4, name: 'Html Room' };
// The rich-text render writes each of these another way: no outer tags, tag names in capitals, and `&lt;` for the reference.
const HTML = '<HTML><BODY BGCOLOR="#ffffff"><a href="https://example.com"><b>x</b></a> &#60; café</BODY></HTML>';
const ASCII_HTML = '<HTML><a href="https://example.com"><b>x</b></a> &#60; y</HTML>';

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;

async function start(over: Pick<OscarClientOptions, 'oserviceVersion' | 'awayRecord'> = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  h = makeClient(fake, { timers, ...over });
  bob = fake.peer('Bob');
  await h.signOn();
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const text = (words: string): RichText => [{ text: words }];
const fromAlice = (family: number, subtype: number): SnacRecord[] => fake.snacsFrom('alice').filter((s) => s.family === family && s.subtype === subtype);
const imsSent = (): SnacRecord[] => fromAlice(0x04, 0x06);
const locateWrites = (): SnacRecord[] => fromAlice(0x02, 0x04);
const roomSends = (): SnacRecord[] => fromAlice(0x0e, 0x05);
const awayWritten = (snac: SnacRecord | undefined): string | undefined => tlvStr(decodeTlvs(snac?.body ?? new Uint8Array(0)), 0x04);

// The text fragments of a 0x04/0x06: cookie, channel, recipient, TLVs.
function fragmentsOf(snac: SnacRecord | undefined): { charset: number; text: Uint8Array }[] {
  const r = new ByteReader(snac?.body ?? new Uint8Array(0));
  r.u64();
  r.u16();
  r.str8();
  return decodeImFragments(findTlv(decodeTlvs(r.rest()), ICBM_TLV_IM_DATA) ?? new Uint8Array(0));
}

// A 0x0E/0x05: cookie, channel, TLVs; the line is in TLV 0x05.
function roomLineOf(snac: SnacRecord | undefined): { cookie: bigint; text: string | undefined } {
  const r = new ByteReader(snac?.body ?? new Uint8Array(0));
  const cookie = r.u64();
  r.u16();
  const inner = findTlv(decodeTlvs(r.rest()), CHAT_TLV_MESSAGE) ?? new Uint8Array(0);
  return { cookie, text: tlvStr(decodeTlvs(inner), CHAT_MSG_TLV_TEXT) };
}

async function refusalOf(promise: Promise<unknown>): Promise<OscarError['info'] | undefined> {
  return promise.then(
    () => undefined,
    (e: OscarError) => e.info,
  );
}

describe('an { html } IM', () => {
  it('an { html } IM goes out byte for byte', async () => {
    await start();
    await h.client.sendIm('bob', { html: HTML });
    expect(bob.ims().at(-1)?.html).toBe(HTML);
    const wire = encodeImText(HTML);
    expect(fragmentsOf(imsSent()[0])).toEqual([{ charset: wire.charset, text: wire.bytes }]);
  });

  it('the same text as rich text goes out another way', async () => {
    await start();
    await h.client.sendIm('bob', parseAimHtml(HTML));
    expect(bob.ims().at(-1)?.html).toBe('<A HREF="https://example.com"><B>x</B></A> &lt; café');
  });

  it('an { html } IM takes the options and resolves as a rich-text IM does', async () => {
    await start();
    const sent = await h.client.sendIm('bob', { html: ASCII_HTML }, { automatic: true });
    expect(sent).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), stored: true });
    expect(bob.ims().map((im) => [im.html, hasTlv(im.tlvs, ICBM_TLV_AUTO_RESPONSE)])).toEqual([[ASCII_HTML, true]]);
  });

  it('an { html } IM over the server limit but under one frame is sent', async () => {
    await start();
    const html = `<B>${'a'.repeat(2000)}</B>`;
    expect(html.length).toBeGreaterThan(h.client.limits?.imBytes ?? Number.POSITIVE_INFINITY);
    await h.client.sendIm('bob', { html });
    expect(bob.ims().at(-1)?.html).toBe(html);
  });

  it('an { html } IM that does not fit one frame is refused message-too-long and nothing is written', async () => {
    await start();
    const refusal = await refusalOf(h.client.sendIm('bob', { html: 'a'.repeat(FLAP_MAX_PAYLOAD - 512 + 1) }));
    expect(refusal).toEqual({ kind: 'local', code: 'message-too-long' });
    await imRoundTrip(fake, h);
    expect(imsSent()).toHaveLength(1);
  });

  it('a rich-text IM over the server limit is still refused', async () => {
    await start();
    const limit = h.client.limits?.imBytes ?? 0;
    expect(await refusalOf(h.client.sendIm('bob', text('a'.repeat(limit + 1))))).toEqual({ kind: 'local', code: 'message-too-long' });
    await imRoundTrip(fake, h);
    expect(imsSent()).toHaveLength(1);
  });
});

describe('an { html } room line', () => {
  it('an { html } room line and whisper go out as given and the result has the receipt id', async () => {
    await start();
    fake.rooms.peerJoin('Bob', ROOM);
    const id = (await h.client.joinRoom(ROOM)).id;
    const line = await h.client.sendRoomMessage(id, { html: ASCII_HTML });
    const whisper = await h.client.sendRoomMessage(id, { html: `${ASCII_HTML}!` }, { whisperTo: 'Bob' });
    const sent = roomSends().map(roomLineOf);
    expect(sent.map((s) => s.text)).toEqual([ASCII_HTML, `${ASCII_HTML}!`]);
    expect(line).toEqual({ replacedBy: null, id: sent[0]?.cookie.toString(16) });
    expect(whisper).toEqual({ replacedBy: null, id: sent[1]?.cookie.toString(16) });
    expect(fake.rooms.peerLines('Bob', ROOM).slice(-2)).toEqual([
      { from: 'alice', text: ASCII_HTML, whisper: false },
      { from: 'alice', text: `${ASCII_HTML}!`, whisper: true },
    ]);
  });

  it('a rich-text room line resolves with replacedBy as before, and an id', async () => {
    await start();
    fake.rooms.peerJoin('Bob', ROOM);
    const id = (await h.client.joinRoom(ROOM)).id;
    const line = await h.client.sendRoomMessage(id, text('hello'));
    expect(line).toEqual({ replacedBy: null, id: roomLineOf(roomSends()[0]).cookie.toString(16) });
    const roll = await h.client.sendRoomMessage(id, text('//roll'));
    expect((roll.replacedBy ?? []).map((run) => run.text).join('')).toContain('rolled');
    expect(roll.id).toBe(roomLineOf(roomSends()[1]).cookie.toString(16));
  });

  it('an { html } room line over the limit of a room line is refused message-too-long', async () => {
    await start();
    fake.rooms.peerJoin('Bob', ROOM);
    const id = (await h.client.joinRoom(ROOM)).id;
    expect(await refusalOf(h.client.sendRoomMessage(id, { html: 'a'.repeat(1025) }))).toEqual({ kind: 'local', code: 'message-too-long' });
    await h.client.sendRoomMessage(id, { html: 'a'.repeat(1024) });
    expect(roomSends()).toHaveLength(1);
  });
});

describe('an { html } away message', () => {
  it('an { html } away is written as given, and awayMessage reads its parsed text', async () => {
    await start();
    await h.client.setAway({ html: ASCII_HTML });
    expect(h.client.awayMessage).toEqual(parseAimHtml(ASCII_HTML));
    await imRoundTrip(fake, h);
    expect(awayWritten(locateWrites().at(-1))).toBe(ASCII_HTML);
  });

  it('the auto-response to an IM carries the parsed text of an { html } away', async () => {
    await start();
    await h.client.setAway({ html: '<B>out</B> &amp; about' });
    bob.sendIm('Alice', 'are you there?');
    await waitFor(() => h.autoResponses.length === 1, 'the auto-response');
    await h.autoResponses[0]?.done;
    expect(h.autoResponses[0]?.body).toEqual(parseAimHtml('<B>out</B> &amp; about'));
    expect(bob.ims().map((im) => [im.html, hasTlv(im.tlvs, ICBM_TLV_AUTO_RESPONSE)])).toEqual([['<B>out</B> &amp; about', true]]);
  });

  it('a null away after an { html } away clears it', async () => {
    await start();
    await h.client.setAway({ html: 'brb' });
    await h.client.setAway(null);
    expect(h.client.awayMessage).toBeNull();
    await imRoundTrip(fake, h);
    expect(awayWritten(locateWrites().at(-1))).toBe('');
  });

  it('an { html } away over the limit is refused text-too-long', async () => {
    await start();
    const limit = h.client.limits?.awayAndProfileBytes ?? 0;
    const writes = locateWrites().length;
    expect(await refusalOf(h.client.setAway({ html: 'a'.repeat(limit + 1) }))).toEqual({ kind: 'local', code: 'text-too-long' });
    expect(await refusalOf(h.client.setAway({ html: '' }))).toEqual({ kind: 'local', code: 'invalid-argument' });
    expect(h.client.awayMessage).toBeNull();
    await h.client.setAway({ html: 'a'.repeat(limit) });
    await imRoundTrip(fake, h);
    expect(locateWrites()).toHaveLength(writes + 1);
  });

  it('an { html } away with the awayRecord option is refused invalid-argument', async () => {
    await start({ oserviceVersion: 4, awayRecord: { name: 'example.away', role: 'own', source: 'phone', random: () => 0 } });
    const writes = locateWrites().length;
    expect(await refusalOf(h.client.setAway({ html: 'brb' }))).toEqual({ kind: 'local', code: 'invalid-argument' });
    expect(h.client.awayMessage).toBeNull();
    await h.client.setAway(text('brb'));
    await imRoundTrip(fake, h);
    expect(locateWrites()).toHaveLength(writes + 1);
    expect(awayWritten(locateWrites().at(-1))).toBe('brb');
  });
});
