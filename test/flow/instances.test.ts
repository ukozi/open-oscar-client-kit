import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toHex } from '../../src/wire/bytes.js';
import { CAP_CHAT, CAP_MOBILE_CLIENT, CAP_UTF8_MESSAGES } from '../../src/wire/constants.js';
import { decodeUserInfoUpdate, encodeClientVersions } from '../../src/wire/oservice.js';
import { userFlags } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { findTlv, tlv, tlvU8 } from '../../src/wire/tlv.js';
import { MOBILE_CAPABILITY, otherInstances } from '../../src/model/instances.js';
import type { UserInfoSnapshot } from '../../src/model/instances.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const PHONE_CAPS = [CAP_UTF8_MESSAGES, CAP_CHAT, CAP_MOBILE_CLIENT];

let timers: ManualTimers;
let fake: FakeOscarServer;
let phone: ClientHarness;
let desk: ClientHarness;

const locateWrites = (): number => fake.snacsFrom('alice').filter((s) => s.conn === 'bos' && s.family === 2 && s.subtype === 0x04).length;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([]));
  phone = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
  desk = makeClient(fake, { timers, oserviceVersion: 4 });
  await phone.signOn();
  await desk.signOn();
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe('the instances of a session', () => {
  it("lists every instance with its own status, and the session's away only when all are away", async () => {
    await desk.client.setInvisible(true);
    const before = locateWrites();
    await desk.client.setAway([{ text: 'out' }]);
    // The away goes out on the desk's connection; the server must have read it before the query on the other.
    await waitFor(() => locateWrites() > before, 'the away write');
    const snap = await phone.client.queryUserInfo();
    expect(snap.instances).toHaveLength(2);
    expect([snap.self?.mobile, snap.self?.capabilities?.includes(MOBILE_CAPABILITY)]).toEqual([true, true]);
    expect(otherInstances(snap)?.map((i) => [i.invisible, i.away, i.mobile])).toEqual([[true, true, false]]);
    expect(snap.session.away).toBe(false);
    expect(phone.client.userInfo()).toBe(snap);
  });

  it('the 90 s probe refreshes the snapshot', async () => {
    const seen: UserInfoSnapshot[] = [];
    phone.client.on('userInfo', (s) => seen.push(s));
    await timers.advance(90_000);
    await waitFor(() => seen.length === 1, 'the probe reply');
    expect(phone.client.userInfo()).toBe(seen[0]);
    expect(seen[0]?.instances).toHaveLength(2);
  });

  it('an unsolicited self info changes no snapshot', async () => {
    const before = phone.client.userInfo();
    expect(before?.instances).toHaveLength(1);
    fake.decayWarning('Alice', 50);
    fake.sendSelfInfo('alice');
    await waitFor(() => phone.client.self?.warnLevel === 50, 'the self info');
    expect(phone.client.userInfo()).toBe(before);
  });

  it('below version 4 the snapshot has no instances', async () => {
    const plain = makeClient(fake, { timers });
    await expect(plain.client.queryUserInfo()).rejects.toMatchObject({ info: { kind: 'not-signed-on' } });
    await plain.signOn();
    const snap = await plain.client.queryUserInfo();
    expect([snap.multiInstance, snap.instances, snap.self, snap.selfMatches]).toEqual([false, [], null, 0]);
  });

  it('two mobile instances on one address cannot tell themselves apart', async () => {
    const second = makeClient(fake, { timers, oserviceVersion: 4, capabilities: PHONE_CAPS });
    await second.signOn();
    const snap = await second.client.queryUserInfo();
    expect([snap.instances.length, snap.self, snap.selfMatches, otherInstances(snap)]).toEqual([3, null, 2, null]);
  });

  it('forgets the snapshot when the link goes', async () => {
    expect(phone.client.userInfo()).not.toBeNull();
    fake.dropInstance('alice', 0);
    await waitFor(() => phone.client.state === 'reconnecting', 'the drop');
    expect(phone.client.userInfo()).toBeNull();
  });
});

describe('the test server and the instances', () => {
  it('answers a version 4 query with the session block, then one block per instance in sign-on order', async () => {
    const { tlvs, client: auth } = await RawClient.login(fake.port, 'Alice', 'alicepw1', 0x01);
    auth.close();
    const raw = await RawClient.connect(fake.port);
    raw.signon([tlv.bytes(0x06, findTlv(tlvs, 0x06) ?? new Uint8Array(0))]);
    const reply = async (requestId: number): Promise<Snac> => {
      for (;;) {
        const snac = await raw.nextSnac();
        if (snac.requestId === requestId) return snac;
      }
    };
    raw.snac(1, 0x17, 1, encodeClientVersions([1], () => 4));
    await reply(1);
    raw.snac(1, 0x0e, 2);
    const [session, ...instances] = decodeUserInfoUpdate((await reply(2)).body);
    raw.close();
    expect(session?.tlvs.map((t) => t.tag)).toEqual([0x1e, 0x0a, 0x100a, 0x28, 0x03, 0x01, 0x06]);
    expect([toHex(findTlv(session?.tlvs ?? [], 0x0a) ?? new Uint8Array(0)), tlvU8(session?.tlvs ?? [], 0x28)]).toEqual(['7f000001', 1]);
    // The raw connection wrote no capabilities.
    expect(instances.map((i) => i.tlvs.map((t) => t.tag))).toEqual([
      [0x1e, 0x0a, 0x100a, 0x14, 0x0d, 0x01, 0x06, 0x03],
      [0x1e, 0x0a, 0x100a, 0x14, 0x0d, 0x01, 0x06, 0x03],
      [0x1e, 0x0a, 0x100a, 0x14, 0x01, 0x06, 0x03],
    ]);
    expect(instances.map((i) => [tlvU8(i.tlvs, 0x14), userFlags(i)])).toEqual([[1, 0x0090], [2, 0x0010], [3, 0x0010]]);
  });
});
