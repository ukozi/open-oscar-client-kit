import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OscarError } from '../../src/client/errors.js';
import { INVITE_TEXT_MAX, MAX_PENDING_INVITES, ROOM_CLOSE_SETTLE_MS, Rooms } from '../../src/client/rooms.js';
import { ByteReader, ByteWriter } from '../../src/wire/bytes.js';
import { CAP_CHAT, SERVICE_TLV_ROOM_INFO } from '../../src/wire/constants.js';
import { encodeFileProposal, encodeRendezvousAccept, encodeRendezvousCancel } from '../../src/wire/rendezvous.js';
import { encodeUserInfo } from '../../src/wire/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { Invite, RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, captureLog, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord } from '../fake/oscar-server.js';

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;
let id: string;

const ROOM: RoomId = { exchange: 4, name: 'Dev Room' };

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
  h = makeClient(server, { timers });
  await h.signOn();
  bob = server.peer('Bob');
  id = (await h.client.joinRoom(ROOM)).id;
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const channel2 = (): SnacRecord[] =>
  server.snacsFrom('alice').filter((s) => s.family === 0x04 && s.subtype === 0x06 && Buffer.from(s.body).readUInt16BE(8) === 2);

// The TLVs of a 0x04/0x06 body: they follow the cookie, the channel and the recipient's name.
function tlvsOf(record: SnacRecord | undefined): Tlv[] {
  if (!record) throw new Error('no such SNAC');
  const r = new ByteReader(record.body);
  r.u64();
  r.u16();
  r.str8();
  return decodeTlvs(r.rest());
}

// The room cookie in TLV 0x0001 of a chat service request: exchange, the cookie with a one-byte length, instance.
function requestedCookies(): string[] {
  return server
    .snacsFrom('alice')
    .filter((s) => s.conn === 'bos' && s.family === 0x01 && s.subtype === 0x04 && Buffer.from(s.body).readUInt16BE(0) === 0x000e)
    .map((s) => {
      const info = findTlv(decodeTlvs(s.body.subarray(2)), SERVICE_TLV_ROOM_INFO);
      if (!info) throw new Error('the service request carries no room');
      return Buffer.from(info).toString('utf8', 3, 3 + (info[2] ?? 0));
    });
}

