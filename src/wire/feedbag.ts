import { ByteReader, ByteWriter } from './bytes.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvU8, tlvU16 } from './tlv.js';
import type { Tlv } from './tlv.js';

export const FAMILY_FEEDBAG = 0x0013;

export const FEEDBAG_ERR = 0x0001;
export const FEEDBAG_RIGHTS_QUERY = 0x0002;
export const FEEDBAG_RIGHTS_REPLY = 0x0003;
export const FEEDBAG_QUERY = 0x0004;
export const FEEDBAG_REPLY = 0x0006;
export const FEEDBAG_USE = 0x0007;
export const FEEDBAG_INSERT = 0x0008;
export const FEEDBAG_UPDATE = 0x0009;
export const FEEDBAG_DELETE = 0x000a;
export const FEEDBAG_STATUS = 0x000e;
export const FEEDBAG_START_CLUSTER = 0x0011;
export const FEEDBAG_END_CLUSTER = 0x0012;

export const FEEDBAG_CLASS_BUDDY = 0x0000;
export const FEEDBAG_CLASS_GROUP = 0x0001;
export const FEEDBAG_CLASS_PERMIT = 0x0002;
export const FEEDBAG_CLASS_DENY = 0x0003;
export const FEEDBAG_CLASS_PDINFO = 0x0004;
export const FEEDBAG_CLASS_BUDDY_PREFS = 0x0005;
export const FEEDBAG_CLASS_BART = 0x0014;

export const FEEDBAG_ATTR_ORDER = 0x00c8;
export const FEEDBAG_ATTR_PREFS = 0x00c9;
export const FEEDBAG_ATTR_PD_MODE = 0x00ca;
export const FEEDBAG_ATTR_BART_INFO = 0x00d5;
export const FEEDBAG_ATTR_PREFS_VALID = 0x00d6;
export const FEEDBAG_ATTR_ALIAS = 0x0131;
// On a buddy item: the buddy has not yet authorised the listing (wire/snacs.go:1760 at 7af2464).
export const FEEDBAG_ATTR_PENDING = 0x0066;

export const BART_ICON_ITEM_NAME = '1';

// TLV 0x00CA of the privacy item (wire/snacs.go:1882-1893 at 7af2464).
export const PD_MODE_PERMIT_ALL = 1;
export const PD_MODE_DENY_ALL = 2;
export const PD_MODE_PERMIT_SOME = 3;
export const PD_MODE_DENY_SOME = 4;
export const PD_MODE_PERMIT_ON_LIST = 5;

// Buddy prefs by number (wire/buddy_prefs.go:58). Prefs 0 to 31 count bytes from the mask's right end (wire/buddy_prefs.go:133-146).
export const BUDDY_PREF_ACCEPT_NON_LIST_BART = 0x0c;
export const BUDDY_PREF_DISCLOSE_TYPING = 0x16;
const BUDDY_PREF_LIMIT = 32;
const BUDDY_PREF_MASK_BYTES = 4;

const FEEDBAG_RIGHTS_TLV_MAX_ITEM_ATTRS = 0x0003;
const FEEDBAG_RIGHTS_TLV_MAX_BY_CLASS = 0x0004;
const FEEDBAG_RIGHTS_TLV_MAX_ITEM_NAME_LENGTH = 0x0006;
const FEEDBAG_RIGHTS_TLV_MAX_BUDDIES_PER_GROUP = 0x000c;

export type FeedbagItem = { name: string; groupId: number; itemId: number; classId: number; attrs: Tlv[] };

export type FeedbagRights = { maxItemAttrs?: number; maxByClass: number[]; maxItemNameLength?: number; maxBuddiesPerGroup?: number };

function u16List(bytes: Uint8Array): number[] {
  const r = new ByteReader(bytes);
  const out: number[] = [];
  while (r.remaining >= 2) out.push(r.u16());
  return out;
}

export function encodeFeedbagItems(items: readonly FeedbagItem[]): Uint8Array {
  const w = new ByteWriter();
  for (const item of items) {
    const attrs = encodeTlvs(item.attrs);
    w.str16(item.name).u16(item.groupId).u16(item.itemId).u16(item.classId).u16(attrs.length).bytes(attrs);
  }
  return w.toBytes();
}

export function readFeedbagItem(r: ByteReader): FeedbagItem {
  const name = r.str16();
  const groupId = r.u16();
  const itemId = r.u16();
  const classId = r.u16();
  return { name, groupId, itemId, classId, attrs: decodeTlvs(r.bytes(r.u16())) };
}

export function decodeFeedbagReply(body: Uint8Array): { version: number; items: FeedbagItem[]; lastUpdate: number } {
  const r = new ByteReader(body);
  const version = r.u8();
  const count = r.u16();
  const items: FeedbagItem[] = [];
  for (let i = 0; i < count; i++) items.push(readFeedbagItem(r));
  return { version, items, lastUpdate: r.u32() };
}

