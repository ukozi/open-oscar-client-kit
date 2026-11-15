import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ListWriteError, OscarError } from '../../src/client/errors.js';
import { buildBuddyList } from '../../src/client/feedbag.js';
import type { OscarClient } from '../../src/client/oscar-client.js';
import { ByteReader, toHex } from '../../src/wire/bytes.js';
import { BUDDY_PREF_ACCEPT_NON_LIST_BART, buddyPref, encodeFeedbagItems, feedbagAlias, feedbagOrder, orderAttr, privacyMode, readFeedbagItem, typingPref } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { findTlv, tlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { LocalRefusal } from '../../src/model/session.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { RawClient, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { bytesOf, loadVectors } from '../support/vectors.js';

const MULTI_SESSION = 0x01;
const START = 0x11;
const END = 0x12;
const INSERT = 0x08;
const UPDATE = 0x09;
const DELETE = 0x0a;
const ALIAS = 0x0131;
const MODE = 0x00ca;
const UNKNOWN = tlv.bytes(0x0999, Uint8Array.of(0xde, 0xad, 0xbe, 0xef));

const item = (classId: number, name: string, groupId: number, itemId: number, attrs: Tlv[] = []): FeedbagItem => ({ name, groupId, itemId, classId, attrs });
const root = (ids: number[], more: Tlv[] = []): FeedbagItem => item(1, '', 0, 0, [orderAttr(ids), ...more]);
const group = (id: number, name: string, ids: number[] = [], more: Tlv[] = []): FeedbagItem => item(1, name, id, 0, [orderAttr(ids), ...more]);
const buddy = (groupId: number, itemId: number, name: string, attrs: Tlv[] = []): FeedbagItem => item(0, name, groupId, itemId, attrs);
const deny = (itemId: number, name: string): FeedbagItem => item(3, name, 0, itemId);
const permit = (itemId: number, name: string): FeedbagItem => item(2, name, 0, itemId);
const privacy = (itemId: number, mode: number, more: Tlv[] = []): FeedbagItem => item(4, '', 0, itemId, [tlv.u8(MODE, mode), ...more]);
// A buddy item waiting for authorisation: TLV 0x0066.
const pendingBuddy = (itemId: number, name: string, groupId = 1): FeedbagItem => buddy(groupId, itemId, name, [tlv.bytes(0x0066, new Uint8Array(0))]);
const alias = (text: string): Tlv => tlv.str(ALIAS, text);

/** Buddies (1): bob 1, carol 2. Work (2): erin 4. */
const base = (): FeedbagItem[] => [
  root([1, 2]),
  group(1, 'Buddies', [1, 2]),
  buddy(1, 1, 'bob'),
  buddy(1, 2, 'carol'),
  group(2, 'Work', [4]),
  buddy(2, 4, 'erin'),
];

const handListsInfo = loadVectors('hand-lists-info.json');
const vectorItem = (name: string): FeedbagItem => readFeedbagItem(new ByteReader(bytesOf(handListsInfo, name)));
const PREF_ENABLED = vectorItem('feedbag item, buddy preferences with typing enabled');
const PREF_DISABLED = vectorItem('feedbag item, buddy preferences with typing disabled');
const PREF_EMPTY = vectorItem('feedbag item, empty buddy preferences item 9');

let fake: FakeOscarServer;
let h: ClientHarness;
let client: OscarClient;
let from = 0;
let marker = 0x7000;

beforeEach(async () => {
  fake = await FakeOscarServer.start();
  fake.addUser('Alice', 'alicepw1');
  h = makeClient(fake);
  client = h.client;
  from = 0;
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

async function ready(items: FeedbagItem[]): Promise<void> {
  fake.setFeedbag('Alice', withTypingPref(items));
  await h.signOn();
  from = fake.snacsFrom('Alice').length;
}

const feedbagSnacs = (name = 'Alice') => fake.snacsFrom(name).slice(from).filter((s) => s.family === 0x13);
const writes = (name = 'Alice'): number[] => feedbagSnacs(name).map((s) => s.subtype).filter((s) => ![0x02, 0x04, 0x07].includes(s));
const queries = (): number => feedbagSnacs().filter((s) => s.subtype === 0x04).length;

function itemsOf(body: Uint8Array): FeedbagItem[] {
  const r = new ByteReader(body);
  const items: FeedbagItem[] = [];
  while (r.remaining > 0) items.push(readFeedbagItem(r));
  return items;
}

const WRITE_NAMES: Record<number, string> = { [INSERT]: 'insert', [UPDATE]: 'update', [DELETE]: 'delete' };
// One string per list write since `ready`: 'start'/'end' for cluster marks, 'query' for 0x13/0x04, else subtype and item classes.
function wire(): string[] {
  return feedbagSnacs().flatMap((s): string[] => {
    if (s.subtype === START) return ['start'];
    if (s.subtype === END) return ['end'];
    if (s.subtype === 0x04) return ['query'];
    const name = WRITE_NAMES[s.subtype];
    return name === undefined ? [] : [`${name} ${itemsOf(s.body).map((i) => i.classId).join(',')}`];
  });
}

// No SNAC carries the privacy item beside a buddy, permit or deny item, and no cluster holds a privacy item.
function privacyWrittenAlone(): void {
  let inCluster = false;
  for (const s of feedbagSnacs()) {
    if (s.subtype === START) inCluster = true;
    if (s.subtype === END) inCluster = false;
    if (![INSERT, UPDATE, DELETE].includes(s.subtype)) continue;
    const classes = itemsOf(s.body).map((i) => i.classId);
    if (!classes.includes(4)) continue;
    expect(classes.some((c) => c === 0 || c === 2 || c === 3)).toBe(false);
    expect(inCluster).toBe(false);
  }
}

function written(subtype: number, nth = 0): FeedbagItem[] {
  const snac = feedbagSnacs().filter((s) => s.subtype === subtype)[nth];
  if (!snac) throw new Error(`no write 0x${subtype.toString(16)} number ${nth}`);
  return itemsOf(snac.body);
}

const stored = (): FeedbagItem[] => fake.feedbagOf('Alice');
function storedAt(groupId: number, itemId: number): FeedbagItem {
  const found = stored().find((i) => i.groupId === groupId && i.itemId === itemId);
  if (!found) throw new Error(`the test server holds no item (${groupId}, ${itemId})`);
  return found;
}
const hex = (one: FeedbagItem): string => toHex(encodeFeedbagItems([one]));
const fresh = () => buildBuddyList(stored());
const namesIn = (groupId: number): string[] => client.buddyList().groups.find((g) => g.id === groupId)?.buddies.map((b) => b.screenName) ?? [];

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

async function writeErrorOf(promise: Promise<unknown>): Promise<ListWriteError> {
  const error = await errorOf(promise);
  expect(error).toBeInstanceOf(ListWriteError);
  return error as ListWriteError;
}

const other = (): Promise<RawClient> => RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
const push = (session: RawClient, subtype: number, items: FeedbagItem[] = []): void =>
  session.snac(0x13, subtype, marker++, subtype === START || subtype === END ? undefined : encodeFeedbagItems(items));

// The test server writes to one socket in order, so when this IM is in, everything it pushed before is in too.
async function delivered(): Promise<void> {
  const count = h.ims.length;
  await settle(fake.port);
  fake.peer('Zed').sendIm('Alice', 'marker');
  await waitFor(() => h.ims.length > count, 'the marker IM');
}

describe('buddy list writes', () => {
  it('adds a buddy last in its group, with its alias, in one cluster', async () => {
    await ready(base());
    await client.addBuddy({ screenName: 'Dave', groupId: 1, alias: 'D' });
    expect(writes()).toEqual([START, INSERT, UPDATE, END]);
    expect(written(INSERT).map((i) => i.name)).toEqual(['Dave']);
    const added = stored().find((i) => i.classId === 0 && i.name === 'dave');
    expect([added?.groupId, added && feedbagAlias(added)]).toEqual([1, 'D']);
    expect(feedbagOrder(storedAt(1, 0)).at(-1)).toBe(added?.itemId);
    expect(namesIn(1)).toEqual(['bob', 'carol', 'dave']);
    expect(client.buddyList().groups[0]?.buddies.at(-1)).toEqual({ itemId: added?.itemId, screenName: 'dave', alias: 'D', pending: false });
  });

  it('the local list equals a fresh query after adding a buddy typed with capitals and spaces', async () => {
    await ready(base());
    await client.addBuddy({ screenName: 'Fr Ank', groupId: 2, alias: null });
    expect(namesIn(2)).toEqual(['erin', 'frank']);
    expect(client.buddyList()).toEqual(fresh());
    const second = await other();
    const lists = h.lists.length;
    push(second, INSERT, [buddy(2, 30, 'Gi Na')]);
    await waitFor(() => h.lists.length > lists, 'the pushed insert');
    expect(namesIn(2)).toEqual(['erin', 'frank', 'gina']);
    expect(client.buddyList()).toEqual(fresh());
  });

  it('the list does not change until the server confirms', async () => {
    await ready(base());
    const before = client.buddyList();
    const lists = h.lists.length;
    const release = fake.withhold(0x13, 0x0e);
    const adding = client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null });
    await waitFor(() => writes().length === 4, 'the cluster');
    await settle(fake.port);
    expect(h.lists.length).toBe(lists);
    expect(client.buddyList()).toEqual(before);
    release();
    await adding;
    expect(namesIn(1)).toEqual(['bob', 'carol', 'dave']);
    expect(h.lists.length).toBe(lists + 1);
    expect(h.lists.at(-1)).toEqual(client.buddyList());
  });

  it('two adds made together are written one after the other with ids no item uses', async () => {
    await ready([...base(), deny(3, 'mallory')]);
    const release = fake.withhold(0x13, 0x0e);
    const first = client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null });
    const second = client.addBuddy({ screenName: 'Frank', groupId: 1, alias: null });
    await waitFor(() => writes().length >= 4, 'the first cluster');
    await settle(fake.port);
    expect(writes()).toEqual([START, INSERT, UPDATE, END]);
    expect(written(INSERT).map((i) => [i.name, i.itemId])).toEqual([['Dave', 5]]);
    release();
    await Promise.all([first, second]);
    expect(writes()).toEqual([START, INSERT, UPDATE, END, START, INSERT, UPDATE, END]);
    expect(written(INSERT, 1).map((i) => [i.name, i.itemId])).toEqual([['Frank', 6]]);
    expect(feedbagOrder(storedAt(1, 0))).toEqual([1, 2, 5, 6]);
    expect(client.buddyList()).toEqual(fresh());
  });

  it('two clusters never interleave on the wire', async () => {
    // A Block under "Allow only the people below" of a name allowed is a cluster of the permit delete and the deny insert.
    await ready([...base(), permit(5, 'carol'), privacy(7, 3)]);
    await Promise.all([client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null }), client.block('carol')]);
    expect(writes()).toEqual([START, INSERT, UPDATE, END, START, DELETE, INSERT, END]);
  });

  it('two blocks made together leave one privacy item', async () => {
    await ready(base());
    await Promise.all([client.block('bob'), client.block('carol')]);
    const modes = stored().filter((i) => i.classId === 4);
    expect(modes.map((i) => privacyMode(i))).toEqual([4]);
    expect(stored().filter((i) => i.classId === 3).map((i) => i.name)).toEqual(['bob', 'carol']);
    // The deny item, then the privacy item alone; the second finds the mode "Block the people below".
    expect(wire()).toEqual(['insert 3', 'insert 4', 'insert 3']);
  });

  it('operations waiting in the queue fail when the connection drops', async () => {
    await ready(base());
    fake.withhold(0x13, 0x0e);
    const first = writeErrorOf(client.setAlias({ groupId: 1, itemId: 1 }, 'B'));
    const second = writeErrorOf(client.setAlias({ groupId: 1, itemId: 2 }, 'C'));
    await waitFor(() => writes().length === 1, 'the first update');
    fake.dropSocket('Alice');
    expect([(await first).info, (await first).reloaded]).toEqual([{ kind: 'connection-lost' }, false]);
    expect([(await second).info, (await second).reloaded]).toEqual([{ kind: 'connection-lost' }, false]);
    await settle(fake.port);
    expect(writes()).toEqual([UPDATE]);
    expect(written(UPDATE).map((i) => i.itemId)).toEqual([1]);
  });

  it("removes a buddy and takes it out of the group's order list", async () => {
    await ready(base());
    await client.removeBuddy({ groupId: 1, itemId: 1 });
    expect(writes()).toEqual([START, DELETE, UPDATE, END]);
    expect(stored().some((i) => i.classId === 0 && i.name === 'bob')).toBe(false);
    expect(feedbagOrder(storedAt(1, 0))).toEqual([2]);
    expect(namesIn(1)).toEqual(['carol']);
    expect(client.buddyList()).toEqual(fresh());
  });

  it('removes a buddy whose group item is gone, and moves one into a group, writing only that group\'s order list', async () => {
    await ready([root([1]), group(1, 'Buddies', [1]), buddy(1, 1, 'bob'), buddy(7, 2, 'orphan', [alias('O')]), buddy(7, 3, 'stray')]);
    expect(client.buddyList().groups.map((g) => [g.id, g.stray ?? false, g.buddies.map((b) => b.screenName)])).toEqual([[1, false, ['bob']], [7, true, ['orphan', 'stray']]]);
    await client.moveBuddy({ groupId: 7, itemId: 2 }, 1);
    expect(writes()).toEqual([START, DELETE, INSERT, UPDATE, END]);
    expect(written(UPDATE).map((i) => i.groupId)).toEqual([1]);
    expect(storedAt(1, 2)).toEqual(buddy(1, 2, 'orphan', [alias('O')]));
    expect(feedbagOrder(storedAt(1, 0))).toEqual([1, 2]);
    expect(client.buddyList()).toEqual(fresh());
    await client.removeBuddy({ groupId: 7, itemId: 3 });
    expect(client.buddyList().groups.map((g) => g.id)).toEqual([1]);
    expect(client.buddyList()).toEqual(fresh());
  });

  it('a move keeps the alias and every unknown attribute', async () => {
    const attrs = [UNKNOWN, alias('Bobby'), tlv.bytes(0x0998, Uint8Array.of(1))];
    await ready([root([1, 2]), group(1, 'Buddies', [1, 2]), buddy(1, 1, 'bob', attrs), buddy(1, 2, 'carol'), group(2, 'Work', [4]), buddy(2, 4, 'erin')]);
    await client.moveBuddy({ groupId: 1, itemId: 1 }, 2);
    expect(writes()).toEqual([START, DELETE, INSERT, UPDATE, END]);
    expect(written(UPDATE).map((i) => i.groupId)).toEqual([1, 2]);
    expect(storedAt(2, 1)).toEqual(buddy(2, 1, 'bob', attrs));
    expect(stored().filter((i) => i.name === 'bob')).toHaveLength(1);
    expect(feedbagOrder(storedAt(1, 0))).toEqual([2]);
    expect(feedbagOrder(storedAt(2, 0))).toEqual([4, 1]);
    expect(client.buddyList().groups[1]?.buddies).toEqual([
      { itemId: 4, screenName: 'erin', alias: null, pending: false },
      { itemId: 1, screenName: 'bob', alias: 'Bobby', pending: false },
    ]);
    expect(client.buddyList()).toEqual(fresh());
  });

  it('a move takes a new item id when the new group already holds an item with the old one', async () => {
    // Other clients number buddies per group, so (1, 1) and (2, 1) can both exist.
    await ready([root([1, 2]), group(1, 'Buddies', [1]), buddy(1, 1, 'bob', [alias('Bobby')]), group(2, 'Work', [1]), buddy(2, 1, 'erin')]);
    await client.moveBuddy({ groupId: 1, itemId: 1 }, 2);
    expect(storedAt(2, 1).name).toBe('erin');
    expect(storedAt(2, 2)).toEqual(buddy(2, 2, 'bob', [alias('Bobby')]));
    expect(feedbagOrder(storedAt(2, 0))).toEqual([1, 2]);
    expect(namesIn(2)).toEqual(['erin', 'bob']);
    expect(client.buddyList()).toEqual(fresh());
  });

  it('sets and clears an alias with a single update and no cluster', async () => {
    await ready([root([1]), group(1, 'Buddies', [1]), buddy(1, 1, 'bob', [UNKNOWN])]);
    await client.setAlias({ groupId: 1, itemId: 1 }, 'Bobby');
    expect(writes()).toEqual([UPDATE]);
    expect(storedAt(1, 1)).toEqual(buddy(1, 1, 'bob', [UNKNOWN, alias('Bobby')]));
    expect(client.buddyList().groups[0]?.buddies[0]?.alias).toBe('Bobby');
    await client.setAlias({ groupId: 1, itemId: 1 }, null);
    expect(writes()).toEqual([UPDATE, UPDATE]);
    expect(storedAt(1, 1)).toEqual(buddy(1, 1, 'bob', [UNKNOWN]));
    expect(client.buddyList().groups[0]?.buddies[0]?.alias).toBeNull();
    await client.setAlias({ groupId: 1, itemId: 1 }, 'B');
    await client.setAlias({ groupId: 1, itemId: 1 }, '');
    expect(findTlv(storedAt(1, 1).attrs, ALIAS)).toBeUndefined();
  });

  it('adds a group, creating the root group when the list has none', async () => {
    await ready([]);
    expect(await client.addGroup(' Friends ')).toBe(1);
    expect(writes()).toEqual([START, INSERT, INSERT, END]);
    expect(feedbagOrder(storedAt(0, 0))).toEqual([1]);
    expect(storedAt(1, 0)).toEqual(group(1, 'Friends'));
    expect(client.buddyList().groups).toEqual([{ id: 1, name: 'Friends', buddies: [] }]);
  });

  it('adds a group last in a list that has a root group', async () => {
    await ready([root([1], [UNKNOWN]), group(1, 'Buddies', [1]), buddy(1, 1, 'bob')]);
    expect(await client.addGroup('Work')).toBe(2);
    expect(writes()).toEqual([START, INSERT, UPDATE, END]);
    expect(storedAt(0, 0)).toEqual(root([1, 2], [UNKNOWN]));
    expect(client.buddyList().groups.map((g) => [g.id, g.name])).toEqual([[1, 'Buddies'], [2, 'Work']]);
    expect(client.buddyList()).toEqual(fresh());
  });

  it('a new group does not take the id of buddies whose group item is gone', async () => {
    await ready([root([1]), group(1, 'Buddies'), buddy(2, 7, 'orphan')]);
    expect(await client.addGroup('Work')).toBe(3);
    expect(client.buddyList().groups[1]).toEqual({ id: 3, name: 'Work', buddies: [] });
  });

  it('renames a group and keeps its order list and unknown attributes', async () => {
    await ready([root([1]), group(1, 'Buddies', [2, 1], [UNKNOWN]), buddy(1, 1, 'bob'), buddy(1, 2, 'carol')]);
    await client.renameGroup(1, ' Pals ');
    expect(writes()).toEqual([UPDATE]);
    expect(storedAt(1, 0)).toEqual(group(1, 'Pals', [2, 1], [UNKNOWN]));
    expect(client.buddyList().groups).toEqual([
      { id: 1, name: 'Pals', buddies: [{ itemId: 2, screenName: 'carol', alias: null, pending: false }, { itemId: 1, screenName: 'bob', alias: null, pending: false }] },
    ]);
  });

  it("deletes a group with its buddies and takes it out of the root's order list", async () => {
    await ready(base());
    await client.deleteGroup(1);
    expect(writes()).toEqual([START, DELETE, DELETE, UPDATE, END]);
    expect(written(DELETE).map((i) => i.name)).toEqual(['bob', 'carol']);
    expect(stored().filter((i) => i.groupId === 1)).toEqual([]);
    expect(feedbagOrder(storedAt(0, 0))).toEqual([2]);
    expect(client.buddyList().groups.map((g) => g.name)).toEqual(['Work']);
    expect(client.buddyList()).toEqual(fresh());
  });

  const many = (count: number, make: (n: number) => FeedbagItem): FeedbagItem[] => Array.from({ length: count }, (_, i) => make(i + 1));
  const refusals: [string, () => FeedbagItem[], (c: OscarClient) => Promise<unknown>, LocalRefusal][] = [
    ['a 62nd buddy', () => [group(1, 'Buddies'), ...many(61, (n) => buddy(1, n, `buddy${n}`))], (c) => c.addBuddy({ screenName: 'Dave', groupId: 1, alias: null }), 'buddy-limit'],
    [
      'a 201st buddy in one group',
      () => [group(1, 'Buddies'), ...many(200, (n) => buddy(1, n, `buddy${n}`)), group(2, 'Work'), buddy(2, 300, 'erin')],
      (c) => c.moveBuddy({ groupId: 2, itemId: 300 }, 1),
      'group-full',
    ],
    ['a 62nd group', () => many(61, (n) => group(n, `Group ${n}`)), (c) => c.addGroup('One more'), 'group-limit'],
    ['B o B when bob is listed', base, (c) => c.addBuddy({ screenName: 'B o B', groupId: 2, alias: null }), 'duplicate-buddy'],
    [' Work  when Work exists', base, (c) => c.addGroup(' Work '), 'duplicate-group'],
    ['a rename to a name another group has', base, (c) => c.renameGroup(1, 'Work'), 'duplicate-group'],
    ['a group named with spaces only', base, (c) => c.addGroup('   '), 'invalid-group-name'],
    ['a group name of 201 bytes', base, (c) => c.addGroup('x'.repeat(201)), 'invalid-group-name'],
    ['a rename to a name of 201 bytes', base, (c) => c.renameGroup(1, `${'é'.repeat(100)}x`), 'invalid-group-name'],
    ['ab as a screen name', base, (c) => c.addBuddy({ screenName: 'ab', groupId: 1, alias: null }), 'invalid-screen-name'],
    ['a 101st deny item', () => [...base(), ...many(100, (n) => deny(100 + n, `foe${n}`))], (c) => c.block('dave'), 'block-limit'],
    ['a block of the own screen name', base, (c) => c.block('a l i c e'), 'own-screen-name'],
    ['a move to the own group', base, (c) => c.moveBuddy({ groupId: 1, itemId: 1 }, 1), 'unknown-item'],
    ['a move to a group that is not there', base, (c) => c.moveBuddy({ groupId: 1, itemId: 1 }, 9), 'unknown-item'],
    ['a removal of an item that is not there', base, (c) => c.removeBuddy({ groupId: 1, itemId: 77 }), 'unknown-item'],
    ['a buddy for a group that is not there', base, (c) => c.addBuddy({ screenName: 'Dave', groupId: 9, alias: null }), 'unknown-item'],
    ['an alias for a group item', base, (c) => c.setAlias({ groupId: 1, itemId: 0 }, 'x'), 'unknown-item'],
    ['a rename of the root group', base, (c) => c.renameGroup(0, 'Top'), 'unknown-item'],
    ['a delete of a group that is not there', base, (c) => c.deleteGroup(9), 'unknown-item'],
  ];
  it.each(refusals)('refuses before sending: %s', async (_case, seed, act, code) => {
    await ready(seed());
    const before = client.buddyList();
    const error = await errorOf(act(client));
    expect(error).toBeInstanceOf(OscarError);
    expect(error).not.toBeInstanceOf(ListWriteError);
    expect((error as OscarError).info).toEqual({ kind: 'local', code });
    await settle(fake.port);
    expect(writes()).toEqual([]);
    expect(client.buddyList()).toEqual(before);
  });

  it('the 61st buddy and the 61st group are written', async () => {
    await ready([group(1, 'Buddies'), ...Array.from({ length: 60 }, (_, i) => buddy(1, i + 1, `buddy${i + 1}`))]);
    await client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null });
    expect(namesIn(1)).toHaveLength(61);
  });

  it('refuses every list write when not signed on', async () => {
    const calls: Promise<unknown>[] = [
      client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null }),
      client.removeBuddy({ groupId: 1, itemId: 1 }),
      client.moveBuddy({ groupId: 1, itemId: 1 }, 2),
      client.setAlias({ groupId: 1, itemId: 1 }, 'x'),
      client.addGroup('Work'),
      client.renameGroup(1, 'Work'),
      client.deleteGroup(1),
      client.block('bob'),
      client.unblock('bob'),
      client.setPrivacyMode('block-all'),
      client.setAcceptNonListIcons(true),
      client.allow('bob'),
      client.disallow('bob'),
      client.addBlocked('bob'),
      client.removeBlocked('bob'),
    ];
    for (const call of calls) expect(((await errorOf(call)) as OscarError).info).toEqual({ kind: 'not-signed-on' });
  });

  it('a refused single write leaves the list unchanged and is not queried again', async () => {
    await ready(base());
    const before = client.buddyList();
    const lists = h.lists.length;
    fake.failNext(0x13, 0x09, { code: 0x000a });
    const error = await writeErrorOf(client.setAlias({ groupId: 1, itemId: 1 }, 'B'));
    expect([error.info, error.reloaded]).toEqual([{ kind: 'refused', code: 10 }, false]);
    await settle(fake.port);
    expect(queries()).toBe(0);
    expect(client.buddyList()).toEqual(before);
    expect(h.lists.length).toBe(lists);
    await client.setAlias({ groupId: 1, itemId: 1 }, 'B');
    expect(client.buddyList().groups[0]?.buddies[0]?.alias).toBe('B');
  });

  it('a non-zero result fails the write', async () => {
    await ready(base());
    fake.failNextStatus(0x000e);
    const error = await writeErrorOf(client.setAlias({ groupId: 1, itemId: 1 }, 'B'));
    expect([error.info, error.reloaded]).toEqual([{ kind: 'refused', code: 14 }, false]);
    expect(client.buddyList().groups[0]?.buddies[0]?.alias).toBeNull();
  });

  it("a failed cluster re-queries and the list equals the server's", async () => {
    await ready(base());
    const lists = h.lists.length;
    fake.failNext(0x13, 0x09, { code: 0x000a });
    const error = await writeErrorOf(client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null }));
    expect([error.info, error.reloaded]).toEqual([{ kind: 'refused', code: 10 }, true]);
    expect(queries()).toBe(1);
    expect(client.buddyList()).toEqual(fresh());
    // The server stored the buddy item and not the order list: it shows after the ordered ones.
    expect(namesIn(1)).toEqual(['bob', 'carol', 'dave']);
    expect(feedbagOrder(storedAt(1, 0))).toEqual([1, 2]);
    expect(h.lists.length).toBe(lists + 1);
    expect(h.lists.at(-1)).toEqual(client.buddyList());
  });

  it('a timeout re-queries', async () => {
    await ready(base());
    fake.withhold(0x13, 0x0e);
    const failed = writeErrorOf(client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null }));
    await waitFor(() => writes().length === 4, 'the cluster');
    await h.timers.advance(9_999);
    expect(queries()).toBe(0);
    await h.timers.advance(1);
    const error = await failed;
    expect([error.info, error.reloaded]).toEqual([{ kind: 'timeout', rateLimited: false }, true]);
    expect(queries()).toBe(1);
    expect(client.buddyList()).toEqual(fresh());
    expect(namesIn(1)).toEqual(['bob', 'carol', 'dave']);
  });

  it('a connection that drops fails the write without a query', async () => {
    await ready(base());
    fake.closeOn(0x13, 0x08, 'destroy');
    const error = await writeErrorOf(client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null }));
    expect([error.info, error.reloaded]).toEqual([{ kind: 'connection-lost' }, false]);
    await settle(fake.port);
    expect(queries()).toBe(0);
  });

  it('keeps items and attributes it does not understand through every write', async () => {
    const strange = item(0x0014, 'whatever', 0, 20, [UNKNOWN, tlv.bytes(0x0001, Uint8Array.of(7))]);
    await ready([root([1, 2], [UNKNOWN]), group(1, 'Buddies', [1], [UNKNOWN]), buddy(1, 1, 'bob', [UNKNOWN]), group(2, 'Work', [], [UNKNOWN]), strange]);
    const check = (groupIds = [0, 1, 2]): void => {
      expect(hex(storedAt(0, 20))).toBe(hex(strange));
      for (const groupId of groupIds) {
        expect(toHex(findTlv(storedAt(groupId, 0).attrs, 0x0999) ?? new Uint8Array(0))).toBe('deadbeef');
      }
      expect(client.buddyList()).toEqual(fresh());
    };
    await client.addBuddy({ screenName: 'Dave', groupId: 1, alias: null });
    check();
    await client.moveBuddy({ groupId: 1, itemId: 1 }, 2);
    check();
    expect(hex(storedAt(2, 1))).toBe(hex(buddy(2, 1, 'bob', [UNKNOWN])));
    await client.renameGroup(2, 'Office');
    check();
    await client.removeBuddy({ groupId: 2, itemId: 1 });
    check();
    await client.addGroup('More');
    check();
    await client.deleteGroup(1);
    check([0, 2]);
    expect(client.buddyList().groups.map((g) => g.name)).toEqual(['Office', 'More']);
  });
});

