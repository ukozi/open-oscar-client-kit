import { describe, expect, it } from 'vitest';
import { BosLink } from '../../../src/client/bos-link.js';
import type { OscarError } from '../../../src/client/errors.js';
import { Feedbag, buildBuddyList, feedbagLimits } from '../../../src/client/feedbag.js';
import { ByteReader, fromHex, toHex } from '../../../src/wire/bytes.js';
import {
  FEEDBAG_ATTR_PD_MODE,
  FEEDBAG_ATTR_PREFS,
  FEEDBAG_ATTR_PREFS_VALID,
  FEEDBAG_CLASS_BUDDY_PREFS,
  FEEDBAG_CLASS_PDINFO,
  FEEDBAG_INSERT,
  FEEDBAG_UPDATE,
  PD_MODE_DENY_SOME,
  decodeFeedbagReply,
  encodeFeedbagItems,
  readFeedbagItem,
} from '../../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../../src/wire/feedbag.js';
import { captureLog, ManualTimers } from '../../fake/oscar-client.js';
import { StubConn } from '../../fake/stub-conn.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const v = loadVectors('hand-session.json');
const order = (ids: number[]) => ({ tag: 0x00c8, value: Uint8Array.from(ids.flatMap((id) => [id >> 8, id & 0xff])) });
const root = (ids?: number[]): FeedbagItem => ({ name: '', groupId: 0, itemId: 0, classId: 1, attrs: ids ? [order(ids)] : [] });
const group = (id: number, name: string, ids?: number[]): FeedbagItem => ({ name, groupId: id, itemId: 0, classId: 1, attrs: ids ? [order(ids)] : [] });
const buddy = (groupId: number, itemId: number, name: string): FeedbagItem => ({ name, groupId, itemId, classId: 0, attrs: [] });
const prefsItem = (value: string, valid: string): FeedbagItem => ({
  name: '', groupId: 0, itemId: 9, classId: FEEDBAG_CLASS_BUDDY_PREFS,
  attrs: [{ tag: FEEDBAG_ATTR_PREFS, value: fromHex(value) }, { tag: FEEDBAG_ATTR_PREFS_VALID, value: fromHex(valid) }],
});
const shape = (items: FeedbagItem[]) => buildBuddyList(items).groups.map((g) => [g.name, g.buddies.map((b) => b.screenName)]);

describe('buildBuddyList', () => {
  it('orders groups by the root list and buddies by their group list', () => {
    const { items } = decodeFeedbagReply(bytesOf(v, 'feedbag reply body, six items'));
    expect(buildBuddyList(items)).toEqual({
      groups: [
        { id: 2, name: 'Work', buddies: [] },
        { id: 1, name: 'Buddies', buddies: [{ itemId: 11, screenName: 'alice', alias: null, pending: false }, { itemId: 10, screenName: 'chimrdev2', alias: 'Dev Two', pending: false }] },
      ],
      privacy: { mode: 'allow-all', allow: [], block: [] },
      acceptNonListIcons: null,
    });
  });

  const rows: [string, FeedbagItem[], unknown][] = [
    ['an empty feedbag', [], []],
    ['no root group: ascending group id', [group(3, 'C'), group(1, 'A'), group(2, 'B')], [['A', []], ['B', []], ['C', []]]],
    ['a root with no order list', [root(), group(2, 'B'), group(1, 'A')], [['A', []], ['B', []]]],
    ['groups missing from the root list come after it, ascending', [root([3]), group(4, 'D'), group(1, 'A'), group(3, 'C')], [['C', []], ['A', []], ['D', []]]],
    ['a root list naming missing and repeated ids', [root([9, 2, 2, 1, 2]), group(1, 'A'), group(2, 'B')], [['B', []], ['A', []]]],
    ['buddies missing from the group list come after it, ascending', [group(1, 'A', [7]), buddy(1, 9, 'i'), buddy(1, 7, 'g'), buddy(1, 3, 'c')], [['A', ['g', 'c', 'i']]]],
    ['a group list naming missing, repeated and foreign ids', [group(1, 'A', [5, 99, 5, 4, 8]), group(2, 'B'), buddy(1, 4, 'd'), buddy(1, 5, 'e'), buddy(2, 8, 'h')], [['A', ['e', 'd']], ['B', ['h']]]],
    ['the same screen name in two groups is shown in both', [group(1, 'A'), group(2, 'B'), buddy(1, 1, 'bob'), buddy(2, 2, 'bob')], [['A', ['bob']], ['B', ['bob']]]],
    ['a buddy whose group item is gone is shown in a stray group after the others', [group(1, 'A'), buddy(1, 1, 'kept'), buddy(7, 2, 'orphan')], [['A', ['kept']], ['', ['orphan']]]],
    ['a buddy filed under group 0 is shown in a stray group', [root(), group(1, 'A'), buddy(0, 3, 'loose')], [['A', []], ['', ['loose']]]],
    ['other item classes are not part of the view', [group(1, 'A'), { name: 'blocked', groupId: 0, itemId: 4, classId: 3, attrs: [] }, { name: '', groupId: 0, itemId: 5, classId: 4, attrs: [] }], [['A', []]]],
  ];
  it.each(rows)('%s', (_name, items, want) => {
    expect(shape(items)).toEqual(want);
  });
});

