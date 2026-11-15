import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OscarError } from '../../src/client/errors.js';
import { ByteReader } from '../../src/wire/bytes.js';
import { ICBM_TLV_AUTO_RESPONSE } from '../../src/wire/constants.js';
import { hasTlv } from '../../src/wire/tlv.js';
import { aimVariableValues } from '../../src/model/aim-variables.js';
import { DEFAULT_TIME_FORMAT } from '../../src/model/aim-variables.js';
import type { TimeFormat } from '../../src/model/aim-variables.js';
import type { RichText } from '../../src/model/rich-text.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer, SnacRecord } from '../fake/oscar-server.js';
import { bytesOf, loadVectors } from '../support/vectors.js';

const vectors = loadVectors('hand-lists-info.json');
const NOTICE_SENDER = 'OOS System Msg';
const SENT_AT = 1_790_000_000;

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;
let carol: FakePeer;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([]));
  bob = fake.peer('Bob');
  carol = fake.peer('Carol');
  h = makeClient(fake, { timers });
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const text = (words: string): RichText => [{ text: words }];
const hex = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? new Uint8Array(0)).toString('hex');
const bosFromAlice = (): SnacRecord[] => fake.snacsFrom('alice').filter((s) => s.conn === 'bos');
const fromAlice = (family: number, subtype: number): SnacRecord[] => bosFromAlice().filter((s) => s.family === family && s.subtype === subtype);
const recipients = (): string[] =>
  fromAlice(0x04, 0x06).map((s) => {
    const r = new ByteReader(s.body);
    r.u64();
    r.u16();
    return r.str8();
  });
const ims = (count: number): Promise<void> => waitFor(() => h.ims.length >= count, `IM ${count}`);
const answers = (count: number): Promise<void> => waitFor(() => h.autoResponses.length >= count, `auto-response ${count}`);
const automatic = (peer: FakePeer): string[] =>
  peer
    .ims()
    .filter((im) => hasTlv(im.tlvs, ICBM_TLV_AUTO_RESPONSE))
    .map((im) => im.html);

const roundTrip = (): Promise<void> => imRoundTrip(fake, h);

type Outcome<T> = { settled: 'resolved'; value: T } | { settled: 'rejected'; error: OscarError } | null;
function watch<T>(promise: Promise<T>): { outcome: () => Outcome<T> } {
  let outcome: Outcome<T> = null;
  promise.then(
    (value) => {
      outcome = { settled: 'resolved', value };
    },
    (error: OscarError) => {
      outcome = { settled: 'rejected', error };
    },
  );
  return { outcome: () => outcome };
}

async function infoOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: OscarError) => error.info,
  );
}

describe('typing notifications', () => {
  it('sends typing, typed and stopped as events 2, 1 and 0', async () => {
    await h.signOn();
    await h.client.sendTyping('Bob', 'typing');
    await h.client.sendTyping('Bob', 'typed');
    await h.client.sendTyping('Bob', 'stopped');
    await roundTrip();
    expect(bob.typingEvents()).toEqual([
      { from: 'Alice', event: 2 },
      { from: 'Alice', event: 1 },
      { from: 'Alice', event: 0 },
    ]);
  });

  it('reports a buddy typing, and typed or stopped as not typing', async () => {
    await h.signOn();
    bob.sendTyping('Alice', 2, 1);
    bob.sendTyping('Alice', 1, 1);
    bob.sendTyping('Alice', 2, 1);
    bob.sendTyping('Alice', 0, 1);
    await roundTrip();
    expect(h.typings).toEqual([
      { from: 'Bob', typing: true },
      { from: 'Bob', typing: false },
      { from: 'Bob', typing: true },
      { from: 'Bob', typing: false },
    ]);
    expect(h.ims).toEqual([]);
  });
});