describe('buddy list changes pushed from another session', () => {
  it('applies an insert, an update and a delete pushed from another session', async () => {
    await ready(base());
    const second = await other();
    let lists = h.lists.length;
    const pushed = async (subtype: number, items: FeedbagItem[]): Promise<void> => {
      push(second, subtype, items);
      await waitFor(() => h.lists.length > lists, `the push 0x${subtype.toString(16)}`);
      await delivered();
      expect(h.lists.length).toBe(lists + 1);
      lists = h.lists.length;
      expect(h.lists.at(-1)).toEqual(client.buddyList());
      expect(client.buddyList()).toEqual(fresh());
    };
    await pushed(INSERT, [buddy(2, 30, 'Gina')]);
    expect(namesIn(2)).toEqual(['erin', 'gina']);
    await pushed(UPDATE, [buddy(2, 30, 'gina', [alias('G')]), group(2, 'Work', [30, 4])]);
    expect(client.buddyList().groups[1]?.buddies).toEqual([
      { itemId: 30, screenName: 'gina', alias: 'G', pending: false },
      { itemId: 4, screenName: 'erin', alias: null, pending: false },
    ]);
    await pushed(DELETE, [buddy(2, 30, 'gina')]);
    expect(namesIn(2)).toEqual(['erin']);
    await pushed(INSERT, [deny(40, 'Mal Lory'), privacy(41, 4)]);
    expect(client.buddyList().privacy).toEqual({ mode: 'block-list', allow: [], block: ['mallory'] });
  });

  it('a push inside a cluster is applied when the cluster ends', async () => {
    await ready(base());
    const second = await other();
    const lists = h.lists.length;
    const before = client.buddyList();
    push(second, START);
    push(second, INSERT, [buddy(2, 30, 'gina')]);
    push(second, UPDATE, [group(2, 'Work', [30, 4])]);
    await delivered();
    expect(h.lists.length).toBe(lists);
    expect(client.buddyList()).toEqual(before);
    push(second, END);
    await waitFor(() => h.lists.length > lists, 'the cluster to be applied');
    await delivered();
    expect(h.lists.length).toBe(lists + 1);
    expect(namesIn(2)).toEqual(['gina', 'erin']);
    expect(client.buddyList()).toEqual(fresh());
  });

  it('a push for an item with a write in flight does not settle that write', async () => {
    await ready(base());
    const second = await other();
    const release = fake.withhold(0x13, 0x0e);
    let settled = false;
    const mine = client.setAlias({ groupId: 1, itemId: 1 }, 'Mine').finally(() => {
      settled = true;
    });
    await waitFor(() => writes().includes(UPDATE), 'the update');
    const lists = h.lists.length;
    push(second, UPDATE, [buddy(1, 1, 'bob', [alias('Theirs')])]);
    await waitFor(() => h.lists.length > lists, 'the pushed update');
    await delivered();
    expect(settled).toBe(false);
    expect(client.buddyList().groups[0]?.buddies[0]?.alias).toBe('Theirs');
    release();
    await mine;
    expect(client.buddyList().groups[0]?.buddies[0]?.alias).toBe('Mine');
  });
});

