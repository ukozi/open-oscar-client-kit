import { afterEach, describe, expect, it } from 'vitest';
import { RoomJoinError } from '../../src/client/errors.js';
import { memoryIconStore } from '../../src/client/icons.js';
import { FAMILY_BART } from '../../src/wire/bart.js';
import { ByteReader } from '../../src/wire/bytes.js';
import {
  BUDDY_ADD_BUDDIES,
  FAMILY_BUDDY,
  FAMILY_ICBM,
  FAMILY_OSERVICE,
  ICBM_CLIENT_EVENT,
  ICBM_MSG_TO_HOST,
  ICBM_TLV_AUTO_RESPONSE,
  ICBM_TLV_IM_DATA,
  ICBM_TLV_REQUEST_HOST_ACK,
  ICBM_TLV_STORE,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_SERVICE_REQUEST,
  SERVICE_TLV_USE_SSL,
} from '../../src/wire/constants.js';
import { FAMILY_FEEDBAG, FEEDBAG_QUERY, FEEDBAG_USE } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeTlvs } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord, StartOptions } from '../fake/oscar-server.js';
import { md5Hex, pngImage } from '../support/png.js';

// These tests hold the default behaviour of the client. A change to them is a change of a default.

const ROOM: RoomId = { exchange: 4, name: 'Pin Room' };
const PNG = pngImage(8, 8);
const HEX = md5Hex(PNG);
// The default host online of the test server without the icon service, so that an icon needs a service request.
const HOST_ONLINE_WITHOUT_ICONS = [0x0018, 0x0003, 0x0013, 0x0004, 0x0015, 0x0002, 0x0001, 0x0009, 0x000a, 0x0006, 0x0008, 0x000b];

// What the client sends from the login request to client online, in order.
const BRING_UP: [number, number][] = [
  [0x17, 0x06], [0x17, 0x02],
  [0x01, 0x17], [0x01, 0x06], [0x01, 0x08], [0x02, 0x02], [0x02, 0x04], [0x04, 0x04],
  [0x13, 0x02], [0x13, 0x04], [0x13, 0x07], [0x01, 0x02],
];

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

async function start(options: StartOptions = {}, alice: { bot?: boolean } = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, ...options });
  fake.addUser('Alice', 'alicepw1', alice);
  fake.addUser('Bob', 'bobpw1');
  h = makeClient(fake, { timers, iconStore: memoryIconStore() });
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const is = (family: number, subtype: number) => (s: SnacRecord): boolean => s.family === family && s.subtype === subtype;
const types = (records: readonly SnacRecord[]): [number, number][] => records.map((s) => [s.family, s.subtype]);

function upToClientOnline(records: readonly SnacRecord[]): SnacRecord[] {
  const end = records.findIndex((s) => s.conn === 'bos' && is(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE)(s));
  if (end < 0) throw new Error('no client online on BOS');
  return records.slice(0, end + 1);
}

// The TLVs of a 0x04/0x06 body follow the cookie, the channel and the name of the recipient.
function imTlvs(record: SnacRecord | undefined): Tlv[] {
  if (!record) throw new Error('no IM was sent');
  const r = new ByteReader(record.body);
  r.u64();
  r.u16();
  r.str8();
  return decodeTlvs(r.rest());
}

const buddies = (names: string[]): FeedbagItem[] =>
  withTypingPref([
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    ...names.map((name, i): FeedbagItem => ({ name, groupId: 1, itemId: i + 1, classId: 0, attrs: [] })),
  ]);

