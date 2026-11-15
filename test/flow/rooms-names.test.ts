import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

// Each printable ASCII punctuation mark, in a Buddy Chat name between two letters, is joined and spoken in end to end.
const PUNCTUATION = [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'];

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
  h = makeClient(server, { timers });
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

describe('room names with punctuation', () => {
  it('covers every printable ASCII punctuation mark', () => {
    const all = Array.from({ length: 0x7e - 0x20 }, (_, i) => String.fromCharCode(0x21 + i)).filter((c) => !/[0-9A-Za-z]/.test(c));
    expect(PUNCTUATION).toEqual(all);
  });

  it.each(PUNCTUATION)('a Buddy Chat named a%sb is joined and a line in it is echoed', async (c) => {
    await h.signOn();
    const room: RoomId = { exchange: 4, name: `a${c}b` };
    const status = await h.client.joinRoom(room);
    expect(status.state).toBe('joined');
    expect(status.name).toBe(`a${c}b`);
    // The send resolves on the server's echo of it.
    await expect(h.client.sendRoomMessage(status.id, [{ text: 'hello' }])).resolves.toEqual({ replacedBy: null, id: expect.stringMatching(/^[0-9a-f]+$/) });
    expect(h.client.rooms().map((r) => r.state)).toEqual(['joined']);
  });
});