describe('stored messages and server notices', () => {
  it('asks for stored messages once, after the capabilities were sent and after going online', async () => {
    // The reply that ends sign-on is withheld: the client has sent everything of sign-on and is not online.
    const release = fake.withhold(0x01, 0x0f);
    const signing = h.signOn();
    await waitFor(() => fromAlice(0x01, 0x0e).length === 1, 'the last request of sign-on');
    await settle(fake.port);
    expect(h.states.map((s) => s.state)).toEqual(['connecting']);
    expect(fromAlice(0x04, 0x10)).toEqual([]);

    release();
    await signing;
    await waitFor(() => fromAlice(0x04, 0x10).length > 0, 'the request for stored messages');
    expect(h.states.map((s) => s.state)).toEqual(['connecting', 'online']);
    await roundTrip();
    const order = bosFromAlice().map((s) => `${s.family}/${s.subtype}`);
    expect(order.filter((key) => key === '4/16')).toHaveLength(1);
    const capabilities = order.indexOf('2/4');
    const clientOnline = order.indexOf('1/2');
    expect(capabilities).toBeGreaterThanOrEqual(0);
    expect(clientOnline).toBeGreaterThan(capabilities);
    expect(order.indexOf('4/16')).toBeGreaterThan(clientOnline);
    expect(hex(fromAlice(0x04, 0x10)[0]?.body)).toBe('');
  });

  it('a stored message arrives marked offline with the time it was sent', async () => {
    fake.storeOffline('Alice', 'Bob', 'hi', SENT_AT);
    await h.signOn();
    await waitFor(() => h.ims.some((im) => im.offline), 'the stored message');
    expect(h.ims.filter((im) => im.from !== NOTICE_SENDER)).toEqual([
      { from: 'bob', body: text('hi'), offline: true, at: 1_790_000_000_000, autoResponse: false, serverNotice: false },
    ]);
    expect(fake.storedFor('Alice')).toEqual([]);

    // A live IM is not stored: it carries the time it arrived.
    bob.sendIm('Alice', 'now');
    await ims(3);
    expect(h.ims.at(-1)).toEqual({ from: 'Bob', body: text('now'), offline: false, at: timers.now(), autoResponse: false, serverNotice: false });
  });

  it('a stored message with an emoji and non-Latin text arrives intact', async () => {
    fake.storeOffline('Alice', 'Bob', 'ok 😀 日本', SENT_AT);
    await h.signOn();
    await waitFor(() => h.ims.some((im) => im.offline), 'the stored message');
    expect(h.ims.filter((im) => im.offline).map((im) => im.body)).toEqual([text('ok 😀 日本')]);
  });

  it("marks an IM from the server's notice sender", async () => {
    fake.storeOffline('Alice', 'Bob', 'hi', SENT_AT);
    await h.signOn();
    await ims(2);
    const notices = h.ims.filter((im) => im.serverNotice);
    expect(notices.map((im) => [im.from, im.offline, im.autoResponse, im.at])).toEqual([[NOTICE_SENDER, false, false, timers.now()]]);
    expect(notices[0]?.body.map((run) => run.text).join('')).toContain('You just received 1 IM(s) while you were offline.');
    expect(h.ims.filter((im) => !im.serverNotice).map((im) => im.from)).toEqual(['bob']);
  });
});

describe("a person who holds the notice sender's screen name", () => {
  it('is a person when writing live: no server notice, a warning is allowed and an away message answers', async () => {
    const impostor = fake.peer(NOTICE_SENDER);
    await h.signOn();
    await h.client.setAway(text('out'));
    impostor.sendIm('Alice', 'click this link');
    await ims(1);
    expect(h.ims).toEqual([{ from: NOTICE_SENDER, body: text('click this link'), offline: false, at: timers.now(), autoResponse: false, serverNotice: false }]);
    expect(h.client.canWarn(NOTICE_SENDER)).toBe(true);
    await answers(1);
    await h.autoResponses[0]?.done;
    expect(automatic(impostor)).toEqual(['out']);
    expect((await h.client.warn(NOTICE_SENDER)).level).toBeGreaterThan(0);
  });

  it('is a person when the message was stored, though the server relays it with a bare user-info block', async () => {
    fake.storeOffline('Alice', NOTICE_SENDER, 'click this link', SENT_AT);
    await h.signOn();
    await waitFor(() => h.ims.some((im) => im.offline), 'the stored message');
    expect(h.ims.map((im) => [im.from, im.offline, im.serverNotice, im.body.map((run) => run.text).join('').slice(0, 17)])).toEqual([
      // The server's own count of what was stored, and the stored message itself: one name, told apart by the wire.
      [NOTICE_SENDER, false, true, 'You just received'],
      ['oossystemmsg', true, false, 'click this link'],
    ]);
  });
});

