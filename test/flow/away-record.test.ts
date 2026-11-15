import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OscarClientEvents } from '../../src/client/oscar-client.js';
import { ByteReader } from '../../src/wire/bytes.js';
import { CAP_CHAT, CAP_MOBILE_CLIENT, CAP_UTF8_MESSAGES } from '../../src/wire/constants.js';
import { encodeFeedbagItems, readFeedbagItem } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeTlvs, tlvStr } from '../../src/wire/tlv.js';
import { AWAY_RECORD_CLASS, AWAY_TAG, awayRecordItem, decodeAwayAttrs, isAwayRecordItem, placeholderAwayRecord } from '../../src/model/away.js';
import type { AwayRecord } from '../../src/model/away.js';
import type { RichText } from '../../src/model/rich-text.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

type RecordEvent = OscarClientEvents['awayRecord'];

const PHONE_CAPS = [CAP_UTF8_MESSAGES, CAP_CHAT, CAP_MOBILE_CLIENT];
const NAME = 'example.away';
// What random() of 0 and of 0.5 pick for writer.
const PHONE_WRITER = 0;
const DESK_WRITER = 0x8000_0000;
const START = 1_800_000_000_000;
const BACK: AwayRecord = { seq: 1, writer: 1, away: false, text: '', source: 'phone', paused: false, setAt: null };
const PLACEHOLDER = placeholderAwayRecord(PHONE_WRITER, 'phone');
const LUNCH: AwayRecord = { seq: 1, writer: PHONE_WRITER, away: true, text: 'Out to lunch', source: 'phone', paused: true, setAt: START };

let timers: ManualTimers;
let fake: FakeOscarServer;
let phone: ClientHarness;
let desk: ClientHarness;
let bobClient: ClientHarness;

const recordItem = (itemId: number, fields: Partial<AwayRecord> = {}): FeedbagItem => {
  const item = awayRecordItem(NAME, itemId, { ...BACK, ...fields });
  return { ...item, attrs: [...item.attrs] };
};
const items = (): FeedbagItem[] => fake.feedbagOf('alice').filter((i) => isAwayRecordItem(NAME, i));
const stored = (): AwayRecord | null => {
  const [item] = items();
  return item ? decodeAwayAttrs(item.attrs) : null;
};
const bos = (): SnacRecord[] => fake.snacsFrom('alice').filter((s) => s.conn === 'bos');
const order = (snacs: SnacRecord[]): string[] => snacs.filter((s) => s.conn === 'bos').map((s) => `${s.family}/${s.subtype}`);
function itemsIn(snac: SnacRecord | undefined): FeedbagItem[] {
  const r = new ByteReader(snac?.body ?? new Uint8Array(0));
  const out: FeedbagItem[] = [];
  while (r.remaining > 0) out.push(readFeedbagItem(r));
  return out;
}
const writes = (subtype: number, from = 0): SnacRecord[] => bos().slice(from).filter((s) => s.family === 0x13 && s.subtype === subtype);
const recordsIn = (snac: SnacRecord | undefined): (AwayRecord | null)[] => itemsIn(snac).map((i) => decodeAwayAttrs(i.attrs));
const isLocateAway = (snac: SnacRecord, text: string): boolean =>
  snac.family === 0x02 && snac.subtype === 0x04 && tlvStr(decodeTlvs(snac.body), 0x04) === text;
const warnings = (h: ClientHarness, msg: string) => h.logs.lines.filter((l) => l.level === 'warn' && l.msg === msg);

async function deskFirst(list: FeedbagItem[] = []): Promise<void> {
  fake.setFeedbag('alice', withTypingPref(list));
  await desk.signOn();
}

