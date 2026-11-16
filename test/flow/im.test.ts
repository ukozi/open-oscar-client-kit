import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OscarError } from '../../src/client/errors.js';
import { imFailureReason } from '../../src/client/messaging.js';
import type { RichText } from '../../src/model/rich-text.js';
import type { ImFailureReason } from '../../src/model/session.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord } from '../fake/oscar-server.js';

let timers: ManualTimers;
let server: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
  h = makeClient(server, { timers });
  bob = server.peer('Bob');
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

const imsSent = (): SnacRecord[] => server.snacsFrom('alice').filter((s) => s.family === 4 && s.subtype === 6);
const html = (im: { html: string }): string => im.html;
const text = (words: string): RichText => [{ text: words }];

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

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

const settled = (outcome: Outcome, what: string): Promise<void> => waitFor(() => outcome.done, what);

describe('instant messages', () => {
  it('sends a formatted IM and resolves on the acknowledgement', async () => {
    await h.signOn();
    await h.client.sendIm('Bob', [{ text: 'hi ' }, { text: 'there', bold: true }]);
    expect(bob.ims().map((im) => [im.html, im.charset])).toEqual([['hi <B>there</B>', 0]]);
  });

  it('sends emoji and non-Latin text as Unicode and it arrives intact', async () => {
    await h.signOn();
    await h.client.sendIm('Bob', text('héllo 🙂 привет'));
    expect(bob.ims().map((im) => [im.html, im.charset])).toEqual([['héllo 🙂 привет', 2]]);
  });

  it('receives an IM as RichText', async () => {
    await h.signOn();
    bob.sendIm('Alice', '<FONT COLOR="#ff0000">red</FONT> &amp; <A HREF="https://chimr.app/">link</A>');
    await waitFor(() => h.ims.length === 1, 'the IM');
    expect(h.ims[0]).toEqual({
      from: 'Bob',
      body: [{ text: 'red', color: '#ff0000' }, { text: ' & ' }, { text: 'link', link: 'https://chimr.app/' }],
      autoResponse: false,
      at: timers.now(),
      offline: false,
      serverNotice: false,
    });
  });

  it('refuses to send while not signed on and sends nothing', async () => {
    const before = (await errorOf(h.client.sendIm('Bob', text('too early')))) as OscarError;
    expect(before.info).toEqual({ kind: 'not-signed-on' });
    await h.signOn();
    await h.client.signOff();
    const after = (await errorOf(h.client.sendIm('Bob', text('too late')))) as OscarError;
    expect(after.info).toEqual({ kind: 'not-signed-on' });
    await settle(server.port);
    expect(imsSent()).toEqual([]);
  });

  it('refuses a message over the advertised limit before sending', async () => {
    await h.signOn();
    const error = (await errorOf(h.client.sendIm('Bob', text('a'.repeat(513))))) as OscarError;
    expect(error.info).toEqual({ kind: 'local', code: 'message-too-long' });
    await settle(server.port);
    expect(imsSent()).toEqual([]);
  });

  it('refuses a recipient that cannot be sent, as a typed error, before sending', async () => {
    await h.signOn();
    for (const to of ['   ', 'a'.repeat(256)]) {
      const error = await errorOf(h.client.sendIm(to, text('x')));
      expect(error).toBeInstanceOf(OscarError);
      expect((error as OscarError).info).toEqual({ kind: 'local', code: 'invalid-screen-name' });
    }
    await settle(server.port);
    expect(imsSent()).toEqual([]);
  });

  const refusals: [string, () => Promise<string>, { reason: ImFailureReason; code?: number }][] = [
    [
      'the recipient blocks the sender',
      async () => {
        server.failNext(4, 6, { code: 0x10 });
        return 'Bob';
      },
      { reason: 'youBlocked' },
    ],
    ['the recipient does not exist', async () => 'Nobody1', { reason: 'unavailable' }],
    [
      'the offline inbox is full',
      async () => {
        server.addUser('Carol', 'carolpw1');
        // Ten seconds apart keeps the client's governor and the test server's class 3 at their maximum.
        for (let i = 0; i < 10; i++) {
          await timers.advance(10_000);
          await h.client.sendIm('Carol', text(`stored ${i}`));
        }
        await timers.advance(10_000);
        return 'Carol';
      },
      { reason: 'offlineInboxFull' },
    ],
    [
      'any other code',
      async () => {
        server.failNext(4, 6, { code: 0x0e });
        return 'Bob';
      },
      { reason: 'other', code: 0x0e },
    ],
  ];

  it.each(refusals)('fails with each server error: %s', async (_name, arrange, failure) => {
    await h.signOn();
    const to = await arrange();
    expect(imFailureReason(await errorOf(h.client.sendIm(to, text('hello'))))).toEqual(failure);
    expect(server.dropped('alice')).toBe(0);
  });

  it('stores an IM for an offline account and reports it sent', async () => {
    server.addUser('Carol', 'carolpw1');
    await h.signOn();
    await expect(h.client.sendIm('Carol', text('for later'))).resolves.toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), stored: true });
    expect(server.storedFor('carol')).toHaveLength(1);
  });

  it('fails as unconfirmed when the acknowledgement never arrives', async () => {
    await h.signOn();
    server.withhold(4, 0x0c);
    const send = track(h.client.sendIm('Bob', text('anyone there')));
    await waitFor(() => bob.ims().length === 1, 'the IM to be delivered');
    await timers.advance(14_999);
    expect(send.done).toBe(false);
    await timers.advance(1);
    expect(send.done).toBe(true);
    expect(imFailureReason(send.error)).toEqual({ reason: 'unconfirmed' });
    expect(bob.ims().map(html)).toEqual(['anyone there']);
  });

  it("is not failed by a peer's typing event or client error that carries the pending IM's request id", async () => {
    await h.signOn();
    const release = server.withhold(4, 0x0c);
    const send = track(h.client.sendIm('Bob', text('are you typing')));
    await waitFor(() => imsSent().length === 1, 'the IM to reach the test server');
    const requestId = imsSent()[0]?.requestId ?? -1;
    // Written before the acknowledgement, so the client reads them first.
    bob.sendTyping('Alice', 2, requestId);
    bob.sendClientError('Alice', 1, requestId);
    release();
    await settled(send, 'the send to settle');
    expect(send.error).toBeUndefined();
    expect(bob.ims().map(html)).toEqual(['are you typing']);
    bob.sendIm('Alice', 'yes');
    await waitFor(() => h.ims.length === 1, 'the next IM');
  });

  it("stays unconfirmed when only a peer's typing event came on the pending IM's request id", async () => {
    await h.signOn();
    server.withhold(4, 0x0c);
    const send = track(h.client.sendIm('Bob', text('anyone')));
    await waitFor(() => imsSent().length === 1, 'the IM to reach the test server');
    bob.sendTyping('Alice', 2, imsSent()[0]?.requestId ?? -1);
    await settle(server.port);
    await timers.advance(14_999);
    expect(send.done).toBe(false);
    await timers.advance(1);
    expect(imFailureReason(send.error)).toEqual({ reason: 'unconfirmed' });
  });

  it('fails as rate limited when the class is reported limited before the timeout', async () => {
    await h.signOn();
    server.withhold(4, 0x0c);
    const send = track(h.client.sendIm('Bob', text('one too many')));
    await waitFor(() => imsSent().length === 1, 'the IM to reach the test server');
    server.spend('alice', 3, 8);
    await waitFor(() => h.rates.length === 1, 'the limited notice');
    await timers.advance(15_000);
    expect(send.done).toBe(true);
    expect(imFailureReason(send.error)).toEqual({ reason: 'rateLimited' });
    expect(h.rates).toEqual([{ limited: true }]);
  });

  it('reports the rate as clear when the session ends while limited', async () => {
    await h.signOn();
    server.spend('alice', 3, 8);
    await waitFor(() => h.rates.at(-1)?.limited === true, 'the limited notice');
    await h.client.signOff();
    expect(h.rates.at(-1)).toEqual({ limited: false });
    const before = h.rates.length;
    await h.signOn();
    await h.client.signOff();
    expect(h.rates).toHaveLength(before);
  });

  it('a burst is paced and none is dropped', async () => {
    await h.signOn();
    const order = Array.from({ length: 10 }, (_, i) => `message ${i}`);
    const sends = order.map((words) => track(h.client.sendIm('Bob', text(words))));
    await timers.advance(0);
    await waitFor(() => sends.filter((s) => s.done).length === 3, 'the first three acknowledgements');
    await settle(server.port);
    expect(bob.ims()).toHaveLength(3);
    // The next timer is the class's pacing. The clock goes to it and waits there until the server acknowledges the send it let go.
    // Then no send is on its way when the clock moves on and counted late.
    for (const [at, send] of sends.entries()) {
      if (send.done) continue;
      await timers.advance(timers.pending()[0] ?? 0);
      await waitFor(() => send.done, `the acknowledgement of message ${at}`);
    }
    expect(sends.map((s) => [s.done, s.error])).toEqual(order.map(() => [true, undefined]));
    expect(bob.ims().map(html)).toEqual(order);
    expect(server.dropped('alice')).toBe(0);
    expect(server.rateNotices('alice')).toEqual([]);
  });

  it('holds IMs after an alert caused by another session of the same account until the server reports clear', async () => {
    await h.signOn();
    server.spend('alice', 3, 4);
    await waitFor(() => h.logs.lines.some((l) => l.msg === 'rate notice'), 'the alert notice');
    const send = track(h.client.sendIm('Bob', text('held back')));
    await timers.advance(7500);
    await settle(server.port);
    expect(send.done).toBe(false);
    expect(imsSent()).toEqual([]);
    // 7500 ms on, one more send is over the alert line: the monitor reports clear (code 4).
    server.rateTick('alice');
    await waitFor(() => h.logs.lines.filter((l) => l.msg === 'rate notice').length === 2, 'the clear notice');
    // The hold is over. The pacing keeps the IM until a send is the margin over the line: 20 * 5033 - 19 * 4886 = 7826 ms after the alert.
    expect(timers.pending()).toContain(326);
    await timers.advance(326);
    await settled(send, 'the held IM to be acknowledged');
    expect(send.error).toBeUndefined();
    expect(server.rateNotices('alice').map((n) => n.code)).toEqual([2, 4]);
    expect(bob.ims().map(html)).toEqual(['held back']);
    expect(h.rates).toEqual([]);
  });

  it('holds IMs after an alert caused by another session until its own count of the level is back at the alert level and the margin, when the server stays silent', async () => {
    await h.signOn();
    server.spend('alice', 3, 4);
    await waitFor(() => h.logs.lines.some((l) => l.msg === 'rate notice'), 'the alert notice');
    const send = track(h.client.sendIm('Bob', text('held back')));
    // The notice has level 4886. A send leaves it at 5033 after 20 * 5033 - 19 * 4886 = 7826 ms.
    await timers.advance(7825);
    await settle(server.port);
    expect(send.done).toBe(false);
    expect(imsSent()).toEqual([]);
    await timers.advance(1);
    await settled(send, 'the held IM to be acknowledged');
    expect(send.error).toBeUndefined();
    // The send is over the alert line, thus the server reports clear with it.
    expect(server.rateNotices('alice')).toEqual([{ code: 2, classId: 3, level: 4886 }, { code: 4, classId: 3, level: 5033 }]);
    expect(server.dropped('alice')).toBe(0);
    expect(bob.ims().map(html)).toEqual(['held back']);
  });

  it('a malformed IM is logged and skipped and the session continues', async () => {
    await h.signOn();
    bob.sendRaw('Alice', 1, [{ tag: 0x02, value: Uint8Array.of(0x01, 0x01, 0xff) }]);
    bob.sendIm('Alice', 'still here');
    await waitFor(() => h.ims.length === 1, 'the IM after the malformed one');
    expect(h.ims.map((im) => im.body)).toEqual([[{ text: 'still here' }]]);
    expect(h.client.state).toBe('online');
    const warnings = h.logs.lines.filter((l) => l.level === 'warn' && l.fields?.family === 4 && l.fields?.subtype === 7);
    expect(warnings).toHaveLength(1);
    expect(h.logs.text()).not.toContain('still here');
  });

  it('never logs a message body', async () => {
    await h.signOn();
    await h.client.sendIm('Bob', text('outgoing secret words'));
    bob.sendIm('Alice', 'incoming secret words');
    await waitFor(() => h.ims.length === 1, 'the IM');
    expect(h.logs.text()).not.toContain('outgoing secret words');
    expect(h.logs.text()).not.toContain('incoming secret words');
  });
});

