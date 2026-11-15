import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, toHex } from '../../src/wire/bytes.js';
import { ICBM_CHANNEL_IM, ICBM_TLV_IM_DATA } from '../../src/wire/constants.js';
import { FEEDBAG_ATTR_PD_MODE, FEEDBAG_ATTR_PENDING, encodeFeedbagItems, readFeedbagItem } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { encodeImFragments } from '../../src/wire/icbm.js';
import { decodeRateParamsReply } from '../../src/wire/rate.js';
import { decodeSnac } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { encodeImText } from '../../src/wire/text.js';
import { encodeTlvs, tlv } from '../../src/wire/tlv.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';
import { blocks } from '../fake/relationship.js';

const MULTI_SESSION = 0x01;
const SERVER_REQUEST_ID = 0x80000000;
const INSERT = 0x08;
const UPDATE = 0x09;
const DELETE = 0x0a;

const item = (classId: number, name: string, groupId: number, itemId: number, attrs = [] as FeedbagItem['attrs']): FeedbagItem => ({
  name,
  groupId,
  itemId,
  classId,
  attrs,
});
const buddy = (name: string, groupId = 1, itemId = 5): FeedbagItem => item(0, name, groupId, itemId);
const group = (name: string, groupId = 1): FeedbagItem => item(1, name, groupId, 0);
const permit = (name: string, itemId = 0x21): FeedbagItem => item(2, name, 0, itemId);
const deny = (name: string, itemId = 0x31): FeedbagItem => item(3, name, 0, itemId);
const privacy = (mode: number, itemId = 0x41): FeedbagItem => item(4, '', 0, itemId, [tlv.u8(FEEDBAG_ATTR_PD_MODE, mode)]);

let fake: FakeOscarServer;
let marker = 0x7000;
beforeEach(async () => {
  fake = await FakeOscarServer.start();
  fake.addUser('Alice', 'alicepw1');
});
afterEach(async () => {
  await fake.stop();
});

const session = (): Promise<RawClient> => RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

async function replyTo(client: RawClient, requestId: number): Promise<Snac> {
  await waitFor(() => snacsOf(client).some((s) => s.requestId === requestId), `a reply to request ${requestId}`);
  const found = snacsOf(client).find((s) => s.requestId === requestId);
  if (!found) throw new Error('no reply');
  return found;
}

async function request(client: RawClient, family: number, subtype: number, body?: Uint8Array): Promise<Snac> {
  const requestId = marker++;
  client.snac(family, subtype, requestId, body);
  return replyTo(client, requestId);
}

const write = (client: RawClient, subtype: number, items: FeedbagItem[]): Promise<Snac> =>
  request(client, 0x13, subtype, encodeFeedbagItems(items));

// The test server handles one connection's SNACs in order, so when this echo is back it has handled everything the client sent before it.
const roundTrip = (client: RawClient): Promise<Snac> => request(client, 1, 0x17);

function itemsOf(body: Uint8Array): FeedbagItem[] {
  const r = new ByteReader(body);
  const items: FeedbagItem[] = [];
  while (r.remaining > 0) items.push(readFeedbagItem(r));
  return items;
}

const pushesTo = (client: RawClient): Snac[] =>
  snacsOf(client).filter((s) => s.family === 0x13 && [INSERT, UPDATE, DELETE].includes(s.subtype));

const events = (peer: FakePeer): string[] => peer.sightings().map((s) => s.event);