type Fragment = { type?: number; capability?: Uint8Array; cookie?: bigint };
// TLV 0x0005 of a room proposal: the type, the invitation's cookie, the capability, then the sequence number and the room.
function fragment(exchange: number, roomCookie: string, over: Fragment = {}): Tlv {
  const name = Buffer.from(roomCookie, 'utf8');
  const room = new ByteWriter().u16(exchange).u8(name.length).bytes(name).u16(0).toBytes();
  const value = new ByteWriter()
    .u16(over.type ?? 0)
    .u64(over.cookie ?? 0x0a0b0c0d0e0f1011n)
    .bytes(over.capability ?? CAP_CHAT)
    .bytes(encodeTlvs([tlv.u16(0x000a, 1), tlv.bytes(0x2711, room)]))
    .toBytes();
  return tlv.bytes(0x0005, value);
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

const infoOf = (error: unknown): unknown => (error instanceof OscarError ? error.info : error);

// Alice has read everything the peer sent before this: an IM written after it has arrived.
async function readUpTo(peer: FakePeer, marker: string): Promise<void> {
  peer.sendIm('Alice', marker);
  await waitFor(() => h.ims.some((im) => im.body.map((run) => run.text).join('') === marker), `the IM "${marker}"`);
}

const imTexts = (): string[] => h.ims.map((im) => im.body.map((run) => run.text).join(''));
const aboveDebug = (): number => h.logs.lines.filter((line) => line.level !== 'debug').length;

function firstInvite(): Invite {
  const invite = h.invites[0];
  if (!invite) throw new Error('no invite was raised');
  return invite;
}

const hex = (cookie: bigint): string => cookie.toString(16).padStart(16, '0');

describe('room invites', () => {
  it("invites a screen name with the room's own cookie and the fixed text, and resolves on the acknowledgement", async () => {
    await h.client.inviteToRoom(id, 'Bob');
    const got = bob.invites().at(-1);
    expect(got).toEqual({
      from: 'Alice',
      kind: 'proposal',
      cookie: got?.cookie,
      roomCookie: '4-0-Dev Room',
      exchange: 4,
      html: 'Join me in this room.',
    });
    expect(typeof got?.cookie).toBe('bigint');
    expect(channel2()).toHaveLength(1);
    expect(findTlv(tlvsOf(channel2()[0]), 0x0003)).toBeDefined();
  });

  it("fails with the server's code when the screen name cannot be reached", async () => {
    const error = await errorOf(h.client.inviteToRoom(id, 'Nobody'));
    expect(error).toBeInstanceOf(OscarError);
    expect(infoOf(error)).toEqual({ kind: 'refused', code: 0x0004 });
    expect(h.client.state).toBe('online');
  });

  it('fails as a timeout 15 s after the invitation was written when nothing comes back', async () => {
    const release = server.withhold(0x0004, 0x000c);
    const outcome: { done: boolean; error?: unknown } = { done: false };
    h.client.inviteToRoom(id, 'Bob').then(
      () => {
        outcome.done = true;
      },
      (error: unknown) => {
        outcome.done = true;
        outcome.error = error;
      },
    );
    await waitFor(() => channel2().length === 1, 'the invitation to reach the test server');
    await timers.advance(14_999);
    expect(outcome.done).toBe(false);
    await timers.advance(1);
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeInstanceOf(OscarError);
    expect(infoOf(outcome.error)).toMatchObject({ kind: 'timeout' });
    release();
  });

  it('refuses to invite from a room that is not joined', async () => {
    await h.client.leaveRoom(id);
    const error = await errorOf(h.client.inviteToRoom(id, 'Bob'));
    expect(error).toBeInstanceOf(OscarError);
    expect(infoOf(error)).toEqual({ kind: 'local', code: 'not-in-room' });
    await readUpTo(bob, 'nothing came');
    expect(channel2()).toEqual([]);
    expect(bob.invites()).toEqual([]);
  });

  it('refuses to invite from a room whose close is held, which still reads joined, and sends nothing', async () => {
    server.rooms.evict('Alice', ROOM);
    await waitFor(() => timers.pending().includes(ROOM_CLOSE_SETTLE_MS), 'the client to read the room close');
    expect(h.client.rooms().find((room) => room.id === id)?.state).toBe('joined');
    const error = await errorOf(h.client.inviteToRoom(id, 'Bob'));
    expect(error).toBeInstanceOf(OscarError);
    expect(infoOf(error)).toEqual({ kind: 'local', code: 'not-in-room' });
    await readUpTo(bob, 'nothing came');
    expect(channel2()).toEqual([]);
    expect(bob.invites()).toEqual([]);
  });

  it('raises an invite with who sent it, the room as its cookie spells it, the kind and the text', async () => {
    const cookie = bob.invite('Alice', { exchange: 4, cookie: '4-0-Night Shift' }, { text: '<B>come</B> over' });
    await waitFor(() => h.invites.length === 1, 'the invite');
    expect(h.invites).toEqual([
      {
        id: `bob:${hex(cookie)}`,
        from: 'Bob',
        room: { exchange: 4, name: 'Night Shift' },
        text: [{ text: 'come', bold: true }, { text: ' over' }],
        at: timers.now(),
      },
    ]);
    await readUpTo(bob, 'marker');
    expect(imTexts()).toEqual(['marker']);
  });

  it("an accepted invite never sends the invite's cookie", async () => {
    server.rooms.peerJoin('Bob', { exchange: 4, name: 'Ghost' });
    bob.invite('Alice', { exchange: 4, cookie: '4-7-Ghost' });
    await waitFor(() => h.invites.length === 1, 'the invite');
    const before = requestedCookies().length;
    const joined = await h.client.joinRoom(firstInvite().room);
    expect(joined.state).toBe('joined');
    expect(requestedCookies().slice(before)).toEqual(['4-0-Ghost']);
    expect(requestedCookies()).not.toContain('4-7-Ghost');
    expect(h.client.state).toBe('online');
    expect(server.instancesOf('Alice')).toBe(1);
    expect(bob.invites().filter((invite) => invite.from === 'Alice')).toEqual([]);
    expect(channel2()).toEqual([]);
  });

  it.each([
    ['exchange 6', 6, '6-0-Night Shift'],
    ['a cookie with no name', 4, '4-0-'],
    ['a cookie with no hyphens', 4, 'lobby'],
    ['a name with an accent', 4, '4-0-café'],
    ['a name of 101 characters', 4, `4-0-${'n'.repeat(101)}`],
    ['a name with a trailing space', 4, '4-0-Night Shift '],
  ])('an invite with an exchange, cookie or name outside the rules is ignored: %s', async (_what, exchange, roomCookie) => {
    bob.sendRaw('Alice', 2, [fragment(exchange, roomCookie)]);
    await readUpTo(bob, 'marker');
    expect(h.invites).toEqual([]);
    expect(imTexts()).toEqual(['marker']);
    expect(h.client.state).toBe('online');
    bob.sendRaw('Alice', 2, [fragment(4, '4-0-Night Shift')]);
    await waitFor(() => h.invites.length === 1, 'the valid invite');
  });

  // The last field: `handle` takes the message, or leaves it to the part that owns the capability.
  const NOT_INVITES: [string, () => Tlv[], boolean][] = [
    ['a proposal with another capability', () => [fragment(4, '4-0-Night Shift', { capability: new Uint8Array(16).fill(0x09) })], false],
    ['an accept with the chat capability', () => [fragment(4, '4-0-Night Shift', { type: 2 })], true],
    ['a TLV 0x0005 of 10 bytes', () => [tlv.bytes(0x0005, new Uint8Array(10))], true],
    ['no TLV 0x0005', () => [tlv.u16(0x000a, 1)], true],
  ];

  it.each(NOT_INVITES)('ignores every channel 2 message that is not a valid room invite: %s', async (_what, tlvs) => {
    const logged = aboveDebug();
    bob.sendRaw('Alice', 2, tlvs());
    await readUpTo(bob, 'still here');
    expect(h.invites).toEqual([]);
    expect(h.declines).toEqual([]);
    expect(imTexts()).toEqual(['still here']);
    expect(aboveDebug()).toBe(logged);
    expect(h.client.state).toBe('online');
  });

  // The server relays no fragment shorter than 26 bytes, so the test hands each message to the rooms as the BOS connection hands it.
  it.each(NOT_INVITES)('takes a channel 2 message that is no room invite and raises nothing: %s', (_what, tlvs, taken) => {
    const logs = captureLog();
    const raised: unknown[] = [];
    const rooms = new Rooms({
      log: logs.log,
      now: timers.now,
      timers: timers.api,
      random: () => 0.5,
      emitRoom: (status) => raised.push(status),
      emitOccupant: (change) => raised.push(change),
      emitMessage: (message) => raised.push(message),
      isBlocked: () => false,
      emitInvite: (invite) => raised.push(invite),
      emitDeclined: (declined) => raised.push(declined),
      bosAlive: () => Promise.resolve(true),
      sawUser: () => {},
    });
    const sender = encodeUserInfo({ name: 'Bob', warning: 0, tlvs: [] });
    const body = (channel: number, inner: Tlv[]): Uint8Array =>
      new ByteWriter().u64(7n).u16(channel).bytes(sender).bytes(encodeTlvs(inner)).toBytes();
    const snac = (channel: number, inner: Tlv[]) => ({ family: 0x04, subtype: 0x07, flags: 0, requestId: 0, body: body(channel, inner) });
    expect(rooms.handle(snac(2, tlvs()))).toBe(taken);
    expect(raised).toEqual([]);
    expect(logs.lines.filter((line) => line.level !== 'debug')).toEqual([]);
    expect(rooms.handle(snac(1, tlvs()))).toBe(false);
    expect(rooms.handle(snac(2, [fragment(4, '4-0-Night Shift')]))).toBe(true);
    expect(raised).toHaveLength(1);
  });

  it('a file proposal reaches no room listener and Rooms.handle returns false for it', async () => {
    const proposal = encodeFileProposal(7n, 'Alice', {
      sequence: 1,
      address: { ip: '203.0.113.7', port: 5190 },
      file: { multiple: false, count: 1, totalBytes: 90112, name: 'budget.xls' },
    });
    const logged = aboveDebug();
    bob.sendRaw('Alice', 2, tlvsOf({ family: 0x04, subtype: 0x06, requestId: 0, body: proposal, conn: 'bos' }), 7n);
    await readUpTo(bob, 'still here');
    expect(h.invites).toEqual([]);
    expect(h.declines).toEqual([]);
    expect(h.rooms.filter((room) => room.id !== id)).toEqual([]);
    expect(imTexts()).toEqual(['still here']);
    expect(aboveDebug()).toBe(logged);
    expect(h.client.state).toBe('online');

    const logs = captureLog();
    const raised: unknown[] = [];
    const rooms = new Rooms({
      log: logs.log,
      now: timers.now,
      timers: timers.api,
      random: () => 0.5,
      emitRoom: (status) => raised.push(status),
      emitOccupant: (change) => raised.push(change),
      emitMessage: (message) => raised.push(message),
      isBlocked: () => false,
      emitInvite: (invite) => raised.push(invite),
      emitDeclined: (declined) => raised.push(declined),
      bosAlive: () => Promise.resolve(true),
      sawUser: () => {},
    });
    const sender = encodeUserInfo({ name: 'Bob', warning: 0, tlvs: [] });
    const toClient = (inner: Tlv[]): Uint8Array => new ByteWriter().u64(7n).u16(2).bytes(sender).bytes(encodeTlvs(inner)).toBytes();
    const inner = tlvsOf({ family: 0x04, subtype: 0x06, requestId: 0, body: proposal, conn: 'bos' });
    for (const service of ['send-file', 'direct-im', 'get-file'] as const) {
      const cancel = encodeRendezvousCancel(7n, 'Alice', service, 1);
      const accept = encodeRendezvousAccept(7n, 'Alice', service);
      for (const body of [cancel, accept]) {
        const tlvs = tlvsOf({ family: 0x04, subtype: 0x06, requestId: 0, body, conn: 'bos' });
        expect(rooms.handle({ family: 0x04, subtype: 0x07, flags: 0, requestId: 0, body: toClient(tlvs) })).toBe(false);
      }
    }
    expect(rooms.handle({ family: 0x04, subtype: 0x07, flags: 0, requestId: 0, body: toClient(inner) })).toBe(false);
    expect(raised).toEqual([]);
    expect(logs.lines).toEqual([]);
  });

  it('the same invite delivered twice is raised once', async () => {
    const one = fragment(4, '4-0-Night Shift');
    bob.sendRaw('Alice', 2, [one]);
    bob.sendRaw('Alice', 2, [one]);
    await readUpTo(bob, 'marker');
    expect(h.invites).toHaveLength(1);
    server.peer('Carol').invite('Alice', { exchange: 4, cookie: '4-0-Night Shift' });
    await waitFor(() => h.invites.length === 2, 'the invitation of Carol');
    expect(new Set(h.invites.map((invite) => invite.id)).size).toBe(2);
  });

  it('a repeated invitation to the same room from the same screen name takes the place of the pending one', async () => {
    const first = bob.invite('Alice', { exchange: 4, cookie: '4-0-Night Shift' }, { text: 'one' });
    await waitFor(() => h.invites.length === 1, 'the invite');
    const second = bob.invite('Alice', { exchange: 4, cookie: '4-0-night shift' }, { text: 'two' });
    await waitFor(() => h.invites.length === 2, 'the repeated invite');
    expect(second).not.toBe(first);
    expect(h.invites[1]?.id).toBe(firstInvite().id);
    expect(h.invites[1]?.text).toEqual([{ text: 'two' }]);
    await readUpTo(bob, 'marker');
    expect(channel2()).toEqual([]);

    await h.client.declineInvite(firstInvite().id);
    await waitFor(() => bob.invites().length === 1, 'the decline');
    expect(bob.invites().at(-1)).toEqual({ from: 'Alice', kind: 'decline', cookie: second });
    expect(channel2()).toHaveLength(1);

    bob.invite('Alice', { exchange: 4, cookie: '4-0-Night Shift' });
    await waitFor(() => h.invites.length === 3, 'a new invite');
    expect(h.invites[2]?.id).not.toBe(firstInvite().id);
  });

  it(`holds at most ${MAX_PENDING_INVITES} pending invites and answers nothing for the rest`, async () => {
    for (let i = 0; i < MAX_PENDING_INVITES + 5; i++) bob.invite('Alice', { exchange: 4, cookie: `4-0-flood ${i}` });
    await readUpTo(bob, 'marker');
    expect(h.invites).toHaveLength(MAX_PENDING_INVITES);
    expect(h.invites.at(-1)?.room.name).toBe(`flood ${MAX_PENDING_INVITES - 1}`);
    expect(channel2()).toEqual([]);
    expect(h.logs.lines.filter((line) => line.level !== 'debug' && line.msg.includes('invit'))).toEqual([]);
    expect(h.logs.text()).not.toContain('flood');

    await h.client.declineInvite(firstInvite().id);
    h.client.forgetInvite(h.invites[1]?.id ?? '');
    bob.invite('Alice', { exchange: 4, cookie: '4-0-after one' });
    bob.invite('Alice', { exchange: 4, cookie: '4-0-after two' });
    bob.invite('Alice', { exchange: 4, cookie: '4-0-after three' });
    await readUpTo(bob, 'marker two');
    expect(h.invites.slice(MAX_PENDING_INVITES).map((invite) => invite.room.name)).toEqual(['after one', 'after two']);
    await h.client.declineInvite(h.invites[1]?.id ?? '');
    await readUpTo(bob, 'marker three');
    expect(channel2()).toHaveLength(1);
  });

  it(`cuts the invitation text to ${INVITE_TEXT_MAX} characters, keeping its formatting`, async () => {
    const long = 'x'.repeat(INVITE_TEXT_MAX - 2);
    bob.invite('Alice', { exchange: 4, cookie: '4-0-Night Shift' }, { text: `${long}<b>bold and more</b> and a tail` });
    await waitFor(() => h.invites.length === 1, 'the invite');
    const text = firstInvite().text;
    expect(text.map((run) => run.text).join('')).toBe(`${long}bo`);
    expect(text.at(-1)).toEqual({ text: 'bo', bold: true });
  });

  it('declines an invite with a cancel of its cookie, to the inviter alone', async () => {
    const carol = server.peer('Carol');
    const c = bob.invite('Alice', { exchange: 4, cookie: '4-0-Night Shift' });
    await waitFor(() => h.invites.length === 1, 'the invite');
    await h.client.declineInvite(firstInvite().id);
    await waitFor(() => bob.invites().length === 1, 'the decline');
    expect(bob.invites().at(-1)).toEqual({ from: 'Alice', kind: 'decline', cookie: c });
    expect(carol.invites()).toEqual([]);
    expect(channel2()).toHaveLength(1);
    expect(findTlv(tlvsOf(channel2()[0]), 0x0003)).toBeUndefined();
    await h.client.declineInvite(firstInvite().id);
    await h.client.declineInvite('bob:0000000000000099');
    await readUpTo(bob, 'marker');
    expect(channel2()).toHaveLength(1);
  });

  it('tells the room when its invitation was declined, once', async () => {
    await h.client.inviteToRoom(id, 'Bob');
    const cookie = bob.invites().at(-1)?.cookie;
    if (cookie === undefined) throw new Error('the invitation did not reach Bob');
    bob.declineInvite('Alice', cookie);
    await waitFor(() => h.declines.length === 1, 'the decline');
    expect(h.declines).toEqual([{ roomId: id, by: 'Bob' }]);
    bob.declineInvite('Alice', cookie);
    await readUpTo(bob, 'marker');
    expect(h.declines).toHaveLength(1);
    expect(imTexts()).toEqual(['marker']);
  });

  it('a decline that matches no invitation of this session is ignored', async () => {
    const carol = server.peer('Carol');
    await h.client.inviteToRoom(id, 'Bob');
    const cookie = bob.invites().at(-1)?.cookie;
    if (cookie === undefined) throw new Error('the invitation did not reach Bob');
    bob.declineInvite('Alice', 0x99n);
    await readUpTo(bob, 'from bob');
    expect(h.declines).toEqual([]);
    carol.declineInvite('Alice', cookie);
    await readUpTo(carol, 'from carol');
    expect(h.declines).toEqual([]);
    bob.declineInvite('Alice', cookie);
    await waitFor(() => h.declines.length === 1, 'the decline of Bob');
    expect(h.declines).toEqual([{ roomId: id, by: 'Bob' }]);
  });

  it('invites and declines carry the full 26-byte header', async () => {
    await h.client.inviteToRoom(id, 'Bob');
    bob.invite('Alice', { exchange: 4, cookie: '4-0-Night Shift' });
    await waitFor(() => h.invites.length === 1, 'the invite');
    await h.client.declineInvite(firstInvite().id);
    await waitFor(() => bob.invites().length === 2, 'the decline');
    expect(bob.invites().map((invite) => invite.kind)).toEqual(['proposal', 'decline']);
    expect(channel2()).toHaveLength(2);
    for (const record of channel2()) {
      expect(findTlv(tlvsOf(record), 0x0005)?.length ?? 0).toBeGreaterThanOrEqual(26);
    }
    await readUpTo(bob, 'marker');
    expect(server.instancesOf('Alice')).toBe(1);
    expect(h.client.state).toBe('online');
  });

  it("never logs an invitation's text or room", async () => {
    bob.invite('Alice', { exchange: 4, cookie: '4-0-Night Shift' }, { text: '<B>come</B> over' });
    await waitFor(() => h.invites.length === 1, 'the invite');
    await h.client.declineInvite(firstInvite().id);
    await h.client.inviteToRoom(id, 'Bob');
    await errorOf(h.client.inviteToRoom(id, 'Nobody'));
    const logged = h.logs.text();
    expect(logged).not.toContain('come');
    expect(logged).not.toContain('Night Shift');
    expect(logged).not.toContain('Dev Room');
    expect(logged).not.toContain('Nobody');
    expect(h.logs.lines.some((line) => line.level === 'warn' && line.fields?.kind === 'refused' && line.fields.code === 0x0004)).toBe(true);
  });
});
