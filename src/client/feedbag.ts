import { decodeBartInfo, encodeBartInfo, isClearHash } from '../wire/bart.js';
import { ByteReader } from '../wire/bytes.js';
import { REQUEST_TIMEOUT_MS } from '../wire/constants.js';
import {
  BART_ICON_ITEM_NAME,
  BUDDY_PREF_ACCEPT_NON_LIST_BART,
  FAMILY_FEEDBAG,
  FEEDBAG_ATTR_ALIAS,
  FEEDBAG_ATTR_BART_INFO,
  FEEDBAG_ATTR_ORDER,
  FEEDBAG_ATTR_PD_MODE,
  FEEDBAG_ATTR_PENDING,
  FEEDBAG_CLASS_BART,
  FEEDBAG_CLASS_BUDDY,
  FEEDBAG_CLASS_BUDDY_PREFS,
  FEEDBAG_CLASS_DENY,
  FEEDBAG_CLASS_GROUP,
  FEEDBAG_CLASS_PDINFO,
  FEEDBAG_CLASS_PERMIT,
  FEEDBAG_DELETE,
  FEEDBAG_END_CLUSTER,
  FEEDBAG_ERR,
  FEEDBAG_INSERT,
  FEEDBAG_QUERY,
  FEEDBAG_REPLY,
  FEEDBAG_RIGHTS_QUERY,
  FEEDBAG_RIGHTS_REPLY,
  FEEDBAG_START_CLUSTER,
  FEEDBAG_STATUS,
  FEEDBAG_UPDATE,
  FEEDBAG_USE,
  buddyPref,
  decodeFeedbagError,
  decodeFeedbagReply,
  decodeFeedbagRights,
  decodeFeedbagStatus,
  encodeFeedbagItems,
  feedbagAlias,
  feedbagOrder,
  orderAttr,
  privacyMode,
  readFeedbagItem,
  typingPref,
  withAttr,
  withBuddyPref,
  withTypingEnabled,
} from '../wire/feedbag.js';
import type { FeedbagItem, FeedbagRights } from '../wire/feedbag.js';
import type { Snac } from '../wire/snac.js';
import { tlv } from '../wire/tlv.js';
import type { Logger } from '../wire/types.js';
import type { BuddyGroup, BuddyList, BuddyRef } from '../model/buddy-list.js';
import { modeOf, privacyChange, settledBuddies, wireOf } from '../model/privacy.js';
import type { Privacy, PrivacyMode } from '../model/privacy.js';
import { isValidScreenName, normalizeScreenName, utf8ByteLength } from '../model/screen-name.js';
import type { CommandError, LocalRefusal, SessionLimits } from '../model/session.js';
import type { BosLink } from './bos-link.js';
import { ListWriteError, OscarError } from './errors.js';

export const LIST_WRITE_TIMEOUT_MS = 10_000;

export type FeedbagLimits = Pick<
  SessionLimits,
  'buddies' | 'groups' | 'permits' | 'denies' | 'buddiesPerGroup' | 'itemNameBytes'
>;

function inOrder<T>(order: readonly number[], entries: readonly T[], idOf: (entry: T) => number): T[] {
  const out = new Set<T>();
  for (const id of order) {
    const named = entries.find((entry) => idOf(entry) === id);
    if (named !== undefined) out.add(named);
  }
  for (const entry of [...entries].sort((a, b) => idOf(a) - idOf(b))) out.add(entry);
  return [...out];
}

const isRoot = (item: FeedbagItem): boolean => item.classId === FEEDBAG_CLASS_GROUP && item.groupId === 0 && item.itemId === 0;

function rootOf(items: readonly FeedbagItem[]): FeedbagItem | undefined {
  return items.find(isRoot);
}

function shownGroups(items: readonly FeedbagItem[]): FeedbagItem[] {
  const groups = new Map<number, FeedbagItem>();
  for (const item of items) {
    if (item.classId === FEEDBAG_CLASS_GROUP && item.groupId !== 0 && !groups.has(item.groupId)) groups.set(item.groupId, item);
  }
  const root = rootOf(items);
  return inOrder(root ? feedbagOrder(root) : [], [...groups.values()], (group) => group.groupId);
}

function shownBuddies(items: readonly FeedbagItem[], group: FeedbagItem): FeedbagItem[] {
  const buddies = items.filter((item) => item.classId === FEEDBAG_CLASS_BUDDY && item.groupId === group.groupId);
  return inOrder(feedbagOrder(group), buddies, (buddy) => buddy.itemId);
}

function strayBuddies(items: readonly FeedbagItem[]): Map<number, FeedbagItem[]> {
  const shown = new Set(shownGroups(items).map((group) => group.groupId));
  const stray = new Map<number, FeedbagItem[]>();
  const buddies = items.filter((item) => item.classId === FEEDBAG_CLASS_BUDDY && !shown.has(item.groupId));
  for (const buddy of [...buddies].sort((a, b) => a.groupId - b.groupId || a.itemId - b.itemId)) {
    stray.set(buddy.groupId, [...(stray.get(buddy.groupId) ?? []), buddy]);
  }
  return stray;
}