describe('block', () => {
  afterEach(() => {
    privacyWrittenAlone();
  });

  it('block inserts the deny item, then puts the privacy item in "Block the people below" alone', async () => {
    await ready(base());
    expect(await client.block('B ob')).toEqual({ alsoBlocked: 0 });
    expect(wire()).toEqual(['insert 3', 'insert 4']);
    expect(written(INSERT).map((i) => [i.classId, i.name, i.groupId])).toEqual([[3, 'bob', 0]]);
    expect(stored().filter((i) => i.classId === 3).map((i) => i.name)).toEqual(['bob']);
    expect(stored().filter((i) => i.classId === 4).map((i) => [i.name, i.groupId, toHex(findTlv(i.attrs, MODE) ?? new Uint8Array(0))])).toEqual([['', 0, '04']]);
    expect(new Set(stored().map((i) => i.itemId)).size).toBe(stored().filter((i) => i.itemId !== 0).length + 1);
    expect(client.buddyList().privacy).toEqual({ mode: 'block-list', allow: [], block: ['bob'] });
    expect(h.lists.at(-1)).toEqual(client.buddyList());
  });

  it("block keeps the privacy item's other attributes", async () => {
    await ready([...base(), privacy(7, 1, [UNKNOWN])]);
    await client.block('bob');
    expect(wire()).toEqual(['insert 3', 'update 4']);
    expect(storedAt(0, 7)).toEqual(privacy(7, 4, [UNKNOWN]));
    expect(stored().filter((i) => i.classId === 4)).toHaveLength(1);
  });

  it('block gives a privacy item without a mode "Block the people below"', async () => {
    await ready([...base(), item(4, '', 0, 7, [UNKNOWN])]);
    await client.block('bob');
    expect(storedAt(0, 7)).toEqual(item(4, '', 0, 7, [UNKNOWN, tlv.u8(MODE, 4)]));
    expect(client.buddyList().privacy.block).toEqual(['bob']);
  });

  it('block under "Block the people below" is a single insert', async () => {
    await ready([...base(), privacy(7, 4)]);
    await client.block('bob');
    expect(writes()).toEqual([INSERT]);
    expect(client.buddyList().privacy.block).toEqual(['bob']);
    await client.block('Bob');
    await settle(fake.port);
    expect(writes()).toEqual([INSERT]);
  });

  it('blocking for the first time shows every deny item another client left', async () => {
    await ready([...base(), deny(5, 'carol'), privacy(7, 1)]);
    expect(client.buddyList().privacy).toEqual({ mode: 'allow-all', allow: [], block: ['carol'] });
    expect(await client.block('bob')).toEqual({ alsoBlocked: 1 });
    expect(client.buddyList().privacy).toEqual({ mode: 'block-list', allow: [], block: ['carol', 'bob'] });
  });

  it('unblock deletes the deny item and leaves the mode', async () => {
    await ready([...base(), deny(5, 'bob'), deny(6, 'carol'), privacy(7, 4, [UNKNOWN])]);
    await client.unblock('B o b');
    expect(writes()).toEqual([DELETE]);
    expect(stored().filter((i) => i.classId === 3).map((i) => i.name)).toEqual(['carol']);
    expect(storedAt(0, 7)).toEqual(privacy(7, 4, [UNKNOWN]));
    expect(client.buddyList().privacy).toEqual({ mode: 'block-list', allow: [], block: ['carol'] });
    await client.unblock('dave');
    await settle(fake.port);
    expect(writes()).toEqual([DELETE]);
  });

  it('a watcher loses sight of the client when blocked and sees it again when unblocked', async () => {
    await ready(base());
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    expect(bob.sightings().map((s) => s.event)).toEqual(['arrived']);
    await client.block('Bob');
    await settle(fake.port);
    expect(bob.sightings().at(-1)?.event).toBe('departed');
    const seen = bob.sightings().length;
    await client.unblock('Bob');
    await settle(fake.port);
    expect(bob.sightings().length).toBeGreaterThan(seen);
    expect(bob.sightings().at(-1)?.event).toBe('arrived');
  });
});