describe('auto-response', () => {
  const lunch: RichText = [{ text: 'out to ' }, { text: 'lunch', bold: true }];

  it('answers the first IM of each sender once per away period', async () => {
    await h.signOn();
    await h.client.setAway(lunch);
    bob.sendIm('Alice', 'one');
    bob.sendIm('Alice', 'two');
    carol.sendIm('Alice', 'three');
    await ims(3);
    await answers(2);
    await Promise.all(h.autoResponses.map((sent) => sent.done));
    await roundTrip();
    expect(bob.ims().map((im) => [im.html, hasTlv(im.tlvs, ICBM_TLV_AUTO_RESPONSE)])).toEqual([['out to <B>lunch</B>', true]]);
    expect(carol.ims().map((im) => [im.html, hasTlv(im.tlvs, ICBM_TLV_AUTO_RESPONSE)])).toEqual([['out to <B>lunch</B>', true]]);
    expect(h.autoResponses.map(({ to, body, at }) => ({ to, body, at }))).toEqual([
      { to: 'Bob', body: lunch, at: timers.now() },
      { to: 'Carol', body: lunch, at: timers.now() },
    ]);
  });

  it('holds the auto-response of a knock until it is released, and answers once then while still away', async () => {
    // The listener asks for the hold as the client emits the IM, before the client answers it.
    h.client.on('im', (im) => {
      if (im.from === 'Bob') h.client.holdAutoResponse(im.from);
    });
    await h.signOn();
    await h.client.setAway(lunch);
    bob.sendIm('Alice', 'one');
    carol.sendIm('Alice', 'two');
    await ims(2);
    await answers(1);
    await roundTrip();
    expect(h.autoResponses.map((sent) => sent.to)).toEqual(['Carol']);
    expect(automatic(bob)).toEqual([]);

    h.client.releaseAutoResponse('bob', true);
    await answers(2);
    await h.autoResponses[1]?.done;
    bob.sendIm('Alice', 'three');
    await ims(3);
    expect(automatic(bob)).toEqual(['out to <B>lunch</B>']);
    expect(h.autoResponses.map((sent) => sent.to)).toEqual(['Carol', 'bob']);
  });

  it('a knock released without an answer sends nothing, and one released while back sends nothing either', async () => {
    await h.signOn();
    await h.client.setAway(lunch);
    h.client.holdAutoResponse('Bob');
    bob.sendIm('Alice', 'one');
    await ims(1);
    h.client.releaseAutoResponse('Bob', false);
    h.client.holdAutoResponse('Carol');
    carol.sendIm('Alice', 'two');
    await ims(2);
    await h.client.setAway(null);
    h.client.releaseAutoResponse('Carol', true);
    await roundTrip();
    expect(h.autoResponses).toEqual([]);
    expect(recipients()).toEqual(['Echo']);
  });

  it('answers nobody while no away message is set', async () => {
    await h.signOn();
    bob.sendIm('Alice', 'one');
    await ims(1);
    await roundTrip();
    expect(h.autoResponses).toEqual([]);
    expect(bob.ims()).toEqual([]);
  });

  it('editing the away message does not answer a sender again', async () => {
    await h.signOn();
    await h.client.setAway(lunch);
    bob.sendIm('Alice', 'one');
    await answers(1);
    await h.client.setAway(text('back at two'));
    bob.sendIm('Alice', 'two');
    await ims(2);
    await roundTrip();
    expect(h.autoResponses).toHaveLength(1);
    expect(automatic(bob)).toEqual(['out to <B>lunch</B>']);
    carol.sendIm('Alice', 'three');
    await answers(2);
    await h.autoResponses[1]?.done;
    expect(automatic(carol)).toEqual(['back at two']);
  });

  it('a new away period answers again', async () => {
    await h.signOn();
    await h.client.setAway(lunch);
    bob.sendIm('Alice', 'one');
    await answers(1);
    await h.client.setAway(null);
    bob.sendIm('Alice', 'two');
    await ims(2);
    await roundTrip();
    expect(h.autoResponses).toHaveLength(1);

    await h.client.setAway(text('gone again'));
    bob.sendIm('Alice', 'three');
    await answers(2);
    await h.autoResponses[1]?.done;
    expect(automatic(bob)).toEqual(['out to <B>lunch</B>', 'gone again']);
  });

  it("does not answer an auto-response, a stored message or the server's notice", async () => {
    fake.storeOffline('Alice', 'Carol', 'while you were out', SENT_AT);
    // Every IM to Alice is withheld until she is away, the notice and the stored message among them.
    const release = fake.withhold(0x04, 0x07);
    await h.signOn();
    await h.client.setAway(lunch);
    await roundTrip();
    bob.sendIm('Alice', 'I am away too', { autoResponse: true });
    release();
    await ims(3);
    await roundTrip();
    expect(h.ims.map((im) => [im.from, im.serverNotice, im.offline, im.autoResponse])).toEqual([
      [NOTICE_SENDER, true, false, false],
      ['carol', false, true, false],
      ['Bob', false, false, true],
    ]);
    expect(h.autoResponses).toEqual([]);
    expect(recipients()).toEqual(['Echo', 'Echo']);

    carol.sendIm('Alice', 'hello');
    bob.sendIm('Alice', 'hello');
    await answers(2);
    expect(h.autoResponses.map((sent) => sent.to)).toEqual(['Carol', 'Bob']);
  });

  it('the auto-response is acknowledged like any IM and settles its promise', async () => {
    await h.signOn();
    await h.client.setAway(lunch);
    bob.sendIm('Alice', 'one');
    await answers(1);
    expect(await infoOf(h.autoResponses[0]?.done ?? Promise.reject(new Error('no auto-response')))).toBe('resolved');
    expect(automatic(bob)).toEqual(['out to <B>lunch</B>']);

    fake.failNext(0x04, 0x06, { code: 4 });
    carol.sendIm('Alice', 'two');
    await answers(2);
    expect(await infoOf(h.autoResponses[1]?.done ?? Promise.resolve())).toEqual({ kind: 'refused', code: 4 });
    expect(automatic(carol)).toEqual([]);
    // The client logs the failure with its kind and code, and nothing of the message or of who it was for.
    const line = h.logs.lines.find((l) => l.msg === 'the auto-response was not sent');
    expect(line?.fields).toEqual({ kind: 'refused', code: 4 });
  });

  it('shortens an away message that is over the IM limit to the longest prefix that fits', async () => {
    await h.signOn();
    await h.client.setAway([{ text: 'z'.repeat(700), bold: true }]);
    bob.sendIm('Alice', 'one');
    await answers(1);
    await h.autoResponses[0]?.done;
    expect(automatic(bob)).toEqual([`<B>${'z'.repeat(505)}</B>`]);
    expect(h.autoResponses[0]?.body).toEqual([{ text: 'z'.repeat(505), bold: true }]);
  });
});