const pdInfoOf = (items: readonly FeedbagItem[]): FeedbagItem | undefined => items.find((item) => item.classId === FEEDBAG_CLASS_PDINFO);
const buddyPrefsOf = (items: readonly FeedbagItem[]): FeedbagItem | undefined => items.find((item) => item.classId === FEEDBAG_CLASS_BUDDY_PREFS);

const namesOf = (items: readonly FeedbagItem[], classId: number): string[] =>
  [...new Set(items.filter((item) => item.classId === classId).map((item) => normalizeScreenName(item.name)))];

/** Other clients write this list too, so an order list can name ids that are gone, or one id twice. */
export function buildBuddyList(items: readonly FeedbagItem[]): BuddyList {
  const entry = (buddy: FeedbagItem) => ({
    itemId: buddy.itemId, screenName: buddy.name, alias: feedbagAlias(buddy), pending: buddy.attrs.some((attr) => attr.tag === FEEDBAG_ATTR_PENDING),
  });
  const prefs = buddyPrefsOf(items);
  return {
    groups: [
      ...shownGroups(items).map((group): BuddyGroup => ({ id: group.groupId, name: group.name, buddies: shownBuddies(items, group).map(entry) })),
      ...[...strayBuddies(items)].map(([id, buddies]): BuddyGroup => ({ id, name: '', buddies: buddies.map(entry), stray: true })),
    ],
    privacy: { mode: modeOf(privacyMode(pdInfoOf(items))), allow: namesOf(items, FEEDBAG_CLASS_PERMIT), block: namesOf(items, FEEDBAG_CLASS_DENY) },
    acceptNonListIcons: prefs ? buddyPref(prefs, BUDDY_PREF_ACCEPT_NON_LIST_BART) : null,
  };
}

export function feedbagLimits(rights: FeedbagRights): FeedbagLimits {
  return {
    buddies: rights.maxByClass[FEEDBAG_CLASS_BUDDY] ?? 61,
    groups: rights.maxByClass[FEEDBAG_CLASS_GROUP] ?? 61,
    permits: rights.maxByClass[FEEDBAG_CLASS_PERMIT] ?? 100,
    denies: rights.maxByClass[FEEDBAG_CLASS_DENY] ?? 100,
    buddiesPerGroup: rights.maxBuddiesPerGroup ?? 200,
    itemNameBytes: rights.maxItemNameLength ?? 200,
  };
}

async function ask(link: BosLink, subtype: number, replySubtype: number): Promise<Uint8Array> {
  // Subtype 1 is the error SNAC in every family; its body starts with the code.
  const reply = await link.requestMatching(
    FAMILY_FEEDBAG,
    subtype,
    undefined,
    REQUEST_TIMEOUT_MS,
    (snac) => snac.family === FAMILY_FEEDBAG && (snac.subtype === replySubtype || snac.subtype === FEEDBAG_ERR),
  );
  if (reply.subtype === replySubtype) return reply.body;
  throw new OscarError({ kind: 'refused', code: decodeFeedbagError(reply.body) });
}

type Write = { subtype: number; items: FeedbagItem[] };
type Plan<T> = { writes: Write[]; after?: Write; result: T };
type Planner<T> = (items: readonly FeedbagItem[], limits: FeedbagLimits) => Plan<T>;
type Job = { run: () => Promise<void>; reject: (error: Error) => void };

export type FeedbagDeps = { log: Logger; changed: () => void };

const MAX_ID = 0x7fff;
// The server stores the name of these items normalised (state/user_store.go:1032-1038).
const NAMED_CLASSES = [FEEDBAG_CLASS_BUDDY, FEEDBAG_CLASS_PERMIT, FEEDBAG_CLASS_DENY];
const WRITE_SUBTYPES = [FEEDBAG_INSERT, FEEDBAG_UPDATE, FEEDBAG_DELETE];

function refuse(code: LocalRefusal): never {
  throw new OscarError({ kind: 'local', code });
}

// As the server keeps it: an insert or update replaces the item with that (group id, item id) or goes last.
function applyWrite(items: readonly FeedbagItem[], write: Write): FeedbagItem[] {
  const out = [...items];
  for (const item of write.items) {
    const at = out.findIndex((stored) => stored.groupId === item.groupId && stored.itemId === item.itemId);
    if (write.subtype === FEEDBAG_DELETE) {
      if (at >= 0) out.splice(at, 1);
      continue;
    }
    const stored = NAMED_CLASSES.includes(item.classId) ? { ...item, name: normalizeScreenName(item.name) } : item;
    if (at >= 0) out[at] = stored;
    else out.push(stored);
  }
  return out;
}

function takeId(used: Set<number>, full: LocalRefusal): number {
  for (let id = 1; id <= MAX_ID; id++) {
    if (used.has(id)) continue;
    used.add(id);
    return id;
  }
  return refuse(full);
}