describe('buddies whose group item is gone', () => {
  it('are kept in one stray group per group id, ascending, after the shown groups, each with its buddies by item id', () => {
    expect(buildBuddyList([root([1]), group(1, 'A', [1]), buddy(1, 1, 'kept'), buddy(9, 8, 'zed'), buddy(9, 3, 'yan'), buddy(4, 5, 'xia')])).toEqual({
      groups: [
        { id: 1, name: 'A', buddies: [{ itemId: 1, screenName: 'kept', alias: null, pending: false }] },
        { id: 4, name: '', stray: true, buddies: [{ itemId: 5, screenName: 'xia', alias: null, pending: false }] },
        { id: 9, name: '', stray: true, buddies: [{ itemId: 3, screenName: 'yan', alias: null, pending: false }, { itemId: 8, screenName: 'zed', alias: null, pending: false }] },
      ],
      privacy: { mode: 'allow-all', allow: [], block: [] },
      acceptNonListIcons: null,
    });
  });
});

describe('the icon item in the list', () => {
  it('an icon item is no buddy, no group and blocks nobody', () => {
    const handIcons = loadVectors('hand-icons.json');
    const icons = [
      'feedbag item, icon item 9 with a real icon',
      'feedbag item, icon item 9 cleared',
      'feedbag item, icon item 9 with another attribute before the icon',
    ].map((name) => readFeedbagItem(new ByteReader(bytesOf(handIcons, name))));
    // "Block the people below" is the mode in which a deny item can block somebody.
    const denySome: FeedbagItem = { name: '', groupId: 0, itemId: 3, classId: FEEDBAG_CLASS_PDINFO, attrs: [{ tag: FEEDBAG_ATTR_PD_MODE, value: Uint8Array.of(PD_MODE_DENY_SOME) }] };
    expect(icons.map((item) => [item.classId, item.name])).toEqual([[0x14, '1'], [0x14, '1'], [0x14, '1']]);
    expect(buildBuddyList([icons[0], group(1, 'A'), icons[1], buddy(1, 4, 'bob'), denySome, icons[2]].flatMap((item) => (item ? [item] : [])))).toEqual({
      groups: [{ id: 1, name: 'A', buddies: [{ itemId: 4, screenName: 'bob', alias: null, pending: false }] }],
      privacy: { mode: 'block-list', allow: [], block: [] },
      acceptNonListIcons: null,
    });
  });
});

describe('acceptNonListIcons in the list', () => {
  const rows: [string, FeedbagItem[], boolean | null][] = [
    ['no class-5 item', [group(1, 'A')], null],
    ['a prefs item with no masks', [{ ...prefsItem('', ''), attrs: [] }], null],
    ['set but not marked valid', [prefsItem('00001000', '00000000')], null],
    ['valid and set', [prefsItem('00001000', '00001000')], true],
    ['valid and clear', [prefsItem('00000000', '00001000')], false],
  ];
  it.each(rows)('%s', (_name, items, want) => {
    expect(buildBuddyList(items).acceptNonListIcons).toBe(want);
  });
});

describe('feedbagLimits', () => {
  it('falls back to the documented values for anything the server did not send', () => {
    expect(feedbagLimits({ maxByClass: [] })).toEqual({ buddies: 61, groups: 61, permits: 100, denies: 100, buddiesPerGroup: 200, itemNameBytes: 200 });
    expect(feedbagLimits({ maxByClass: [10, 20, 30, 40], maxItemNameLength: 50, maxBuddiesPerGroup: 60 })).toEqual({ buddies: 10, groups: 20, permits: 30, denies: 40, buddiesPerGroup: 60, itemNameBytes: 50 });
  });
});