describe('the privacy setting and its lists', () => {
  const many = (count: number, make: (n: number) => FeedbagItem): FeedbagItem[] => Array.from({ length: count }, (_, i) => make(i + 1));
  const refusalOf = async (promise: Promise<unknown>): Promise<unknown> => {
    const error = await errorOf(promise);
    expect(error).toBeInstanceOf(OscarError);
    expect(error).not.toBeInstanceOf(ListWriteError);
    return (error as OscarError).info;
  };
  const modeStored = (): number[] => stored().filter((i) => i.classId === 4).map((i) => privacyMode(i));
  /** Holds every 0x13/0x0E from now; `next()` sends what it holds and holds the ones after it. */
  const holdReplies = (): { next: () => void; release: () => void } => {
    let release = fake.withhold(0x13, 0x0e);
    return {
      next: () => {
        const held = release;
        release = fake.withhold(0x13, 0x0e);
        held();
      },
      release: () => release(),
    };
  };

  afterEach(() => {
    privacyWrittenAlone();
  });

  describe('setPrivacyMode', () => {
    it('updates the privacy item alone, with TLV 0x00CA changed and an unknown TLV kept byte for byte', async () => {
      await ready([...base(), privacy(7, 1, [UNKNOWN])]);
      await client.setPrivacyMode('block-all');
      expect(wire()).toEqual(['update 4']);
      expect(toHex(encodeFeedbagItems(written(UPDATE)))).toBe(hex(privacy(7, 2, [UNKNOWN])));
      expect(hex(storedAt(0, 7))).toBe(hex(privacy(7, 2, [UNKNOWN])));
      expect(client.buddyList().privacy.mode).toBe('block-all');
    });

    it('inserts a privacy item when there is none: group 0, a new id, no name', async () => {
      await ready(base());
      await client.setPrivacyMode('allow-buddies');
      expect(wire()).toEqual(['insert 4']);
      // base() uses the item ids 1, 2 and 4, and the preference item 9.
      expect(written(INSERT)).toEqual([item(4, '', 0, 3, [tlv.u8(MODE, 5)])]);
      expect(modeStored()).toEqual([5]);
    });

    it('writes nothing for the mode already set', async () => {
      await ready([...base(), privacy(7, 1)]);
      await client.setPrivacyMode('allow-all');
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });

    it('keeps both lists: only the mode is written', async () => {
      await ready([...base(), permit(5, 'amy'), deny(6, 'zed'), privacy(7, 4)]);
      await client.setPrivacyMode('allow-list');
      expect(wire()).toEqual(['update 4']);
      expect(client.buddyList().privacy).toEqual({ mode: 'allow-list', allow: ['amy'], block: ['zed'] });
    });
  });

  describe('the Allow and Block lists', () => {
    it.each<[string, (c: OscarClient) => Promise<unknown>, string, string[]]>([
      ['allow', (c) => c.allow('Dave'), 'insert 2', ['amy', 'dave']],
      ['addBlocked', (c) => c.addBlocked('Dave'), 'insert 3', ['zed', 'dave']],
      ['disallow', (c) => c.disallow('A My'), 'delete 2', []],
      ['removeBlocked', (c) => c.removeBlocked('ZED'), 'delete 3', []],
    ])('%s writes one SNAC of a permit or deny item and leaves the privacy item alone', async (op, act, sent, after) => {
      await ready([...base(), permit(5, 'amy'), deny(6, 'zed'), privacy(7, 1, [UNKNOWN])]);
      await act(client);
      expect(wire()).toEqual([sent]);
      expect(hex(storedAt(0, 7))).toBe(hex(privacy(7, 1, [UNKNOWN])));
      const privacyNow = client.buddyList().privacy;
      expect(op === 'allow' || op === 'disallow' ? privacyNow.allow : privacyNow.block).toEqual(after);
      expect(privacyNow.mode).toBe('allow-all');
    });

    it('an insert names the screen name normalised, under group 0 and a new id', async () => {
      await ready(base());
      await client.allow('Da Ve');
      expect(written(INSERT)).toEqual([item(2, 'dave', 0, 3)]);
    });

    it('disallow deletes every permit item of that name in one SNAC, and writes nothing for a name with none', async () => {
      await ready([...base(), permit(5, 'amy'), permit(6, 'A my'), permit(7, 'zed')]);
      await client.disallow('amy');
      expect(wire()).toEqual(['delete 2,2']);
      expect(written(DELETE).map((i) => i.itemId)).toEqual([5, 6]);
      await client.disallow('nobody');
      await client.removeBlocked('nobody');
      await settle(fake.port);
      expect(wire()).toEqual(['delete 2,2']);
    });

    it('the two lists are independent: a name on one can be put on the other', async () => {
      await ready([...base(), deny(5, 'carol'), permit(6, 'bob')]);
      await client.allow('carol');
      await client.addBlocked('bob');
      expect(wire()).toEqual(['insert 2', 'insert 3']);
      expect(client.buddyList().privacy).toEqual({ mode: 'allow-all', allow: ['bob', 'carol'], block: ['carol', 'bob'] });
    });

    const refusals: [string, () => FeedbagItem[], (c: OscarClient) => Promise<unknown>, LocalRefusal][] = [
      ['allow of C', base, (c) => c.allow('C'), 'invalid-screen-name'],
      ['addBlocked of C', base, (c) => c.addBlocked('C'), 'invalid-screen-name'],
      ['allow of the own screen name', base, (c) => c.allow('A Lice'), 'own-screen-name'],
      ['addBlocked of the own screen name', base, (c) => c.addBlocked('ALICE'), 'own-screen-name'],
      ['allow of a name allowed', () => [...base(), permit(5, 'bob')], (c) => c.allow('B o b'), 'already-listed'],
      ['addBlocked of a name blocked', () => [...base(), deny(5, 'bob')], (c) => c.addBlocked('B o b'), 'already-listed'],
      ['a 101st permit item', () => [...base(), ...many(100, (n) => permit(100 + n, `pal${n}`))], (c) => c.allow('dave'), 'allow-limit'],
      ['a 101st deny item', () => [...base(), ...many(100, (n) => deny(100 + n, `foe${n}`))], (c) => c.addBlocked('dave'), 'block-limit'],
    ];
    it.each(refusals)('refuses before sending: %s', async (_case, seed, act, code) => {
      await ready(seed());
      const before = client.buddyList();
      expect(await refusalOf(act(client))).toEqual({ kind: 'local', code });
      await settle(fake.port);
      expect(wire()).toEqual([]);
      expect(client.buddyList()).toEqual(before);
    });

    it('counts deny items, duplicates included, as the Block list limit does: 99 names in 100 items are full', async () => {
      await ready([...base(), ...many(99, (n) => deny(100 + n, `foe${n}`)), deny(300, 'F O E1')]);
      expect(client.buddyList().privacy.block).toHaveLength(99);
      expect(client.denyItems()).toBe(100);
      expect(await refusalOf(client.addBlocked('dave'))).toEqual({ kind: 'local', code: 'block-limit' });
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });

    it('adds a name the server sent as it was sent, an ICQ number included: one deny insert; typed, the number is refused', async () => {
      await ready(base());
      expect(await refusalOf(client.addBlocked('123456789'))).toEqual({ kind: 'local', code: 'invalid-screen-name' });
      await settle(fake.port);
      expect(wire()).toEqual([]);
      await client.addBlocked('123456789', { fromServer: true });
      expect(wire()).toEqual(['insert 3']);
      expect(client.buddyList().privacy.block).toEqual(['123456789']);
    });

    it.each<[string, () => FeedbagItem[], string, LocalRefusal]>([
      ['an empty name', base, '   ', 'invalid-screen-name'],
      ['the own screen name', base, 'A Lice', 'own-screen-name'],
      ['a name blocked', () => [...base(), deny(5, '123456789')], '123456789', 'already-listed'],
      ['a 101st deny item', () => [...base(), ...many(100, (n) => deny(100 + n, `foe${n}`))], '123456789', 'block-limit'],
    ])('a name the server sent is still refused for %s', async (_case, seed, name, code) => {
      await ready(seed());
      expect(await refusalOf(client.addBlocked(name, { fromServer: true }))).toEqual({ kind: 'local', code });
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });
  });

  describe('Block under each mode', () => {
    it('mode 1: the deny insert alone, then, after its reply, the privacy update alone', async () => {
      await ready([...base(), privacy(7, 1)]);
      const replies = holdReplies();
      const blocking = client.block('bob');
      await waitFor(() => wire().length === 1, 'the deny insert');
      await settle(fake.port);
      expect(wire()).toEqual(['insert 3']);
      replies.release();
      expect(await blocking).toEqual({ alsoBlocked: 0 });
      expect(wire()).toEqual(['insert 3', 'update 4']);
      expect(modeStored()).toEqual([4]);
    });

    it('no privacy item: the deny insert, then a privacy insert', async () => {
      await ready(base());
      await client.block('bob');
      expect(wire()).toEqual(['insert 3', 'insert 4']);
    });

    it.each([0, 6])('an unknown mode (%i) is "Allow everyone": the deny insert, then the mode alone with its other TLVs kept', async (mode) => {
      await ready([...base(), privacy(7, mode, [UNKNOWN])]);
      expect(client.buddyList().privacy.mode).toBe('unknown');
      await client.block('bob');
      expect(wire()).toEqual(['insert 3', 'update 4']);
      expect(hex(storedAt(0, 7))).toBe(hex(privacy(7, 4, [UNKNOWN])));
    });

    it('mode 1 with a deny item for the name already: the privacy update alone', async () => {
      await ready([...base(), deny(5, 'Bob'), privacy(7, 1)]);
      await client.block('bob');
      expect(wire()).toEqual(['update 4']);
    });

    it('mode 1 with a full Block list: block-limit, nothing written', async () => {
      await ready([...base(), ...many(100, (n) => deny(100 + n, `foe${n}`)), privacy(7, 1)]);
      expect(await refusalOf(client.block('bob'))).toEqual({ kind: 'local', code: 'block-limit' });
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });

    it('mode 4: the deny insert only', async () => {
      await ready([...base(), privacy(7, 4)]);
      await client.block('bob');
      expect(wire()).toEqual(['insert 3']);
    });

    it('mode 3 of a name allowed: the permit delete and the deny insert in one cluster', async () => {
      await ready([...base(), permit(5, 'bob'), privacy(7, 3)]);
      expect(await client.block('Bob')).toEqual({ alsoBlocked: 0 });
      expect(wire()).toEqual(['start', 'delete 2', 'insert 3', 'end']);
      expect(client.buddyList().privacy).toEqual({ mode: 'allow-list', allow: [], block: ['bob'] });
    });

    it('mode 3 with a full Block list: the permit delete alone, never refused for the Block list', async () => {
      await ready([...base(), permit(5, 'bob'), ...many(100, (n) => deny(100 + n, `foe${n}`)), privacy(7, 3)]);
      await client.block('bob');
      expect(wire()).toEqual(['delete 2']);
    });

    it('mode 5, Block of a buddy: needs-conversion without convert, and nothing written', async () => {
      await ready([...base(), privacy(7, 5)]);
      expect(await refusalOf(client.block('bob'))).toEqual({ kind: 'local', code: 'needs-conversion' });
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });

    it('mode 5, Block of a buddy, converted: permits for the other settled buddies and the delete of his, then, after every reply, the mode alone', async () => {
      await ready([...base(), pendingBuddy(3, 'pat'), permit(5, 'bob'), permit(6, 'erin'), privacy(7, 5)]);
      const replies = holdReplies();
      const blocking = client.block('bob', { convert: true });
      await waitFor(() => wire().includes('end'), 'the cluster');
      await settle(fake.port);
      expect(wire()).toEqual(['start', 'insert 2', 'delete 2', 'end']);
      // carol only: erin is allowed already, and pat waits for authorisation, so the server does not count him.
      expect(written(INSERT).map((i) => i.name)).toEqual(['carol']);
      replies.release();
      await blocking;
      expect(wire()).toEqual(['start', 'insert 2', 'delete 2', 'end', 'update 4']);
      expect(client.buddyList().privacy).toEqual({ mode: 'allow-list', allow: ['erin', 'carol'], block: [] });
    });

    it('mode 5, converted, with no permit item of his: the inserts alone, then the mode', async () => {
      await ready([...base(), privacy(7, 5)]);
      await client.block('bob', { convert: true });
      expect(wire()).toEqual(['insert 2,2', 'update 4']);
      expect(written(INSERT).map((i) => i.name)).toEqual(['carol', 'erin']);
    });

    it('mode 5 with a conversion the Allow list cannot hold: allow-limit, before needs-conversion, nothing written', async () => {
      await ready([...base(), ...many(99, (n) => permit(100 + n, `pal${n}`)), privacy(7, 5)]);
      expect(await refusalOf(client.block('bob'))).toEqual({ kind: 'local', code: 'allow-limit' });
      expect(await refusalOf(client.block('bob', { convert: true }))).toEqual({ kind: 'local', code: 'allow-limit' });
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });

    it.each<[string, FeedbagItem[], string]>([
      ['mode 2, anyone', [privacy(7, 2)], 'bob'],
      ['mode 5, a non-buddy', [privacy(7, 5)], 'zed'],
      ['mode 3, a name not allowed', [privacy(7, 3)], 'bob'],
      ['mode 4, a name on the Block list', [deny(5, 'bob'), privacy(7, 4)], 'bob'],
    ])('Block of a name already blocked writes nothing: %s', async (_case, more, name) => {
      await ready([...base(), ...more]);
      expect(await client.block(name)).toEqual({ alsoBlocked: 0 });
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });

    it.each<[string, FeedbagItem[], number]>([
      ['mode 1', [privacy(7, 1)], 3],
      ['no privacy item', [], 3],
      ['mode 4', [privacy(7, 4)], 0],
    ])('alsoBlocked counts the other names on the Block list that the first Block blocks too: %s', async (_case, more, count) => {
      await ready([...base(), deny(20, 'x'), deny(21, 'y'), deny(22, 'Z'), deny(23, 'z'), deny(24, 'alice'), ...more]);
      expect(await client.block('bob')).toEqual({ alsoBlocked: count });
    });
  });

  describe('Unblock under each mode', () => {
    it.each<[string, FeedbagItem[]]>([
      ['mode 1', [privacy(7, 1)]],
      ['mode 0', [privacy(7, 0)]],
    ])('%s: nothing is written, even with a deny item for the name', async (_case, more) => {
      await ready([...base(), deny(5, 'bob'), ...more]);
      await client.unblock('bob');
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });

    it('mode 4: the deny delete', async () => {
      await ready([...base(), deny(5, 'bob'), privacy(7, 4)]);
      await client.unblock('bob');
      expect(wire()).toEqual(['delete 3']);
    });

    it('mode 3: the permit insert and the delete of his deny item in one cluster, or the permit insert alone', async () => {
      await ready([...base(), deny(5, 'bob'), privacy(7, 3)]);
      await client.unblock('bob');
      expect(wire()).toEqual(['start', 'insert 2', 'delete 3', 'end']);
      await client.unblock('carol');
      expect(wire()).toEqual(['start', 'insert 2', 'delete 3', 'end', 'insert 2']);
      expect(client.buddyList().privacy).toEqual({ mode: 'allow-list', allow: ['bob', 'carol'], block: [] });
    });

    it('mode 3 with a full Allow list: allow-limit, nothing written', async () => {
      await ready([...base(), ...many(100, (n) => permit(100 + n, `pal${n}`)), privacy(7, 3)]);
      expect(await refusalOf(client.unblock('bob'))).toEqual({ kind: 'local', code: 'allow-limit' });
      await settle(fake.port);
      expect(wire()).toEqual([]);
    });

    it('mode 2: needs-conversion; converted, the permit insert and his deny delete, then the mode alone', async () => {
      await ready([...base(), deny(5, 'bob'), privacy(7, 2)]);
      expect(await refusalOf(client.unblock('bob'))).toEqual({ kind: 'local', code: 'needs-conversion' });
      await client.unblock('bob', { convert: true });
      expect(wire()).toEqual(['start', 'insert 2', 'delete 3', 'end', 'update 4']);
      expect(client.buddyList().privacy).toEqual({ mode: 'allow-list', allow: ['bob'], block: [] });
    });

    it('mode 5, Unblock of a stranger, converted: permits for every settled buddy not allowed and the stranger in one SNAC, then the mode', async () => {
      await ready([...base(), pendingBuddy(3, 'pat'), permit(5, 'carol'), privacy(7, 5)]);
      expect(await refusalOf(client.unblock('zed'))).toEqual({ kind: 'local', code: 'needs-conversion' });
      await client.unblock('zed', { convert: true });
      expect(wire()).toEqual(['insert 2,2,2', 'update 4']);
      expect(written(INSERT).map((i) => i.name)).toEqual(['bob', 'erin', 'zed']);
      expect(client.buddyList().privacy).toEqual({ mode: 'allow-list', allow: ['carol', 'bob', 'erin', 'zed'], block: [] });
    });
  });

  describe('the trailing write', () => {
    it('a mode chosen while a Block waits for its trailing write is written after it, each alone, the last choice kept', async () => {
      await ready([...base(), privacy(7, 1)]);
      const replies = holdReplies();
      const blocking = client.block('bob');
      await waitFor(() => wire().length === 1, 'the deny insert');
      replies.next();
      await waitFor(() => wire().length === 2, 'the trailing write');
      const choosing = client.setPrivacyMode('block-all');
      await settle(fake.port);
      expect(wire()).toEqual(['insert 3', 'update 4']);
      replies.release();
      await Promise.all([blocking, choosing]);
      expect(wire()).toEqual(['insert 3', 'update 4', 'update 4']);
      expect([privacyMode(written(UPDATE, 0)[0]), privacyMode(written(UPDATE, 1)[0])]).toEqual([4, 2]);
      expect(modeStored()).toEqual([2]);
      expect(client.buddyList().privacy).toEqual({ mode: 'block-all', allow: [], block: ['bob'] });
    });

    it('a refused trailing write queries the list again and fails reloaded', async () => {
      await ready([...base(), privacy(7, 1)]);
      const lists = h.lists.length;
      const replies = holdReplies();
      const failed = writeErrorOf(client.block('bob'));
      await waitFor(() => wire().length === 1, 'the deny insert');
      // The server has handled the deny insert; the next write it handles is the trailing one.
      fake.failNextStatus(0x000a);
      replies.release();
      const error = await failed;
      expect([error.info, error.reloaded]).toEqual([{ kind: 'refused', code: 10 }, true]);
      expect(wire()).toEqual(['insert 3', 'update 4', 'query']);
      expect(client.buddyList()).toEqual(fresh());
      expect(client.buddyList().privacy).toEqual({ mode: 'allow-all', allow: [], block: ['bob'] });
      expect(h.lists.length).toBeGreaterThan(lists);
    });

    it('a refused first part sends no trailing write', async () => {
      await ready([...base(), privacy(7, 1)]);
      fake.failNext(0x13, 0x08, { code: 0x000a });
      const error = await writeErrorOf(client.block('bob'));
      expect([error.info, error.reloaded]).toEqual([{ kind: 'refused', code: 10 }, false]);
      await settle(fake.port);
      expect(wire()).toEqual(['insert 3']);
      expect(modeStored()).toEqual([1]);
    });

    it('another operation waits for the trailing reply: nothing of it falls between the two parts', async () => {
      await ready([...base(), privacy(7, 1)]);
      const replies = holdReplies();
      const blocking = client.block('bob');
      const aliasing = client.setAlias({ groupId: 1, itemId: 2 }, 'C');
      await waitFor(() => wire().length === 1, 'the deny insert');
      replies.next();
      await waitFor(() => wire().length === 2, 'the trailing write');
      await settle(fake.port);
      expect(wire()).toEqual(['insert 3', 'update 4']);
      replies.release();
      await Promise.all([blocking, aliasing]);
      expect(wire()).toEqual(['insert 3', 'update 4', 'update 0']);
    });
  });
});

