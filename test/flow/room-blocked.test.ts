import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEEDBAG_ATTR_PD_MODE } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { tlv } from '../../src/wire/tlv.js';
import type { RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const LOBBY: RoomId = { exchange: 4, name: 'Lobby' };

const deny = (itemId: number, name: string): FeedbagItem => ({ name, groupId: 0, itemId, classId: 3, attrs: [] });
const privacy = (itemId: number, mode: number): FeedbagItem => ({ name: '', groupId: 0, itemId, classId: 4, attrs: [tlv.u8(FEEDBAG_ATTR_PD_MODE, mode)] });

let fake: FakeOscarServer;
let h: ClientHarness;

beforeEach(async () => {
  fake = await FakeOscarServer.start();
  fake.addUser('Alice', 'alicepw1');
  h = makeClient(fake);
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

async function lobby(list: FeedbagItem[]): Promise<void> {
  fake.setFeedbag('Alice', withTypingPref(list));
  await h.signOn();
  fake.rooms.peerJoin('Mallory', LOBBY);
  fake.rooms.peerJoin('Bob', LOBBY);
  await h.client.joinRoom(LOBBY);
}

describe('lines from senders on the Block list', () => {
  it('reach the user marked, whispers too, and a line from anyone else carries no mark', async () => {
    await lobby([privacy(1, 4), deny(2, 'mallory')]);
    fake.rooms.peerSay('Mallory', LOBBY, 'hi');
    fake.rooms.peerSay('Bob', LOBBY, 'hey');
    fake.rooms.peerSay('Mallory', LOBBY, 'psst', { whisperTo: 'Alice' });
    await waitFor(() => h.roomMessages.length === 3, 'the three lines');
    expect(h.roomMessages).toMatchObject([
      { from: 'Mallory', blocked: true, whisper: false },
      { from: 'Bob' },
      { from: 'Mallory', blocked: true, whisper: true },
    ]);
    expect('blocked' in (h.roomMessages[1] ?? {})).toBe(false);
  });

  it('are marked by the deny items under any mode, and a stranger is not marked under "Block everyone"', async () => {
    await lobby([privacy(1, 2), deny(2, 'mallory')]);
    fake.rooms.peerSay('Mallory', LOBBY, 'hi');
    fake.rooms.peerSay('Bob', LOBBY, 'hey');
    await waitFor(() => h.roomMessages.length === 2, 'the two lines');
    expect(h.roomMessages[0]).toMatchObject({ from: 'Mallory', blocked: true });
    expect('blocked' in (h.roomMessages[1] ?? {})).toBe(false);
  });

  it("do not mark the server's own line", async () => {
    await lobby([privacy(1, 4), deny(2, 'onlinehost')]);
    fake.rooms.peerSay('Bob', LOBBY, '//roll');
    await waitFor(() => h.roomMessages.length === 1, 'the roll');
    expect(h.roomMessages[0]).toMatchObject({ from: 'OnlineHost', fromServer: true });
    expect('blocked' in (h.roomMessages[0] ?? {})).toBe(false);
  });

  it('follow the list as it changes', async () => {
    await lobby([privacy(1, 4)]);
    fake.rooms.peerSay('Mallory', LOBBY, 'before');
    await waitFor(() => h.roomMessages.length === 1, 'the first line');
    await h.client.block('Mallory');
    fake.rooms.peerSay('Mallory', LOBBY, 'after');
    await waitFor(() => h.roomMessages.length === 2, 'the second line');
    expect(h.roomMessages.map((m) => m.blocked === true)).toEqual([false, true]);
  });
});