const itemIds = (items: readonly FeedbagItem[]): Set<number> => new Set(items.map((item) => item.itemId));
const withOrder = (item: FeedbagItem, ids: readonly number[]): FeedbagItem => withAttr(item, FEEDBAG_ATTR_ORDER, orderAttr(ids).value);
const buddyIds = (items: readonly FeedbagItem[], group: FeedbagItem): number[] => shownBuddies(items, group).map((buddy) => buddy.itemId);

function groupOf(items: readonly FeedbagItem[], groupId: number): FeedbagItem {
  return shownGroups(items).find((group) => group.groupId === groupId) ?? refuse('unknown-item');
}

function buddyOf(items: readonly FeedbagItem[], ref: BuddyRef): FeedbagItem {
  const found = items.find((item) => item.classId === FEEDBAG_CLASS_BUDDY && item.groupId === ref.groupId && item.itemId === ref.itemId);
  return found ?? refuse('unknown-item');
}

function groupName(items: readonly FeedbagItem[], limits: FeedbagLimits, name: string, renamed?: FeedbagItem): string {
  const trimmed = name.trim();
  if (trimmed === '' || utf8ByteLength(trimmed) > limits.itemNameBytes) refuse('invalid-group-name');
  if (shownGroups(items).some((group) => group !== renamed && group.name === trimmed)) refuse('duplicate-group');
  return trimmed;
}

function planAddBuddy(input: { screenName: string; groupId: number; alias: string | null }): Planner<void> {
  return (items, limits) => {
    const group = groupOf(items, input.groupId);
    if (!isValidScreenName(input.screenName)) refuse('invalid-screen-name');
    const buddies = items.filter((item) => item.classId === FEEDBAG_CLASS_BUDDY);
    const ident = normalizeScreenName(input.screenName);
    if (buddies.some((buddy) => normalizeScreenName(buddy.name) === ident)) refuse('duplicate-buddy');
    if (buddies.length >= limits.buddies) refuse('buddy-limit');
    const members = buddyIds(items, group);
    if (members.length >= limits.buddiesPerGroup) refuse('group-full');
    const itemId = takeId(itemIds(items), 'buddy-limit');
    const attrs = input.alias === null || input.alias === '' ? [] : [tlv.str(FEEDBAG_ATTR_ALIAS, input.alias)];
    const buddy: FeedbagItem = { name: input.screenName, groupId: group.groupId, itemId, classId: FEEDBAG_CLASS_BUDDY, attrs };
    return {
      writes: [
        { subtype: FEEDBAG_INSERT, items: [buddy] },
        { subtype: FEEDBAG_UPDATE, items: [withOrder(group, [...members, itemId])] },
      ],
      result: undefined,
    };
  };
}

function planRemoveBuddy(ref: BuddyRef): Planner<void> {
  return (items) => {
    const buddy = buddyOf(items, ref);
    const writes: Write[] = [{ subtype: FEEDBAG_DELETE, items: [buddy] }];
    const group = shownGroups(items).find((g) => g.groupId === ref.groupId);
    if (group) writes.push({ subtype: FEEDBAG_UPDATE, items: [withOrder(group, buddyIds(items, group).filter((id) => id !== buddy.itemId))] });
    return { writes, result: undefined };
  };
}

function planMoveBuddy(ref: BuddyRef, toGroupId: number): Planner<void> {
  return (items, limits) => {
    const buddy = buddyOf(items, ref);
    const from = shownGroups(items).find((g) => g.groupId === ref.groupId);
    if (toGroupId === ref.groupId) refuse('unknown-item');
    const to = groupOf(items, toGroupId);
    const members = buddyIds(items, to);
    if (members.length >= limits.buddiesPerGroup) refuse('group-full');
    // Other clients number buddies per group, so the new group can already hold this item id: then a new id.
    const taken = items.some((item) => item.groupId === to.groupId && item.itemId === buddy.itemId);
    const itemId = taken ? takeId(itemIds(items), 'buddy-limit') : buddy.itemId;
    return {
      writes: [
        { subtype: FEEDBAG_DELETE, items: [buddy] },
        { subtype: FEEDBAG_INSERT, items: [{ ...buddy, groupId: to.groupId, itemId }] },
        {
          subtype: FEEDBAG_UPDATE,
          items: [...(from ? [withOrder(from, buddyIds(items, from).filter((id) => id !== buddy.itemId))] : []), withOrder(to, [...members, itemId])],
        },
      ],
      result: undefined,
    };
  };
}

function planSetAlias(ref: BuddyRef, alias: string | null): Planner<void> {
  return (items) => {
    const value = alias === null || alias === '' ? null : tlv.str(FEEDBAG_ATTR_ALIAS, alias).value;
    return { writes: [{ subtype: FEEDBAG_UPDATE, items: [withAttr(buddyOf(items, ref), FEEDBAG_ATTR_ALIAS, value)] }], result: undefined };
  };
}

