import { afterEach, describe, expect, it } from 'vitest';
import type { RichText } from '../../src/model/rich-text.js';
import type { RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle } from '../fake/oscar-client.js';
import { fakeRateChange } from '../fake/oscar-rooms.js';
import type { FakeGeneration } from '../fake/oscar-rooms.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord } from '../fake/oscar-server.js';

const ROOM: RoomId = { exchange: 4, name: 'Dev Room' };
const IM_RATE_CLASS = 3;
const RATE_CODE_CLEAR = 4;

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;

async function start(generation: FakeGeneration): Promise<void> {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now, generation });
  server.addUser('Alice', 'alicepw1');
  h = makeClient(server, { timers });
  bob = server.peer('Bob');
  await h.signOn();
}

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const imsSent = (): SnacRecord[] => server.snacsFrom('alice').filter((s) => s.family === 4 && s.subtype === 6);
const text = (words: string): RichText => [{ text: words }];
const rateNotices = (): number => h.logs.lines.filter((l) => l.msg === 'rate notice').length;

describe('a BOS rate notice on the ChatNav connection', () => {
  it('v0.24: the client reports the rate as limited and holds its IMs, and a clear notice lifts both', async () => {
    await start('v0.24');
    server.rooms.strayRateOnNextNav();
    await h.client.joinRoom(ROOM);
    expect(h.rates).toEqual([{ limited: true }]);

    let sent = false;
    const send = h.client.sendIm('Bob', text('held back')).then(() => {
      sent = true;
    });
    await timers.advance(10_000);
    await settle(server.port);
    expect(imsSent()).toEqual([]);
    expect(sent).toBe(false);

    server.sendSnac('Alice', 1, 0x0a, fakeRateChange(RATE_CODE_CLEAR, IM_RATE_CLASS));
    await send;
    expect(h.rates).toEqual([{ limited: true }, { limited: false }]);
    expect(bob.ims().map((im) => im.html)).toEqual(['held back']);
    expect(h.logs.text()).not.toContain('a rate hold stopped');
  });

  it('main: no notice comes there, and an IM goes out at once', async () => {
    await start('main');
    server.rooms.strayRateOnNextNav();
    await h.client.joinRoom(ROOM);
    await h.client.sendIm('Bob', text('at once'));
    expect(h.rates).toEqual([]);
    expect(rateNotices()).toBe(0);
    expect(bob.ims().map((im) => im.html)).toEqual(['at once']);
  });
});