async function bothOn(): Promise<void> {
  await deskFirst();
  await phone.signOn();
  await waitFor(() => desk.client.awayRecord?.seq === 0, 'the desktop to hold the placeholder');
}

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  fake.setFeedbag('alice', withTypingPref([]));
  fake.setFeedbag('bob', withTypingPref([]));
  phone = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS, awayRecord: { name: NAME, role: 'own', source: 'phone', random: () => 0 } });
  desk = makeClient(fake, { timers, oserviceVersion: 4, awayRecord: { name: NAME, role: 'follow', source: 'desktop', random: () => 0.5 } });
  bobClient = makeClient(fake, { timers });
  await bobClient.signOn('Bob', 'bobpw1');
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe('the away record while signed on', () => {
  it('the phone creates the placeholder after client online at the lowest free id from 0x4000', async () => {
    await deskFirst();
    await phone.signOn();
    await waitFor(() => items().length === 1, 'the placeholder');
    expect(items().map((i) => [i.itemId, decodeAwayAttrs(i.attrs)?.seq, decodeAwayAttrs(i.attrs)?.away])).toEqual([[0x4000, 0, false]]);
    expect(fake.feedbagOf('alice').filter((i) => i.classId === AWAY_RECORD_CLASS).map((i) => i.name)).toEqual(['example.away']);
    const o = order(fake.snacsFrom('alice'));
    expect(o.indexOf('19/8')).toBeGreaterThan(o.lastIndexOf('1/2'));
    expect(phone.client.awayRecord).toEqual(PLACEHOLDER);
  });

  it("a phone's away writes Locate, then the record, paused; the desktop applies it and never writes", async () => {
    await bothOn();
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    const snacs = bos();
    const update = snacs.findIndex((s) => s.family === 0x13 && s.subtype === 0x09);
    expect(snacs.findIndex((s) => isLocateAway(s, 'Out to lunch'))).toBeGreaterThan(-1);
    expect(snacs.findIndex((s) => isLocateAway(s, 'Out to lunch'))).toBeLessThan(update);
    expect(recordsIn(snacs[update])).toEqual([LUNCH]);
    await waitFor(() => desk.client.awayMessage?.[0]?.text === 'Out to lunch', 'the desktop follows');
    await waitFor(() => bos().filter((s) => isLocateAway(s, 'Out to lunch')).length === 2, "the desktop's Locate write");
    expect(await bobClient.client.getInfo('Alice')).toMatchObject({ status: 'ok', awayMessage: [{ text: 'Out to lunch' }] });
    // The phone's placeholder insert and its one update: the desktop wrote no record.
    await settle(fake.port);
    expect(order(fake.snacsFrom('alice')).filter((s) => s === '19/8' || s === '19/9')).toEqual(['19/8', '19/9']);
    expect(desk.client.awayRecord).toEqual(LUNCH);
  });

  it("a desktop's edit keeps paused; back clears it and setAt", async () => {
    await bothOn();
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => desk.client.awayRecord?.seq === 1, 'the desktop follows');
    await timers.advance(30_000);
    await desk.client.setAway([{ text: 'Back at 3' }]);
    expect(stored()).toEqual({ seq: 2, writer: DESK_WRITER, away: true, text: 'Back at 3', source: 'desktop', paused: true, setAt: START });
    await waitFor(() => phone.client.awayMessage?.[0]?.text === 'Back at 3', 'the phone follows the edit');
    await desk.client.setAway(null);
    expect(stored()).toEqual({ seq: 3, writer: DESK_WRITER, away: false, text: '', source: 'desktop', paused: false, setAt: null });
    await waitFor(() => phone.client.awayMessage === null, 'the phone follows back');
  });

  it.each<{ name: string; body: RichText }>([
    { name: 'no runs', body: [] },
    { name: 'an empty run', body: [{ text: '' }] },
  ])('an away with $name writes back, to Locate and to the record', async ({ body }) => {
    await bothOn();
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => desk.client.awayRecord?.seq === 1, 'the desktop follows');
    const from = bos().length;
    await phone.client.setAway(body);
    const snacs = bos().slice(from);
    const update = snacs.findIndex((s) => s.family === 0x13 && s.subtype === 0x09);
    expect(snacs.findIndex((s) => isLocateAway(s, ''))).toBeGreaterThan(-1);
    expect(snacs.findIndex((s) => isLocateAway(s, ''))).toBeLessThan(update);
    expect(stored()).toEqual({ seq: 2, writer: PHONE_WRITER, away: false, text: '', source: 'phone', paused: false, setAt: null });
    expect(phone.client.awayMessage).toBeNull();
    await waitFor(() => desk.client.awayMessage === null, 'the desktop follows back');
  });

  it("a desktop's auto-away writes the source it is given", async () => {
    await bothOn();
    await desk.client.setAway([{ text: 'Away from the computer' }], { source: 'auto' });
    expect(stored()).toMatchObject({ seq: 1, writer: DESK_WRITER, away: true, source: 'auto', paused: false });
  });

  it('answers an older record with the one it holds, and everyone ends on the newer', async () => {
    await deskFirst([recordItem(0x4000, { seq: 4 })]);
    await phone.signOn();
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => desk.client.awayRecord?.seq === 5, 'the desktop follows');
    const held = phone.client.awayRecord;
    expect(held).toEqual({ ...LUNCH, seq: 5 });
    const from = bos().length;
    fake.sendSnac('alice', 0x13, 0x09, encodeFeedbagItems([recordItem(0x4000, { seq: 4 })]));
    await waitFor(() => writes(0x09, from).length === 2, 'both instances to answer');
    await settle(fake.port);
    expect(writes(0x09, from).map(recordsIn)).toEqual([[held], [held]]);
    expect(stored()).toEqual(held);
  });

  it('an away desktop answers the placeholder with its away', async () => {
    await deskFirst();
    await desk.client.setAway([{ text: 'brb' }]);
    const brb: AwayRecord = { seq: 1, writer: DESK_WRITER, away: true, text: 'brb', source: 'desktop', paused: false, setAt: START };
    expect(desk.client.awayRecord).toEqual(brb);
    expect(items()).toEqual([]);
    await phone.signOn();
    await waitFor(() => phone.client.awayMessage?.[0]?.text === 'brb', 'the phone applies the away');
    expect(stored()).toEqual(brb);
    expect(writes(0x09).map(recordsIn)).toEqual([[brb]]);
    expect(phone.client.awayRecord).toEqual(brb);
  });

  it('keeps the highest of duplicates and the phone deletes the rest after client online; the desktop deletes none', async () => {
    const junk: FeedbagItem = { ...recordItem(0x4001), attrs: [] };
    await deskFirst([recordItem(0x6000, { seq: 3, writer: 9 }), recordItem(0x5000, { seq: 3, writer: 9 }), recordItem(0x4100, { seq: 4 }), junk]);
    await phone.signOn();
    await waitFor(() => items().length === 1, 'the duplicates to go');
    await settle(fake.port);
    expect(items().map((i) => i.itemId)).toEqual([0x4100]);
    expect(writes(0x0a).map((s) => itemsIn(s).map((i) => i.itemId))).toEqual([[0x5000, 0x6000, 0x4001]]);
    const o = order(fake.snacsFrom('alice'));
    expect(o.indexOf('19/10')).toBeGreaterThan(o.lastIndexOf('1/2'));
    expect(o.filter((s) => s === '19/8' || s === '19/9')).toEqual([]);
  });

  it("role 'remove' deletes the record after client online and writes Locate only", async () => {
    await deskFirst([recordItem(0x4000, { seq: 2 })]);
    const off = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS, awayRecord: { name: NAME, role: 'remove', source: 'phone', random: () => 0 } });
    await off.signOn();
    await waitFor(() => items().length === 0, 'the record to go');
    const o = order(fake.snacsFrom('alice'));
    expect(o.filter((s) => s === '19/10')).toEqual(['19/10']);
    expect(o.indexOf('19/10')).toBeGreaterThan(o.lastIndexOf('1/2'));
    expect(writes(0x0a).map((s) => itemsIn(s).map((i) => i.itemId))).toEqual([[0x4000]]);
    const from = bos().length;
    await off.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => bos().length > from, 'the Locate write');
    await settle(fake.port);
    expect(order(bos().slice(from))).toEqual(['2/4']);
  });

  it('accept false leaves a newer record unapplied', async () => {
    const offered: AwayRecord[] = [];
    const accept = (record: AwayRecord): boolean => {
      offered.push(record);
      return false;
    };
    const picky = makeClient(fake, { timers, oserviceVersion: 4, awayRecord: { name: NAME, role: 'follow', source: 'desktop', random: () => 0.5, accept } });
    await picky.signOn();
    await phone.signOn();
    await waitFor(() => offered.length === 1, 'the placeholder to be offered');
    const held = picky.client.awayRecord;
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => offered.length === 2, 'the away to be offered');
    await settle(fake.port);
    expect(offered).toEqual([PLACEHOLDER, LUNCH]);
    expect(picky.client.awayMessage).toBeNull();
    expect(picky.client.awayRecord).toBe(held);
  });

  it('ignores an unreadable record and writes over it', async () => {
    const plain = recordItem(0x4000, { seq: 7 });
    const unreadable: FeedbagItem = { ...plain, attrs: plain.attrs.map((a) => (a.tag === AWAY_TAG.state ? { tag: a.tag, value: Uint8Array.of(2) } : a)) };
    await deskFirst([unreadable]);
    await phone.signOn();
    await waitFor(() => stored() !== null, 'the placeholder over it');
    expect(items().map((i) => i.itemId)).toEqual([0x4000]);
    expect(stored()).toEqual(PLACEHOLDER);
    expect(order(fake.snacsFrom('alice')).filter((s) => ['19/8', '19/9', '19/10'].includes(s))).toEqual(['19/9']);
    await waitFor(() => desk.client.awayRecord !== null, 'the desktop to hold the placeholder');
    const from = bos().length;
    fake.sendSnac('alice', 0x13, 0x09, encodeFeedbagItems([unreadable]));
    await settle(fake.port);
    expect(bos().slice(from)).toEqual([]);
    expect([phone.client.skippedSnacs().size, desk.client.skippedSnacs().size]).toEqual([0, 0]);
    expect([phone.client.awayRecord, desk.client.awayRecord]).toEqual([PLACEHOLDER, PLACEHOLDER]);
  });

  it('logs and keeps its state when a record cannot be applied', async () => {
    await deskFirst();
    await desk.client.setAway([{ text: 'brb' }]);
    const held = desk.client.awayRecord;
    await waitFor(() => bos().some((s) => isLocateAway(s, 'brb')), "the desktop's Locate write");
    const from = bos().length;
    const long = recordItem(0x4000, { seq: 9, writer: 3, away: true, text: 'é'.repeat(2000), paused: true, setAt: START });
    fake.sendSnac('alice', 0x13, 0x08, encodeFeedbagItems([long]));
    await waitFor(() => warnings(desk, 'the away record could not be applied').length === 1, 'the warning');
    await settle(fake.port);
    expect(warnings(desk, 'the away record could not be applied')[0]?.fields).toEqual({ code: 'text-too-long' });
    expect(desk.client.awayMessage).toEqual([{ text: 'brb' }]);
    expect(desk.client.awayRecord).toBe(held);
    expect(bos().slice(from)).toEqual([]);
    expect(desk.logs.text()).not.toContain('é');
  });

  it('logs a refused record once and carries on without it', async () => {
    await deskFirst();
    fake.failNextStatus(0x0a);
    await phone.signOn();
    await waitFor(() => warnings(phone, 'the away record was refused').length === 1, 'the refusal');
    expect(warnings(phone, 'the away record was refused')[0]?.fields).toEqual({ code: 0x0a });
    expect(items()).toEqual([]);
    // A record another instance made: this session leaves it alone.
    const other = recordItem(0x5000, { seq: 1, writer: 7 });
    fake.setFeedbag('alice', [...fake.feedbagOf('alice'), other]);
    fake.sendSnac('alice', 0x13, 0x08, encodeFeedbagItems([other]));
    await waitFor(() => desk.client.awayRecord?.writer === 7, 'the desktop to hold the other record');
    expect(phone.client.awayRecord).toEqual(PLACEHOLDER);
    const from = bos().length;
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => bos().length > from, 'the Locate write');
    await settle(fake.port);
    expect(order(bos().slice(from))).toEqual(['2/4']);
    expect(phone.client.awayRecord).toEqual(LUNCH);
    expect(warnings(phone, 'the away record was refused')).toHaveLength(1);
    expect(stored()).toEqual({ ...BACK, writer: 7 });
  });

  it('emits awayRecord at each change, applied only for another instance', async () => {
    const seen: { phone: RecordEvent[]; desk: RecordEvent[] } = { phone: [], desk: [] };
    phone.client.on('awayRecord', (e) => seen.phone.push(e));
    desk.client.on('awayRecord', (e) => seen.desk.push(e));
    await bothOn();
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => seen.desk.length === 2, 'the desktop to follow');
    expect(seen.phone).toEqual([
      { record: PLACEHOLDER, itemId: 0x4000, applied: false },
      { record: LUNCH, itemId: 0x4000, applied: false },
    ]);
    expect(seen.desk).toEqual([
      { record: PLACEHOLDER, itemId: 0x4000, applied: true },
      { record: LUNCH, itemId: 0x4000, applied: true },
    ]);
  });

  it('a client without the option neither writes nor follows the record', async () => {
    const plain = makeClient(fake, { timers, oserviceVersion: 4 });
    await plain.signOn();
    await phone.signOn();
    await waitFor(() => items().length === 1, 'the placeholder');
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => plain.lists.length >= 3, 'the away to reach the plain client');
    expect(plain.client.awayMessage).toBeNull();
    const from = bos().length;
    await plain.client.setAway([{ text: 'brb' }]);
    await waitFor(() => bos().length > from, 'the Locate write');
    await settle(fake.port);
    expect(order(bos().slice(from))).toEqual(['2/4']);
    expect(plain.client.awayRecord).toBeNull();
    expect(stored()).toEqual(LUNCH);
  });
});
