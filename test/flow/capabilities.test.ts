import { afterEach, describe, expect, it } from 'vitest';
import { concatBytes, toHex } from '../../src/wire/bytes.js';
import { CAP_BUDDY_ICON, CAP_CHAT, CAP_DIRECT_IM, CAP_GET_FILE, CAP_SEND_FILE, CAP_UTF8_MESSAGES, LOCATE_TLV_CAPABILITIES } from '../../src/wire/constants.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { capabilityUuid } from '../../src/wire/oservice.js';
import { decodeTlvs, findTlv } from '../../src/wire/tlv.js';
import { DIRECT_IM_CAPABILITY, GET_FILE_CAPABILITY, SEND_FILE_CAPABILITY } from '../../src/model/buddy-list.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { treeSource } from '../fake/peer-get-file.js';

const BUDDIES: FeedbagItem = { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] };
const buddy = (name: string): FeedbagItem => ({ name, groupId: 1, itemId: 1, classId: 0, attrs: [] });
const DEFAULT_TWO = [CAP_UTF8_MESSAGES, CAP_CHAT];

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: ClientHarness;

// Alice and Bob have each other on their lists. Alice signs on first.
type Services = Pick<OscarClientOptions, 'fileTransfer' | 'directIm' | 'getFile' | 'buddyIcon'>;
const SEND_FILE_ONLY: Services = { fileTransfer: {} };

async function start(capabilities?: readonly Uint8Array[], services: Services = SEND_FILE_ONLY, relay = false): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, ...(relay && { timers: timers.api, relay }) });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw123');
  fake.setFeedbag('alice', withTypingPref([BUDDIES, buddy('bob')]));
  fake.setFeedbag('bob', withTypingPref([BUDDIES, buddy('alice')]));
  alice = makeClient(fake, { timers });
  bob = makeClient(fake, { timers, ...services, ...(capabilities && { capabilities }) });
  await alice.signOn();
  await bob.signOn('Bob', 'bobpw123');
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

// The capability block of the one Locate write of sign-on.
function written(name: string): string {
  const writes = fake.snacsFrom(name).filter((s) => s.conn === 'bos' && s.family === 2 && s.subtype === 0x04);
  expect(writes).toHaveLength(1);
  return toHex(findTlv(decodeTlvs(writes[0]?.body ?? new Uint8Array(0)), LOCATE_TLV_CAPABILITIES) ?? new Uint8Array(0));
}

describe('capabilities in presence', () => {
  it('shows Alice that Bob takes a file offer, and shows Bob that Alice does not', async () => {
    await start();
    await waitFor(() => alice.presence.some((p) => p.screenName === 'Bob' && p.online), 'Bob arrives');
    await waitFor(() => bob.presence.some((p) => p.screenName === 'Alice' && p.online), 'Alice arrives');
    expect(alice.presence.at(-1)).toMatchObject({ screenName: 'Bob', capabilities: expect.arrayContaining([SEND_FILE_CAPABILITY]) });
    expect(alice.client.presenceOf('Bob')?.capabilities).toContain(SEND_FILE_CAPABILITY);
    const seen = bob.presence.find((p) => p.screenName === 'Alice')?.capabilities;
    expect(seen).toEqual(DEFAULT_TWO.map(capabilityUuid));
    expect(seen).not.toContain(SEND_FILE_CAPABILITY);
  });

  it('shows Alice that Bob takes Direct IM when Bob has it on, and shows Bob that Alice does not', async () => {
    await start(undefined, { directIm: {} });
    await waitFor(() => alice.presence.some((p) => p.screenName === 'Bob' && p.online), 'Bob arrives');
    await waitFor(() => bob.presence.some((p) => p.screenName === 'Alice' && p.online), 'Alice arrives');
    expect(alice.presence.at(-1)).toMatchObject({ screenName: 'Bob', capabilities: expect.arrayContaining([DIRECT_IM_CAPABILITY]) });
    expect(alice.client.presenceOf('Bob')?.capabilities).not.toContain(SEND_FILE_CAPABILITY);
    expect(bob.presence.find((p) => p.screenName === 'Alice')?.capabilities).not.toContain(DIRECT_IM_CAPABILITY);
  });

  it('holds no capabilities for a buddy who signed off', async () => {
    await start();
    await waitFor(() => alice.client.presenceOf('Bob')?.online === true, 'Bob arrives');
    await bob.client.signOff();
    await waitFor(() => alice.client.presenceOf('Bob')?.online === false, 'Bob leaves');
    expect('capabilities' in (alice.client.presenceOf('Bob') ?? { capabilities: [] })).toBe(false);
  });
});