function planAddGroup(name: string): Planner<number> {
  return (items, limits) => {
    const trimmed = groupName(items, limits, name);
    const shown = shownGroups(items);
    if (shown.length >= limits.groups) refuse('group-limit');
    const groupId = takeId(new Set(items.map((item) => item.groupId)), 'group-limit');
    const group: FeedbagItem = { name: trimmed, groupId, itemId: 0, classId: FEEDBAG_CLASS_GROUP, attrs: [orderAttr([])] };
    const order = [...shown.map((g) => g.groupId), groupId];
    const root = rootOf(items);
    const writes: Write[] = root
      ? [
          { subtype: FEEDBAG_INSERT, items: [group] },
          { subtype: FEEDBAG_UPDATE, items: [withOrder(root, order)] },
        ]
      : [
          { subtype: FEEDBAG_INSERT, items: [{ name: '', groupId: 0, itemId: 0, classId: FEEDBAG_CLASS_GROUP, attrs: [orderAttr(order)] }] },
          { subtype: FEEDBAG_INSERT, items: [group] },
        ];
    return { writes, result: groupId };
  };
}

function planRenameGroup(groupId: number, name: string): Planner<void> {
  return (items, limits) => {
    const group = groupOf(items, groupId);
    return { writes: [{ subtype: FEEDBAG_UPDATE, items: [{ ...group, name: groupName(items, limits, name, group) }] }], result: undefined };
  };
}

function planDeleteGroup(groupId: number): Planner<void> {
  return (items) => {
    const group = groupOf(items, groupId);
    const buddies = items.filter((item) => item.classId === FEEDBAG_CLASS_BUDDY && item.groupId === groupId);
    const writes: Write[] = [];
    if (buddies.length > 0) writes.push({ subtype: FEEDBAG_DELETE, items: buddies });
    writes.push({ subtype: FEEDBAG_DELETE, items: [group] });
    const root = rootOf(items);
    const order = shownGroups(items).map((g) => g.groupId).filter((id) => id !== groupId);
    if (root) writes.push({ subtype: FEEDBAG_UPDATE, items: [withOrder(root, order)] });
    return { writes, result: undefined };
  };
}

function privacyIn(items: readonly FeedbagItem[]): { privacy: Privacy; buddies: ReadonlySet<string> } {
  const list = buildBuddyList(items);
  return { privacy: list.privacy, buddies: settledBuddies(list.groups) };
}

const named = (items: readonly FeedbagItem[], classId: number, ident: string): FeedbagItem[] =>
  items.filter((item) => item.classId === classId && normalizeScreenName(item.name) === ident);

const listItem = (classId: number, ident: string, itemId: number): FeedbagItem => ({ name: ident, groupId: 0, itemId, classId, attrs: [] });

function modeWrite(items: readonly FeedbagItem[], used: Set<number>, mode: Exclude<PrivacyMode, 'unknown'>, full: LocalRefusal): Write {
  const value = Uint8Array.of(wireOf(mode));
  const pd = pdInfoOf(items);
  if (pd) return { subtype: FEEDBAG_UPDATE, items: [withAttr(pd, FEEDBAG_ATTR_PD_MODE, value)] };
  const itemId = takeId(used, full);
  return { subtype: FEEDBAG_INSERT, items: [{ name: '', groupId: 0, itemId, classId: FEEDBAG_CLASS_PDINFO, attrs: [{ tag: FEEDBAG_ATTR_PD_MODE, value }] }] };
}

const nonEmpty = (...writes: Write[]): Write[] => writes.filter((write) => write.items.length > 0);

function planSetMode(mode: Exclude<PrivacyMode, 'unknown'>): Planner<void> {
  return (items) => {
    if (modeOf(privacyMode(pdInfoOf(items))) === mode) return { writes: [], result: undefined };
    return { writes: [modeWrite(items, itemIds(items), mode, 'buddy-limit')], result: undefined };
  };
}

function planListAdd(classId: number, screenName: string, self: string, full: LocalRefusal, fromServer = false): Planner<void> {
  return (items, limits) => {
    if (fromServer ? normalizeScreenName(screenName) === '' : !isValidScreenName(screenName)) refuse('invalid-screen-name');
    const ident = normalizeScreenName(screenName);
    if (ident === normalizeScreenName(self)) refuse('own-screen-name');
    if (named(items, classId, ident).length > 0) refuse('already-listed');
    const max = classId === FEEDBAG_CLASS_PERMIT ? limits.permits : limits.denies;
    if (items.filter((item) => item.classId === classId).length >= max) refuse(full);
    return { writes: [{ subtype: FEEDBAG_INSERT, items: [listItem(classId, ident, takeId(itemIds(items), full))] }], result: undefined };
  };
}

function planListRemove(classId: number, screenName: string): Planner<void> {
  return (items) => ({ writes: nonEmpty({ subtype: FEEDBAG_DELETE, items: named(items, classId, normalizeScreenName(screenName)) }), result: undefined });
}

