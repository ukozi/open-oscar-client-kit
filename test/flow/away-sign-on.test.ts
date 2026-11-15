import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResumeState } from '../../src/client/oscar-client.js';
import { ByteReader } from '../../src/wire/bytes.js';
import { CAP_CHAT, CAP_MOBILE_CLIENT, CAP_UTF8_MESSAGES } from '../../src/wire/constants.js';
import { readFeedbagItem } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeTlvs, tlvStr } from '../../src/wire/tlv.js';
import { AWAY_RECORD_CLASS, awayRecordItem, decodeAwayAttrs, isAwayRecordItem } from '../../src/model/away.js';
import type { AwayRecord } from '../../src/model/away.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord } from '../fake/oscar-server.js';

const PHONE_CAPS = [CAP_UTF8_MESSAGES, CAP_CHAT, CAP_MOBILE_CLIENT];
const NAME = 'example.away';
// What random() of 0 picks for writer.
const PHONE_WRITER = 0;
const START = 1_800_000_000_000;
// Records an earlier phone session wrote.
const BRB: AwayRecord = { seq: 1, writer: 1, away: true, text: 'brb', source: 'phone', paused: true, setAt: START };
const BACK: AwayRecord = { seq: 1, writer: 1, away: false, text: '', source: 'phone', paused: false, setAt: null };
const LEFT: AwayRecord = { ...BRB, seq: 4 };
const WRITTEN_BACK: AwayRecord = { seq: 5, writer: PHONE_WRITER, away: false, text: '', source: 'phone', paused: false, setAt: null };
const AUTO_TEXT = 'I am away from my computer right now.';
const AUTO: AwayRecord = { seq: 5, writer: 3, away: true, text: AUTO_TEXT, source: 'auto', paused: false, setAt: START };

let timers: ManualTimers;
let fake: FakeOscarServer;
let bob: FakePeer;
let phone: ClientHarness;
let desk: ClientHarness;

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });
const order = (snacs: SnacRecord[]): string[] => snacs.filter((s) => s.conn === 'bos').map((s) => `${s.family}/${s.subtype}`);
const bos = (): SnacRecord[] => fake.snacsFrom('alice').filter((s) => s.conn === 'bos');
const resume = (origin: ResumeState['origin'], away: AwayRecord | null = null): ResumeState => ({ origin, invisible: false, away, answered: [], reportIdle: false });
const signOn = (h: ClientHarness, state: ResumeState): Promise<'online' | 'cancelled'> =>
  h.client.signOn({ screenName: 'Alice', password: 'alicepw1' }, here(), { resume: state });

const recordItem = (itemId: number, record: AwayRecord): FeedbagItem => {
  const item = awayRecordItem(NAME, itemId, record);
  return { ...item, attrs: [...item.attrs] };
};
const stored = (): AwayRecord | null => {
  const [item] = fake.feedbagOf('alice').filter((i) => isAwayRecordItem(NAME, i));
  return item ? decodeAwayAttrs(item.attrs) : null;
};
const isLocate = (s: SnacRecord): boolean => s.family === 0x02 && s.subtype === 0x04;
const awayText = (s: SnacRecord | undefined): string | undefined => tlvStr(decodeTlvs(s?.body ?? new Uint8Array(0)), 0x04);
const writes = (subtype: number): SnacRecord[] => bos().filter((s) => s.family === 0x13 && s.subtype === subtype);
function recordsIn(snac: SnacRecord): (AwayRecord | null)[] {
  const r = new ByteReader(snac.body);
  const out: (AwayRecord | null)[] = [];
  while (r.remaining > 0) out.push(decodeAwayAttrs(readFeedbagItem(r).attrs));
  return out;
}
const reads = (): number => order(fake.snacsFrom('alice')).filter((s) => s === '19/4').length;
const readsSince = (from: number): number => order(bos().slice(from)).filter((s) => s === '19/4').length;

// A desktop whose user is at it refuses another computer's auto-away.
function atDesk(asked: AwayRecord[]): ClientHarness {
  const accept = (record: AwayRecord): boolean => {
    asked.push(record);
    return record.source !== 'auto';
  };
  return makeClient(fake, { timers, random: () => 0, oserviceVersion: 4, awayRecord: { name: NAME, role: 'follow', source: 'desktop', random: () => 0.75, accept } });
}