describe('IMs held by a rate alert', () => {
  // The server's clock runs `lag` ms ahead of the client's: a larger lag on one arrival makes the next gap shorter for the server.
  let lag = 0;

  async function restart(opts: { rateMonitor: boolean }): Promise<void> {
    await server.stop();
    lag = 0;
    // The clock of the server does not go back when the lag falls.
    let latest = 0;
    const now = (): number => {
      latest = Math.max(latest, timers.now() + lag);
      return latest;
    };
    server = await FakeOscarServer.start({ now, timers: timers.api, rateMonitor: opts.rateMonitor });
    server.addUser('Alice', 'alicepw1');
    h = makeClient(server, { timers });
    bob = server.peer('Bob');
  }

  // Six IMs. The first four arrive 800 ms late and the fifth on time, so the server counts the fifth 800 ms early: level 4993, an alert.
  async function burstIntoAlert(): Promise<Outcome[]> {
    lag = 800;
    await h.signOn();
    const sends = Array.from({ length: 6 }, (_, i) => track(h.client.sendIm('Bob', text(`message ${i}`))));
    await timers.advance(0);
    await waitFor(() => sends.filter((s) => s.done).length === 3, 'the first three acknowledgements');
    await timers.advance(2924);
    await settled(sends[3] as Outcome, 'the acknowledgement of message 3');
    lag = 0;
    await timers.advance(5033);
    await settled(sends[4] as Outcome, 'the acknowledgement of message 4');
    await waitFor(() => h.logs.lines.some((l) => l.msg === 'rate notice'), 'the alert notice');
    expect(server.rateNotices('alice')).toEqual([{ code: 2, classId: 3, level: 4993 }]);
    expect(sends[5]?.done).toBe(false);
    return sends;
  }

  // The clock goes from timer to timer. At each timer it waits until the server acknowledged each IM that the client let go.
  async function runOut(sends: Outcome[], beforeEach: () => void = () => {}): Promise<void> {
    const end = timers.now() + 900_000;
    while (sends.some((s) => !s.done) && timers.now() < end) {
      beforeEach();
      await timers.advance(timers.pending()[0] ?? 1000);
      await settle(server.port);
      await waitFor(() => sends.filter((s) => s.done).length >= imsSent().length, 'the acknowledgement of each IM that the server has');
    }
  }

  // The same numbers for each run of one seed.
  function numbers(seed: number): () => number {
    let x = seed;
    return () => {
      x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
      return x / 2_147_483_648;
    };
  }

  it('a burst of ten IMs that arrive 5 ms early or late raises no alert and takes the paced time', async () => {
    await restart({ rateMonitor: false });
    await h.signOn();
    const start = timers.now();
    const order = Array.from({ length: 10 }, (_, i) => `message ${i}`);
    const sends = order.map((words) => track(h.client.sendIm('Bob', text(words))));
    await timers.advance(0);
    await waitFor(() => sends.filter((s) => s.done).length === 3, 'the first three acknowledgements');
    let late = true;
    await runOut(sends, () => {
      // Each second arrival is 5 ms late, thus the server counts the gap after it 5 ms short.
      lag = late ? 5 : 0;
      late = !late;
    });
    expect(sends.map((s) => [s.done, s.error])).toEqual(order.map(() => [true, undefined]));
    expect(server.rateNotices('alice')).toEqual([]);
    expect(h.logs.text()).not.toContain('rate hold');
    // Three IMs at once, the fourth after 2924 ms, then one each 5033 ms: 858 ms more than with no margin.
    expect(timers.now() - start).toBe(2924 + 6 * 5033);
    expect(bob.ims().map(html)).toEqual(order);
    expect(server.dropped('alice')).toBe(0);
  });

  it.each([
    [1, false], [2, false], [3, false], [1, true], [2, true], [3, true],
  ])('30 IMs that arrive up to 3 s late, seed %i, monitor %s: the class is never limited, and no IM waits long', async (seed, rateMonitor) => {
    await restart({ rateMonitor });
    await h.signOn();
    const start = timers.now();
    const random = numbers(seed);
    const order = Array.from({ length: 30 }, (_, i) => `message ${i}`);
    const sends = order.map((words) => track(h.client.sendIm('Bob', text(words))));
    let seen = -1;
    let longest = 0;
    let last = start;
    await runOut(sends, () => {
      const count = imsSent().length;
      if (count === seen) return;
      if (count > 3 && seen >= 0) longest = Math.max(longest, timers.now() - last);
      last = timers.now();
      seen = count;
      lag = Math.floor(random() * 3000);
    });
    expect(sends.map((s) => [s.done, s.error])).toEqual(order.map(() => [true, undefined]));
    expect(h.client.state).toBe('online');
    expect(server.dropped('alice')).toBe(0);
    expect(server.rateNotices('alice').filter((n) => n.code === 3)).toEqual([]);
    expect(server.rateNotices('alice').every((n) => n.level >= 4000)).toBe(true);
    expect(h.rates).toEqual([]);
    expect(bob.ims().map(html)).toEqual(order);
    // The longest wait goes from the lowest level of an alert here back to the alert level and the margin.
    expect(longest).toBeLessThanOrEqual(12_000);
    expect(timers.now() - start).toBeLessThanOrEqual(30 * 7200);
  });

  it('a burst goes out between the alerts and the clears of the rate monitor of the server', async () => {
    await restart({ rateMonitor: true });
    await h.signOn();
    const sends = Array.from({ length: 6 }, (_, i) => track(h.client.sendIm('Bob', text(`message ${i}`))));
    const start = timers.now();
    await timers.advance(0);
    await waitFor(() => sends.filter((s) => s.done).length === 3, 'the first three acknowledgements');
    // Each second the monitor reports an alert when one more send is under the alert level. The send that the client lets go is over the alert level, thus the server reports clear with it.
    await runOut(sends);
    expect(sends.map((s) => [s.done, s.error])).toEqual(sends.map(() => [true, undefined]));
    expect(server.rateNotices('alice').map((n) => [n.code, n.level])).toEqual([[2, 5144], [4, 5033], [2, 5033], [4, 5033], [2, 5033], [4, 5033]]);
    // An alert does not make the burst longer: the sends go at 2924 ms and then each 5033 ms, as with no notice.
    expect(timers.now() - start).toBe(2924 + 2 * 5033);
    expect(bob.ims().map(html)).toEqual(sends.map((_, i) => `message ${i}`));
    expect(server.dropped('alice')).toBe(0);
  });

  it('goes out when the count of the client is back at the alert level and the margin, when the server never reports clear', async () => {
    await restart({ rateMonitor: false });
    const sends = await burstIntoAlert();
    // A send leaves level 4993 at 5033 after 20 * 5033 - 19 * 4993 = 5793 ms.
    await timers.advance(5792);
    await settle(server.port);
    expect(sends[5]?.done).toBe(false);
    expect(imsSent()).toHaveLength(5);
    expect(server.rateNotices('alice').map((n) => n.code)).toEqual([2]);
    await timers.advance(1);
    await settled(sends[5] as Outcome, 'the acknowledgement of message 5');
    expect(sends[5]?.error).toBeUndefined();
    expect(h.logs.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
    expect(h.logs.text()).toContain('a rate hold stopped: the level is back');
    expect(server.rateNotices('alice').map((n) => [n.code, n.level])).toEqual([[2, 4993], [4, 5033]]);
    expect(bob.ims().map(html)).toEqual(sends.map((_, i) => `message ${i}`));
    expect(server.dropped('alice')).toBe(0);
  });
});
