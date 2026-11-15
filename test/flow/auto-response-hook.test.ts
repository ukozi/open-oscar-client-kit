import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ICBM_TLV_AUTO_RESPONSE } from '../../src/wire/constants.js';
import { hasTlv } from '../../src/wire/tlv.js';
import type { AutoResponseDecision } from '../../src/client/messaging.js';
import type { OscarClientEvents, OscarClientOptions } from '../../src/client/oscar-client.js';
import { aimVariableValues } from '../../src/model/aim-variables.js';
import type { RichText } from '../../src/model/rich-text.js';
import { imRoundTrip, makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;
let answered: OscarClientEvents['answered'][];

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([]));
  bob = fake.peer('Bob');
  answered = [];
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const brb: RichText = [{ text: 'brb %t' }];
const ims = (count: number): Promise<void> => waitFor(() => h.ims.length >= count, `IM ${count}`);
const automatic = (peer: FakePeer): string[] =>
  peer
    .ims()
    .filter((im) => hasTlv(im.tlvs, ICBM_TLV_AUTO_RESPONSE))
    .map((im) => im.html);

const roundTrip = (): Promise<void> => imRoundTrip(fake, h);

async function awayClient(options: Omit<OscarClientOptions, 'now' | 'timers'> = {}): Promise<void> {
  h = makeClient(fake, { timers, ...options });
  h.client.on('answered', (each) => answered.push(each));
  await h.signOn();
  await h.client.setAway(brb);
}