describe('test server: buddy list writes', () => {
  it('a colliding id overwrites the stored item, class included', async () => {
    const alice = await session();
    await write(alice, INSERT, [buddy('bob', 1, 5)]);
    expect(fake.feedbagOf('Alice').map((i) => [i.groupId, i.itemId, i.classId])).toEqual([[1, 5, 0]]);
    await write(alice, INSERT, [item(1, 'Friends', 1, 5)]);
    expect(fake.feedbagOf('Alice')).toEqual([item(1, 'Friends', 1, 5)]);
  });

  it.each([0, 2, 3])('a buddy, permit or deny item is stored under the normalised name and pushed as sent (class %i)', async (classId) => {
    const first = await session();
    const second = await session();
    const sent = [item(classId, 'Bo B', 1, 5), group('My Group', 2)];
    const status = await write(first, INSERT, sent);
    expect(toHex(status.body)).toBe('00000000');
    expect(fake.feedbagOf('Alice')).toEqual([item(classId, 'bob', 1, 5), group('My Group', 2)]);
    await waitFor(() => pushesTo(second).length === 1, 'the push');
    expect(itemsOf(pushesTo(second)[0]?.body ?? new Uint8Array(0))).toEqual(sent);
  });

  it('a delete of an item that is not there reports success', async () => {
    const alice = await session();
    const status = await write(alice, DELETE, [buddy('bob', 9, 9)]);
    expect([status.family, status.subtype, toHex(status.body)]).toEqual([0x13, 0x0e, '0000']);
  });

  it('a deny item naming the account itself is refused with error 0x08 and nothing of the request is stored', async () => {
    const first = await session();
    const second = await session();
    const refused = await write(first, INSERT, [buddy('bob', 1, 5), deny('alice')]);
    expect([refused.family, refused.subtype]).toEqual([0x13, 0x01]);
    expect(new ByteReader(refused.body).u16()).toBe(8);
    expect(fake.feedbagOf('Alice')).toEqual([]);
    const stored = await write(first, INSERT, [buddy('bob', 1, 5), deny('carol')]);
    expect([stored.subtype, toHex(stored.body)]).toEqual([0x0e, '00000000']);
    expect(fake.feedbagOf('Alice').map((i) => i.name)).toEqual(['bob', 'carol']);
    await waitFor(() => pushesTo(second).length > 0, 'the push of the second request');
    expect(pushesTo(second).length).toBe(1);
  });

  it("a write is pushed to the account's other sessions with its own subtype and the server's request id", async () => {
    const first = await session();
    const second = await session();
    const sent = [buddy('bob', 1, 5), group('Friends', 1)];
    for (const [count, subtype] of [INSERT, UPDATE, DELETE].entries()) {
      const status = await write(first, subtype, sent);
      expect([status.subtype, toHex(status.body)]).toEqual([0x0e, '00000000']);
      await waitFor(() => pushesTo(second).length === count + 1, `the push of 0x${subtype.toString(16)}`);
      const push = pushesTo(second)[count];
      expect([push?.subtype, push?.requestId]).toEqual([subtype, SERVER_REQUEST_ID]);
      expect(itemsOf(push?.body ?? new Uint8Array(0))).toEqual(sent);
    }
    expect(fake.feedbagOf('Alice')).toEqual([]);
    await roundTrip(first);
    expect(pushesTo(first)).toEqual([]);
  });

  it("cluster marks are relayed with the sender's request id", async () => {
    const first = await session();
    const second = await session();
    first.snac(0x13, 0x11, 77);
    first.snac(0x13, 0x12, 78);
    const marks = (client: RawClient): number[][] =>
      snacsOf(client)
        .filter((s) => s.family === 0x13 && (s.subtype === 0x11 || s.subtype === 0x12))
        .map((s) => [s.subtype, s.requestId]);
    await waitFor(() => marks(second).length === 2, 'both marks');
    expect(marks(second)).toEqual([
      [0x11, 77],
      [0x12, 78],
    ]);
    await roundTrip(first);
    expect(marks(first)).toEqual([]);
  });

  it('failNextStatus reports a non-zero result and stores nothing for that item', async () => {
    const alice = await session();
    fake.failNextStatus(0x000e);
    const status = await write(alice, INSERT, [buddy('bob', 1, 5), buddy('carol', 1, 6)]);
    expect([status.subtype, toHex(status.body)]).toEqual([0x0e, '000e0000']);
    expect(fake.feedbagOf('Alice')).toEqual([buddy('carol', 1, 6)]);
    const again = await write(alice, INSERT, [buddy('bob', 1, 5)]);
    expect(toHex(again.body)).toBe('0000');
    expect(fake.feedbagOf('Alice').map((i) => i.name)).toEqual(['carol', 'bob']);
  });
});

