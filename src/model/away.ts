import type { RichText } from './rich-text.js';

export const AWAY_RECORD_CLASS = 0x0c41;
export const AWAY_RECORD_GROUP = 0;
export const AWAY_RECORD_VERSION = 1;
export const AWAY_TAG = { version: 0x7a01, seq: 0x7a02, writer: 0x7a03, state: 0x7a04, text: 0x7a05, source: 0x7a06, paused: 0x7a07, setAt: 0x7a08 } as const;
export const AWAY_ITEM_ID_MIN = 0x4000;
export const AWAY_ITEM_ID_MAX = 0x7fff;

export type AwayAttr = { tag: number; value: Uint8Array };
export type AwayItem = { name: string; groupId: number; itemId: number; classId: number; attrs: readonly AwayAttr[] };
export type AwayRecord = Readonly<{
  seq: number;
  writer: number;
  away: boolean;
  text: string; // plain, '%n', '%d' and '%t' as typed; '' when back
  source: string; // 'phone' | 'desktop' | 'auto', open
  paused: boolean;
  setAt: number | null; // ms, whole seconds; null when back
}>;
export type AwayChange = { away: boolean; text: string; source: string };
export type AwayState = { away: boolean; text: string };
export type AwaySignOnPlan = { locate: AwayState | null; hold: AwayRecord | null; write: 'none' | 'create' | 'held' | 'back' };

const OVERLONG_BELOW = [0, 0, 0x80, 0x800, 0x10000] as const;

function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    let cp = char.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

function utf8Text(bytes: Uint8Array): string | null {
  let text = '';
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i] ?? 0;
    const size = lead < 0x80 ? 1 : lead < 0xc0 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0;
    if (size === 0 || i + size > bytes.length) return null;
    let cp = size === 1 ? lead : lead & (0xff >> (size + 1));
    for (let k = 1; k < size; k++) {
      const next = bytes[i + k] ?? 0;
      if ((next & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (next & 0x3f);
    }
    if (cp < (OVERLONG_BELOW[size] ?? 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    text += String.fromCodePoint(cp);
    i += size;
  }
  return text;
}

function u8(tag: number, value: number): AwayAttr {
  return { tag, value: Uint8Array.of(value) };
}

function u32(tag: number, value: number): AwayAttr {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return { tag, value: bytes };
}

function readU32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

export function encodeAwayAttrs(record: AwayRecord): AwayAttr[] {
  return [
    u8(AWAY_TAG.version, AWAY_RECORD_VERSION),
    u32(AWAY_TAG.seq, record.seq),
    u32(AWAY_TAG.writer, record.writer),
    u8(AWAY_TAG.state, record.away ? 1 : 0),
    { tag: AWAY_TAG.text, value: utf8Bytes(record.text) },
    { tag: AWAY_TAG.source, value: utf8Bytes(record.source) },
    u8(AWAY_TAG.paused, record.paused ? 1 : 0),
    u32(AWAY_TAG.setAt, record.setAt === null ? 0 : Math.floor(record.setAt / 1000)),
  ];
}

export function decodeAwayAttrs(attrs: readonly AwayAttr[]): AwayRecord | null {
  const value = (tag: number): Uint8Array | undefined => attrs.find((a) => a.tag === tag)?.value;
  const seq = value(AWAY_TAG.seq);
  const writer = value(AWAY_TAG.writer);
  const state = value(AWAY_TAG.state);
  if (seq?.length !== 4 || writer?.length !== 4 || state?.length !== 1 || (state[0] !== 0 && state[0] !== 1)) return null;
  const text = utf8Text(value(AWAY_TAG.text) ?? new Uint8Array(0));
  if (text === null) return null;
  const common = { seq: readU32(seq), writer: readU32(writer), source: utf8Text(value(AWAY_TAG.source) ?? new Uint8Array(0)) ?? '' };
  if (state[0] === 0) return { ...common, away: false, text: '', paused: false, setAt: null };
  const paused = value(AWAY_TAG.paused);
  const setAt = value(AWAY_TAG.setAt);
  const seconds = setAt?.length === 4 ? readU32(setAt) : 0;
  return { ...common, away: true, text, paused: paused?.length === 1 && paused[0] !== 0, setAt: seconds === 0 ? null : seconds * 1000 };
}

export function awayRecordItem(name: string, itemId: number, record: AwayRecord): AwayItem {
  return { name, groupId: AWAY_RECORD_GROUP, itemId, classId: AWAY_RECORD_CLASS, attrs: encodeAwayAttrs(record) };
}

export function isAwayRecordItem(name: string, item: AwayItem): boolean {
  return item.classId === AWAY_RECORD_CLASS && item.groupId === AWAY_RECORD_GROUP && item.name === name;
}

export function compareAwayRecords(a: AwayRecord, b: AwayRecord): number {
  return (a.seq >>> 0) - (b.seq >>> 0) || (a.writer >>> 0) - (b.writer >>> 0);
}

export function chooseAwayItem<T extends AwayItem>(name: string, items: readonly T[]): { keep: T; record: AwayRecord | null; duplicates: T[] } | null {
  const ranked = items
    .filter((item) => isAwayRecordItem(name, item))
    .map((item) => {
      const record = decodeAwayAttrs(item.attrs);
      return { item, record, seq: record ? record.seq >>> 0 : -1, writer: record ? record.writer >>> 0 : -1 };
    })
    .sort((a, b) => b.seq - a.seq || b.writer - a.writer || a.item.itemId - b.item.itemId);
  const [first, ...rest] = ranked;
  if (first === undefined) return null;
  return { keep: first.item, record: first.record, duplicates: rest.map((r) => r.item) };
}

export function freeAwayItemId(items: readonly AwayItem[], random: () => number): number | null {
  const taken = new Set(items.flatMap((item) => [item.itemId, item.groupId]));
  const free: number[] = [];
  for (let id = AWAY_ITEM_ID_MIN; id <= AWAY_ITEM_ID_MAX; id++) if (!taken.has(id)) free.push(id);
  if (free.length === 0) return null;
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))] ?? null;
}