// The phone starts alone; `change` runs once it has read the list and is held before client online.
async function whileStarting(change: () => void): Promise<void> {
  fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, LEFT)]));
  const release = fake.withhold(1, 0x0f);
  const signingOn = signOn(phone, resume('start'));
  await waitFor(() => order(bos()).includes('1/14'), "the phone's user info query");
  change();
  release();
  await signingOn;
}

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, preOnlineStatus: 'silent' });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([]));
  bob = fake.peer('Bob');
  bob.watch('Alice');
  phone = makeClient(fake, { timers, random: () => 0, oserviceVersion: 4, capabilities: PHONE_CAPS, awayRecord: { name: NAME, role: 'own', source: 'phone', random: () => 0 } });
  desk = makeClient(fake, { timers, oserviceVersion: 4, awayRecord: { name: NAME, role: 'follow', source: 'desktop', random: () => 0.5 } });
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe('the away record at sign-on', () => {
  it("a sign-on that starts beside an away desktop takes the record's away before client online, and Bob sees no change", async () => {
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, BRB)]));
    await signOn(desk, resume('restore', BRB));
    expect(desk.client.awayMessage).toEqual([{ text: 'brb' }]);
    await waitFor(() => bob.sightings().length > 0, 'Bob to see the desktop');
    await settle(fake.port);
    const from = bos().length;
    const seen = bob.sightings().length;
    await signOn(phone, resume('start'));
    const snacs = bos().slice(from);
    const brb = snacs.findIndex((s) => isLocate(s) && awayText(s) === 'brb');
    expect(brb).toBeGreaterThan(-1);
    expect(brb).toBeLessThan(order(snacs).lastIndexOf('1/2'));
    await waitFor(() => bob.sightings().length > seen, 'Bob to hear of the phone');
    expect(bob.sightings().map((s) => s.away)).not.toContain(false);
    expect([phone.client.awayMessage, phone.client.awayRecord]).toEqual([[{ text: 'brb' }], BRB]);
  });

  it('a sign-on that starts beside an available desktop starts available and writes back', async () => {
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, LEFT)]));
    const available = makeClient(fake, { timers, oserviceVersion: 4 });
    await available.signOn();
    await signOn(phone, resume('start'));
    await waitFor(() => stored()?.seq === 5, 'the record written back');
    expect(stored()).toEqual(WRITTEN_BACK);
    const o = order(fake.snacsFrom('alice'));
    expect(o.indexOf('19/9')).toBeGreaterThan(o.lastIndexOf('1/2'));
    expect(bos().filter(isLocate).map(awayText)).toEqual([undefined, undefined]);
    expect([phone.client.awayMessage, phone.client.awayRecord]).toEqual([null, WRITTEN_BACK]);
  });

  it('a record that moved on while it started stands, and nothing is written back', async () => {
    const meeting: AwayRecord = { ...BRB, seq: 5, writer: 9, text: 'meeting' };
    await whileStarting(() => fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, meeting)])));
    await waitFor(() => phone.client.awayMessage !== null, 'the phone to follow');
    await settle(fake.port);
    expect(writes(0x09)).toEqual([]);
    expect([stored(), phone.client.awayRecord, phone.client.awayMessage]).toEqual([meeting, meeting, [{ text: 'meeting' }]]);
  });

  it('a record deleted while it started is created again, back', async () => {
    await whileStarting(() => fake.setFeedbag('alice', withTypingPref([])));
    await waitFor(() => stored() !== null, 'the record created');
    expect([stored(), phone.client.awayRecord, phone.client.awayMessage]).toEqual([WRITTEN_BACK, WRITTEN_BACK, null]);
    expect(fake.feedbagOf('alice').filter((i) => i.classId === AWAY_RECORD_CLASS).map((i) => i.name)).toEqual(['example.away']);
  });

  it('below version 4 a starting sign-on leaves a leftover away record alone', async () => {
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, LEFT)]));
    const old = makeClient(fake, { timers, capabilities: PHONE_CAPS, awayRecord: { name: NAME, role: 'own', source: 'phone', random: () => 0 } });
    await signOn(old, resume('start'));
    expect(old.client.oserviceVersion).toBe(1);
    await waitFor(() => reads() === 2, 'the second read');
    await settle(fake.port);
    expect(order(fake.snacsFrom('alice')).filter((s) => ['19/8', '19/9', '19/10'].includes(s))).toEqual([]);
    expect(stored()).toEqual(LEFT);
    expect([old.client.awayMessage, old.client.awayRecord]).toEqual([null, LEFT]);
  });

  it('a restore puts back the away it held, then follows the record that moved on, all before client online', async () => {
    const held: AwayRecord = { ...BRB, seq: 3 };
    const moved: AwayRecord = { seq: 4, writer: 7, away: false, text: '', source: 'desktop', paused: false, setAt: null };
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, moved)]));
    await signOn(phone, resume('restore', held));
    const snacs = bos();
    const locates = snacs.filter(isLocate);
    expect(locates.map(awayText)).toEqual(['brb', '']);
    expect(snacs.indexOf(locates[1] as SnacRecord)).toBeLessThan(order(snacs).lastIndexOf('1/2'));
    expect([phone.client.awayMessage, phone.client.awayRecord]).toEqual([null, moved]);
  });

  it('a restore holding the newer record writes it again', async () => {
    const older: AwayRecord = { ...BACK, seq: 2 };
    const held: AwayRecord = { ...BRB, seq: 3 };
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, older)]));
    await signOn(phone, resume('restore', held));
    await waitFor(() => stored()?.seq === 3, 'the held record written again');
    await settle(fake.port);
    const o = order(fake.snacsFrom('alice'));
    expect(o.indexOf('19/9')).toBeGreaterThan(o.lastIndexOf('1/2'));
    expect(writes(0x09).map(recordsIn)).toEqual([[held]]);
    expect([phone.client.awayMessage, phone.client.awayRecord]).toEqual([[{ text: 'brb' }], held]);
  });

  it('reads the feedbag again after client online and finds what was written while it signed on', async () => {
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, BACK)]));
    await desk.signOn();
    await waitFor(() => reads() === 2, "the desktop's second read");
    await settle(fake.port);
    const from = bos().length;
    const release = fake.withhold(1, 0x0f);
    const signingOn = phone.signOn();
    await waitFor(() => order(bos().slice(from)).includes('1/14'), "the phone's user info query");
    expect(order(bos().slice(from))).toContain('19/4');
    await desk.client.setAway([{ text: 'meeting' }]);
    expect(stored()).toMatchObject({ seq: 2, away: true, text: 'meeting' });
    release();
    await signingOn;
    await waitFor(() => phone.client.awayMessage !== null, 'the phone to follow');
    const o = order(bos().slice(from));
    expect(o.filter((s) => s === '19/4')).toHaveLength(2);
    expect(o.lastIndexOf('19/4')).toBeGreaterThan(o.lastIndexOf('1/2'));
    expect(phone.client.awayMessage).toEqual([{ text: 'meeting' }]);
    expect(phone.client.awayRecord).toEqual(stored());
  });

  it('the reconnect inside the client keeps its away and follows the record', async () => {
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, BACK)]));
    await desk.signOn();
    await phone.signOn();
    await phone.client.setAway([{ text: 'Out to lunch' }]);
    await waitFor(() => desk.client.awayRecord?.seq === 2, 'the desktop follows');
    fake.dropInstance('alice', 1);
    await waitFor(() => phone.client.state === 'reconnecting', 'the phone to notice the drop');
    await desk.client.setAway(null);
    expect(stored()).toMatchObject({ seq: 3, away: false });
    const from = bos().length;
    await timers.advance(2_000);
    await waitFor(() => phone.client.state === 'online', 'the phone to be online again');
    const snacs = bos().slice(from);
    const locates = snacs.filter(isLocate);
    expect(locates.map(awayText)).toEqual(['Out to lunch', '']);
    expect(snacs.indexOf(locates[1] as SnacRecord)).toBeLessThan(order(snacs).lastIndexOf('1/2'));
    expect(phone.client.awayMessage).toBeNull();
    expect(phone.client.awayRecord).toEqual(stored());
  });

  it('a start beside an away instance does not take an away that accept refuses', async () => {
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, AUTO)]));
    await signOn(desk, resume('restore', AUTO));
    expect(desk.client.awayMessage).toEqual([{ text: AUTO_TEXT }]);
    const asked: AwayRecord[] = [];
    const picky = atDesk(asked);
    const from = bos().length;
    await picky.signOn();
    await waitFor(() => readsSince(from) === 2, 'the second read');
    await settle(fake.port);
    expect(bos().slice(from).filter(isLocate).map(awayText)).not.toContain(AUTO_TEXT);
    expect([picky.client.awayMessage, picky.client.awayRecord, stored()]).toEqual([null, null, AUTO]);
    expect(asked).toContainEqual(AUTO);
  });

  it('a reconnect does not follow a moved-on record that accept refuses', async () => {
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, BACK)]));
    const asked: AwayRecord[] = [];
    const picky = atDesk(asked);
    await desk.signOn();
    await picky.signOn();
    await waitFor(() => reads() === 4, 'both second reads');
    await settle(fake.port);
    expect(picky.client.awayRecord).toEqual(BACK);
    fake.dropInstance('alice', 1);
    await waitFor(() => picky.client.state === 'reconnecting', 'the desktop to notice the drop');
    await desk.client.setAway([{ text: AUTO_TEXT }], { source: 'auto' });
    const auto = stored();
    expect(auto).toMatchObject({ seq: 2, away: true, text: AUTO_TEXT, source: 'auto' });
    const from = bos().length;
    await timers.advance(2_000);
    await waitFor(() => picky.client.state === 'online', 'the desktop to be online again');
    await waitFor(() => readsSince(from) === 2, 'the second read');
    await settle(fake.port);
    expect(bos().slice(from).filter(isLocate).map(awayText)).not.toContain(AUTO_TEXT);
    expect([picky.client.awayMessage, picky.client.awayRecord]).toEqual([null, BACK]);
    expect(asked).toContainEqual(auto);
  });

  it('a restore keeps the away it held when accept refuses the record that moved on', async () => {
    const held: AwayRecord = { ...BRB, seq: 3 };
    fake.setFeedbag('alice', withTypingPref([recordItem(0x4000, AUTO)]));
    const asked: AwayRecord[] = [];
    const picky = atDesk(asked);
    await signOn(picky, resume('restore', held));
    await waitFor(() => reads() === 2, 'the second read');
    await settle(fake.port);
    expect(bos().filter(isLocate).map(awayText)).toEqual(['brb']);
    expect([picky.client.awayMessage, picky.client.awayRecord, stored()]).toEqual([[{ text: 'brb' }], held, AUTO]);
    expect(asked).toContainEqual(AUTO);
  });

  it('a client without the option reads the feedbag once', async () => {
    const plain = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await plain.signOn();
    await settle(fake.port);
    expect(reads()).toBe(1);
  });
});