describe('test server: privacy', () => {
  it('a deny item hides presence only in deny-some mode', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    expect(bob.sightings()).toEqual([]);
    const alice = await session();
    expect(bob.sightings()).toEqual([{ name: 'Alice', event: 'arrived', away: false, idleMinutes: null, warning: 0, icon: null }]);

    // foodgroup/buddy.go BroadcastVisibility: not blocked, so the server sends the arrival again.
    await write(alice, INSERT, [deny('bob')]);
    expect(events(bob)).toEqual(['arrived', 'arrived']);

    await write(alice, INSERT, [privacy(4)]);
    expect(events(bob)).toEqual(['arrived', 'arrived', 'departed']);
    expect(bob.sightings().at(-1)).toEqual({ name: 'alice', event: 'departed', away: false, idleMinutes: null, warning: 0, icon: null });

    await write(alice, DELETE, [deny('bob')]);
    expect(events(bob)).toEqual(['arrived', 'arrived', 'departed', 'arrived']);
  });

  it('presence changes inside a cluster are announced when it ends', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    const alice = await session();
    alice.snac(0x13, 0x11, marker++);
    await write(alice, INSERT, [deny('bob')]);
    await write(alice, INSERT, [privacy(4)]);
    expect(events(bob)).toEqual(['arrived']);
    alice.snac(0x13, 0x12, marker++);
    await roundTrip(alice);
    expect(events(bob)).toEqual(['arrived', 'departed']);
  });

  it('a session that comes on the air is told of nobody who is blocked either way', async () => {
    fake.setFeedbag('Alice', [buddy('bob', 1, 1), buddy('carol', 1, 2), buddy('dave', 1, 3), deny('carol'), privacy(4)]);
    const bob = fake.peer('Bob');
    fake.peer('Carol');
    fake.peer('Dave');
    bob.watch('Alice');
    fake.setFeedbag('Dave', [deny('alice'), privacy(4)]);
    const alice = await session();
    await roundTrip(alice);
    const arrivals = snacsOf(alice)
      .filter((s) => s.family === 0x03 && s.subtype === 0x0b)
      .map((s) => new ByteReader(s.body).str8());
    expect(arrivals).toEqual(['Bob']);
    expect(events(bob)).toEqual(['arrived']);
  });

  it('an IM from someone the recipient blocks fails as not available, and to someone the sender blocks as blocked', async () => {
    const bob = fake.peer('Bob');
    const alice = await session();
    const text = encodeImText('hello');
    const tlvs = encodeTlvs([tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(text.charset, text.bytes))]);
    const body = new ByteWriter().u64(1n).u16(ICBM_CHANNEL_IM).str8('Bob').bytes(tlvs).toBytes();
    const errorOf = (reply: Snac): number[] => [reply.family, reply.subtype, new ByteReader(reply.body).u16()];

    fake.setFeedbag('Alice', [deny('bob'), privacy(4)]);
    expect(errorOf(await request(alice, 4, 0x06, body))).toEqual([0x04, 0x01, 0x0010]);
    expect(bob.ims()).toEqual([]);

    fake.setFeedbag('Alice', []);
    fake.setFeedbag('Bob', [deny('alice'), privacy(4)]);
    expect(errorOf(await request(alice, 4, 0x06, body))).toEqual([0x04, 0x01, 0x0004]);
    expect(bob.ims()).toEqual([]);

    fake.setFeedbag('Bob', []);
    const requestId = marker++;
    alice.snac(4, 0x06, requestId, body);
    await roundTrip(alice);
    expect(snacsOf(alice).some((s) => s.requestId === requestId)).toBe(false);
    expect(bob.ims().map((m) => m.html)).toEqual(['hello']);
  });

  it.each([
    ['no privacy item and a deny item', [deny('bob')], false],
    ['a privacy item without the mode attribute and a deny item', [item(4, '', 0, 0x41), deny('bob')], false],
    ['mode 1 and a deny item', [privacy(1), deny('bob')], false],
    ['mode 2', [privacy(2)], true],
    ['mode 3 with a permit item', [privacy(3), permit('bob')], false],
    ['mode 3 without a permit item', [privacy(3), permit('carol'), buddy('bob')], true],
    ['mode 4 with a deny item', [privacy(4), deny('bob')], true],
    ['mode 4 without a deny item', [privacy(4), deny('carol'), buddy('bob')], false],
    ['mode 5 with a buddy item', [privacy(5), buddy('bob')], false],
    ['mode 5 without a buddy item', [privacy(5), buddy('carol'), permit('bob')], true],
    ['mode 4 with the name in another spelling', [privacy(4), deny('B o B')], true],
    // state/relationship.go:32, :59 at 7af2464: only a buddy item not waiting for authorisation counts.
    ['mode 5 with a buddy item waiting for authorisation', [privacy(5), item(0, 'bob', 1, 5, [tlv.bytes(FEEDBAG_ATTR_PENDING, new Uint8Array(0))])], true],
    ['mode 5 with a settled buddy item beside a pending one', [privacy(5), item(0, 'bob', 1, 5, [tlv.bytes(FEEDBAG_ATTR_PENDING, new Uint8Array(0))]), buddy('bob', 2, 6)], false],
  ])("the privacy modes block as the server's table says: %s", (_case, feedbag, expected) => {
    expect(blocks(feedbag, 'Bob')).toBe(expected);
  });
});

describe('test server: rate reply', () => {
  it("the rate reply reports the account's current level", async () => {
    await session();
    fake.spend('Alice', 3, 4);
    const second = await session();
    const classes = decodeRateParamsReply((await request(second, 1, 0x06)).body).classes;
    const levelOf = (id: number): number | undefined => classes.find((c) => c.id === id)?.currentLevel;
    expect(levelOf(3)).toBeLessThan(6000);
    expect(levelOf(4)).toBe(8000);
  });
});
