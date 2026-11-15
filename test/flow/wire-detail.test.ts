import { afterEach, describe, expect, it } from 'vitest';
import { ByteWriter } from '../../src/wire/bytes.js';
import { ICBM_CHANNEL_IM, ICBM_TLV_IM_DATA } from '../../src/wire/constants.js';
import { tlv } from '../../src/wire/tlv.js';
import type { RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';

const ROOM: RoomId = { exchange: 4, name: 'Wire Room' };
const HTML = '<B>hi</B> &amp; <A HREF="https://example.com">x</A>';

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;

async function start(wireDetail?: boolean): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  h = makeClient(fake, { timers, ...(wireDetail === undefined ? {} : { wireDetail }) });
  bob = fake.peer('Bob');
  await h.signOn();
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

// The capabilities fragment, then one text fragment for each part, each with charset 0.
function twoFragments(parts: readonly string[]): Uint8Array {
  const data = new ByteWriter().u8(5).u8(1).u16(3).bytes(Uint8Array.of(1, 1, 2));
  for (const part of parts) {
    const bytes = Buffer.from(part, 'ascii');
    data.u8(1).u8(1).u16(4 + bytes.length).u16(0).u16(0).bytes(bytes);
  }
  return data.toBytes();
}

describe('with wireDetail', () => {
  it('an IM carries its cookie as 16 hex digits and its HTML as sent', async () => {
    await start(true);
    bob.sendIm('Alice', HTML, { cookie: 0x1n });
    await waitFor(() => h.ims.length === 1, 'the IM');
    expect(h.ims[0]?.wire).toEqual({ cookie: '0000000000000001', html: HTML });
    expect(h.ims[0]?.body.map((run) => run.text).join('')).toBe('hi & x');
  });

  it('an IM cookie with all 64 bits set is 16 lowercase hex digits', async () => {
    await start(true);
    bob.sendIm('Alice', 'max', { cookie: 0xfedcba9876543210n });
    await waitFor(() => h.ims.length === 1, 'the IM');
    expect(h.ims[0]?.wire).toEqual({ cookie: 'fedcba9876543210', html: 'max' });
  });

  it('an IM in two fragments carries the joined HTML', async () => {
    await start(true);
    bob.sendRaw('Alice', ICBM_CHANNEL_IM, [tlv.bytes(ICBM_TLV_IM_DATA, twoFragments(['<B>a', 'b</B> c']))], 0xabn);
    await waitFor(() => h.ims.length === 1, 'the IM');
    expect(h.ims[0]?.wire).toEqual({ cookie: '00000000000000ab', html: '<B>ab</B> c' });
    expect(h.ims[0]?.body).toEqual([{ text: 'ab', bold: true }, { text: ' c' }]);
  });

  it('a server notice carries cookie 0000000000000000', async () => {
    await start(true);
    await makeClient(fake, { timers }).signOn();
    await waitFor(() => h.ims.length === 1, 'the notice of two locations');
    const notice = h.ims[0];
    expect(notice?.serverNotice).toBe(true);
    expect(notice?.wire?.cookie).toBe('0000000000000000');
    expect(notice?.wire?.html).toContain('in 2 locations');
  });

  it('a room line and a whisper carry cookie and HTML', async () => {
    await start(true);
    fake.rooms.peerJoin('Bob', ROOM);
    await h.client.joinRoom(ROOM);
    fake.rooms.peerSay('Bob', ROOM, '<B>a line</B> &lt;', { cookie: 0x2an });
    fake.rooms.peerSay('Bob', ROOM, '<I>psst</I>', { cookie: 0x2bn, whisperTo: 'Alice' });
    await waitFor(() => h.roomMessages.length === 2, 'the two room lines');
    expect(h.roomMessages.map((m) => [m.whisper, m.wire])).toEqual([
      [false, { cookie: '000000000000002a', html: '<B>a line</B> &lt;' }],
      [true, { cookie: '000000000000002b', html: '<I>psst</I>' }],
    ]);
  });

  it('an invitation carries the HTML of its text', async () => {
    await start(true);
    bob.invite('Alice', { exchange: 4, cookie: '4-0-Other Room' }, { text: '<B>come</B> &amp; see' });
    await waitFor(() => h.invites.length === 1, 'the invitation');
    expect(h.invites[0]?.wire).toEqual({ html: '<B>come</B> &amp; see' });
    // The same room again under a new cookie updates the invitation, with its own text.
    bob.invite('Alice', { exchange: 4, cookie: '4-0-Other Room' }, { text: 'again' });
    await waitFor(() => h.invites.length === 2, 'the second invitation');
    expect(h.invites[1]?.wire).toEqual({ html: 'again' });
  });

  it('the wire object survives JSON.stringify', async () => {
    await start(true);
    bob.sendIm('Alice', HTML, { cookie: 0x7n });
    fake.rooms.peerJoin('Bob', ROOM);
    await h.client.joinRoom(ROOM);
    fake.rooms.peerSay('Bob', ROOM, 'line', { cookie: 0x8n });
    bob.invite('Alice', { exchange: 4, cookie: '4-0-Other Room' }, { text: 'come' });
    await waitFor(() => h.ims.length === 1 && h.roomMessages.length === 1 && h.invites.length === 1, 'the three events');
    for (const wire of [h.ims[0]?.wire, h.roomMessages[0]?.wire, h.invites[0]?.wire]) {
      expect(wire).toBeDefined();
      expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    }
  });
});

describe('without wireDetail', () => {
  it.each([
    ['off', false],
    ['not set', undefined],
  ] as const)('with the option %s no event has a wire key', async (_label, wireDetail) => {
    await start(wireDetail);
    bob.sendIm('Alice', HTML, { cookie: 0x1n });
    await waitFor(() => h.ims.length === 1, 'the IM');
    await makeClient(fake, { timers }).signOn();
    await waitFor(() => h.ims.length === 2, 'the notice of two locations');
    fake.rooms.peerJoin('Bob', ROOM);
    await h.client.joinRoom(ROOM);
    fake.rooms.peerSay('Bob', ROOM, 'a line');
    fake.rooms.peerSay('Bob', ROOM, 'psst', { whisperTo: 'Alice' });
    bob.invite('Alice', { exchange: 4, cookie: '4-0-Other Room' }, { text: 'come' });
    await waitFor(() => h.roomMessages.length === 2 && h.invites.length === 1, 'the room lines and the invitation');
    for (const event of [...h.ims, ...h.roomMessages, ...h.invites]) expect('wire' in event).toBe(false);
  });
});