describe('the host deciding each auto-response', () => {
  it.each([
    ['send', 1, ['bob']],
    ['count', 0, ['bob']],
    ['skip', 0, []],
  ] as const)("a '%s' decision sends %i auto-responses and leaves %j answered", async (decision, sent, names) => {
    await awayClient({ autoRespond: () => decision });
    bob.sendIm('Alice', 'one');
    await ims(1);
    await Promise.all(h.autoResponses.map((each) => each.done));
    await roundTrip();
    expect(automatic(bob)).toHaveLength(sent);
    expect(h.autoResponses).toHaveLength(sent);
    expect(h.client.answeredSenders()).toEqual(names);
    expect(answered).toEqual(decision === 'skip' ? [] : [{ screenName: 'bob', sent: decision === 'send' }]);
  });

  it('asks once per sender while a decision is pending, and sends when it resolves', async () => {
    const asked: { to: string; at: number }[] = [];
    let settleCheck: (decision: AutoResponseDecision) => void = () => {};
    await awayClient({
      autoRespond: (ctx) => {
        asked.push(ctx);
        return new Promise((resolve) => {
          settleCheck = resolve;
        });
      },
    });
    bob.sendIm('Alice', 'one');
    bob.sendIm('Alice', 'two');
    await ims(2);
    await roundTrip();
    expect(asked).toEqual([{ to: 'Bob', at: timers.now() }]);
    expect(h.client.answeredSenders()).toEqual(['bob']);
    expect(automatic(bob)).toEqual([]);
    expect(answered).toEqual([]);

    settleCheck('send');
    await waitFor(() => h.autoResponses.length === 1, 'the auto-response');
    await h.autoResponses[0]?.done;
    await roundTrip();
    expect(automatic(bob)).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(answered).toEqual([{ screenName: 'bob', sent: true }]);
  });

  it('frees the sender of a pending decision that resolves skip', async () => {
    let settleCheck: (decision: AutoResponseDecision) => void = () => {};
    const asked: string[] = [];
    await awayClient({
      autoRespond: ({ to }) => {
        asked.push(to);
        return new Promise((resolve) => {
          settleCheck = resolve;
        });
      },
    });
    bob.sendIm('Alice', 'one');
    await ims(1);
    settleCheck('skip');
    await roundTrip();
    expect(h.client.answeredSenders()).toEqual([]);
    bob.sendIm('Alice', 'two');
    await ims(2);
    await roundTrip();
    expect(asked).toEqual(['Bob', 'Bob']);
  });

  it('drops a decision that resolves after its away period ended, though another began', async () => {
    let settleCheck: (decision: AutoResponseDecision) => void = () => {};
    await awayClient({
      autoRespond: () =>
        new Promise((resolve) => {
          settleCheck = resolve;
        }),
    });
    bob.sendIm('Alice', 'one');
    await ims(1);
    await h.client.setAway(null);
    await h.client.setAway(brb);
    settleCheck('send');
    await roundTrip();
    expect(automatic(bob)).toEqual([]);
    expect(h.autoResponses).toEqual([]);
    expect(h.client.answeredSenders()).toEqual([]);
    expect(answered).toEqual([]);
  });

  it('puts %t in the time zone it was given', async () => {
    await awayClient({ timeFormat: () => ({ locale: 'en-US', hour12: true, timeZone: 'Asia/Tokyo' }) });
    bob.sendIm('Alice', 'one');
    await waitFor(() => h.autoResponses.length === 1, 'the auto-response');
    await h.autoResponses[0]?.done;
    await roundTrip();
    expect(automatic(bob)).toEqual(['brb 5:00 PM']);
  });

  it('still answers with a time zone nobody knows', async () => {
    await awayClient({ timeFormat: () => ({ locale: 'en-US', hour12: true, timeZone: 'Not/AZone' }) });
    bob.sendIm('Alice', 'one');
    await waitFor(() => h.autoResponses.length === 1, 'the auto-response');
    await h.autoResponses[0]?.done;
    await roundTrip();
    expect(automatic(bob)).toEqual([`brb ${aimVariableValues('Bob', timers.now(), { locale: 'en-US', hour12: true }).time}`]);
  });

  it('sends while invisible', async () => {
    await awayClient();
    await h.client.setInvisible(true);
    bob.sendIm('Alice', 'one');
    await waitFor(() => h.autoResponses.length === 1, 'the auto-response');
    await h.autoResponses[0]?.done;
    await roundTrip();
    expect(automatic(bob)).toHaveLength(1);
  });

  it('markAnswered keeps a sender from being answered, and back clears the set', async () => {
    const asked: string[] = [];
    await awayClient({
      autoRespond: ({ to }) => {
        asked.push(to);
        return 'send';
      },
    });
    h.client.markAnswered('Bob');
    bob.sendIm('Alice', 'one');
    await ims(1);
    await roundTrip();
    expect(automatic(bob)).toEqual([]);
    expect(asked).toEqual([]);
    expect(h.client.answeredSenders()).toEqual(['bob']);

    await h.client.setAway(null);
    expect(h.client.answeredSenders()).toEqual([]);
  });

  it.each([
    ['throws', () => {
      throw new TypeError('secret detail');
    }],
    ['rejects', () => Promise.reject(new TypeError('secret detail'))],
  ] as const)('a decision that %s sends nothing and leaves the sender unanswered', async (_how, autoRespond) => {
    await awayClient({ autoRespond });
    bob.sendIm('Alice', 'one');
    await ims(1);
    await roundTrip();
    expect(automatic(bob)).toEqual([]);
    expect(h.client.answeredSenders()).toEqual([]);
    expect(answered).toEqual([]);
    expect(h.logs.lines.filter((line) => line.msg === 'the auto-response check failed')).toEqual([
      { level: 'warn', msg: 'the auto-response check failed', fields: { error: 'TypeError' } },
    ]);
    expect(h.logs.text()).not.toContain('secret detail');
  });

  it('without a predicate answers as before', async () => {
    await awayClient();
    bob.sendIm('Alice', 'one');
    await waitFor(() => h.autoResponses.length === 1, 'the auto-response');
    await h.autoResponses[0]?.done;
    await roundTrip();
    expect(automatic(bob)).toHaveLength(1);
    expect(h.client.answeredSenders()).toEqual(['bob']);
    expect(answered).toEqual([{ screenName: 'bob', sent: true }]);
  });
});
