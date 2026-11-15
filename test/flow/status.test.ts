import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OscarError } from '../../src/client/errors.js';
import { INVISIBLE_TIMEOUT_MS } from '../../src/client/sign-on.js';
import type { RichText } from '../../src/model/rich-text.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, Sighting, SnacRecord } from '../fake/oscar-server.js';
import { bytesOf, loadVectors } from '../support/vectors.js';

const vectors = loadVectors('hand-lists-info.json');

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([]));
  bob = fake.peer('Bob');
  bob.watch('Alice');
  h = makeClient(fake, { timers });
  await h.signOn();
  await sightings(1);
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const text = (words: string): RichText => [{ text: words }];
const hex = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? new Uint8Array(0)).toString('hex');
const fromAlice = (family: number, subtype: number): SnacRecord[] =>
  fake.snacsFrom('alice').filter((s) => s.conn === 'bos' && s.family === family && s.subtype === subtype);
const sightings = (count: number): Promise<void> => waitFor(() => bob.sightings().length >= count, `sighting ${count} of Alice`);
const lastSighting = (): Sighting | undefined => bob.sightings().at(-1);

type Outcome = { settled: 'resolved' } | { settled: 'rejected'; error: OscarError } | null;
function watch(promise: Promise<void>): { outcome: () => Outcome } {
  let outcome: Outcome = null;
  promise.then(
    () => {
      outcome = { settled: 'resolved' };
    },
    (error: OscarError) => {
      outcome = { settled: 'rejected', error };
    },
  );
  return { outcome: () => outcome };
}

const roundTrip = (): Promise<void> => imRoundTrip(fake, h);

describe('invisible', () => {
  it('goes invisible: a watcher sees a departure, and the client reports it only once the server confirms', async () => {
    expect(lastSighting()?.event).toBe('arrived');
    const selvesBefore = h.selves.length;
    const release = fake.withhold(0x01, 0x0f);
    const going = watch(h.client.setInvisible(true));
    await sightings(2);
    expect(fromAlice(0x01, 0x1e).map((s) => hex(s.body))).toEqual([hex(bytesOf(vectors, 'status body, invisible'))]);
    expect(lastSighting()?.event).toBe('departed');
    await roundTrip();
    expect(h.client.self?.invisible).toBe(false);
    expect(going.outcome()).toBeNull();
    expect(h.selves.length).toBe(selvesBefore);

    release();
    await waitFor(() => going.outcome() !== null, 'setInvisible to settle');
    expect(going.outcome()).toEqual({ settled: 'resolved' });
    expect(h.client.self?.invisible).toBe(true);
    expect(h.selves.slice(selvesBefore).map((s) => s.invisible)).toEqual([true]);
  });

  it('comes back: a watcher sees an arrival', async () => {
    await h.client.setInvisible(true);
    expect(lastSighting()?.event).toBe('departed');
    await h.client.setInvisible(false);
    expect(fromAlice(0x01, 0x1e).map((s) => hex(s.body))).toEqual([
      hex(bytesOf(vectors, 'status body, invisible')),
      hex(bytesOf(vectors, 'status body, visible')),
    ]);
    expect(bob.sightings().map((s) => s.event)).toEqual(['arrived', 'departed', 'arrived']);
    expect(h.client.self?.invisible).toBe(false);
    expect(h.selves.at(-1)?.invisible).toBe(false);
  });

  it('the away message is unchanged across going invisible and back', async () => {
    await h.client.setAway(text('out to lunch'));
    await sightings(2);
    expect(lastSighting()?.away).toBe(true);
    await h.client.setInvisible(true);
    expect(lastSighting()?.event).toBe('departed');
    await h.client.setInvisible(false);
    expect(lastSighting()).toMatchObject({ name: 'Alice', event: 'arrived', away: true });
    expect(h.client.awayMessage).toEqual(text('out to lunch'));
  });

  it('setInvisible fails after 15 s and the status stays', async () => {
    fake.failNext(0x01, 0x1e, { code: 1 });
    const going = watch(h.client.setInvisible(true));
    await waitFor(() => fromAlice(0x01, 0x1e).length === 1, 'the status write');
    // A self info that is not the confirmation: the client reads it and the command keeps waiting.
    fake.sendSelfInfo('Alice');
    await roundTrip();
    expect(going.outcome()).toBeNull();

    await timers.advance(INVISIBLE_TIMEOUT_MS - 1);
    expect(going.outcome()).toBeNull();
    await timers.advance(1);
    const outcome = going.outcome();
    expect(outcome?.settled).toBe('rejected');
    expect(outcome?.settled === 'rejected' ? outcome.error.info : null).toEqual({ kind: 'timeout', rateLimited: false });
    expect(INVISIBLE_TIMEOUT_MS).toBe(15_000);
    expect(h.client.self?.invisible).toBe(false);
    expect(bob.sightings().map((s) => s.event)).toEqual(['arrived']);
  });
});