export function placeholderAwayRecord(writer: number, source: string): AwayRecord {
  return { seq: 0, writer, away: false, text: '', source, paused: false, setAt: null };
}

export function nextAwayRecord(input: { held: AwayRecord | null; highestSeq: number; writer: number; change: AwayChange; now: number }): AwayRecord {
  const { held, writer, change } = input;
  const seq = input.highestSeq + 1;
  if (!change.away) return { seq, writer, away: false, text: '', source: change.source, paused: false, setAt: null };
  const ongoing = held?.away === true ? held : null;
  return {
    seq,
    writer,
    away: true,
    text: change.text,
    source: change.source,
    paused: change.source === 'phone' || (ongoing?.paused ?? false),
    setAt: ongoing ? ongoing.setAt : Math.floor(input.now / 1000) * 1000,
  };
}

export function followAwayRecord(input: { held: AwayRecord | null; own: AwayState; incoming: AwayRecord }): {
  verdict: 'apply' | 'answer' | 'same';
  locate: AwayState | null;
} {
  const { held, own, incoming } = input;
  const order = held === null ? 1 : compareAwayRecords(incoming, held);
  if (order < 0) return { verdict: 'answer', locate: null };
  if (order === 0) return { verdict: 'same', locate: null };
  const target = { away: incoming.away, text: incoming.away ? incoming.text : '' };
  return { verdict: 'apply', locate: own.away === target.away && own.text === target.text ? null : target };
}

export function signOnAway(input: {
  origin: 'start' | 'restore';
  held: AwayRecord | null;
  stored: AwayRecord | null;
  found: boolean;
  siblingAway: boolean | null;
  writer: number;
  source: string;
}): AwaySignOnPlan {
  const { origin, held, stored, siblingAway } = input;
  if (stored === null) {
    const placeholder = placeholderAwayRecord(input.writer, input.source);
    return { locate: null, hold: origin === 'restore' ? (held ?? placeholder) : placeholder, write: input.found ? 'held' : 'create' };
  }
  if (origin === 'start') {
    if (stored.away && siblingAway === true) return { locate: { away: true, text: stored.text }, hold: stored, write: 'none' };
    return { locate: null, hold: stored, write: stored.away && siblingAway === false ? 'back' : 'none' };
  }
  // A restore's first Locate write carries the away it held.
  const own = { away: held?.away ?? false, text: held?.away ? held.text : '' };
  const { verdict, locate } = followAwayRecord({ held, own, incoming: stored });
  if (verdict === 'apply') return { locate, hold: stored, write: 'none' };
  return { locate: null, hold: held, write: verdict === 'answer' ? 'held' : 'none' };
}

export function awayText(body: RichText | null): string {
  return body === null ? '' : body.map((run) => run.text).join('');
}

export function awayBody(text: string): RichText | null {
  return text === '' ? null : [{ text }];
}
