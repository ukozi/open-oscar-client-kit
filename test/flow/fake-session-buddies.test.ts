import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeNameList } from '../../src/wire/buddy.js';
import { BUDDY_ADD_BUDDIES, BUDDY_ARRIVED, BUDDY_DEL_BUDDIES, BUDDY_DEPARTED, FAMILY_BUDDY } from '../../src/wire/constants.js';
import { FEEDBAG_ATTR_PD_MODE } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeSnac, decodeUserInfo } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { findTlv, tlv } from '../../src/wire/tlv.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let fake: FakeOscarServer;
const open: RawClient[] = [];
beforeEach(async () => {
  fake = await FakeOscarServer.start();
  fake.addUser('Alice', 'alicepw1');
});
afterEach(async () => {
  for (const client of open.splice(0)) client.close();
  await fake.stop();
});

let marker = 0x7000;

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

async function roundTrip(client: RawClient): Promise<void> {
  const requestId = marker++;
  client.snac(1, 0x17, requestId);
  await waitFor(() => snacsOf(client).some((s) => s.subtype === 0x18 && s.requestId === requestId), 'the version echo');
}

// A bring-up with the session list in place of the feedbag. `names` null sends no 0x03/0x04; `feedbag` also uses the feedbag.
async function bringUp(names: readonly string[] | null, opts: { feedbag?: boolean } = {}): Promise<RawClient> {
  const { tlvs, client: auth } = await RawClient.login(fake.port, 'Alice', 'alicepw1');
  auth.close();
  const cookie = findTlv(tlvs, 0x06);
  if (!cookie) throw new Error('login failed');
  const bos = await RawClient.connect(fake.port);
  open.push(bos);
  bos.signon([tlv.bytes(0x06, cookie)]);
  await bos.nextSnac();
  if (names !== null) bos.snac(FAMILY_BUDDY, BUDDY_ADD_BUDDIES, marker++, encodeNameList(names));
  if (opts.feedbag) bos.snac(0x13, 0x07, marker++);
  bos.snac(1, 0x02, marker++);
  await roundTrip(bos);
  return bos;
}

function add(client: RawClient, names: readonly string[]): void {
  client.snac(FAMILY_BUDDY, BUDDY_ADD_BUDDIES, marker++, encodeNameList(names));
}

function remove(client: RawClient, names: readonly string[]): void {
  client.snac(FAMILY_BUDDY, BUDDY_DEL_BUDDIES, marker++, encodeNameList(names));
}

function named(client: RawClient, subtype: number): string[] {
  return snacsOf(client)
    .filter((s) => s.family === FAMILY_BUDDY && s.subtype === subtype)
    .map((s) => decodeUserInfo(s.body, 0).info.name);
}

const arrivals = (client: RawClient): string[] => named(client, BUDDY_ARRIVED);
const departures = (client: RawClient): string[] => named(client, BUDDY_DEPARTED);
const buddy = (name: string, itemId: number): FeedbagItem => ({ name, groupId: 1, itemId, classId: 0, attrs: [] });

describe('the test server with a session buddy list', () => {
  it('0x03/0x04 with names adds them and sends an arrival for each one online', async () => {
    const bob = fake.peer('Bob');
    fake.peer('Carol');
    fake.addUser('Dave', 'davepw1');
    const alice = await bringUp(['Bob', 'Carol', 'Dave']);
    expect(arrivals(alice).sort()).toEqual(['Bob', 'Carol']);
    fake.peer('Erin');
    add(alice, ['Erin']);
    await waitFor(() => arrivals(alice).includes('Erin'), 'the arrival of a name added after online');
    bob.signOff();
    await waitFor(() => departures(alice).length === 1, 'the departure');
    expect(departures(alice)).toEqual(['bob']);
    expect(snacsOf(alice).filter((s) => s.family === FAMILY_BUDDY && s.subtype === 0x01)).toEqual([]);
  });

  it('0x03/0x04 with no names is accepted and the account is then announced online', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    const alice = await bringUp([]);
    expect(snacsOf(alice).filter((s) => s.subtype === 0x01)).toEqual([]);
    await waitFor(() => bob.sightings().some((s) => s.name === 'Alice' && s.event === 'arrived'), 'the account online');
  });

  it('without 0x03/0x04 or a feedbag the account is not announced', async () => {
    const bob = fake.peer('Bob');
    bob.watch('Alice');
    await bringUp(null);
    expect(bob.sightings()).toEqual([]);
  });

  it('0x03/0x05 removes names and no later arrival comes for them', async () => {
    const bob = fake.peer('Bob');
    const carol = fake.peer('Carol');
    const alice = await bringUp(['Bob', 'Carol']);
    expect(arrivals(alice).sort()).toEqual(['Bob', 'Carol']);
    remove(alice, ['bob']);
    await roundTrip(alice);
    bob.setAway(true);
    carol.setAway(true);
    bob.signOff();
    await waitFor(() => arrivals(alice).length === 3, 'the arrival for the name kept');
    await roundTrip(alice);
    expect(arrivals(alice).sort()).toEqual(['Bob', 'Carol', 'Carol']);
    expect(departures(alice)).toEqual([]);
  });

  it('sessionBuddiesOf lists what the account holds, normalised', async () => {
    expect(fake.sessionBuddiesOf('Alice')).toEqual([]);
    const alice = await bringUp(['Bob Smith', 'carol', 'BOBSMITH']);
    expect(fake.sessionBuddiesOf('alice')).toEqual(['bobsmith', 'carol']);
    remove(alice, ['Bob Smith']);
    add(alice, ['Dave']);
    await roundTrip(alice);
    expect(fake.sessionBuddiesOf('A lice')).toEqual(['carol', 'dave']);
  });

  it('the session list ends with the session', async () => {
    const alice = await bringUp(['Bob']);
    expect(fake.sessionBuddiesOf('Alice')).toEqual(['bob']);
    alice.close();
    await waitFor(() => fake.instancesOf('Alice') === 0, 'the session to end');
    expect(fake.sessionBuddiesOf('Alice')).toEqual([]);
    const bob = fake.peer('Bob');
    const again = await bringUp([]);
    bob.setAway(true);
    await roundTrip(again);
    expect(arrivals(again)).toEqual([]);
  });

  it('a session list and a feedbag list on one account each bring their own arrivals once', async () => {
    fake.setFeedbag('Alice', [buddy('bob', 5), buddy('dave', 6)]);
    for (const name of ['Bob', 'Carol', 'Dave']) fake.peer(name);
    const alice = await bringUp(['Carol', 'Dave'], { feedbag: true });
    expect(arrivals(alice).sort()).toEqual(['Bob', 'Carol', 'Dave']);
  });

  it('a name that blocks everyone sends no arrival through the session list', async () => {
    const bob = fake.peer('Bob');
    fake.setFeedbag('Bob', [{ name: '', groupId: 0, itemId: 0x41, classId: 4, attrs: [tlv.u8(FEEDBAG_ATTR_PD_MODE, 2)] }]);
    fake.peer('Carol');
    const alice = await bringUp(['Bob', 'Carol']);
    bob.setAway(true);
    await roundTrip(alice);
    expect(arrivals(alice)).toEqual(['Carol']);
  });
});
