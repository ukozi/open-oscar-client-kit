import { afterEach, describe, expect, it } from 'vitest';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { CHAT_MSG_TO_HOST, FAMILY_CHAT, FAMILY_ICBM, ICBM_MSG_TO_HOST } from '../../src/wire/constants.js';
import type { RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

const ROOM: RoomId = { exchange: 4, name: 'Bot Room' };
const IM_CLASS = 3;

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

async function start(alice: { bot: boolean }, options: Pick<OscarClientOptions, 'botFlagExempt'> = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1', alice);
  fake.peer('Bob');
  h = makeClient(fake, { timers, ...options });
  await h.signOn();
  // The server does not count the sends of a bot. The test server counts them, so here it must not end the session.
  fake.setRateParams('Alice', IM_CLASS, { disconnectLevel: 0 });
  await waitFor(() => h.logs.lines.some((l) => l.msg === 'rate notice'), 'the changed notice');
}

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const ims = (): SnacRecord[] => fake.snacsFrom('alice').filter((s) => s.family === FAMILY_ICBM && s.subtype === ICBM_MSG_TO_HOST);
const roomLines = (): SnacRecord[] => fake.snacsFrom('alice').filter((s) => s.family === FAMILY_CHAT && s.subtype === CHAT_MSG_TO_HOST);

function sendTwenty(): void {
  // Sends past the test server's limit get no acknowledgement and time out: that outcome is not what these tests check.
  for (let i = 0; i < 20; i++) h.client.sendIm('Bob', [{ text: `line ${i}` }]).catch(() => {});
}

async function pacedCount(): Promise<number> {
  await settle(fake.port);
  await waitFor(() => ims().length > 0, 'the first IM');
  await settle(fake.port);
  return ims().length;
}

describe('the exemption from pacing for user flag 0x0400', () => {
  it('with the option and a bot account, twenty IMs go out at once', async () => {
    await start({ bot: true }, { botFlagExempt: true });
    const at = timers.now();
    sendTwenty();
    await waitFor(() => ims().length === 20, 'twenty IMs');
    expect(timers.now()).toBe(at);
  });

  it('with the option and an account without the flag, sends are paced', async () => {
    await start({ bot: false }, { botFlagExempt: true });
    sendTwenty();
    expect(await pacedCount()).toBe(3);
  });

  it('without the option a bot account is paced', async () => {
    await start({ bot: true });
    sendTwenty();
    expect(await pacedCount()).toBe(3);
  });

  it('a rate notice under the exemption still fires the rate event and holds nothing', async () => {
    await start({ bot: true }, { botFlagExempt: true });
    fake.spend('Alice', IM_CLASS, 8);
    await waitFor(() => h.rates.some((r) => r.limited), 'the limited rate event');
    h.client.sendIm('Bob', [{ text: 'still sent' }]).catch(() => {});
    await waitFor(() => ims().length === 1, 'the IM');
    expect(h.rates).toEqual([{ limited: true }]);
  });

  it('a room send under the exemption is still paced', async () => {
    await start({ bot: true }, { botFlagExempt: true });
    fake.rooms.peerJoin('Bob', ROOM);
    const id = (await h.client.joinRoom(ROOM)).id;
    fake.rooms.setRoomRate('Alice', ROOM, 'limited');
    await settle(fake.port);
    h.client.sendRoomMessage(id, [{ text: 'held' }]).catch(() => {});
    sendTwenty();
    await waitFor(() => ims().length === 20, 'twenty IMs');
    await settle(fake.port);
    expect(roomLines()).toEqual([]);
    fake.rooms.setRoomRate('Alice', ROOM, 'clear');
    await waitFor(() => roomLines().length === 1, 'the room line after the clear notice');
  });
});