describe('auto-response variables', () => {
  const BRITISH: TimeFormat = { locale: 'en-GB', hour12: false };

  it('fills %n, %d and %t in the auto-response and keeps the away message as typed', async () => {
    h = makeClient(fake, { timers, timeFormat: () => BRITISH });
    const dev = fake.peer('Chimr Dev 2');
    const away: RichText = [{ text: 'Sorry ' }, { text: '%n', bold: true }, { text: ', it is %t on %d. 100% %N' }];
    await h.signOn();
    await h.client.setAway(away);
    dev.sendIm('Alice', 'hi');
    await answers(1);
    await h.autoResponses[0]?.done;
    const { date, time } = aimVariableValues('Chimr Dev 2', timers.now(), BRITISH);
    expect([date, time]).toEqual([expect.stringMatching(/^\d{2}\/\d{2}\/\d{4}$/), expect.stringMatching(/^\d{1,2}:\d{2}$/)]);
    expect(automatic(dev)).toEqual([`Sorry <B>Chimr Dev 2</B>, it is ${time} on ${date}. 100% %N`]);
    expect(h.autoResponses[0]?.body).toEqual([{ text: 'Sorry ' }, { text: 'Chimr Dev 2', bold: true }, { text: `, it is ${time} on ${date}. 100% %N` }]);
    // What the client holds and gives to Locate keeps the tokens; the next sender gets their own name.
    expect(h.client.awayMessage).toEqual(away);
    bob.sendIm('Alice', 'hey');
    await answers(2);
    await h.autoResponses[1]?.done;
    expect(automatic(bob)).toEqual([`Sorry <B>Bob</B>, it is ${time} on ${date}. 100% %N`]);
  });

  it("a time format that cannot be read gives a US locale's forms, and a log line", async () => {
    h = makeClient(fake, {
      timers,
      timeFormat: () => {
        throw new TypeError('no defaults');
      },
    });
    await h.signOn();
    await h.client.setAway(text('%n at %t'));
    bob.sendIm('Alice', 'one');
    await answers(1);
    await h.autoResponses[0]?.done;
    expect(automatic(bob)).toEqual([`Bob at ${aimVariableValues('Bob', timers.now(), DEFAULT_TIME_FORMAT).time}`]);
    expect(h.logs.lines.find((l) => l.msg === 'could not read the time format')?.fields).toEqual({ error: 'TypeError' });
  });

  it("leaves them as typed in a link's address, in what the server holds for Get Info and in an ordinary IM", async () => {
    await h.signOn();
    const away: RichText = [{ text: '%n at %t ' }, { text: 'here', link: 'https://example.com/?v=%n' }];
    await h.client.setAway(away);
    bob.sendIm('Alice', 'one');
    await answers(1);
    await h.autoResponses[0]?.done;
    const { time } = aimVariableValues('Bob', timers.now(), DEFAULT_TIME_FORMAT);
    expect(h.autoResponses[0]?.body).toEqual([{ text: `Bob at ${time} ` }, { text: 'here', link: 'https://example.com/?v=%n' }]);
    expect(automatic(bob)).toEqual([expect.stringContaining('?v=%n')]);
    const info = await h.client.getInfo('Alice');
    expect(info.status === 'ok' ? info.awayMessage : info).toEqual(away);
    await h.client.sendIm('Bob', text('%n on %d at %t'));
    expect(bob.ims().map((im) => im.html).at(-1)).toBe('%n on %d at %t');
  });

  it('shortens to the IM limit after putting them in', async () => {
    await h.signOn();
    // 512 bytes as typed, which fits; 513 once %n is Bob.
    await h.client.setAway(text(`${'z'.repeat(509)} %n`));
    bob.sendIm('Alice', 'one');
    await answers(1);
    await h.autoResponses[0]?.done;
    expect(automatic(bob)).toEqual([`${'z'.repeat(509)} Bo`]);
    expect(h.autoResponses[0]?.body).toEqual(text(`${'z'.repeat(509)} Bo`));
  });
});