function make() {
  const timers = new ManualTimers();
  const conn = new StubConn(timers);
  const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captureLog().log });
  const answer = (subtype: number, replySubtype: number, body: Uint8Array) => {
    const sent = conn.sent.find((s) => s.family === 0x13 && s.subtype === subtype);
    conn.deliver({ family: 0x13, subtype: replySubtype, body, requestId: sent?.requestId ?? -1 });
  };
  return { timers, conn, link, answer, feedbag: new Feedbag() };
}

describe('Feedbag.load', () => {
  it('asks for rights, then the list, and keeps unknown items byte for byte', async () => {
    const { timers, conn, link, answer, feedbag } = make();
    const body = bytesOf(v, 'feedbag reply body, six items');
    const loaded = feedbag.load(link);
    await timers.advance(0);
    // The recorded rights equal the fallbacks, so this reply allows 62 buddies: one TLV 0x0004 holding 0x003e.
    answer(0x02, 0x03, Uint8Array.of(0x00, 0x04, 0x00, 0x02, 0x00, 0x3e));
    await timers.advance(0);
    answer(0x04, 0x06, body);
    await loaded;
    expect(conn.sent.map((s) => [s.family, s.subtype])).toEqual([[0x13, 0x02], [0x13, 0x04]]);
    expect(toHex(encodeFeedbagItems(feedbag.items))).toBe(toHex(body.subarray(3, body.length - 4)));
    expect(feedbag.limits.buddies).toBe(62);
    expect(feedbag.buddyList().groups.map((g) => g.name)).toEqual(['Work', 'Buddies']);
  });

  it('sends feedbag use with an empty body', async () => {
    const { timers, conn, link, feedbag } = make();
    await feedbag.use(link);
    await timers.advance(0);
    expect(conn.sent.map((s) => [s.family, s.subtype, s.body.length])).toEqual([[0x13, 0x07, 0]]);
  });

  it('fails when the list does not arrive in 20 s, and when the server answers with an error', async () => {
    const a = make();
    let error: unknown;
    a.feedbag.load(a.link).catch((e: unknown) => (error = e));
    await a.timers.advance(20_000);
    expect((error as OscarError).info).toEqual({ kind: 'timeout', rateLimited: false });
    const b = make();
    b.feedbag.load(b.link).catch((e: unknown) => (error = e));
    await b.timers.advance(0);
    b.answer(0x02, 0x01, Uint8Array.of(0x00, 0x0d));
    await b.timers.advance(0);
    expect((error as OscarError).info).toEqual({ kind: 'refused', code: 0x0d });
  });

  it("is not failed by a relayed SNAC of another family's kind that carries the request id", async () => {
    const { timers, conn, link, answer, feedbag } = make();
    let done = false;
    let error: unknown;
    feedbag.load(link).then(() => (done = true), (e: unknown) => (error = e));
    await timers.advance(0);
    // A peer's typing event, relayed with the request id the peer chose.
    conn.deliver({ family: 0x04, subtype: 0x14, requestId: conn.sent[0]?.requestId ?? -1 });
    conn.deliver({ family: 0x04, subtype: 0x03, requestId: conn.sent[0]?.requestId ?? -1 });
    await timers.advance(0);
    expect([done, error, conn.sent.length]).toEqual([false, undefined, 1]);
    answer(0x02, 0x03, bytesOf(v, 'feedbag rights reply body'));
    await timers.advance(0);
    conn.deliver({ family: 0x04, subtype: 0x0b, requestId: conn.sent[1]?.requestId ?? -1 });
    await timers.advance(0);
    expect([done, error]).toEqual([false, undefined]);
    answer(0x04, 0x06, bytesOf(v, 'feedbag reply body, six items'));
    await timers.advance(0);
    expect([done, error, feedbag.items.length]).toEqual([true, undefined, 6]);
  });

  it('applies a change pushed right behind the list reply, and not one pushed before it', async () => {
    const { timers, link, conn, answer, feedbag } = make();
    link.onSnac((snac) => {
      feedbag.handle(snac);
    });
    const push = (name: string, itemId: number) =>
      conn.deliver({ family: 0x13, subtype: 0x08, requestId: 0x80000000, body: encodeFeedbagItems([buddy(1, itemId, name)]) });
    const loaded = feedbag.load(link);
    await timers.advance(0);
    answer(0x02, 0x03, bytesOf(v, 'feedbag rights reply body'));
    await timers.advance(0);
    // The server made this change before it answered the query, so the reply holds it if it still stands.
    push('before', 40);
    // Both in one turn, as when one read of the socket holds the reply and the push.
    answer(0x04, 0x06, bytesOf(v, 'feedbag reply body, six items'));
    push('Be Hind', 41);
    await loaded;
    expect(feedbag.items.map((i) => i.name).slice(6)).toEqual(['behind']);
    expect(feedbag.items).toHaveLength(7);
  });

  it('forgets the list on reset', async () => {
    const { timers, link, answer, feedbag } = make();
    const fallbacks = feedbagLimits({ maxByClass: [] });
    const loaded = feedbag.load(link);
    await timers.advance(0);
    answer(0x02, 0x03, Uint8Array.of(0x00, 0x04, 0x00, 0x02, 0x00, 0x0a));
    await timers.advance(0);
    answer(0x04, 0x06, bytesOf(v, 'feedbag reply body, six items'));
    await loaded;
    expect(feedbag.items).toHaveLength(6);
    expect(feedbag.limits).toEqual({ ...fallbacks, buddies: 10 });
    feedbag.reset();
    expect([feedbag.items, feedbag.buddyList(), feedbag.limits]).toEqual([[], { groups: [], privacy: { mode: 'allow-all', allow: [], block: [] }, acceptNonListIcons: null }, fallbacks]);
  });
});