export function decodeFeedbagRights(body: Uint8Array): FeedbagRights {
  const tlvs = decodeTlvs(body);
  const rights: FeedbagRights = { maxByClass: u16List(findTlv(tlvs, FEEDBAG_RIGHTS_TLV_MAX_BY_CLASS) ?? new Uint8Array(0)) };
  const maxItemAttrs = tlvU16(tlvs, FEEDBAG_RIGHTS_TLV_MAX_ITEM_ATTRS);
  if (maxItemAttrs !== undefined) rights.maxItemAttrs = maxItemAttrs;
  const maxItemNameLength = tlvU16(tlvs, FEEDBAG_RIGHTS_TLV_MAX_ITEM_NAME_LENGTH);
  if (maxItemNameLength !== undefined) rights.maxItemNameLength = maxItemNameLength;
  const maxBuddiesPerGroup = tlvU16(tlvs, FEEDBAG_RIGHTS_TLV_MAX_BUDDIES_PER_GROUP);
  if (maxBuddiesPerGroup !== undefined) rights.maxBuddiesPerGroup = maxBuddiesPerGroup;
  return rights;
}

export function decodeFeedbagStatus(body: Uint8Array): number[] {
  return u16List(body);
}

export function feedbagOrder(item: FeedbagItem): number[] {
  return u16List(findTlv(item.attrs, FEEDBAG_ATTR_ORDER) ?? new Uint8Array(0));
}

export function feedbagAlias(item: FeedbagItem): string | null {
  const value = findTlv(item.attrs, FEEDBAG_ATTR_ALIAS);
  return value && value.length > 0 ? Buffer.from(value).toString('utf8') : null;
}

export function orderAttr(ids: readonly number[]): Tlv {
  const w = new ByteWriter();
  for (const id of ids) w.u16(id);
  return tlv.bytes(FEEDBAG_ATTR_ORDER, w.toBytes());
}

export function withAttr(item: FeedbagItem, tag: number, value: Uint8Array | null): FeedbagItem {
  if (value === null) return { ...item, attrs: item.attrs.filter((t) => t.tag !== tag) };
  const at = item.attrs.findIndex((t) => t.tag === tag);
  if (at < 0) return { ...item, attrs: [...item.attrs, { tag, value }] };
  return { ...item, attrs: item.attrs.map((t, i) => (i === at ? { tag, value } : t)) };
}

export function privacyMode(item: FeedbagItem | undefined): number {
  return (item ? tlvU8(item.attrs, FEEDBAG_ATTR_PD_MODE) : undefined) ?? PD_MODE_PERMIT_ALL;
}

function buddyPrefPlace(pref: number, length: number): { index: number; bit: number } {
  if (!Number.isInteger(pref) || pref < 0 || pref >= BUDDY_PREF_LIMIT) throw new RangeError(`buddy pref ${pref} is not in 0 to 31`);
  return { index: length - 1 - Math.floor(pref / 8), bit: 1 << (pref % 8) };
}

// The valid mask's length places the byte in both masks, as readBuddyPref does (wire/buddy_prefs.go:260-280).
function buddyPrefBytes(item: FeedbagItem, pref: number): { index: number; bit: number; valid: Uint8Array; value: Uint8Array } | undefined {
  const valid = findTlv(item.attrs, FEEDBAG_ATTR_PREFS_VALID);
  const value = findTlv(item.attrs, FEEDBAG_ATTR_PREFS);
  const { index, bit } = buddyPrefPlace(pref, valid?.length ?? 0);
  if (!valid || !value) return undefined;
  return index < 0 || index >= value.length ? undefined : { index, bit, valid, value };
}

// null: the valid mask does not mark this pref.
export function buddyPref(item: FeedbagItem, pref: number): boolean | null {
  const found = buddyPrefBytes(item, pref);
  if (!found || ((found.valid[found.index] ?? 0) & found.bit) === 0) return null;
  return ((found.value[found.index] ?? 0) & found.bit) !== 0;
}

// Zero bytes on the left keep each bit at its place from the right end.
function leftPad(mask: Uint8Array | undefined, length: number): Uint8Array {
  const out = new Uint8Array(Math.max(mask?.length ?? 0, length));
  if (mask) out.set(mask, out.length - mask.length);
  return out;
}

export function withBuddyPref(item: FeedbagItem, pref: number, on: boolean): FeedbagItem {
  const valid = leftPad(findTlv(item.attrs, FEEDBAG_ATTR_PREFS_VALID), BUDDY_PREF_MASK_BYTES);
  const value = leftPad(findTlv(item.attrs, FEEDBAG_ATTR_PREFS), valid.length);
  const { index, bit } = buddyPrefPlace(pref, valid.length);
  valid[index] = (valid[index] ?? 0) | bit;
  value[index] = on ? (value[index] ?? 0) | bit : (value[index] ?? 0) & ~bit;
  return withAttr(withAttr(item, FEEDBAG_ATTR_PREFS, value), FEEDBAG_ATTR_PREFS_VALID, valid);
}

// 'unset' is what the server reads as its default, which for this pref is enabled.
export function typingPref(item: FeedbagItem): 'enabled' | 'disabled' | 'unset' {
  const on = buddyPref(item, BUDDY_PREF_DISCLOSE_TYPING);
  if (on === null) return 'unset';
  return on ? 'enabled' : 'disabled';
}

export function withTypingEnabled(item: FeedbagItem): FeedbagItem {
  return buddyPrefBytes(item, BUDDY_PREF_DISCLOSE_TYPING) ? withBuddyPref(item, BUDDY_PREF_DISCLOSE_TYPING, true) : item;
}

export function decodeFeedbagError(body: Uint8Array): number {
  return body.length < 2 ? 0 : new ByteReader(body).u16();
}