describe('icons from people not on the list', () => {
  const prefs = (): FeedbagItem[] => stored().filter((i) => i.classId === 5);
  const accepts = (): (boolean | null)[] => prefs().map((pref) => buddyPref(pref, BUDDY_PREF_ACCEPT_NON_LIST_BART));

  it('the list is null until the pref is written, then the write reaches the server and the next buddyList event', async () => {
    await ready(base());
    expect(client.buddyList().acceptNonListIcons).toBeNull();
    const lists = h.lists.length;
    await client.setAcceptNonListIcons(true);
    expect(writes()).toEqual([UPDATE]);
    expect(accepts()).toEqual([true]);
    expect(typingPref(prefs()[0] as FeedbagItem)).toBe('enabled');
    await waitFor(() => h.lists.length > lists, 'the list after the write');
    expect(h.lists.at(-1)?.acceptNonListIcons).toBe(true);
    await client.setAcceptNonListIcons(false);
    expect(accepts()).toEqual([false]);
    expect(client.buddyList().acceptNonListIcons).toBe(false);
  });

  it('the same choice twice writes once', async () => {
    await ready(base());
    await client.setAcceptNonListIcons(true);
    await client.setAcceptNonListIcons(true);
    expect(writes()).toEqual([UPDATE]);
  });

  it('a refused write keeps the list as it was and rejects', async () => {
    await ready(base());
    fake.failNext(0x13, UPDATE, { code: 1 });
    expect(((await errorOf(client.setAcceptNonListIcons(true))) as OscarError).info).toEqual({ kind: 'refused', code: 1 });
    expect(client.buddyList().acceptNonListIcons).toBeNull();
  });
});

