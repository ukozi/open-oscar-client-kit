import { afterEach, describe, expect, it } from 'vitest';
import { decodeFeedbagReply, encodeFeedbagItems, feedbagOrder } from '../../src/wire/feedbag.js';
import { buddyListFeedbag } from '../../lib/feedbag.js';
import { openSession } from '../../lib/session.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const groups = [
  { name: 'Buddies', buddies: ['Alice', 'Bob'] },
  { name: 'Work', buddies: ['Cathy'] },
];

let fake: FakeOscarServer | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

describe('buddyListFeedbag', () => {
  it('lists the root, the groups and the buddies with their orders', () => {
    const items = buddyListFeedbag(groups);
    expect(items[0]).toMatchObject({ classId: 1, groupId: 0, itemId: 0 });
    expect(feedbagOrder(items[0] as never)).toEqual([1, 2]);
    const buddies = items.filter((i) => i.classId === 0);
    expect(buddies.map((b) => b.name)).toEqual(['Alice', 'Bob', 'Cathy']);
    expect(new Set(buddies.map((b) => b.itemId)).size).toBe(3);
    const first = items.find((i) => i.classId === 1 && i.name === 'Buddies');
    expect(feedbagOrder(first as never)).toEqual(buddies.slice(0, 2).map((b) => b.itemId));
  });

  it('round-trips through the feedbag codec', () => {
    const items = buddyListFeedbag(groups);
    const encoded = encodeFeedbagItems(items);
    const body = new Uint8Array(3 + encoded.length + 4);
    body[1] = items.length >> 8;
    body[2] = items.length & 0xff;
    body.set(encoded, 3);
    expect(decodeFeedbagReply(body).items).toEqual(items);
  });

  it('shows up as the buddy list the client builds', async () => {
    fake = await FakeOscarServer.start();
    fake.addUser('Bot', 'botpass1');
    fake.setFeedbag('bot', buddyListFeedbag(groups));
    const session = await openSession({
      screenName: 'Bot',
      password: 'botpass1',
      app: 'Test',
      server: { host: '127.0.0.1', port: fake.port },
    });
    expect(session.buddies().map((b) => [b.group, b.screenName])).toEqual([
      ['Buddies', 'Alice'],
      ['Buddies', 'Bob'],
      ['Work', 'Cathy'],
    ]);
    await session.signOff();
  });
});
