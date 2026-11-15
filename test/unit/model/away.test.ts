import { describe, expect, it } from 'vitest';
import {
  awayBody,
  awayRecordItem,
  awayText,
  chooseAwayItem,
  compareAwayRecords,
  decodeAwayAttrs,
  encodeAwayAttrs,
  followAwayRecord,
  freeAwayItemId,
  isAwayRecordItem,
  nextAwayRecord,
  placeholderAwayRecord,
  signOnAway,
} from '../../../src/model/away.js';
import type { AwayAttr, AwayItem, AwayRecord, AwaySignOnPlan } from '../../../src/model/away.js';
import { ByteReader, fromHex, toHex } from '../../../src/wire/bytes.js';
import { encodeFeedbagItems, readFeedbagItem } from '../../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../../src/wire/feedbag.js';
import { loadVectors } from '../../support/vectors.js';

const vectors = loadVectors('away-record.json');
const NAME = 'example.away';

function recordOf(inputs: Record<string, string> = {}): AwayRecord {
  const setAt = Number(inputs.setAt);
  return {
    seq: Number(inputs.seq),
    writer: Number(inputs.writer),
    away: inputs.away === 'true',
    text: inputs.text ?? '',
    source: inputs.source ?? '',
    paused: inputs.paused === 'true',
    setAt: setAt === 0 ? null : setAt * 1000,
  };
}

const toFeedbagItem = (item: AwayItem): FeedbagItem => ({ ...item, attrs: [...item.attrs] });
const record = (fields: Partial<AwayRecord> = {}): AwayRecord => ({
  seq: 1,
  writer: 1,
  away: true,
  text: 'Out to lunch',
  source: 'phone',
  paused: true,
  setAt: 1_793_000_000_000,
  ...fields,
});
const backRecord = (fields: Partial<AwayRecord> = {}): AwayRecord => record({ away: false, text: '', paused: false, setAt: null, ...fields });

const PHONE = encodeAwayAttrs(record());
const withAttr = (attrs: readonly AwayAttr[], tag: number, value: Uint8Array): AwayAttr[] => attrs.map((a) => (a.tag === tag ? { tag, value } : a));
const without = (attrs: readonly AwayAttr[], tag: number): AwayAttr[] => attrs.filter((a) => a.tag !== tag);

const item = (itemId: number, fields: Partial<AwayRecord>): AwayItem => awayRecordItem(NAME, itemId, record(fields));
const junk = (itemId: number): AwayItem => ({ ...awayRecordItem(NAME, itemId, record()), attrs: [] });
const used = (itemId: number, groupId = 1): AwayItem => ({ name: 'Bob', groupId, itemId, classId: 0, attrs: [] });
const buddyItem = used(0x4000);