describe('Feedbag.reload', () => {
  it('queries again after the writes queued before it, replaces the list and reports the change', async () => {
    const { timers, conn, link, answer } = make();
    let changes = 0;
    const feedbag = new Feedbag({ changed: () => changes++ });
    const loaded = feedbag.load(link);
    await timers.advance(0);
    answer(0x02, 0x03, bytesOf(v, 'feedbag rights reply body'));
    await timers.advance(0);
    answer(0x04, 0x06, bytesOf(v, 'feedbag reply body, six items'));
    await loaded;
    const written = feedbag.writeItems(link, FEEDBAG_INSERT, [buddy(1, 40, 'carol')]);
    const reloaded = feedbag.reload(link);
    await timers.advance(0);
    const sent = () => conn.sent.slice(2).map((s) => [s.family, s.subtype]);
    expect(sent()).toEqual([[0x13, 0x08]]);
    answer(0x08, 0x0e, Uint8Array.of(0, 0));
    await written;
    await timers.advance(0);
    expect([sent(), feedbag.items.length, changes]).toEqual([[[0x13, 0x08], [0x13, 0x04]], 7, 1]);
    const encoded = encodeFeedbagItems([buddy(1, 41, 'dave')]);
    const body = new Uint8Array(3 + encoded.length + 4);
    body.set([0, 0, 1]);
    body.set(encoded, 3);
    conn.deliver({ family: 0x13, subtype: 0x06, body, requestId: conn.sent.at(-1)?.requestId ?? -1 });
    await reloaded;
    expect([feedbag.items.map((i) => i.name), changes]).toEqual([['dave'], 2]);
  });
});

describe('a privacy item with no item id free', () => {
  // A list whose every item id is taken. It holds a deny item for bob, then items of a class the client does not read, and no privacy item.
  async function full() {
    const h = make();
    const items: FeedbagItem[] = [{ name: 'bob', groupId: 0, itemId: 1, classId: 3, attrs: [] }];
    for (let id = 2; id <= 0x7fff; id++) items.push({ name: '', groupId: 0, itemId: id, classId: 0x1d, attrs: [] });
    const encoded = encodeFeedbagItems(items);
    const body = new Uint8Array(3 + encoded.length + 4);
    body.set([0, items.length >> 8, items.length & 0xff]);
    body.set(encoded, 3);
    const loaded = h.feedbag.load(h.link);
    await h.timers.advance(0);
    h.answer(0x02, 0x03, new Uint8Array(0));
    await h.timers.advance(0);
    h.answer(0x04, 0x06, body);
    await loaded;
    return h;
  }

  it("refuses Block under Allow everyone with the Block list's own code, block-limit, and writes nothing", async () => {
    const { conn, feedbag, link } = await full();
    const sent = conn.sent.length;
    const error = await feedbag.block(link, 'Bob', 'Alice').then(() => null, (e: unknown) => e);
    expect((error as OscarError).info).toEqual({ kind: 'local', code: 'block-limit' });
    expect(conn.sent).toHaveLength(sent);
  });

  it('refuses a mode switch as any setting item with no id free is refused', async () => {
    const { conn, feedbag, link } = await full();
    const sent = conn.sent.length;
    const error = await feedbag.setPrivacyMode(link, 'block-all').then(() => null, (e: unknown) => e);
    expect((error as OscarError).info).toEqual({ kind: 'local', code: 'buddy-limit' });
    expect(conn.sent).toHaveLength(sent);
  });
});