/** The items go first and any mode after them, alone, so the server broadcasts the mode to everyone related. */
function planBlock(screenName: string, self: string, convert: boolean): Planner<{ alsoBlocked: number }> {
  return (items, limits) => {
    const ident = normalizeScreenName(screenName);
    if (ident === '') refuse('invalid-screen-name');
    if (ident === normalizeScreenName(self)) refuse('own-screen-name');
    const { privacy, buddies } = privacyIn(items);
    const change = privacyChange(privacy, buddies, ident, 'block', limits.permits);
    if (change.kind === 'none') return { writes: [], result: { alsoBlocked: 0 } };
    if (!change.fits) refuse('allow-limit');
    if (change.kind === 'convert' && !convert) refuse('needs-conversion');
    const used = itemIds(items);
    const denied = named(items, FEEDBAG_CLASS_DENY, ident).length > 0;
    const full = items.filter((item) => item.classId === FEEDBAG_CLASS_DENY).length >= limits.denies;
    const permits = { subtype: FEEDBAG_DELETE, items: named(items, FEEDBAG_CLASS_PERMIT, ident) };
    switch (privacy.mode) {
      case 'allow-all':
      case 'unknown': {
        if (!denied && full) refuse('block-limit');
        const deny = { subtype: FEEDBAG_INSERT, items: denied ? [] : [listItem(FEEDBAG_CLASS_DENY, ident, takeId(used, 'block-limit'))] };
        const others = new Set(privacy.block.filter((name) => name !== ident && name !== normalizeScreenName(self)));
        return { writes: nonEmpty(deny), after: modeWrite(items, used, 'block-list', 'block-limit'), result: { alsoBlocked: others.size } };
      }
      case 'block-list':
        if (full) refuse('block-limit');
        return { writes: [{ subtype: FEEDBAG_INSERT, items: [listItem(FEEDBAG_CLASS_DENY, ident, takeId(used, 'block-limit'))] }], result: { alsoBlocked: 0 } };
      case 'allow-list': {
        const deny = { subtype: FEEDBAG_INSERT, items: denied || full ? [] : [listItem(FEEDBAG_CLASS_DENY, ident, takeId(used, 'block-limit'))] };
        return { writes: nonEmpty(permits, deny), result: { alsoBlocked: 0 } };
      }
      default: {
        const allowed = new Set(privacy.allow);
        const inserts = [...buddies].filter((buddy) => buddy !== ident && !allowed.has(buddy)).map((buddy) => listItem(FEEDBAG_CLASS_PERMIT, buddy, takeId(used, 'allow-limit')));
        return { writes: nonEmpty({ subtype: FEEDBAG_INSERT, items: inserts }, permits), after: modeWrite(items, used, 'allow-list', 'allow-limit'), result: { alsoBlocked: 0 } };
      }
    }
  };
}

function planUnblock(screenName: string, convert: boolean): Planner<void> {
  return (items, limits) => {
    const ident = normalizeScreenName(screenName);
    const { privacy, buddies } = privacyIn(items);
    const change = privacyChange(privacy, buddies, ident, 'unblock', limits.permits);
    if (change.kind === 'none') return { writes: [], result: undefined };
    if (!change.fits) refuse('allow-limit');
    if (change.kind === 'convert' && !convert) refuse('needs-conversion');
    const used = itemIds(items);
    const denies = { subtype: FEEDBAG_DELETE, items: named(items, FEEDBAG_CLASS_DENY, ident) };
    if (privacy.mode === 'block-list') return { writes: nonEmpty(denies), result: undefined };
    const allowed = new Set(privacy.allow);
    const wanted = [...(privacy.mode === 'allow-buddies' ? buddies : []), ident].filter((name) => !allowed.has(name));
    const inserts = [...new Set(wanted)].map((name) => listItem(FEEDBAG_CLASS_PERMIT, name, takeId(used, 'allow-limit')));
    const writes = nonEmpty({ subtype: FEEDBAG_INSERT, items: inserts }, denies);
    return change.kind === 'convert' ? { writes, after: modeWrite(items, used, 'allow-list', 'allow-limit'), result: undefined } : { writes, result: undefined };
  };
}

// The server relays typing events only for an account whose preference item exists and does not switch them off.
const planTypingPref: Planner<void> = (items) => {
  const pref = buddyPrefsOf(items);
  if (!pref) {
    const itemId = takeId(itemIds(items), 'buddy-limit');
    return { writes: [{ subtype: FEEDBAG_INSERT, items: [{ name: '', groupId: 0, itemId, classId: FEEDBAG_CLASS_BUDDY_PREFS, attrs: [] }] }], result: undefined };
  }
  if (typingPref(pref) !== 'disabled') return { writes: [], result: undefined };
  return { writes: [{ subtype: FEEDBAG_UPDATE, items: [withTypingEnabled(pref)] }], result: undefined };
};