describe('the away record codec', () => {
  it.each(vectors.vectors)('$name: encodes to its bytes and decodes back', (v) => {
    const expected = recordOf(v.inputs);
    expect(toHex(encodeFeedbagItems([toFeedbagItem(awayRecordItem(NAME, Number(v.inputs?.itemId), expected))]))).toBe(v.hex);
    expect(decodeAwayAttrs(readFeedbagItem(new ByteReader(fromHex(v.hex))).attrs)).toEqual(expected);
  });

  it('reads an unreadable record as null', () => {
    for (const attrs of [
      withAttr(PHONE, 0x7a02, Uint8Array.of(1)),
      withAttr(PHONE, 0x7a03, Uint8Array.of(0, 0, 0, 0, 1)),
      withAttr(PHONE, 0x7a04, Uint8Array.of(2)),
      withAttr(PHONE, 0x7a04, Uint8Array.of(1, 0)),
      withAttr(PHONE, 0x7a05, Uint8Array.of(0xff, 0xfe)),
      withAttr(PHONE, 0x7a05, Uint8Array.of(0xc0, 0xaf)), // overlong '/'
      withAttr(PHONE, 0x7a05, Uint8Array.of(0xed, 0xa0, 0x80)), // a surrogate
      withAttr(PHONE, 0x7a05, Uint8Array.of(0x41, 0x80)),
      withAttr(PHONE, 0x7a05, Uint8Array.of(0x41, 0xe2, 0x82)),
      withAttr(PHONE, 0x7a05, Uint8Array.of(0xf4, 0x90, 0x80, 0x80)), // above U+10FFFF
      without(PHONE, 0x7a02),
      without(PHONE, 0x7a03),
      without(PHONE, 0x7a04),
    ]) {
      expect(decodeAwayAttrs(attrs)).toBeNull();
    }
    expect(decodeAwayAttrs([...PHONE, { tag: 0x7a09, value: Uint8Array.of(9) }])).not.toBeNull();
  });

  it('accepts any version, unknown tags and missing optional attributes, and reads a back record bare', () => {
    expect(decodeAwayAttrs(withAttr(PHONE, 0x7a01, Uint8Array.of(9)))).toEqual(record());
    expect(decodeAwayAttrs(without(PHONE, 0x7a01))).toEqual(record());
    expect(decodeAwayAttrs([...PHONE, { tag: 0x7a09, value: Uint8Array.of(9) }])).toEqual(record());
    expect(decodeAwayAttrs(PHONE.filter((a) => a.tag <= 0x7a04))).toEqual(record({ text: '', source: '', paused: false, setAt: null }));
    expect(decodeAwayAttrs(withAttr(PHONE, 0x7a04, Uint8Array.of(0)))).toEqual(backRecord());
  });

  it('round-trips UTF-8 text of every length and writes a lone surrogate as U+FFFD', () => {
    const text = 'café \u2014 日本 \u{1f32e} %n';
    expect(decodeAwayAttrs(encodeAwayAttrs(record({ text })))?.text).toBe(text);
    const lone = encodeAwayAttrs(record({ text: 'a\ud800b' })).find((a) => a.tag === 0x7a05)?.value;
    expect(toHex(lone ?? new Uint8Array(0))).toBe('61efbfbd62');
  });

  it('joins the runs for Locate and wraps plain text as one run', () => {
    expect(awayText([{ text: 'Out ', bold: true }, { text: 'to lunch' }])).toBe('Out to lunch');
    expect(awayText(null)).toBe('');
    expect(awayBody('Out to lunch')).toEqual([{ text: 'Out to lunch' }]);
    expect(awayBody('')).toBeNull();
  });
});

describe('finding and placing the record', () => {
  it('orders by seq, then writer, then the lowest item id, unreadable last', () => {
    const chosen = chooseAwayItem(NAME, [item(0x6000, { seq: 3, writer: 9 }), item(0x5000, { seq: 3, writer: 9 }), item(0x4100, { seq: 4, writer: 1 }), junk(0x4001), buddyItem]);
    expect([chosen?.keep.itemId, chosen?.duplicates.map((d) => d.itemId)]).toEqual([0x4100, [0x5000, 0x6000, 0x4001]]);
    expect(chosen?.record).toEqual(record({ seq: 4, writer: 1 }));
    expect(chooseAwayItem(NAME, [junk(0x4001)])).toEqual({ keep: junk(0x4001), record: null, duplicates: [] });
    expect(chooseAwayItem(NAME, [buddyItem])).toBeNull();
    expect(chooseAwayItem(NAME, [{ ...item(0x4200, {}), groupId: 1 }, { ...item(0x4300, {}), classId: 0x0c40 }, { ...item(0x4400, {}), name: 'example.awa' }])).toBeNull();
  });

  it('finds the record only under the name it is given', () => {
    const named = awayRecordItem('example.away', 0x4001, record());
    expect(named.name).toBe('example.away');
    expect([isAwayRecordItem('example.away', named), isAwayRecordItem('other.away', named)]).toEqual([true, false]);
    expect(chooseAwayItem('example.away', [awayRecordItem('other.away', 0x4002, record())])).toBeNull();
  });

  it('compares seq first, then writer as unsigned', () => {
    expect(compareAwayRecords(record({ seq: 2, writer: 0xffffffff }), record({ seq: 2, writer: 1 }))).toBeGreaterThan(0);
    expect(compareAwayRecords(record({ seq: 2, writer: 0xffffffff }), record({ seq: 3, writer: 0 }))).toBeLessThan(0);
    expect(compareAwayRecords(record({ seq: 2, writer: 7 }), record({ seq: 2, writer: 7, text: 'other' }))).toBe(0);
  });

  it('takes a free id in 0x4000 to 0x7FFF that no item or group uses', () => {
    expect(freeAwayItemId([used(0x4000), used(0, 0x4001)], () => 0)).toBe(0x4002);
    expect(freeAwayItemId([], () => 0.5)).toBe(0x6000);
    expect(freeAwayItemId([], () => 0.999999)).toBe(0x7fff);
    expect(freeAwayItemId([], () => 1)).toBe(0x7fff);
    const allIdsUsed = Array.from({ length: 0x4000 }, (_, i) => used(0x4000 + i));
    expect(freeAwayItemId(allIdsUsed, () => 0)).toBeNull();
    expect(freeAwayItemId(allIdsUsed.slice(1), () => 0.7)).toBe(0x4000);
  });
});