describe('idle', () => {
  it('reports idle in seconds and clears it with zero; a watcher sees the minutes', async () => {
    await h.client.reportIdle(600);
    await sightings(2);
    expect(fromAlice(0x01, 0x11).map((s) => hex(s.body))).toEqual([hex(bytesOf(vectors, 'idle body, 600 seconds'))]);
    expect(lastSighting()).toEqual({ name: 'Alice', event: 'arrived', away: false, idleMinutes: 10, warning: 0, icon: null });

    await h.client.reportIdle(0);
    await sightings(3);
    expect(fromAlice(0x01, 0x11).map((s) => hex(s.body))).toEqual([hex(bytesOf(vectors, 'idle body, 600 seconds')), '00000000']);
    expect(lastSighting()?.idleMinutes).toBeNull();
  });
});

describe('an away set as an auto-away sets it', () => {
  const ims = (count: number): Promise<void> => waitFor(() => h.ims.length >= count, `IM ${count}`);
  const answers = (count: number): Promise<void> => waitFor(() => h.autoResponses.length >= count, `auto-response ${count}`);

  it("starts an away period: Bob's first IM is answered once, and after Online and a second away he is answered again", async () => {
    const away = text('I am away from my computer right now.');
    await h.client.setAway(away);
    bob.sendIm('Alice', 'one');
    bob.sendIm('Alice', 'two');
    await ims(2);
    await answers(1);
    await h.autoResponses[0]?.done;
    await roundTrip();
    expect(h.autoResponses.map(({ to, body }) => ({ to, body }))).toEqual([{ to: 'Bob', body: away }]);

    // Online, as the return step writes it, ends the period; the next away starts another.
    await h.client.setAway(null);
    await h.client.setAway(away);
    bob.sendIm('Alice', 'three');
    await ims(3);
    await answers(2);
    await h.autoResponses[1]?.done;
    expect(h.autoResponses.map((sent) => sent.to)).toEqual(['Bob', 'Bob']);
  });
});

describe('the own warn level', () => {
  it('learns of a decayed warn level from the liveness probe within five minutes', async () => {
    const selvesBefore = h.selves.length;
    const queriesBefore = fromAlice(0x01, 0x0e).length;
    fake.decayWarning('Alice', 50);
    await sightings(2);
    expect(lastSighting()?.warning).toBe(50);
    await roundTrip();
    expect(h.selves.length).toBe(selvesBefore);
    expect(h.client.self?.warnLevel).toBe(0);

    await timers.advance(90_000);
    await waitFor(() => h.selves.length > selvesBefore, 'a self event');
    expect(h.selves.at(-1)?.warnLevel).toBe(50);
    expect(h.client.self?.warnLevel).toBe(50);
    expect(fromAlice(0x01, 0x0e).length).toBe(queriesBefore + 1);
  });

  it('a warning sets the level and names the warner; an anonymous one names nobody', async () => {
    // The server allows a warning only against someone who IMed the warner.
    await h.client.sendIm('Bob', text('one'));
    await h.client.sendIm('Bob', text('two'));
    const selvesBefore = h.selves.length;

    bob.warn('Alice');
    await waitFor(() => h.warnings.length === 1, 'the first warning');
    expect(h.warnings).toEqual([{ level: 100, by: 'Bob' }]);
    expect(h.client.self?.warnLevel).toBe(100);
    expect(h.selves.slice(selvesBefore).map((s) => s.warnLevel)).toEqual([100]);

    bob.warn('Alice', true);
    await waitFor(() => h.warnings.length === 2, 'the second warning');
    expect(h.warnings[1]).toEqual({ level: 130, by: null });
    expect(h.client.self?.warnLevel).toBe(130);
    expect(h.selves.slice(selvesBefore).map((s) => s.warnLevel)).toEqual([100, 130]);
  });

  it('a self event is heard before the warned event it belongs to', async () => {
    await h.client.sendIm('Bob', text('one'));
    const order: string[] = [];
    h.client.on('self', (self) => order.push(`self ${self.warnLevel}`));
    h.client.on('warned', (warned) => order.push(`warned ${warned.level}`));
    bob.warn('Alice');
    await waitFor(() => order.length === 2, 'both events');
    expect(order).toEqual(['self 100', 'warned 100']);
  });
});