function planAcceptNonListIcons(on: boolean): Planner<void> {
  return (items) => {
    const pref = buddyPrefsOf(items);
    if (!pref) {
      const itemId = takeId(itemIds(items), 'buddy-limit');
      const item: FeedbagItem = { name: '', groupId: 0, itemId, classId: FEEDBAG_CLASS_BUDDY_PREFS, attrs: [] };
      return { writes: [{ subtype: FEEDBAG_INSERT, items: [withBuddyPref(item, BUDDY_PREF_ACCEPT_NON_LIST_BART, on)] }], result: undefined };
    }
    if (buddyPref(pref, BUDDY_PREF_ACCEPT_NON_LIST_BART) === on) return { writes: [], result: undefined };
    return { writes: [{ subtype: FEEDBAG_UPDATE, items: [withBuddyPref(pref, BUDDY_PREF_ACCEPT_NON_LIST_BART, on)] }], result: undefined };
  };
}

const isIconItem = (item: FeedbagItem): boolean => item.classId === FEEDBAG_CLASS_BART && item.name === BART_ICON_ITEM_NAME;

// The server sends its notice only after a write, so this updates the icon item whatever it names now.
function planIcon(info: { flags: number; hash: Uint8Array }): Planner<boolean> {
  return (items) => {
    const value = encodeBartInfo(info.flags, info.hash);
    const held = items.find(isIconItem);
    if (held) return { writes: [{ subtype: FEEDBAG_UPDATE, items: [withAttr(held, FEEDBAG_ATTR_BART_INFO, value)] }], result: true };
    if (isClearHash(info.hash)) return { writes: [], result: false };
    const itemId = takeId(itemIds(items), 'buddy-limit');
    const item: FeedbagItem = { name: BART_ICON_ITEM_NAME, groupId: 0, itemId, classId: FEEDBAG_CLASS_BART, attrs: [tlv.bytes(FEEDBAG_ATTR_BART_INFO, value)] };
    return { writes: [{ subtype: FEEDBAG_INSERT, items: [item] }], result: true };
  };
}

const isWriteReply = (snac: Snac): boolean => snac.family === FAMILY_FEEDBAG && (snac.subtype === FEEDBAG_STATUS || snac.subtype === FEEDBAG_ERR);

async function writeOne(link: BosLink, write: Write): Promise<void> {
  const reply = await link.requestMatching(FAMILY_FEEDBAG, write.subtype, encodeFeedbagItems(write.items), LIST_WRITE_TIMEOUT_MS, isWriteReply);
  if (reply.subtype === FEEDBAG_ERR) throw new OscarError({ kind: 'refused', code: decodeFeedbagError(reply.body) });
  const failed = decodeFeedbagStatus(reply.body).find((result) => result !== 0);
  if (failed !== undefined) throw new OscarError({ kind: 'refused', code: failed });
}

const lost = (): ListWriteError => new ListWriteError({ kind: 'connection-lost' }, false);
const quiet = (): void => {};

export class Feedbag {
  private readonly deps: FeedbagDeps;
  private loaded: readonly FeedbagItem[] = [];
  private rights: FeedbagRights = { maxByClass: [] };
  private ready = false;
  private jobs: Job[] = [];
  private cluster: Write[] | null = null;
  private querying = 0;
  private afterReply: Write[] | null = null;

  constructor(deps: Partial<FeedbagDeps> = {}) {
    this.deps = { log: deps.log ?? { debug: quiet, info: quiet, warn: quiet, error: quiet }, changed: deps.changed ?? quiet };
  }

  async load(link: BosLink): Promise<void> {
    this.cluster = null;
    const rights = decodeFeedbagRights(await ask(link, FEEDBAG_RIGHTS_QUERY, FEEDBAG_RIGHTS_REPLY));
    const items = await this.query(link);
    this.rights = rights;
    this.loaded = items;
    this.ready = true;
  }

  /** Reads the items and asks for no rights. This is for a copy of the list that serves one item. */
  async loadItems(link: BosLink): Promise<void> {
    this.cluster = null;
    this.loaded = await this.query(link);
    this.ready = true;
  }

  use(link: BosLink): Promise<void> {
    return link.send(FAMILY_FEEDBAG, FEEDBAG_USE);
  }

  get items(): readonly FeedbagItem[] {
    return this.loaded;
  }

  get limits(): FeedbagLimits {
    return feedbagLimits(this.rights);
  }

  buddyList(): BuddyList {
    return buildBuddyList(this.loaded);
  }

  addBuddy(link: BosLink, input: { screenName: string; groupId: number; alias: string | null }): Promise<void> {
    return this.enqueue(link, planAddBuddy(input));
  }

  removeBuddy(link: BosLink, ref: BuddyRef): Promise<void> {
    return this.enqueue(link, planRemoveBuddy(ref));
  }

  moveBuddy(link: BosLink, ref: BuddyRef, toGroupId: number): Promise<void> {
    return this.enqueue(link, planMoveBuddy(ref, toGroupId));
  }

  setAlias(link: BosLink, ref: BuddyRef, alias: string | null): Promise<void> {
    return this.enqueue(link, planSetAlias(ref, alias));
  }