describe('warn', () => {
  it('warn is allowed once per live IM, at most three, and offline messages do not count', async () => {
    fake.storeOffline('Alice', 'Bob', 'earlier', SENT_AT);
    expect(h.client.canWarn('Bob')).toBe(false);
    await h.signOn();
    await waitFor(() => h.ims.some((im) => im.offline), 'the stored message');
    expect(h.client.canWarn('Bob')).toBe(false);

    bob.sendIm('Alice', 'one');
    await ims(3);
    expect(h.client.canWarn('Bob')).toBe(true);
    expect(h.client.canWarn('b o b')).toBe(true);
    expect(h.client.canWarn('Carol')).toBe(false);
    await h.client.warn('Bob');
    expect(h.client.canWarn('Bob')).toBe(false);

    for (let i = 0; i < 4; i++) bob.sendIm('Alice', 'more');
    await ims(7);
    expect(h.client.canWarn('Bob')).toBe(true);
    await h.client.warn('Bob');
    expect(h.client.canWarn('Bob')).toBe(true);
    expect(await h.client.warn('Bob')).toEqual({ level: 300 });
    expect(h.client.canWarn('Bob')).toBe(false);

    await timers.advance(3_600_001);
    expect(h.client.canWarn('Bob')).toBe(false);
    bob.sendIm('Alice', 'again');
    await ims(8);
    expect(h.client.canWarn('Bob')).toBe(true);
    expect(await h.client.warn('Bob')).toEqual({ level: 400 });
  });

  it('an accepted warning returns the new level', async () => {
    await h.signOn();
    bob.sendIm('Alice', 'one');
    await ims(1);
    expect(await h.client.warn('bob')).toEqual({ level: 100 });
    expect(fromAlice(0x04, 0x08).map((s) => hex(s.body))).toEqual([hex(bytesOf(vectors, 'warn request body, normal, bob'))]);
  });

  it("a refused warning rejects with the server's code", async () => {
    await h.signOn();
    expect(await infoOf(h.client.warn('Carol'))).toEqual({ kind: 'refused', code: 13 });
    carol.signOff();
    expect(await infoOf(h.client.warn('Carol'))).toEqual({ kind: 'refused', code: 4 });
    expect(fromAlice(0x04, 0x08)).toHaveLength(2);
  });

  it('a warning with no reply in 10 s is a timeout', async () => {
    await h.signOn();
    bob.sendIm('Alice', 'one');
    await ims(1);
    fake.withhold(0x04, 0x09);
    const warning = watch(h.client.warn('Bob'));
    await waitFor(() => fromAlice(0x04, 0x08).length === 1, 'the warning');
    await timers.advance(9_999);
    expect(warning.outcome()).toBeNull();
    await timers.advance(1);
    const outcome = warning.outcome();
    expect(outcome?.settled).toBe('rejected');
    expect(outcome?.settled === 'rejected' ? outcome.error.info : null).toEqual({ kind: 'timeout', rateLimited: false });
    expect(h.client.canWarn('Bob')).toBe(true);
  });

  it('refuses to warn while not signed on and sends nothing', async () => {
    expect(await infoOf(h.client.warn('Bob'))).toEqual({ kind: 'not-signed-on' });
    expect(await infoOf(h.client.sendTyping('Bob', 'typing'))).toEqual({ kind: 'not-signed-on' });
  });

  it('a second session inherits no warn allowance, away message or answered sender', async () => {
    await h.signOn();
    await h.client.setAway(text('away'));
    bob.sendIm('Alice', 'one');
    await answers(1);
    await h.autoResponses[0]?.done;
    expect(h.client.canWarn('Bob')).toBe(true);
    await h.client.signOff();
    expect(h.client.canWarn('Bob')).toBe(false);

    await h.signOn();
    expect(h.client.canWarn('Bob')).toBe(false);
    bob.sendIm('Alice', 'two');
    await ims(2);
    await roundTrip();
    expect(h.autoResponses).toHaveLength(1);
    await h.client.setAway(text('away'));
    bob.sendIm('Alice', 'three');
    await answers(2);
  });

  it('the IM class follows the notice the server sends when the user is warned', async () => {
    await h.signOn();
    // The server allows a warning only against someone who IMed the warner.
    await h.client.sendIm('Bob', text('one'));
    bob.warn('Alice');
    await waitFor(() => h.warnings.length === 1, 'the warning');
    expect(fake.rateNotices('Alice').map((n) => [n.code, n.classId])).toEqual([[1, 3]]);

    await h.client.sendIm('Bob', text('two'));
    expect(fake.dropped('Alice')).toBe(0);
    // The server answers a burst paced by the class as it was before the warning with an alert.
    const sends = Array.from({ length: 8 }, (_, i) => watch(h.client.sendIm('Bob', text(`burst ${i}`))));
    // What the client releases at once has reached the test server before the clock moves: both count the same time between sends.
    await timers.advance(0);
    await settle(fake.port);
    for (let second = 0; second < 120; second++) {
      await timers.advance(1_000);
      await settle(fake.port);
      await waitFor(() => sends.filter((s) => s.outcome() !== null).length === fromAlice(0x04, 0x06).length - 2, 'an acknowledgement for every IM the test server read');
    }
    expect(sends.map((s) => s.outcome()?.settled)).toEqual(sends.map(() => 'resolved'));
    expect(fake.dropped('Alice')).toBe(0);
    expect(fake.rateNotices('Alice').map((n) => n.code)).toEqual([1]);
  });
});