describe('capabilities written at sign-on', () => {
  it('a client built without fileTransfer writes exactly the default two capabilities', async () => {
    await start();
    expect(written('alice')).toBe(toHex(concatBytes(DEFAULT_TWO)));
  });

  it('a client built with fileTransfer writes the default two and Send File last', async () => {
    await start();
    expect(written('bob')).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_SEND_FILE])));
  });

  it('adds Send File to the capabilities the caller gave', async () => {
    await start([CAP_CHAT]);
    expect(written('bob')).toBe(toHex(concatBytes([CAP_CHAT, CAP_SEND_FILE])));
  });

  it('writes Send File one time when the caller gave it', async () => {
    await start([CAP_SEND_FILE, CAP_CHAT]);
    expect(written('bob')).toBe(toHex(concatBytes([CAP_SEND_FILE, CAP_CHAT])));
  });

  it('a client built with directIm writes the default two and Direct IM last, and no Send File', async () => {
    await start(undefined, { directIm: {} });
    expect(written('bob')).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_DIRECT_IM])));
    expect(written('alice')).toBe(toHex(concatBytes(DEFAULT_TWO)));
  });

  it('a client with fileTransfer and directIm writes the default two plus both, each one time', async () => {
    await start(undefined, { fileTransfer: {}, directIm: {} });
    expect(written('bob')).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_SEND_FILE, CAP_DIRECT_IM])));
  });

  it('writes Direct IM and Send File one time each when the caller gave both', async () => {
    await start([CAP_DIRECT_IM, CAP_SEND_FILE, CAP_CHAT], { fileTransfer: {}, directIm: {} });
    expect(written('bob')).toBe(toHex(concatBytes([CAP_DIRECT_IM, CAP_SEND_FILE, CAP_CHAT])));
  });
});