describe('the client never writes 0x013D or 0x013E', () => {
  // AlertPrefs and BudalertSound (wire/snacs.go:1804-1805 at 7af2464).
  const ALERT_TAGS = [0x013d, 0x013e];
  const WRITES = [0x08, 0x09, 0x0a];

  async function loadedWith(items: FeedbagItem[]) {
    const h = make();
    const encoded = encodeFeedbagItems(items);
    const body = new Uint8Array(3 + encoded.length + 4);
    body.set([0, items.length >> 8, items.length & 0xff]);
    body.set(encoded, 3);
    const loading = h.feedbag.load(h.link);
    await h.timers.advance(0);
    h.answer(0x02, 0x03, new Uint8Array(0));
    await h.timers.advance(0);
    h.answer(0x04, 0x06, body);
    await loading;
    return h;
  }

  const itemsOf = (body: Uint8Array): FeedbagItem[] => {
    const r = new ByteReader(body);
    const items: FeedbagItem[] = [];
    while (r.remaining > 0) items.push(readFeedbagItem(r));
    return items;
  };

  async function written(h: Awaited<ReturnType<typeof loadedWith>>, op: () => unknown): Promise<FeedbagItem[]> {
    const from = h.conn.sent.length;
    const answered = new Set<number>();
    const done = Promise.resolve(op());
    for (let turn = 0; turn < 10; turn++) {
      await h.timers.advance(0);
      for (const sent of h.conn.sent.slice(from)) {
        if (sent.family !== 0x13 || !WRITES.includes(sent.subtype) || answered.has(sent.requestId)) continue;
        answered.add(sent.requestId);
        h.conn.deliver({ family: 0x13, subtype: 0x0e, requestId: sent.requestId, body: new Uint8Array(itemsOf(sent.body).length * 2) });
      }
    }
    await done;
    return h.conn.sent.slice(from).filter((sent) => sent.family === 0x13 && WRITES.includes(sent.subtype)).flatMap((sent) => itemsOf(sent.body));
  }

  const carriesAlertTag = (item: FeedbagItem): boolean => item.attrs.some((attr) => ALERT_TAGS.includes(attr.tag));

  it('no planner adds either tag to a list without them', async () => {
    const h = await loadedWith([root([1, 2]), group(1, 'Buddies', [11, 12]), group(2, 'Work', [13]), buddy(1, 11, 'bob'), buddy(1, 12, 'carol'), buddy(2, 13, 'dan')]);
    const { feedbag, link } = h;
    const all: FeedbagItem[][] = [];
    all.push(await written(h, () => feedbag.addBuddy(link, { screenName: 'Erin', groupId: 1, alias: null })));
    all.push(await written(h, () => feedbag.removeBuddy(link, { groupId: 2, itemId: 13 })));
    all.push(await written(h, () => feedbag.moveBuddy(link, { groupId: 1, itemId: 12 }, 2)));
    all.push(await written(h, () => feedbag.setAlias(link, { groupId: 1, itemId: 11 }, 'Bobby')));
    let added = 0;
    all.push(await written(h, async () => {
      added = await feedbag.addGroup(link, 'Family');
    }));
    all.push(await written(h, () => feedbag.renameGroup(link, added, 'Kin')));
    all.push(await written(h, () => feedbag.deleteGroup(link, added)));
    all.push(await written(h, () => feedbag.block(link, 'Frank', 'Alice')));
    all.push(await written(h, () => feedbag.unblock(link, 'Frank')));
    all.push(await written(h, () => feedbag.ensureTypingPref(link)));
    all.push(await written(h, () => feedbag.setAcceptNonListIcons(link, true)));
    all.push(await written(h, () => feedbag.setIcon(link, { flags: 1, hash: new Uint8Array(16).fill(7) })));
    expect(all.map((items) => items.length > 0)).toEqual(all.map(() => true));
    expect(all.flat().filter(carriesAlertTag)).toEqual([]);
  });

  it("keeps one another client stored on a buddy item byte for byte when the client moves or aliases that buddy", async () => {
    const stored = { tag: 0x013d, value: Uint8Array.of(1, 2, 3) };
    const bob: FeedbagItem = { ...buddy(1, 11, 'bob'), attrs: [stored] };
    const h = await loadedWith([root([1, 2]), group(1, 'Buddies', [11]), group(2, 'Work', []), bob]);
    const aliased = await written(h, () => h.feedbag.setAlias(h.link, { groupId: 1, itemId: 11 }, 'Bobby'));
    const moved = await written(h, () => h.feedbag.moveBuddy(h.link, { groupId: 1, itemId: 11 }, 2));
    const bobs = [...aliased, ...moved].filter((item) => item.classId === 0 && item.name === 'bob');
    expect(bobs).toHaveLength(3);
    for (const item of bobs) expect(item.attrs.find((attr) => attr.tag === 0x013d)?.value).toEqual(Uint8Array.of(1, 2, 3));
    expect(bobs.flatMap((item) => item.attrs.filter((attr) => attr.tag === 0x013e))).toEqual([]);
  });

  describe('setAcceptNonListIcons', () => {
    const masks = (item: FeedbagItem | undefined): (string | undefined)[] => [FEEDBAG_ATTR_PREFS, FEEDBAG_ATTR_PREFS_VALID].map((tag) => {
      const value = item?.attrs.find((attr) => attr.tag === tag)?.value;
      return value && toHex(value);
    });
    const subtypes = (h: Awaited<ReturnType<typeof loadedWith>>): number[] => h.conn.sent.filter((sent) => sent.family === 0x13 && WRITES.includes(sent.subtype)).map((sent) => sent.subtype);

    it('with no prefs item, inserts one class-5 item with the bit and its valid bit', async () => {
      const h = await loadedWith([root([1]), group(1, 'A')]);
      const items = await written(h, () => h.feedbag.setAcceptNonListIcons(h.link, true));
      expect(subtypes(h)).toEqual([FEEDBAG_INSERT]);
      expect(items.map((item) => item.classId)).toEqual([FEEDBAG_CLASS_BUDDY_PREFS]);
      expect(masks(items[0])).toEqual(['00001000', '00001000']);
    });

    it('with no prefs item, off still marks the pref valid', async () => {
      const h = await loadedWith([root([1]), group(1, 'A')]);
      const items = await written(h, () => h.feedbag.setAcceptNonListIcons(h.link, false));
      expect(subtypes(h)).toEqual([FEEDBAG_INSERT]);
      expect(masks(items[0])).toEqual(['00000000', '00001000']);
    });

    it('with a prefs item, sends one update of that item and keeps its other bits', async () => {
      const h = await loadedWith([root([1]), group(1, 'A'), prefsItem('00400000', '00400000')]);
      const items = await written(h, () => h.feedbag.setAcceptNonListIcons(h.link, true));
      expect(subtypes(h)).toEqual([FEEDBAG_UPDATE]);
      expect(items.map((item) => item.itemId)).toEqual([9]);
      expect(masks(items[0])).toEqual(['00401000', '00401000']);
    });

    it('a pref not marked valid is written even when its bit already matches', async () => {
      const h = await loadedWith([root([1]), group(1, 'A'), prefsItem('00000000', '00000000')]);
      const items = await written(h, () => h.feedbag.setAcceptNonListIcons(h.link, false));
      expect(subtypes(h)).toEqual([FEEDBAG_UPDATE]);
      expect(masks(items[0])).toEqual(['00000000', '00001000']);
    });

    const same: [string, string, boolean][] = [['true', '00001000', true], ['false', '00000000', false]];
    it.each(same)('writes nothing when the item already reads %s', async (_name, value, on) => {
      const h = await loadedWith([root([1]), group(1, 'A'), prefsItem(value, '00001000')]);
      expect(await written(h, () => h.feedbag.setAcceptNonListIcons(h.link, on))).toEqual([]);
      expect(subtypes(h)).toEqual([]);
    });
  });
});
