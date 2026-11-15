import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ByteWriter } from '../../src/wire/bytes.js';
import { decodeNavInfo, decodeSnacErrorCode, encodeCreateRoom, encodeServiceRoomInfo } from '../../src/wire/chatnav.js';
import type { RoomInfo } from '../../src/wire/chatnav.js';
import { decodeRoomMessage, decodeRoster, encodeClassIds, encodeRoomClientOnline } from '../../src/wire/chatroom.js';
import { CHAT_RATE_CLASS_IDS } from '../../src/wire/constants.js';
import type { FlapFrame } from '../../src/wire/flap.js';
import { decodeHostAck, decodeImToClient, encodeChatInvite, parseInviteCancel } from '../../src/wire/icbm.js';
import { decodeSnac } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { decodeTlvBlock, decodeTlvs, encodeTlvs, tlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { RoomRef } from '../../src/wire/types.js';
import { RawClient, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const MULTI_SESSION = 0x01;
const SERVER_REQUEST_ID = 0x80000000;
const CHATNAV = 0x000d;
const CHAT = 0x000e;

let t = 1_800_000_000_000;
let fake: FakeOscarServer;
let opened: RawClient[] = [];
let nextId = 0x100;

beforeEach(async () => {
  t = 1_800_000_000_000;
  opened = [];
  fake = await FakeOscarServer.start({ now: () => t });
  fake.addUser('Alice', 'pw');
  fake.addUser('Bob', 'pw');
});
afterEach(async () => {
  for (const client of opened) client.close();
  await fake?.stop();
});

function keep(client: RawClient): RawClient {
  opened.push(client);
  return client;
}

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

function of(client: RawClient, family: number, subtype: number): Snac[] {
  return snacsOf(client).filter((s) => s.family === family && s.subtype === subtype);
}

async function reply(client: RawClient, requestId: number, what: string): Promise<Snac> {
  const find = (): Snac | undefined => snacsOf(client).find((s) => s.requestId === requestId);
  await waitFor(() => find() !== undefined || client.closed, what);
  const found = find();
  if (!found) throw new Error(`connection closed before ${what}`);
  return found;
}

// The liveness query and its answer: when it is back, the test server has handled everything this client wrote before it.
async function alive(client: RawClient): Promise<Snac> {
  const requestId = nextId++;
  client.snac(1, 0x0e, requestId);
  return reply(client, requestId, 'the liveness reply');
}

function lastFrame(client: RawClient): FlapFrame | undefined {
  return client.frames[client.frames.length - 1];
}

async function bos(name: string): Promise<RawClient> {
  return keep(await RawClient.signOn(fake.port, name, 'pw', MULTI_SESSION));
}

async function nav(bosClient: RawClient): Promise<RawClient> {
  const client = keep(await RawClient.service(fake.port, await bosClient.requestService(CHATNAV)));
  const online = await client.nextSnac();
  expect([online.family, online.subtype]).toEqual([1, 0x03]);
  return client;
}

async function create(navClient: RawClient, exchange: number, name: string): Promise<Snac> {
  navClient.snac(CHATNAV, 0x08, nextId++, encodeCreateRoom({ exchange: exchange as 4 | 5, name }));
  return navClient.nextSnac();
}

async function resolve(bosClient: RawClient, exchange: 4 | 5, name: string): Promise<RoomInfo> {
  const navClient = await nav(bosClient);
  const answer = await create(navClient, exchange, name);
  navClient.close();
  const info = decodeNavInfo(answer.body);
  if (answer.subtype !== 0x09 || !info) throw new Error(`room ${name} did not resolve`);
  return info;
}

async function chat(bosClient: RawClient, info: RoomInfo): Promise<RawClient> {
  const cookie = await bosClient.requestService(CHAT, encodeServiceRoomInfo(info));
  const client = keep(await RawClient.service(fake.port, cookie));
  client.snac(1, 0x06, nextId++);
  client.snac(1, 0x08, nextId++, encodeClassIds(CHAT_RATE_CLASS_IDS));
  client.snac(1, 0x02, nextId++, encodeRoomClientOnline());
  await waitFor(() => of(client, CHAT, 0x03).length > 0 || client.closed, 'the roster');
  if (client.closed) throw new Error('room connection closed before the roster');
  return client;
}

function names(roster: Snac | undefined): string[] {
  return decodeRoster(roster?.body ?? new Uint8Array(0)).map((info) => info.name);
}

function line(cookie: bigint, text: string, reflect: boolean): Uint8Array {
  const inner = encodeTlvs([tlv.str(0x02, 'us-ascii'), tlv.str(0x03, 'en'), tlv.str(0x01, text)]);
  const tlvs: Tlv[] = [tlv.empty(0x01)];
  if (reflect) tlvs.push(tlv.empty(0x06));
  tlvs.push(tlv.bytes(0x05, inner));
  return new ByteWriter().u64(cookie).u16(3).bytes(encodeTlvs(tlvs)).toBytes();
}

function lines(client: RawClient): { cookie: bigint; sender: string; text: string; requestId: number }[] {
  return of(client, CHAT, 0x06).map((snac) => {
    const message = decodeRoomMessage(snac.body);
    if (!message) throw new Error('a room line that does not parse');
    return { cookie: message.cookie, sender: message.sender.name, text: Buffer.from(message.text).toString('ascii'), requestId: snac.requestId };
  });
}

async function pair(name = 'Dev Room'): Promise<{ room: RoomRef; info: RoomInfo; aliceBos: RawClient; alice: RawClient; bob: RawClient }> {
  const aliceBos = await bos('Alice');
  const info = await resolve(aliceBos, 4, name);
  const alice = await chat(aliceBos, info);
  const bob = await chat(await bos('Bob'), info);
  await waitFor(() => of(alice, CHAT, 0x03).length === 2 && of(alice, CHAT, 0x02).length === 1 && of(bob, CHAT, 0x02).length === 1, 'both joins');
  return { room: { exchange: 4, name }, info, aliceBos, alice, bob };
}

describe('the test server: ChatNav', () => {
  it("creates a buddy chat on first ask and gives a later asker the creator's spelling", async () => {
    const first = await create(await nav(await bos('Alice')), 4, 'Dev Room');
    expect([first.family, first.subtype]).toEqual([CHATNAV, 0x09]);
    // The room was made now, in Unix seconds, and holds 100 (state/chat.go TLVList).
    const made = { exchange: 4, cookie: '4-0-Dev Room', name: 'Dev Room', createdAt: 1_800_000_000, maxOccupancy: 100 };
    expect(decodeNavInfo(first.body)).toEqual(made);

    t += 90_000;
    const second = await create(await nav(await bos('Bob')), 4, 'dev room');
    expect(decodeNavInfo(second.body)).toEqual(made);
  });

  it("describes a room with the server's TLVs, in the server's order", async () => {
    const answer = await create(await nav(await bos('Alice')), 4, 'Dev Room');
    const block = decodeTlvs(answer.body)[0]?.value ?? new Uint8Array(0);
    const room = decodeTlvBlock(block, 3 + (block[2] ?? 0) + 3).tlvs;
    expect(room.map((each) => each.tag)).toEqual([0x00c9, 0x00ca, 0x00d1, 0x00d2, 0x00d5, 0x006a, 0x00d3, 0x00da]);
  });

  it('answers no match for a public room nobody created, and the connection stays up', async () => {
    const navClient = await nav(await bos('Alice'));
    const refused = await create(navClient, 5, 'nowhere');
    expect([refused.family, refused.subtype, decodeSnacErrorCode(refused.body)]).toEqual([CHATNAV, 0x01, 0x0014]);

    const answered = await create(navClient, 4, 'x');
    expect([answered.family, answered.subtype]).toEqual([CHATNAV, 0x09]);
    expect(navClient.closed).toBe(false);
  });

  it('resolves a public room the operator created, without regard to case', async () => {
    fake.rooms.addRoom({ exchange: 5, name: 'chimr-lobby' });
    const answer = await create(await nav(await bos('Alice')), 5, 'Chimr-Lobby');
    expect(answer.subtype).toBe(0x09);
    expect(decodeNavInfo(answer.body)?.name).toBe('chimr-lobby');
  });

  it('refuses any other exchange with code 8', async () => {
    const answer = await create(await nav(await bos('Alice')), 6, 'x');
    expect([answer.family, answer.subtype, decodeSnacErrorCode(answer.body)]).toEqual([CHATNAV, 0x01, 0x0008]);
  });

  it('closes the ChatNav connection with no reply as often as told', async () => {
    const aliceBos = await bos('Alice');
    fake.rooms.dropCreates(2);
    for (let i = 0; i < 2; i++) {
      const navClient = await nav(aliceBos);
      navClient.snac(CHATNAV, 0x08, nextId++, encodeCreateRoom({ exchange: 4, name: 'Dev Room' }));
      await navClient.untilClosed();
      expect(snacsOf(navClient).map((s) => [s.family, s.subtype])).toEqual([[1, 0x03]]);
    }
    const third = await create(await nav(aliceBos), 4, 'Dev Room');
    expect([third.family, third.subtype]).toEqual([CHATNAV, 0x09]);
  });

  it('a removed public room answers no match to a new ask while its occupants stay connected', async () => {
    const room: RoomRef = { exchange: 5, name: 'chimr-lobby' };
    fake.rooms.addRoom(room);
    const aliceBos = await bos('Alice');
    const info = await resolve(aliceBos, 5, room.name);
    const alice = await chat(aliceBos, info);
    const bob = await chat(await bos('Bob'), info);

    fake.rooms.removeRoom(room);
    const answer = await create(await nav(aliceBos), 5, room.name);
    expect([answer.family, answer.subtype, decodeSnacErrorCode(answer.body)]).toEqual([CHATNAV, 0x01, 0x0014]);

    expect(fake.openConnections('Alice')).toContain('chat');
    bob.snac(CHAT, 0x05, nextId++, line(7n, 'still here', false));
    await waitFor(() => lines(alice).length === 1, "Bob's line");
    expect(lines(alice)[0]).toMatchObject({ cookie: 7n, sender: 'Bob', text: 'still here' });
    expect(alice.closed).toBe(false);
  });

  it('a room whose cookie was lengthened resolves with the long cookie and still seats a joiner', async () => {
    const room: RoomRef = { exchange: 5, name: 'long' };
    fake.rooms.addRoom(room);
    fake.rooms.lengthenCookie(room, 170);
    const aliceBos = await bos('Alice');
    const info = await resolve(aliceBos, 5, 'long');
    expect(Buffer.byteLength(info.cookie)).toBe(170);
    expect(info.cookie.startsWith('5-0')).toBe(true);
    expect(info.cookie.endsWith('-long')).toBe(true);

    const alice = await chat(aliceBos, info);
    expect(names(of(alice, CHAT, 0x03)[0])).toEqual(['Alice']);
    expect(fake.rooms.occupants(room)).toEqual(['alice']);
  });
});

describe('the test server: service requests and room connections', () => {
  it('closes the BOS connection on a chat service request for a cookie no room has', async () => {
    const aliceBos = await bos('Alice');
    const ghost = encodeServiceRoomInfo({ exchange: 4, cookie: '4-0-ghost', name: 'ghost' });
    await expect(aliceBos.requestService(CHAT, ghost)).rejects.toThrow();
    expect(aliceBos.closed).toBe(true);
    await waitFor(() => fake.instancesOf('Alice') === 0, 'the instance to end');
  });

  it('refuses a service request on a room connection with code 8', async () => {
    const { alice } = await pair();
    const requestId = nextId++;
    alice.snac(1, 0x04, requestId, new ByteWriter().u16(CHATNAV).toBytes());
    const answer = await reply(alice, requestId, 'the refusal');
    expect([answer.family, answer.subtype, decodeSnacErrorCode(answer.body)]).toEqual([1, 0x01, 0x0008]);
    expect((await alive(alice)).subtype).toBe(0x0f);
  });

  it('sends the joiner the whole roster with itself in it, then the room info, and tells the others', async () => {
    const room: RoomRef = { exchange: 4, name: 'Dev Room' };
    const aliceBos = await bos('Alice');
    const info = await resolve(aliceBos, 4, room.name);
    fake.rooms.peerJoin('Carol', room);

    const alice = await chat(aliceBos, info);
    await waitFor(() => of(alice, CHAT, 0x02).length === 1, 'the room info');
    const chatSnacs = snacsOf(alice).filter((s) => s.family === CHAT);
    expect(chatSnacs.map((s) => s.subtype)).toEqual([0x03, 0x02]);
    expect([...names(chatSnacs[0])].sort()).toEqual(['Alice', 'Carol']);
    expect(names(chatSnacs[0])[0]).toBe('Alice');

    const bob = await chat(await bos('Bob'), info);
    await waitFor(() => of(alice, CHAT, 0x03).length === 2, "Bob's arrival");
    expect(names(of(alice, CHAT, 0x03)[1])).toEqual(['Bob']);
    expect(names(of(bob, CHAT, 0x03)[0])[0]).toBe('Bob');
    expect([...names(of(bob, CHAT, 0x03)[0])].sort()).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('seats one connection per screen name per room: a second join ends the first with the bare four-byte sign-off', async () => {
    const room: RoomRef = { exchange: 4, name: 'Dev Room' };
    const firstBos = await bos('Alice');
    const secondBos = await bos('Alice');
    const info = await resolve(firstBos, 4, room.name);
    const first = await chat(firstBos, info);
    const second = await chat(secondBos, info);

    await first.untilClosed();
    // Only FlapDecoder.end() sets `truncated`, for the four bytes `2A 04 seq seq` and EOF
    expect(lastFrame(first)).toMatchObject({ type: 4, truncated: true });
    expect(lastFrame(first)?.payload.length).toBe(0);
    expect((await alive(second)).subtype).toBe(0x0f);
    expect(second.closed).toBe(false);
    expect(fake.rooms.occupants(room)).toEqual(['alice']);
    expect(firstBos.closed).toBe(false);
  });

  it('reflects a line to its sender on the request id only when asked, and relays it to the others', async () => {
    const { alice, bob } = await pair();
    const requestId = nextId++;
    alice.snac(CHAT, 0x05, requestId, line(0x1111n, 'one', true));
    await waitFor(() => lines(alice).length === 1 && lines(bob).length === 1, 'the reflection and the relay');
    expect(lines(alice)[0]).toEqual({ cookie: 0x1111n, sender: 'Alice', text: 'one', requestId });
    expect(lines(bob)[0]).toEqual({ cookie: 0x1111n, sender: 'Alice', text: 'one', requestId: SERVER_REQUEST_ID });

    alice.snac(CHAT, 0x05, nextId++, line(0x2222n, 'two', false));
    await waitFor(() => lines(bob).length === 2, 'the second relay');
    expect(lines(bob)[1]).toMatchObject({ cookie: 0x2222n, text: 'two' });
    await alive(alice);
    expect(lines(alice)).toHaveLength(1);
  });

  it("drops a limited sender's line with no reply at all", async () => {
    const { room, alice, bob } = await pair();
    fake.rooms.setRoomRate('Alice', room, 'limited', true);
    const before = snacsOf(alice).length;
    alice.snac(CHAT, 0x05, nextId++, line(1n, 'dropped', true));
    await settle(fake.port);
    expect(snacsOf(alice)).toHaveLength(before);
    expect(lines(bob)).toHaveLength(0);

    fake.rooms.setRoomRate('Alice', room, 'clear');
    await waitFor(() => of(alice, 1, 0x0a).length === 1, 'the rate notice');
    expect(decodeSnacErrorCode(of(alice, 1, 0x0a)[0]?.body ?? new Uint8Array(0))).toBe(4);
    alice.snac(CHAT, 0x05, nextId++, line(2n, 'kept', true));
    await waitFor(() => lines(alice).length === 1 && lines(bob).length === 1, 'the line after the limit');
    expect(lines(alice)[0]).toMatchObject({ cookie: 2n, text: 'kept' });
    expect(lines(bob)[0]).toMatchObject({ cookie: 2n, text: 'kept' });
  });

  it('closes the room connection on a line with no message TLV', async () => {
    const { aliceBos, alice } = await pair();
    alice.snac(CHAT, 0x05, nextId++, new ByteWriter().u64(9n).u16(3).toBytes());
    await alice.untilClosed();
    expect(lines(alice)).toHaveLength(0);

    const requestId = nextId++;
    aliceBos.snac(1, 0x0e, requestId);
    expect((await reply(aliceBos, requestId, 'the BOS liveness reply')).subtype).toBe(0x0f);
    expect(aliceBos.closed).toBe(false);
  });

  it("replaces //roll with OnlineHost's line under the sender's cookie", async () => {
    const { alice, bob } = await pair();
    const cookie = 0x0c0c0c0c0c0c0c0cn;
    alice.snac(CHAT, 0x05, nextId++, line(cookie, '//roll', true));
    await waitFor(() => lines(alice).length === 1 && lines(bob).length === 1, "the server's line");
    expect(lines(alice)[0]).toMatchObject({ cookie, sender: 'OnlineHost' });
    expect(lines(alice)[0]?.text).not.toContain('//roll');
    expect(lines(bob)[0]).toMatchObject({ cookie, sender: 'OnlineHost' });
  });

  it('answers the liveness query on a room connection', async () => {
    const { alice } = await pair();
    const requestId = nextId++;
    alice.snac(1, 0x0e, requestId);
    const answer = await reply(alice, requestId, 'the liveness reply');
    expect([answer.family, answer.subtype, answer.requestId]).toEqual([1, 0x0f, requestId]);
    expect(names(answer)).toEqual(['Alice']);
  });

  it("ends an account's room connections when its last BOS session ends, and not while another remains", async () => {
    const firstBos = await bos('Alice');
    await bos('Alice');
    const room = await chat(firstBos, await resolve(firstBos, 4, 'Dev Room'));
    await waitFor(() => fake.openConnections('Alice').length === 3, 'the ChatNav connection to end');
    expect(fake.openConnections('Alice')).toEqual(['bos', 'bos', 'chat']);

    fake.dropInstance('Alice', 0);
    await firstBos.untilClosed();
    await waitFor(() => fake.openConnections('Alice').length === 2, 'the first instance to end');
    expect(fake.openConnections('Alice')).toEqual(['bos', 'chat']);
    expect((await alive(room)).subtype).toBe(0x0f);
    expect(room.closed).toBe(false);

    fake.dropInstance('Alice', 0);
    await room.untilClosed();
    expect(lastFrame(room)).toMatchObject({ type: 4, truncated: true });
    expect(lastFrame(room)?.payload.length).toBe(0);
    await waitFor(() => fake.openConnections('Alice').length === 0, 'every connection to end');
    expect(fake.openConnections('Alice')).toEqual([]);
  });

  it('a room connection cookie that has expired closes the connection with nothing sent', async () => {
    const aliceBos = await bos('Alice');
    const info = await resolve(aliceBos, 4, 'Dev Room');
    const roomInfo = encodeServiceRoomInfo(info);

    fake.rooms.refuseNextChatTicket();
    const refused = keep(await RawClient.service(fake.port, await aliceBos.requestService(CHAT, roomInfo)));
    await refused.untilClosed();
    expect(refused.frames.map((f) => f.type)).toEqual([1]);

    const seated = keep(await RawClient.service(fake.port, await aliceBos.requestService(CHAT, roomInfo)));
    const online = await seated.nextSnac();
    expect([online.family, online.subtype]).toEqual([1, 0x03]);
    expect(seated.closed).toBe(false);
  });

  it('a silenced room connection is sent nothing and answered nothing', async () => {
    const { room, alice, bob } = await pair();
    fake.rooms.peerJoin('Carol', room);
    const sawCarol = (client: RawClient): boolean => of(client, CHAT, 0x03).some((snac) => names(snac).includes('Carol'));
    await waitFor(() => sawCarol(alice) && sawCarol(bob), "Carol's arrival");
    fake.rooms.silence('Alice', room);
    const before = alice.frames.length;

    fake.rooms.peerSay('Carol', room, 'anyone?');
    alice.snac(1, 0x0e, nextId++);
    await waitFor(() => lines(bob).length === 1, "Carol's line");
    expect(lines(bob)[0]).toMatchObject({ sender: 'Carol', text: 'anyone?' });
    await settle(fake.port);
    expect(alice.frames).toHaveLength(before);
    expect(alice.closed).toBe(false);
    expect((await alive(bob)).subtype).toBe(0x0f);
  });
});

describe('the test server: room invites', () => {
  it('relays a room proposal without its acknowledgement request, acknowledges it, and delivers a decline the same way', async () => {
    const bob = fake.peer('Bob');
    const bobBos = await bos('Bob');
    const alice = await bos('Alice');
    const cookie = 0x0102030405060708n;
    const room = { exchange: 4 as const, cookie: '4-0-Dev Room' };

    const requestId = nextId++;
    alice.snac(4, 0x06, requestId, encodeChatInvite(cookie, 'Bob', room, 'Join me in this room.'));
    const ack = await reply(alice, requestId, 'the acknowledgement');
    expect([ack.family, ack.subtype]).toEqual([4, 0x0c]);
    expect(decodeHostAck(ack.body)).toEqual({ cookie, channel: 2, screenName: 'Bob' });
    expect(bob.invites()).toEqual([
      { from: 'Alice', kind: 'proposal', cookie, roomCookie: '4-0-Dev Room', exchange: 4, html: 'Join me in this room.' },
    ]);
    // the request for an acknowledgement (TLV 0x03) is the sender's and is not relayed
    await waitFor(() => of(bobBos, 4, 0x07).some((s) => decodeImToClient(s.body).channel === 2), 'the relayed proposal');
    const relayed = of(bobBos, 4, 0x07).map((s) => decodeImToClient(s.body)).filter((im) => im.channel === 2);
    expect(relayed.map((im) => im.tlvs.map((each) => each.tag))).toEqual([[0x05]]);

    bob.declineInvite('Alice', cookie);
    const declines = (): Snac[] => of(alice, 4, 0x07).filter((s) => decodeImToClient(s.body).channel === 2);
    await waitFor(() => declines().length === 1, 'the decline');
    expect(parseInviteCancel(declines()[0]?.body ?? new Uint8Array(0))).toMatchObject({ from: 'bob', cookie });
  });

  it("a peer's proposal reaches the session on channel 2 and is listed by the peer that gets one back", async () => {
    const bob = fake.peer('Bob');
    const carol = fake.peer('Carol');
    const sent = carol.invite('Bob', { exchange: 5, cookie: '5-0-chimr-lobby' }, { text: 'Come over.' });
    expect(bob.invites()).toEqual([{ from: 'Carol', kind: 'proposal', cookie: sent, roomCookie: '5-0-chimr-lobby', exchange: 5, html: 'Come over.' }]);
    bob.declineInvite('Carol', sent);
    expect(carol.invites()).toEqual([{ from: 'Bob', kind: 'decline', cookie: sent }]);
  });
});
