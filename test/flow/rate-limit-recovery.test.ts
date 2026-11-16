import { afterEach, describe, expect, it } from 'vitest';
import type { RichText } from '../../src/model/rich-text.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';

const IM_CLASS = 3;
const WINDOW = 20;
const CLEAR = 5100;
const MARGIN_MS = 660;

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;

async function boot(rateMonitor: boolean): Promise<void> {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now, timers: timers.api, rateMonitor });
  server.addUser('Alice', 'alicepw1');
  h = makeClient(server, { timers });
  bob = server.peer('Bob');
  await h.signOn();
}

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const text = (words: string): RichText => [{ text: words }];
const imsSent = (): number => server.snacsFrom('alice').filter((s) => s.family === 4 && s.subtype === 6).length;
const html = (im: { html: string }): string => im.html;
const lastNotice = (): { code: number; level: number } | undefined => server.rateNotices('alice').at(-1);

type Outcome = { done: boolean; error?: unknown };
function track(promise: Promise<unknown>): Outcome {
  const outcome: Outcome = { done: false };
  promise.then(
    () => {
      outcome.done = true;
    },
    (error: unknown) => {
      outcome.done = true;
      outcome.error = error;
    },
  );
  return outcome;
}

// Another session of the account sends until the server limits the class. The limit notice is still on its way when the client writes `count` IMs.
// The server drops each of them, and each drop moves its level: a limited send still counts.
async function burstIntoLimit(count: number): Promise<{ firsts: Outcome[]; droppedAt: number; serverLevel: number }> {
  const release = server.withhold(1, 0x0a);
  for (let i = 0; i < 40 && lastNotice()?.code !== 3; i++) server.spend('alice', IM_CLASS, 1);
  expect(lastNotice()?.code).toBe(3);
  let serverLevel = lastNotice()?.level ?? 0;
  const droppedAt = timers.now();
  const firsts = Array.from({ length: count }, (_, i) => track(h.client.sendIm('Bob', text(`first copy ${i}`))));
  await waitFor(() => server.dropped('alice') === count, 'the dropped IMs');
  for (let i = 0; i < count; i++) serverLevel = Math.trunc((serverLevel * (WINDOW - 1)) / WINDOW);
  release();
  await waitFor(() => h.rates.at(-1)?.limited === true, 'the limit notice');
  return { firsts, droppedAt, serverLevel };
}

// The clock goes from timer to timer until the server has one more IM. Returns the time of that timer.
async function untilNextIm(maxMs: number): Promise<number> {
  const before = imsSent();
  const end = timers.now() + maxMs;
  while (timers.now() < end && imsSent() === before) {
    await timers.advance(Math.max(1, timers.pending()[0] ?? 1000));
    await settle(server.port);
  }
  return timers.now();
}

describe('recovery after the server limits a rate class', () => {
  it.each([
    ['sends a clear notice', true, 1],
    ['stays silent', false, 1],
    ['sends a clear notice', true, 3],
    ['stays silent', false, 3],
  ])('a server that %s (monitor %s), %i IMs dropped: the second copy goes when the server is back, and the server drops no more', async (_name, rateMonitor, count) => {
    await boot(rateMonitor);
    const { firsts, droppedAt, serverLevel } = await burstIntoLimit(count);
    // A send ends the limit when it leaves the server at its clear level.
    const backAfter = WINDOW * CLEAR - (WINDOW - 1) * serverLevel;
    // The host sends the second copy at once. The client keeps it until it lets a send go.
    const second = track(h.client.sendIm('Bob', text('second copy')));
    const secondAfter = (await untilNextIm(120_000)) - droppedAt;
    // A copy that the server drops gets no acknowledgement and ends after 15 s.
    for (let waited = 0; waited < 16_000 && !second.done; waited += 1000) {
      await settle(server.port);
      if (!second.done) await timers.advance(1000);
    }
    await waitFor(() => second.done, 'the second copy to end');

    expect({ secondAfter, failed: second.error !== undefined, dropped: server.dropped('alice'), got: bob.ims().map(html) }).toEqual({
      secondAfter,
      failed: false,
      dropped: count,
      got: ['second copy'],
    });
    expect(secondAfter).toBeGreaterThanOrEqual(backAfter);
    // The pacing margin is 33 of level, 660 ms in a window of 20.
    expect(secondAfter).toBeLessThanOrEqual(backAfter + MARGIN_MS);
    expect(h.rates.at(-1)).toEqual({ limited: false });
    // The first copies get no acknowledgement.
    await timers.advance(15_000);
    await waitFor(() => firsts.every((f) => f.done), 'the first copies to end');
    expect(firsts.every((f) => f.error !== undefined)).toBe(true);
    expect(server.dropped('alice')).toBe(count);
  });
});
