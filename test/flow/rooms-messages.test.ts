import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OscarError } from '../../src/client/errors.js';
import { isRoomRoll, roomFailureReason } from '../../src/client/rooms.js';
import { CHAT_MSG_TLV_ENCODING, CHAT_TLV_MESSAGE, CHAT_TLV_PUBLIC, CHAT_TLV_REFLECT, CHAT_TLV_WHISPER_TO, PROBE_TIMEOUT_MS } from '../../src/wire/constants.js';
import { decodeTlvs, findTlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { RoomId } from '../../src/model/room.js';
import type { RichText } from '../../src/model/rich-text.js';
import type { RoomStatus } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;
let id: string;

const ROOM: RoomId = { exchange: 4, name: 'Dev Room' };

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
  h = makeClient(server, { timers });
  await h.signOn();
  server.rooms.peerJoin('Bob', ROOM);
  id = (await h.client.joinRoom(ROOM)).id;
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const text = (words: string): RichText => [{ text: words }];
const plain = (body: RichText | null | undefined): string => (body ?? []).map((run) => run.text).join('');
const sent = (): SnacRecord[] => server.snacsFrom('alice').filter((s) => s.family === 0x0e && s.subtype === 0x05);
const roomEvents = (): RoomStatus[] => h.rooms.filter((r) => r.id === id);
const bobRead = (): string[] => server.rooms.peerLines('Bob', ROOM).map((line) => line.text);
const say = (words: string): Promise<{ replacedBy: RichText | null }> => h.client.sendRoomMessage(id, text(words));

type Sent = { replacedBy: RichText | null };
type Outcome = { done: boolean; value?: Sent; error?: unknown };
function track(promise: Promise<Sent>): Outcome {
  const outcome: Outcome = { done: false };
  promise.then(
    (value) => {
      outcome.done = true;
      outcome.value = value;
    },
    (error: unknown) => {
      outcome.done = true;
      outcome.error = error;
    },
  );
  return outcome;
}

const settled = (outcome: Outcome, what: string): Promise<void> => waitFor(() => outcome.done, what);

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

const infoOf = (error: unknown): unknown => (error instanceof OscarError ? error.info : error);

const limitSilently = (): void => server.rooms.setRoomRate('Alice', ROOM, 'limited', true);

// Advances the waits of the pacer until the test server has read `count` room sends. No timer of 10 s or more fires, so no echo times out.
// The deadline allows a busy machine and stays inside the test timeout.
async function written(count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (sent().length < count && Date.now() < deadline) {
    await settle(server.port, 1);
    if (sent().length >= count) break;
    const next = timers.pending()[0];
    if (next !== undefined && next < 10_000) await timers.advance(next);
  }
  expect(sent()).toHaveLength(count);
}

// The TLVs of the last 0x0E/0x05 the test server read from Alice, after its cookie and channel.
const lastTlvs = (): Tlv[] => decodeTlvs(sent().at(-1)?.body.subarray(10) ?? new Uint8Array(0));
async function carolJoins(): Promise<void> {
  server.rooms.peerJoin('Carol', ROOM);
  await waitFor(() => h.occupantChanges.some((c) => c.screenName === 'Carol' && c.change === 'joined'), 'the arrival of Carol');
}

describe('room messages', () => {
  it('sends a line as US-ASCII with numeric references, and the peer reads it', async () => {
    const result = await h.client.sendRoomMessage(id, [{ text: 'café ', bold: true }, { text: '\u{1F600}' }]);
    expect(result).toEqual({ replacedBy: null, id: expect.stringMatching(/^[0-9a-f]+$/) });
    expect(server.rooms.peerLines('Bob', ROOM).at(-1)?.text).toBe('<B>caf&#233; </B>&#128512;');
    expect(sent()).toHaveLength(1);
    const info = findTlv(decodeTlvs(sent()[0]?.body.subarray(10) ?? new Uint8Array(0)), CHAT_TLV_MESSAGE);
    const encoding = findTlv(decodeTlvs(info ?? new Uint8Array(0)), CHAT_MSG_TLV_ENCODING);
    expect(Buffer.from(encoding ?? []).toString('ascii')).toBe('us-ascii');
  });

  it('resolves on the echo of that message and emits no line for it', async () => {
    await say('hello');
    expect(findTlv(decodeTlvs(sent()[0]?.body.subarray(10) ?? new Uint8Array(0)), CHAT_TLV_REFLECT)).toBeDefined();
    expect(h.roomMessages).toEqual([]);
    server.rooms.peerSay('Bob', ROOM, 'after');
    await waitFor(() => h.roomMessages.length > 0, 'the line of Bob');
    expect(h.roomMessages.map((m) => plain(m.body))).toEqual(['after']);
  });

  it('receives a line as RichText from the sender as the server spells it', async () => {
    server.rooms.peerSay('Bob', ROOM, '<B>hi</B> &#233;');
    await waitFor(() => h.roomMessages.length === 1, 'the line');
    expect(h.roomMessages[0]).toEqual({
      roomId: id,
      from: 'Bob',
      body: [{ text: 'hi', bold: true }, { text: ' é' }],
      at: timers.now(),
      whisper: false,
      fromServer: false,
    });
  });

  it('decodes a line by the label its sender gave', async () => {
    server.rooms.peerSay('Bob', ROOM, 'hé 日本');
    await waitFor(() => h.roomMessages.length === 1, 'the Unicode line');
    expect(h.roomMessages[0]?.body).toEqual(text('hé 日本'));
    server.rooms.peerSay('Bob', ROOM, 'café', { toc: true });
    await waitFor(() => h.roomMessages.length === 2, 'the line with no label');
    expect(h.roomMessages[1]?.body).toEqual(text('café'));
  });

  it('marks a line sent to the user alone as a whisper', async () => {
    server.rooms.peerSay('Bob', ROOM, 'psst', { whisperTo: 'Alice' });
    await waitFor(() => h.roomMessages.length === 1, 'the whisper');
    expect(h.roomMessages[0]).toMatchObject({ from: 'Bob', body: text('psst'), whisper: true, fromServer: false });
  });

  it("a line from OnlineHost is the server's", async () => {
    server.rooms.peerSay('Bob', ROOM, '//roll');
    await waitFor(() => h.roomMessages.length === 1, 'the roll');
    expect(h.roomMessages[0]).toMatchObject({ roomId: id, from: 'OnlineHost', fromServer: true, whisper: false });
    expect(plain(h.roomMessages[0]?.body)).toContain('Bob rolled');
  });

  // The server does not reserve the name: its OnlineHost is a session object in no room (foodgroup/chat.go sessOnlineHost).
  it("a line from an occupant whose screen name reads as OnlineHost is that person's line, not the server's", async () => {
    server.rooms.peerJoin('Online Host', ROOM);
    await waitFor(() => h.occupantChanges.some((c) => c.screenName === 'Online Host'), 'the arrival');
    server.rooms.peerSay('Online Host', ROOM, 'Your session expired. Sign on again at example.test');
    await waitFor(() => h.roomMessages.length === 1, 'the line');
    expect(h.roomMessages[0]).toMatchObject({ roomId: id, from: 'Online Host', fromServer: false, whisper: false });

    // The user's own //roll is still answered by the server: its line carries the identifier of the user's send.
    const result = await say('//roll');
    expect(plain(result.replacedBy)).toContain('rolled');
    expect(h.roomMessages).toHaveLength(1);

    server.rooms.peerLeave('Online Host', ROOM);
    await waitFor(() => h.occupantChanges.some((c) => c.screenName === 'Online Host' && c.change === 'left'), 'the departure');
    server.rooms.peerSay('Bob', ROOM, '//roll');
    await waitFor(() => h.roomMessages.length === 2, 'the roll');
    expect(h.roomMessages[1]).toMatchObject({ from: 'OnlineHost', fromServer: true });
  });

  it("a //roll is answered by the server's line under the same identifier, and the send resolves with it", async () => {
    const result = await say('//roll');
    expect(plain(result.replacedBy)).toContain('rolled');
    expect(server.rooms.peerLines('Bob', ROOM).map((line) => line.from)).toEqual(['onlinehost']);
    server.rooms.peerSay('Bob', ROOM, 'nice');
    await waitFor(() => h.roomMessages.some((m) => plain(m.body) === 'nice'), 'the line of Bob');
    expect(h.roomMessages.map((m) => plain(m.body))).toEqual(['nice']);
  });

  it('a //roll that has a font, a size and a color is sent with its markup and the server answers it', async () => {
    const body: RichText = [{ text: '//roll', face: 'Arial', size: 4, color: '#ff0000', italic: true }];
    expect(isRoomRoll(body)).toBe(true);
    const result = await h.client.sendRoomMessage(id, body);
    expect(plain(result.replacedBy)).toContain('rolled');
    expect(server.rooms.peerLines('Bob', ROOM).map((line) => line.from)).toEqual(['onlinehost']);
    expect(Buffer.from(sent().at(-1)?.body ?? []).toString('latin1')).toContain('<FONT COLOR="#ff0000" FACE="Arial" SIZE="4"><I>//roll</I></FONT>');
  });

  it('refuses a line over 1024 encoded bytes before sending', async () => {
    expect(infoOf(await errorOf(say('a'.repeat(1025))))).toEqual({ kind: 'local', code: 'message-too-long' });
    // 206 characters, each six bytes as a numeric reference.
    expect(infoOf(await errorOf(say('é'.repeat(206))))).toEqual({ kind: 'local', code: 'message-too-long' });
    await settle(server.port);
    expect(sent()).toEqual([]);
    expect(await say('a'.repeat(1024))).toEqual({ replacedBy: null, id: expect.stringMatching(/^[0-9a-f]+$/) });
    expect(bobRead()).toEqual(['a'.repeat(1024)]);
  });

  it('a missed echo holds every send in the room and re-sends once when the server reports clear', async () => {
    limitSilently();
    const one = track(say('one'));
    const two = track(say('two'));
    await timers.advance(10_000);
    await settle(server.port);
    expect(sent()).toHaveLength(1);
    expect([one.done, two.done]).toEqual([false, false]);
    await timers.advance(60_000);
    await settle(server.port);
    expect(sent()).toHaveLength(1);
    expect([one.done, two.done]).toEqual([false, false]);
    server.rooms.setRoomRate('Alice', ROOM, 'clear');
    await written(3);
    await settled(one, 'the first send');
    await settled(two, 'the second send');
    expect([one.value, two.value]).toEqual([{ replacedBy: null, id: expect.stringMatching(/^[0-9a-f]+$/) }, { replacedBy: null, id: expect.stringMatching(/^[0-9a-f]+$/) }]);
    expect(bobRead()).toEqual(['one', 'two']);
    expect(h.roomMessages).toEqual([]);
  });

  it('releases the hold after 120 s when the server never reports clear', async () => {
    limitSilently();
    const one = track(say('one'));
    await timers.advance(10_000);
    await timers.advance(119_999);
    await settle(server.port);
    expect(sent()).toHaveLength(1);
    await timers.advance(1);
    await written(2);
    expect(one.done).toBe(false);
  });

  it('fails as rate limited when the re-send gets no echo either, and the room stays joined', async () => {
    limitSilently();
    const one = track(say('one'));
    await timers.advance(10_000);
    // The probes go at 80 s. Their answers come in real time, thus the clock waits for them before their deadline.
    await timers.advance(80_000);
    await waitFor(() => !timers.pending().includes(PROBE_TIMEOUT_MS), 'the answers to the probes');
    await timers.advance(40_000);
    await written(2);
    const events = roomEvents().length;
    expect(one.done).toBe(false);
    await timers.advance(10_000);
    await settled(one, 'the send');
    expect(infoOf(one.error)).toEqual({ kind: 'timeout', rateLimited: true });
    expect(roomFailureReason(one.error)).toBe('rateLimited');
    expect(h.client.rooms()[0]?.state).toBe('joined');
    expect(roomEvents()).toHaveLength(events);
    await settle(server.port);
    expect(sent()).toHaveLength(2);
  });

  it('a send made while 50 are waiting fails at once as rate limited', async () => {
    limitSilently();
    const waiting = Array.from({ length: 51 }, (_, index) => track(say(`line ${index}`)));
    const error = await errorOf(say('one too many'));
    expect(roomFailureReason(error)).toBe('rateLimited');
    expect(infoOf(error)).toEqual({ kind: 'timeout', rateLimited: true });
    await settle(server.port);
    expect(sent()).toHaveLength(1);
    expect(waiting.filter((outcome) => outcome.done)).toEqual([]);
  });

  it('fails everything pending as not in the room when the room connection closes', async () => {
    limitSilently();
    const one = track(say('one'));
    const two = track(say('two'));
    await settle(server.port);
    expect([one.done, two.done]).toEqual([false, false]);
    server.rooms.dropChat('Alice', ROOM);
    await settled(one, 'the first send');
    await settled(two, 'the second send');
    expect([one.error, two.error].map(roomFailureReason)).toEqual(['notInRoom', 'notInRoom']);
    expect([one.error, two.error].map(infoOf)).toEqual([
      { kind: 'local', code: 'not-in-room' },
      { kind: 'local', code: 'not-in-room' },
    ]);
  });

  it('refuses a send to a room that is not joined', async () => {
    await say('before');
    await h.client.leaveRoom(id);
    expect(infoOf(await errorOf(say('x')))).toEqual({ kind: 'local', code: 'not-in-room' });
    await settle(server.port);
    expect(sent()).toHaveLength(1);
    expect(bobRead()).toEqual(['before']);
  });

  it('never logs a room line', async () => {
    await say('zq-room-secret out');
    server.rooms.peerSay('Bob', ROOM, 'zq-room-secret in');
    await waitFor(() => h.roomMessages.length === 1, 'the line');
    // The client logs a failed send too, but not its line.
    expect(infoOf(await errorOf(say(`zq-room-secret ${'a'.repeat(1024)}`)))).toEqual({ kind: 'local', code: 'message-too-long' });
    await h.client.leaveRoom(id);
    await errorOf(say('zq-room-secret late'));
    expect(h.logs.lines.length).toBeGreaterThan(0);
    expect(h.logs.text()).not.toContain('zq-room-secret');
  });
});

describe('room whispers', () => {
  it('sends a whisper with TLV 0x02 and without TLV 0x01, to Bob alone', async () => {
    await carolJoins();
    expect(await h.client.sendRoomMessage(id, text('zq'), { whisperTo: 'Bob' })).toEqual({ replacedBy: null, id: expect.stringMatching(/^[0-9a-f]+$/) });
    const tlvs = lastTlvs();
    expect(Buffer.from(findTlv(tlvs, CHAT_TLV_WHISPER_TO) ?? []).toString('utf8')).toBe('Bob');
    expect(findTlv(tlvs, CHAT_TLV_PUBLIC)).toBeUndefined();
    expect(server.rooms.peerLines('Bob', ROOM).at(-1)).toEqual({ from: 'alice', text: 'zq', whisper: true });
    expect(server.rooms.peerLines('Carol', ROOM).map((line) => line.text)).not.toContain('zq');
  });

  it('a line with no options has TLV 0x01 and no TLV 0x02', async () => {
    await carolJoins();
    expect(await h.client.sendRoomMessage(id, text('zq'))).toEqual({ replacedBy: null, id: expect.stringMatching(/^[0-9a-f]+$/) });
    const tlvs = lastTlvs();
    expect(findTlv(tlvs, CHAT_TLV_PUBLIC)).toBeDefined();
    expect(findTlv(tlvs, CHAT_TLV_WHISPER_TO)).toBeUndefined();
    expect(server.rooms.peerLines('Carol', ROOM).at(-1)).toEqual({ from: 'alice', text: 'zq', whisper: false });
  });

  it('a whisper to someone who left rejects local whisper-target-left, never notInRoom', async () => {
    server.rooms.peerLeave('Bob', ROOM);
    await waitFor(() => h.occupantChanges.some((c) => c.screenName === 'Bob' && c.change === 'left'), 'the departure of Bob');
    await settle(server.port);
    const error = await errorOf(h.client.sendRoomMessage(id, text('zq'), { whisperTo: 'Bob' }));
    expect(error).toBeInstanceOf(OscarError);
    expect(infoOf(error)).toEqual({ kind: 'local', code: 'whisper-target-left' });
    expect(roomFailureReason(error)).toBe('whisperTargetLeft');
    expect(roomFailureReason(error)).not.toBe('notInRoom');
    await settle(server.port);
    expect(sent()).toEqual([]);
  });

  it('isRoomRoll reads the line as the server would', () => {
    expect(isRoomRoll([{ text: '//roll', bold: true }])).toBe(true);
    expect(isRoomRoll([{ text: '//roll for it' }])).toBe(false);
  });
});