  addGroup(link: BosLink, name: string): Promise<number> {
    return this.enqueue(link, planAddGroup(name));
  }

  renameGroup(link: BosLink, groupId: number, name: string): Promise<void> {
    return this.enqueue(link, planRenameGroup(groupId, name));
  }

  deleteGroup(link: BosLink, groupId: number): Promise<void> {
    return this.enqueue(link, planDeleteGroup(groupId));
  }

  block(link: BosLink, screenName: string, self: string, options: { convert?: boolean } = {}): Promise<{ alsoBlocked: number }> {
    return this.enqueue(link, planBlock(screenName, self, options.convert === true));
  }

  unblock(link: BosLink, screenName: string, options: { convert?: boolean } = {}): Promise<void> {
    return this.enqueue(link, planUnblock(screenName, options.convert === true));
  }

  setPrivacyMode(link: BosLink, mode: Exclude<PrivacyMode, 'unknown'>): Promise<void> {
    return this.enqueue(link, planSetMode(mode));
  }

  setAcceptNonListIcons(link: BosLink, on: boolean): Promise<void> {
    return this.enqueue(link, planAcceptNonListIcons(on));
  }

  allow(link: BosLink, screenName: string, self: string): Promise<void> {
    return this.enqueue(link, planListAdd(FEEDBAG_CLASS_PERMIT, screenName, self, 'allow-limit'));
  }

  disallow(link: BosLink, screenName: string): Promise<void> {
    return this.enqueue(link, planListRemove(FEEDBAG_CLASS_PERMIT, screenName));
  }

  addBlocked(link: BosLink, screenName: string, self: string, fromServer = false): Promise<void> {
    return this.enqueue(link, planListAdd(FEEDBAG_CLASS_DENY, screenName, self, 'block-limit', fromServer));
  }

  removeBlocked(link: BosLink, screenName: string): Promise<void> {
    return this.enqueue(link, planListRemove(FEEDBAG_CLASS_DENY, screenName));
  }

  get denyItems(): number {
    return this.loaded.filter((item) => item.classId === FEEDBAG_CLASS_DENY).length;
  }

  ensureTypingPref(link: BosLink): void {
    this.enqueue(link, planTypingPref).catch((error: unknown) => {
      const info: CommandError | { kind: string } = error instanceof OscarError ? error.info : { kind: 'unexpected' };
      this.deps.log.warn('could not write the typing preference', 'code' in info ? { kind: info.kind, code: info.code } : { kind: info.kind });
    });
  }

  setIcon(link: BosLink, info: { flags: number; hash: Uint8Array }): Promise<boolean> {
    return this.enqueue(link, planIcon(info));
  }

  iconInfo(): { flags: number; hash: Uint8Array } | null {
    const value = this.loaded.find(isIconItem)?.attrs.find((attr) => attr.tag === FEEDBAG_ATTR_BART_INFO)?.value;
    return value ? decodeBartInfo(value) : null;
  }

  writeItems(
    link: BosLink,
    subtype: typeof FEEDBAG_INSERT | typeof FEEDBAG_UPDATE | typeof FEEDBAG_DELETE,
    items: readonly FeedbagItem[],
  ): Promise<void> {
    return this.enqueue(link, () => ({ writes: [{ subtype, items: [...items] }], result: undefined }));
  }

  /** Queries the list again once the jobs before it finish, and replaces it. */
  reload(link: BosLink): Promise<void> {
    return this.schedule(async (current) => {
      const items = await this.query(link);
      if (!current()) return;
      this.loaded = items;
      this.deps.changed();
    });
  }

  /** Another session's change: the server answers this session's own writes with 0x13/0x0E and 0x13/0x01, never a write or cluster mark. */
  handle(snac: Snac): boolean {
    if (snac.family !== FAMILY_FEEDBAG) return false;
    if (snac.subtype === FEEDBAG_REPLY) {
      if (this.querying > 0) this.afterReply = [];
      return false;
    }
    if (snac.subtype === FEEDBAG_START_CLUSTER) {
      this.cluster = [];
      return true;
    }
    if (snac.subtype === FEEDBAG_END_CLUSTER) {
      const collected = this.cluster ?? [];
      this.cluster = null;
      this.land(collected);
      return true;
    }
    if (!WRITE_SUBTYPES.includes(snac.subtype)) return false;
    const r = new ByteReader(snac.body);
    const items: FeedbagItem[] = [];
    while (r.remaining > 0) items.push(readFeedbagItem(r));
    const write: Write = { subtype: snac.subtype, items };
    if (this.cluster) this.cluster.push(write);
    else this.land([write]);
    return true;
  }

  reset(): void {
    const waiting = this.jobs;
    this.jobs = [];
    this.loaded = [];
    this.rights = { maxByClass: [] };
    this.ready = false;
    this.cluster = null;
    this.afterReply = null;
    for (const job of waiting) job.reject(lost());
  }