describe('the typing preference', () => {
  const prefs = (): FeedbagItem[] => stored().filter((i) => i.classId === 5);

  it('inserts an empty typing preference item when the account has none', async () => {
    fake.setFeedbag('Alice', base());
    const release = fake.withhold(0x13, 0x0e);
    expect(await h.signOn()).toBe('online');
    await waitFor(() => prefs().length === 1, 'the preference item');
    await settle(fake.port);
    expect(h.states.at(-1)).toEqual({ state: 'online' });
    expect(h.lists).toHaveLength(1);
    release();
    await waitFor(() => h.lists.length === 2, 'the list after the confirmation');
    expect(writes()).toEqual([INSERT]);
    // base() uses the item ids 1, 2 and 4.
    expect(prefs()).toEqual([item(5, '', 0, 3, [])]);
    expect(h.lists[1]).toEqual(h.lists[0]);
  });

  it.each([
    ['enabled', PREF_ENABLED],
    ['unset', PREF_EMPTY],
  ])('leaves the typing preference alone when it is enabled or unset (%s)', async (_case, pref) => {
    fake.setFeedbag('Alice', [...base(), pref]);
    await h.signOn();
    await settle(fake.port);
    expect(writes()).toEqual([]);
    expect(prefs()).toEqual([pref]);
  });

  it("enables typing when it was disabled and keeps the item's other bits", async () => {
    fake.setFeedbag('Alice', [...base(), PREF_DISABLED]);
    await h.signOn();
    await waitFor(() => h.lists.length === 2, 'the list after the confirmation');
    expect(writes()).toEqual([UPDATE]);
    expect(prefs().map(hex)).toEqual([hex(PREF_ENABLED)]);
  });

  it('a failed typing preference write is logged and the session stays online', async () => {
    fake.setFeedbag('Alice', base());
    fake.failNext(0x13, 0x08, { code: 1 });
    await h.signOn();
    const line = () => h.logs.lines.find((l) => l.msg === 'could not write the typing preference');
    await waitFor(() => line() !== undefined, 'the log line');
    expect([line()?.level, line()?.fields]).toEqual(['warn', { kind: 'refused', code: 1 }]);
    await settle(fake.port);
    expect(client.state).toBe('online');
    expect(prefs()).toEqual([]);
    expect(queries()).toBe(1);   // the one of the sign-on sequence: a refused single write is not queried again
    await client.setAlias({ groupId: 1, itemId: 1 }, 'B');
    expect(client.buddyList().groups[0]?.buddies[0]?.alias).toBe('B');
  });
});