describe('writing and following', () => {
  it('a phone sets paused, a desktop keeps it while away, back clears it and setAt', () => {
    const phone = nextAwayRecord({ held: null, highestSeq: 0, writer: 7, change: { away: true, text: 'Lunch', source: 'phone' }, now: 1_793_000_000_750 });
    expect(phone).toEqual({ seq: 1, writer: 7, away: true, text: 'Lunch', source: 'phone', paused: true, setAt: 1_793_000_000_000 });
    const desktop = nextAwayRecord({ held: phone, highestSeq: 1, writer: 9, change: { away: true, text: 'Long lunch', source: 'desktop' }, now: 1_793_000_600_000 });
    expect(desktop).toEqual({ seq: 2, writer: 9, away: true, text: 'Long lunch', source: 'desktop', paused: true, setAt: 1_793_000_000_000 });
    const back = nextAwayRecord({ held: desktop, highestSeq: 2, writer: 9, change: { away: false, text: '', source: 'desktop' }, now: 1_793_001_200_000 });
    expect(back).toEqual({ seq: 3, writer: 9, away: false, text: '', source: 'desktop', paused: false, setAt: null });
    const auto = nextAwayRecord({ held: back, highestSeq: 3, writer: 9, change: { away: true, text: 'Brb', source: 'auto' }, now: 1_793_001_800_000 });
    expect(auto).toEqual({ seq: 4, writer: 9, away: true, text: 'Brb', source: 'auto', paused: false, setAt: 1_793_001_800_000 });
  });

  it('counts an away taken with no record as seq 1', () => {
    const away = nextAwayRecord({ held: null, highestSeq: 0, writer: 3, change: { away: true, text: 'Brb', source: 'desktop' }, now: 1_793_000_000_000 });
    expect(away).toMatchObject({ seq: 1, paused: false });
    expect(followAwayRecord({ held: away, own: { away: true, text: 'Brb' }, incoming: placeholderAwayRecord(2, 'phone') })).toEqual({ verdict: 'answer', locate: null });
  });

  it('follows newer, answers older, ignores the same', () => {
    const held = record({ seq: 3, writer: 5, text: 'Lunch' });
    const own = { away: true, text: 'Lunch' };
    expect(followAwayRecord({ held, own, incoming: record({ seq: 4, writer: 1, text: 'Meeting' }) })).toEqual({ verdict: 'apply', locate: { away: true, text: 'Meeting' } });
    expect(followAwayRecord({ held, own, incoming: backRecord({ seq: 3, writer: 6 }) })).toEqual({ verdict: 'apply', locate: { away: false, text: '' } });
    expect(followAwayRecord({ held, own, incoming: record({ seq: 4, writer: 1, text: 'Lunch' }) })).toEqual({ verdict: 'apply', locate: null });
    expect(followAwayRecord({ held: null, own: { away: false, text: '' }, incoming: placeholderAwayRecord(2, 'phone') })).toEqual({ verdict: 'apply', locate: null });
    expect(followAwayRecord({ held, own, incoming: record({ seq: 2, writer: 9 }) })).toEqual({ verdict: 'answer', locate: null });
    expect(followAwayRecord({ held, own, incoming: held })).toEqual({ verdict: 'same', locate: null });
  });

  it('settles crossed writes on the newer whichever order they land in', () => {
    const start = record({ seq: 4, writer: 1, text: 'Lunch' });
    const fromA = nextAwayRecord({ held: start, highestSeq: 4, writer: 1, change: { away: true, text: 'Meeting', source: 'desktop' }, now: 1_793_000_600_000 });
    const fromB = nextAwayRecord({ held: start, highestSeq: 4, writer: 2, change: { away: false, text: '', source: 'phone' }, now: 1_793_000_600_000 });
    expect([fromA.seq, fromB.seq]).toEqual([5, 5]);
    for (const order of [['A', 'B'], ['B', 'A']] as const) {
      const held = { A: fromA, B: fromB };
      let stored: AwayRecord | null = null;
      const writes: { by: 'A' | 'B'; record: AwayRecord }[] = order.map((by) => ({ by, record: held[by] }));
      // The server stores each write as it lands and relays it to the other instance.
      for (let write = writes.shift(); write !== undefined; write = writes.shift()) {
        stored = write.record;
        const other = write.by === 'A' ? 'B' : 'A';
        const own = { away: held[other].away, text: held[other].text };
        const { verdict } = followAwayRecord({ held: held[other], own, incoming: write.record });
        if (verdict === 'apply') held[other] = write.record;
        if (verdict === 'answer') writes.push({ by: other, record: held[other] });
      }
      expect([stored, held.A, held.B]).toEqual([fromB, fromB, fromB]);
    }
  });
});