  private land(writes: readonly Write[]): void {
    if (writes.length === 0) return;
    if (this.afterReply) {
      this.afterReply.push(...writes);
      return;
    }
    if (!this.ready) return;
    this.loaded = writes.reduce(applyWrite, this.loaded);
    this.deps.changed();
  }

  private async query(link: BosLink): Promise<FeedbagItem[]> {
    this.querying++;
    try {
      const { items } = decodeFeedbagReply(await ask(link, FEEDBAG_QUERY, FEEDBAG_REPLY));
      return (this.afterReply ?? []).reduce(applyWrite, items);
    } finally {
      this.querying--;
      this.afterReply = null;
    }
  }

  private enqueue<T>(link: BosLink, planner: Planner<T>): Promise<T> {
    return this.schedule(async (current) => {
      const plan = planner(this.loaded, this.limits);
      await this.write(link, plan.writes, current);
      if (plan.after !== undefined && current()) await this.write(link, [plan.after], current, plan.writes.length > 0);
      return plan.result;
    });
  }

  // One operation at a time, so no two choose the same id or privacy item; the first starts in the caller's turn.
  private schedule<T>(run: (current: () => boolean) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        reject,
        run: async () => {
          resolve(await run(() => this.jobs[0] === job));
        },
      };
      this.jobs.push(job);
      if (this.jobs.length === 1) void this.pump();
    });
  }

  private async pump(): Promise<void> {
    for (;;) {
      const job = this.jobs[0];
      if (!job) return;
      try {
        await job.run();
      } catch (error) {
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (this.jobs[0] !== job) return;
      this.jobs.shift();
    }
  }

  /** The server keeps one open cluster per session (state/session.go:1291-1297, 1333-1340): a cluster goes to the link in one turn. */
  private async write(link: BosLink, writes: readonly Write[], current: () => boolean, trailing = false): Promise<void> {
    if (writes.length === 0) return;
    const clustered = writes.length > 1;
    if (clustered) link.send(FAMILY_FEEDBAG, FEEDBAG_START_CLUSTER).catch(quiet);
    const replies = writes.map((write) => writeOne(link, write));
    if (clustered) link.send(FAMILY_FEEDBAG, FEEDBAG_END_CLUSTER).catch(quiet);
    const failures: CommandError[] = [];
    for (const outcome of await Promise.allSettled(replies)) {
      if (outcome.status === 'fulfilled') continue;
      if (!(outcome.reason instanceof OscarError)) throw outcome.reason;
      failures.push(outcome.reason.info);
    }
    if (!current()) return;
    const failure = failures.find((info) => info.kind === 'connection-lost') ?? failures[0];
    if (!failure) {
      this.loaded = writes.reduce(applyWrite, this.loaded);
      this.deps.changed();
      return;
    }
    if (failure.kind === 'connection-lost') throw lost();
    // A refused single write changed nothing, unless it trails a first part. Anything else can leave a partial write on the server: ask the server.
    if (!clustered && !trailing && failure.kind === 'refused') throw new ListWriteError(failure, false);
    let reloaded = false;
    try {
      const items = await this.query(link);
      if (!current()) return;
      this.loaded = items;
      reloaded = true;
      this.deps.changed();
    } catch (error) {
      const info: CommandError | { kind: string } = error instanceof OscarError ? error.info : { kind: 'unexpected' };
      this.deps.log.warn('could not reload the buddy list', 'code' in info ? { kind: info.kind, code: info.code } : { kind: info.kind });
    }
    throw new ListWriteError(failure, reloaded);
  }
}

type Held = { link: BosLink; list: Feedbag; loaded: Promise<Feedbag>; users: number };

/**
 * A copy of the server's list for a client that holds no list.
 * The first user reads the list one time. The copy then applies the writes of other sessions.
 * The client lets the copy go when its last user ends.
 */
export class FeedbagCopy {
  private held: Held | null = null;

  constructor(private readonly deps: Pick<FeedbagDeps, 'log'>) {}

  /** `open` reads the list at its first call. Users at the same time on one link share one copy, so their writes go in sequence. */
  async during<T>(link: BosLink, run: (open: () => Promise<Feedbag>) => Promise<T>): Promise<T> {
    let taken: Held | null = null;
    const open = (): Promise<Feedbag> => {
      taken ??= this.take(link);
      return taken.loaded;
    };
    try {
      return await run(open);
    } finally {
      if (taken) this.release(taken);
    }
  }

  handle(snac: Snac): void {
    this.held?.list.handle(snac);
  }

  private take(link: BosLink): Held {
    if (this.held?.link === link) {
      this.held.users++;
      return this.held;
    }
    const list = new Feedbag({ log: this.deps.log });
    const held: Held = { link, list, loaded: list.loadItems(link).then(() => list), users: 1 };
    held.loaded.catch(quiet);
    this.held = held;
    return held;
  }

  private release(held: Held): void {
    held.users--;
    if (held.users === 0 && this.held === held) this.held = null;
  }
}
