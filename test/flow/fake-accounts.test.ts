import { afterEach, describe, expect, it } from 'vitest';
import { ByteWriter } from '../../src/wire/bytes.js';
import { ICBM_CHANNEL_IM, ICBM_TLV_IM_DATA, USER_FLAG_BOT } from '../../src/wire/constants.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { encodeImFragments } from '../../src/wire/icbm.js';
import { decodeSnac, decodeUserInfo, userFlags } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { encodeTlvs, findTlv, tlv, tlvU16 } from '../../src/wire/tlv.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { StartOptions } from '../fake/oscar-server.js';

let fake: FakeOscarServer | undefined;
const open: RawClient[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) client.close();
  await fake?.stop();
  fake = undefined;
});

async function start(opts: StartOptions = {}): Promise<FakeOscarServer> {
  fake = await FakeOscarServer.start(opts);
  return fake;
}

async function signOn(server: FakeOscarServer, name: string, password: string): Promise<RawClient> {
  const client = await RawClient.signOn(server.port, name, password);
  open.push(client);
  return client;
}

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

function flagsAt(body: Uint8Array, offset = 0): number {
  return userFlags(decodeUserInfo(body, offset).info);
}

function selfInfo(client: RawClient): Snac {
  const found = snacsOf(client).find((s) => s.family === 0x01 && s.subtype === 0x0f);
  if (!found) throw new Error('no self info');
  return found;
}

let marker = 0x7000;
async function roundTrip(client: RawClient): Promise<void> {
  const requestId = marker++;
  client.snac(1, 0x17, requestId);
  await waitFor(() => snacsOf(client).some((s) => s.subtype === 0x18 && s.requestId === requestId), 'the version echo');
}

function sendIm(client: RawClient, to: string, text: string): void {
  const data = tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(0, new Uint8Array(Buffer.from(text, 'latin1'))));
  client.snac(4, 0x06, marker++, new ByteWriter().u64(1n).u16(ICBM_CHANNEL_IM).str8(to).bytes(encodeTlvs([data])).toBytes());
}

// Enough IMs at once to reach the limited level of the IM class, too few to reach its disconnect level.
const SENDS = 12;

const buddy = (name: string): FeedbagItem => ({ name, groupId: 1, itemId: 5, classId: 0, attrs: [] });

describe('the test server with checkPasswords', () => {
  it('with checkPasswords false a wrong password signs on and a missing name is made', async () => {
    const server = await start({ checkPasswords: false });
    server.addUser('Alice', 'alicepw1');
    await signOn(server, 'Alice', 'not the password');
    expect(server.instancesOf('alice')).toBe(1);
    await signOn(server, 'New Comer', 'anything');
    expect(server.displayOf('newcomer')).toBe('New Comer');
    expect(server.instancesOf('newcomer')).toBe(1);
  });

  it('with checkPasswords false a stored refusal still refuses', async () => {
    const server = await start({ checkPasswords: false });
    server.addUser('Sus', 'suspw1', { loginError: 0x0011 });
    const { tlvs, client } = await RawClient.login(server.port, 'Sus', 'anything');
    client.close();
    expect(tlvU16(tlvs, 0x08)).toBe(0x0011);
    expect(findTlv(tlvs, 0x06)).toBeUndefined();
  });

  it('with checkPasswords true, the default, a wrong password is refused 0x0005', async () => {
    const server = await start();
    server.addUser('Alice', 'alicepw1');
    const wrong = await RawClient.login(server.port, 'Alice', 'not the password');
    wrong.client.close();
    expect(tlvU16(wrong.tlvs, 0x08)).toBe(0x0005);
    expect(findTlv(wrong.tlvs, 0x06)).toBeUndefined();
    const missing = await RawClient.login(server.port, 'Nobody', 'anything');
    missing.client.close();
    expect(tlvU16(missing.tlvs, 0x08)).toBe(0x0001);
    expect(() => server.displayOf('nobody')).toThrow();
  });
});

describe('the test server with bot users', () => {
  async function botAndWatcher(bot: boolean): Promise<{ server: FakeOscarServer; alice: RawClient; bob: RawClient }> {
    const server = await start();
    server.addUser('Alice', 'alicepw1', { bot });
    server.addUser('Bob', 'bobpw1');
    server.setFeedbag('Bob', [buddy('alice')]);
    const bob = await signOn(server, 'Bob', 'bobpw1');
    const alice = await signOn(server, 'Alice', 'alicepw1');
    return { server, alice, bob };
  }

  const arrivalsOf = (client: RawClient): Snac[] => snacsOf(client).filter((s) => s.family === 0x03 && s.subtype === 0x0b);
  const imsOf = (client: RawClient): Snac[] => snacsOf(client).filter((s) => s.family === 0x04 && s.subtype === 0x07);

  it('a bot user carries flag 0x0400 in its self info and in the arrival a watcher gets', async () => {
    const { alice, bob } = await botAndWatcher(true);
    expect(flagsAt(selfInfo(alice).body) & USER_FLAG_BOT).toBe(USER_FLAG_BOT);
    await waitFor(() => arrivalsOf(bob).length > 0, 'the arrival of the bot');
    expect(flagsAt(arrivalsOf(bob)[0]?.body ?? new Uint8Array(0)) & USER_FLAG_BOT).toBe(USER_FLAG_BOT);
    sendIm(alice, 'Bob', 'hello');
    await waitFor(() => imsOf(bob).length > 0, 'the IM from the bot');
    // The sender block follows the cookie and the channel.
    expect(flagsAt(imsOf(bob)[0]?.body ?? new Uint8Array(0), 10) & USER_FLAG_BOT).toBe(USER_FLAG_BOT);
  });

  it('a user added without bot carries no 0x0400', async () => {
    const { alice, bob } = await botAndWatcher(false);
    expect(flagsAt(selfInfo(alice).body) & USER_FLAG_BOT).toBe(0);
    await waitFor(() => arrivalsOf(bob).length > 0, 'the arrival');
    expect(flagsAt(arrivalsOf(bob)[0]?.body ?? new Uint8Array(0)) & USER_FLAG_BOT).toBe(0);
    sendIm(alice, 'Bob', 'hello');
    await waitFor(() => imsOf(bob).length > 0, 'the IM');
    expect(flagsAt(imsOf(bob)[0]?.body ?? new Uint8Array(0), 10) & USER_FLAG_BOT).toBe(0);
  });

  it.each([true, false])('bot %s: the rate limiter counts the SNACs of the account', async (bot) => {
    const server = await start();
    server.addUser('Alice', 'alicepw1', { bot });
    const bob = server.peer('Bob');
    const alice = await signOn(server, 'Alice', 'alicepw1');
    for (let i = 0; i < SENDS; i++) sendIm(alice, 'Bob', `line ${i}`);
    await roundTrip(alice);
    expect(server.dropped('alice')).toBeGreaterThan(0);
    expect(bob.ims().length).toBeLessThan(SENDS);
  });

  it.each([true, false])('bot %s: a warning of a bot is refused, and of another user accepted', async (bot) => {
    const server = await start();
    server.addUser('Alice', 'alicepw1', { bot });
    const bob = server.peer('Bob');
    const alice = await signOn(server, 'Alice', 'alicepw1');
    sendIm(alice, 'Bob', 'hello');
    await waitFor(() => bob.ims().length === 1, 'the IM');
    bob.warn('Alice');
    await roundTrip(alice);
    const warned = snacsOf(alice).some((s) => s.family === 0x01 && s.subtype === 0x10);
    expect(warned).toBe(!bot);
  });
});