describe('signing on', () => {
  const writer = 0x2222;
  const placeholder = placeholderAwayRecord(writer, 'phone');
  const lunch = record({ seq: 4, writer: 9, text: 'Lunch' });
  const back = backRecord({ seq: 4, writer: 9 });
  const held = record({ seq: 3, writer, text: 'Lunch' });
  const ahead = record({ seq: 5, writer, text: 'Meeting' });
  type Input = Parameters<typeof signOnAway>[0];
  const start = (stored: AwayRecord | null, found: boolean, siblingAway: boolean | null): Input =>
    ({ origin: 'start', held: null, stored, found, siblingAway, writer, source: 'phone' });
  const restore = (heldRecord: AwayRecord | null, stored: AwayRecord | null, found: boolean): Input =>
    ({ origin: 'restore', held: heldRecord, stored, found, siblingAway: true, writer, source: 'phone' });
  const SIGN_ON_ROWS: [string, Input, AwaySignOnPlan][] = [
    ['start, no record', start(null, false, true), { locate: null, hold: placeholder, write: 'create' }],
    ['start, an unreadable record', start(null, true, true), { locate: null, hold: placeholder, write: 'held' }],
    ['start, away beside an away instance', start(lunch, true, true), { locate: { away: true, text: 'Lunch' }, hold: lunch, write: 'none' }],
    ['start, away with no other instance away', start(lunch, true, false), { locate: null, hold: lunch, write: 'back' }],
    ['start, away with no instance list', start(lunch, true, null), { locate: null, hold: lunch, write: 'none' }],
    ['start, back', start(back, true, true), { locate: null, hold: back, write: 'none' }],
    ['restore, no record', restore(held, null, false), { locate: null, hold: held, write: 'create' }],
    ['restore, an unreadable record', restore(held, null, true), { locate: null, hold: held, write: 'held' }],
    ['restore, no record and nothing held', restore(null, null, false), { locate: null, hold: placeholder, write: 'create' }],
    ['restore, a newer record', restore(held, back, true), { locate: { away: false, text: '' }, hold: back, write: 'none' }],
    ['restore, a newer record with the same away', restore(held, lunch, true), { locate: null, hold: lunch, write: 'none' }],
    ['restore, a record and nothing held', restore(null, lunch, true), { locate: { away: true, text: 'Lunch' }, hold: lunch, write: 'none' }],
    ['restore, an older record', restore(ahead, lunch, true), { locate: null, hold: ahead, write: 'held' }],
    ['restore, the same record', restore(lunch, lunch, true), { locate: null, hold: lunch, write: 'none' }],
  ];
  it.each(SIGN_ON_ROWS)('signs on: %s', (_row, input, plan) => {
    expect(signOnAway(input)).toEqual(plan);
  });
});