describe('the Get File capability', () => {
  const SOURCE = treeSource([{ path: ['a.txt'], bytes: new Uint8Array(10) }]);
  const GET_FILE: Services = { getFile: {} };
  // The capability block of each Locate write of the name, in order.
  const writes = (name: string): string[] =>
    fake.snacsFrom(name).filter((s) => s.conn === 'bos' && s.family === 2 && s.subtype === 0x04)
      .map((s) => toHex(findTlv(decodeTlvs(s.body), LOCATE_TLV_CAPABILITIES) ?? new Uint8Array(0)));
  const WITHOUT = toHex(concatBytes(DEFAULT_TWO));
  const WITH = toHex(concatBytes([...DEFAULT_TWO, CAP_GET_FILE]));
  const seen = (): readonly string[] | undefined => alice.presence.filter((p) => p.screenName === 'Bob').at(-1)?.capabilities;

  async function back(): Promise<void> {
    bob.client.dropConnection();
    await waitFor(() => bob.client.state === 'reconnecting', 'the drop');
    for (let second = 0; second < 120 && bob.client.state !== 'online'; second++) await timers.advance(1000);
    await waitFor(() => bob.client.state === 'online', 'the reconnect');
  }

  it('a client with getFile and no source writes the Get File capability at sign-on, and a buddy sees it', async () => {
    await start(undefined, GET_FILE);
    expect(writes('bob')).toEqual([WITH]);
    expect(written('alice')).toBe(WITHOUT);
    await waitFor(() => seen() !== undefined, 'Bob arrives');
    expect(seen()).toContain(GET_FILE_CAPABILITY);
  });

  it('a client without getFile writes no Get File capability', async () => {
    await start(undefined, { fileTransfer: {}, directIm: {} });
    expect(written('bob')).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_SEND_FILE, CAP_DIRECT_IM])));
  });

  it('a client with the three services writes each capability one time, Get File last', async () => {
    await start(undefined, { fileTransfer: {}, directIm: {}, getFile: {} });
    expect(writes('bob')).toEqual([toHex(concatBytes([...DEFAULT_TWO, CAP_SEND_FILE, CAP_DIRECT_IM, CAP_GET_FILE]))]);
  });

  it('a Get File capability that the caller gave is written one time', async () => {
    await start([CAP_GET_FILE, CAP_CHAT], GET_FILE);
    expect(writes('bob')).toEqual([toHex(concatBytes([CAP_GET_FILE, CAP_CHAT]))]);
  });

  it('shareFiles(source) and shareFiles(null) write nothing to the server, and the buddy hears no new presence', async () => {
    await start(undefined, GET_FILE);
    await waitFor(() => seen() !== undefined, 'Bob arrives');
    const locate = (): number => fake.snacsFrom('bob').filter((s) => s.family === 2).length;
    const sent = locate();
    const heard = alice.presence.length;
    await bob.client.shareFiles(SOURCE);
    await bob.client.shareFiles(null);
    await imRoundTrip(fake, bob);
    expect(locate()).toBe(sent);
    expect(writes('bob')).toEqual([WITH]);
    expect(alice.presence).toHaveLength(heard);
  });

  it('after a reconnect the capability is written again, with a source and with none', async () => {
    await start(undefined, GET_FILE);
    await back();
    await bob.client.shareFiles(SOURCE);
    await back();
    expect(writes('bob')).toEqual([WITH, WITH, WITH]);
  });

  it('after signOff and a new signOn, of the same name or another, the capability is written and a proposal is declined at once', async () => {
    await start(undefined, GET_FILE, true);
    fake.addUser('Carol', 'carolpw1');
    const dave = fake.peer('Dave');
    await bob.client.shareFiles(SOURCE);
    await bob.client.signOff();
    await bob.signOn('Bob', 'bobpw123');
    expect(writes('bob')).toEqual([WITH, WITH]);
    expect((await dave.browseFiles('Bob')).outcome).toBe('declined');
    expect(bob.shareRequests).toEqual([]);
    await bob.client.shareFiles(SOURCE);
    await bob.client.signOff();
    await bob.signOn('Carol', 'carolpw1');
    expect(writes('carol')).toEqual([WITH]);
    expect((await dave.browseFiles('Carol')).outcome).toBe('declined');
    expect(bob.shareRequests).toEqual([]);
  });

  it('shareFiles on a client that is not online rejects not-signed-on and stores nothing', async () => {
    await start(undefined, GET_FILE, true);
    await bob.client.signOff();
    await expect(bob.client.shareFiles(SOURCE)).rejects.toMatchObject({ name: 'OscarError', info: { kind: 'not-signed-on' } });
    await bob.signOn('Bob', 'bobpw123');
    expect((await fake.peer('Dave').browseFiles('Bob')).outcome).toBe('declined');
    expect(bob.shareRequests).toEqual([]);
  });
});

describe('the Buddy Icon capability', () => {
  it('has the id of the Buddy Icon capability', () => {
    expect(capabilityUuid(CAP_BUDDY_ICON)).toBe('09461346-4C7F-11D1-8222-444553540000');
  });

  it('a client with buddyIcon writes the default two and Buddy Icon last, and a buddy sees it', async () => {
    await start(undefined, { buddyIcon: true });
    expect(written('bob')).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_BUDDY_ICON])));
    await waitFor(() => alice.presence.some((p) => p.screenName === 'Bob' && p.online), 'Bob arrives');
    expect(alice.client.presenceOf('Bob')?.capabilities).toContain(capabilityUuid(CAP_BUDDY_ICON));
  });

  it('a client without buddyIcon, or with buddyIcon false, writes no Buddy Icon capability', async () => {
    await start(undefined, { buddyIcon: false });
    expect(written('alice')).toBe(toHex(concatBytes(DEFAULT_TWO)));
    expect(written('bob')).toBe(toHex(concatBytes(DEFAULT_TWO)));
  });

  it('a client with the three services and buddyIcon writes each capability one time, Buddy Icon last', async () => {
    await start(undefined, { fileTransfer: {}, directIm: {}, getFile: {}, buddyIcon: true });
    expect(written('bob')).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_SEND_FILE, CAP_DIRECT_IM, CAP_GET_FILE, CAP_BUDDY_ICON])));
  });

  it('a Buddy Icon capability that the caller gave is written one time', async () => {
    await start([CAP_BUDDY_ICON, CAP_CHAT], { buddyIcon: true });
    expect(written('bob')).toBe(toHex(concatBytes([CAP_BUDDY_ICON, CAP_CHAT])));
  });
});