describe('the defaults of a client with no new option', () => {
  it('a client with no new option brings up the session with the same SNACs, in order', async () => {
    await start();
    await h.signOn();
    const sequence = types(upToClientOnline(fake.snacsFrom('alice')));
    expect(sequence).toEqual(BRING_UP);
    expect(sequence).toContainEqual([FAMILY_FEEDBAG, FEEDBAG_QUERY]);
    expect(sequence).toContainEqual([FAMILY_FEEDBAG, FEEDBAG_USE]);
    expect(sequence).not.toContainEqual([FAMILY_BUDDY, BUDDY_ADD_BUDDIES]);
  });

  it('a default IM carries the store TLV and no automatic TLV, and resolves to a value the caller may ignore', async () => {
    await start();
    fake.peer('Bob');
    await h.signOn();
    await h.client.sendIm('Bob', [{ text: 'hello' }]);
    const sent = fake.snacsFrom('alice').filter(is(FAMILY_ICBM, ICBM_MSG_TO_HOST));
    expect(sent).toHaveLength(1);
    const tlvs = imTlvs(sent[0]);
    const tags = tlvs.map((t) => t.tag);
    expect(tags).toEqual([ICBM_TLV_IM_DATA, ICBM_TLV_REQUEST_HOST_ACK, ICBM_TLV_STORE]);
    // The capabilities fragment, then one message part: charset 0, subset 0, the text as given.
    expect(Buffer.from(tlvs[0]?.value ?? []).toString('hex')).toBe('05010003010102010100090000000068656c6c6f');
    expect(tags).toContain(ICBM_TLV_STORE);
    expect(tags).not.toContain(ICBM_TLV_AUTO_RESPONSE);
  });

  it('an incoming IM, a room line and an invitation have no wire field', async () => {
    await start();
    const bob = fake.peer('Bob');
    await h.signOn();
    bob.sendIm('Alice', '<B>hi</B>');
    await waitFor(() => h.ims.length === 1, 'the IM');
    fake.rooms.peerJoin('Bob', ROOM);
    await h.client.joinRoom(ROOM);
    fake.rooms.peerSay('Bob', ROOM, 'a line');
    await waitFor(() => h.roomMessages.length === 1, 'the room line');
    bob.invite('Alice', { exchange: 4, cookie: '4-0-Other Room' }, { text: '<B>come</B>' });
    await waitFor(() => h.invites.length === 1, 'the invitation');
    for (const event of [h.ims[0], h.roomMessages[0], h.invites[0]]) {
      expect(event).toBeDefined();
      expect('wire' in (event as object)).toBe(false);
    }
  });

  it('the eleventh room is refused as room-limit', async () => {
    await start();
    await h.signOn();
    for (let i = 0; i < 10; i++) await h.client.joinRoom({ exchange: 4, name: `r${i}` });
    expect(h.client.rooms().filter((r) => r.state === 'joined')).toHaveLength(10);
    const error = await h.client.joinRoom({ exchange: 4, name: 'r10' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoomJoinError);
    expect((error as RoomJoinError).reason).toBe('room-limit');
  });

  it('every connection is plain TCP and a service request carries no TLV 0x8C', async () => {
    await start({ hostOnline: HOST_ONLINE_WITHOUT_ICONS });
    fake.setFeedbag('Alice', buddies(['bob']));
    fake.peer('Bob').setIcon(PNG);
    await h.signOn();
    await waitFor(() => h.client.iconOf('bob') === HEX, 'the icon of bob');
    await h.client.joinRoom(ROOM);
    await settle(fake.port);
    const opened = h.logs.lines.filter((line) => line.msg === 'oscar connection open');
    expect(opened.map((line) => line.fields?.conn)).toEqual(expect.arrayContaining(['bos', 'chatnav', 'chat']));
    expect(opened.length).toBeGreaterThanOrEqual(5);
    expect(opened.filter((line) => line.fields?.tls !== false)).toEqual([]);
    const requests = fake.snacsFrom('alice').filter(is(FAMILY_OSERVICE, OSERVICE_SERVICE_REQUEST));
    expect(requests.map((s) => new ByteReader(s.body).u16())).toEqual(expect.arrayContaining([FAMILY_BART, 0x000d, 0x000e]));
    for (const request of requests) expect(decodeTlvs(request.body.subarray(2)).map((t) => t.tag)).not.toContain(SERVICE_TLV_USE_SSL);
  });

  it('an arrival that names an icon makes the client ask for it', async () => {
    await start();
    fake.setFeedbag('Alice', buddies(['bob']));
    fake.peer('Bob').setIcon(PNG);
    await h.signOn();
    await waitFor(() => h.client.iconOf('bob') === HEX, 'the icon of bob');
    expect(fake.snacsFrom('alice').filter((s) => s.family === FAMILY_BART && s.subtype === 0x04)).toHaveLength(1);
    expect(h.icons).toContainEqual({ screenName: 'Bob', hash: HEX });
  });

  it('a rate alert holds a typing notice in its class, also for an account with the user flag 0x0400', async () => {
    await start({}, { bot: true });
    fake.peer('Bob');
    await h.signOn();
    await settle(fake.port);
    const typings = (): SnacRecord[] => fake.snacsFrom('alice').filter(is(FAMILY_ICBM, ICBM_CLIENT_EVENT));
    fake.spend('alice', 1, 80);
    await waitFor(() => h.logs.lines.some((l) => l.msg === 'rate notice'), 'the alert notice');
    let done = false;
    const sending = h.client.sendTyping('Bob', 'typing').then(() => (done = true));
    await timers.advance(10_000);
    await settle(fake.port);
    expect(typings()).toEqual([]);
    expect(done).toBe(false);
    await timers.advance(60_000);
    fake.rateTick('alice');
    await sending;
    await waitFor(() => typings().length === 1, 'the typing notice');
  });

  it('no roomRate listener is needed: a room rate notice changes nothing a caller sees', async () => {
    await start();
    fake.rooms.peerJoin('Bob', ROOM);
    await h.signOn();
    const id = (await h.client.joinRoom(ROOM)).id;
    const before = { rooms: h.rooms.length, rates: h.rates.length, state: h.client.state };
    fake.rooms.setRoomRate('Alice', ROOM, 'limited');
    await settle(fake.port);
    fake.rooms.setRoomRate('Alice', ROOM, 'clear');
    await settle(fake.port);
    expect({ rooms: h.rooms.length, rates: h.rates.length, state: h.client.state }).toEqual(before);
    expect(h.client.rooms().find((r) => r.id === id)?.state).toBe('joined');
    await h.client.sendRoomMessage(id, [{ text: 'still here' }]);
    expect(fake.rooms.peerLines('Bob', ROOM).map((line) => line.text)).toEqual(['still here']);
    expect(h.logs.lines.filter((line) => line.level === 'error')).toEqual([]);
  });
});
