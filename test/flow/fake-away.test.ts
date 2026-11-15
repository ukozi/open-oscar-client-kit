import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTlv, tlv } from '../../src/wire/tlv.js';
import type { RichText } from '../../src/model/rich-text.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let timers: ManualTimers;
let fake: FakeOscarServer;
let first: ClientHarness;
let second: ClientHarness;
let bob: ClientHarness;

const locateWrites = (): number => fake.snacsFrom('alice').filter((s) => s.conn === 'bos' && s.family === 0x02 && s.subtype === 0x04).length;

// Each instance writes on its own connection: the server must have read the write before a query on another.
async function away(h: ClientHarness, text: string | null): Promise<void> {
  const before = locateWrites();
  await h.client.setAway(text === null ? null : [{ text }]);
  await waitFor(() => locateWrites() > before, 'the away write');
}

async function shown(asker: ClientHarness = bob): Promise<RichText | null | undefined> {
  const info = await asker.client.getInfo('Alice');
  return info.status === 'ok' ? info.awayMessage : undefined;
}

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  fake.setFeedbag('alice', withTypingPref([]));
  fake.setFeedbag('bob', withTypingPref([]));
  first = makeClient(fake, { timers });
  second = makeClient(fake, { timers });
  bob = makeClient(fake, { timers });
  await first.signOn();
  await second.signOn();
  await bob.signOn('Bob', 'bobpw1');
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe("the test server's away rules", () => {
  it('counts an instance still signing on as not away', async () => {
    await away(first, 'one');
    await away(second, 'two');
    expect(await shown()).toEqual([{ text: 'two' }]);
    const { tlvs, client: auth } = await RawClient.login(fake.port, 'Alice', 'alicepw1', 0x01);
    auth.close();
    const raw = await RawClient.connect(fake.port);
    raw.signon([tlv.bytes(0x06, findTlv(tlvs, 0x06) ?? new Uint8Array(0))]);
    // Host online: the server counts the instance, and it has not sent client online.
    await raw.nextSnac();
    expect(fake.instancesOf('alice')).toBe(3);
    expect(await shown()).toBeNull();
    raw.close();
    await waitFor(() => fake.instancesOf('alice') === 2, 'the raw instance to go');
    expect(await shown()).toEqual([{ text: 'two' }]);
  });

  it('serves the text of the latest away write', async () => {
    await away(first, 'one');
    await away(second, 'two');
    expect(await shown()).toEqual([{ text: 'two' }]);
    await away(first, 'three');
    expect(await shown()).toEqual([{ text: 'three' }]);
  });

  it('serves a text again when it is written again after another', async () => {
    await away(first, 'one');
    await away(second, 'two');
    await away(first, 'one');
    expect(await shown()).toEqual([{ text: 'one' }]);
  });

  it("answers the account's own query with a text only while every instance is away", async () => {
    await away(first, 'one');
    expect(await shown(first)).toBeNull();
    await away(second, 'two');
    expect(await shown(first)).toEqual([{ text: 'two' }]);
    await away(second, null);
    expect(await shown(second)).toBeNull();
  });
});
