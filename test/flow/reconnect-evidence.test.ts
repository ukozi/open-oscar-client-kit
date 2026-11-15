import { afterEach, describe, expect, it } from 'vitest';
import { SignOnError } from '../../src/client/errors.js';
import type { DropEvidence, ReconnectDecision, ReconnectPolicy } from '../../src/client/reconnect.js';
import { bucpTicketSource, storedTicketSource } from '../../src/client/tickets.js';
import type { IssuedTicket } from '../../src/client/tickets.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, captureLog, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { StartOptions } from '../fake/oscar-server.js';

type PolicyInput = Parameters<ReconnectPolicy['next']>[0];
type RecordingPolicy = ReconnectPolicy & { readonly inputs: PolicyInput[] };

const MULTI_SESSION = 0x01;
const RETRY_MS = 1_000;

let timers: ManualTimers;
let fake: FakeOscarServer;
let issued: IssuedTicket;
let policy: RecordingPolicy;
let h: ClientHarness;

function recording(decide: (input: PolicyInput) => ReconnectDecision = () => ({ retry: true, delayMs: RETRY_MS })): RecordingPolicy {
  const inputs: PolicyInput[] = [];
  return {
    inputs,
    next(input) {
      inputs.push(input);
      return decide(input);
    },
  };
}

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });

async function start(server: StartOptions = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ ...server, now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.setFeedbag('alice', withTypingPref([]));
  issued = await bucpTicketSource({
    log: captureLog().log,
    now: timers.now,
    timers: timers.api,
    budget: { take: async () => {} },
    credentials: { screenName: 'Alice', password: 'alicepw1' },
    server: here(),
  }).ticket({ reconnect: false, track: () => {} });
  policy = recording();
}

/** Signs on from the stored ticket and returns when that was. */
async function online(): Promise<number> {
  h = makeClient(fake, { timers, reconnect: policy });
  await h.client.signOnWith(storedTicketSource(issued), here());
  return timers.now();
}

const heard = (count: number, what: string): Promise<void> => waitFor(() => policy.inputs.length === count, what);

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

describe('reconnect evidence', () => {
  it.each<[string, (f: FakeOscarServer) => void, DropEvidence]>([
    ['a dropped socket', (f) => f.dropSocket('alice'), { kind: 'closed', close: 'eof' }],
    ['an empty sign-off', (f) => f.emptySignoff('alice'), { kind: 'empty-signoff' }],
    ['a kick', (f) => f.kick('alice'), { kind: 'signed-off', reason: 1 }],
  ])('reports %s', async (_name, act, evidence) => {
    await start();
    const onlineAt = await online();
    await timers.advance(5_000);
    act(fake);
    await heard(1, 'the drop');
    expect(policy.inputs[0]).toEqual({ phase: 'drop', evidence, attempt: 1, onlineAt, now: onlineAt + 5_000 });
  });

  it('reports when the session last came online', async () => {
    await start();
    await online();
    fake.dropSocket('alice');
    await heard(1, 'the drop');
    await timers.advance(RETRY_MS);
    await waitFor(() => h.client.state === 'online', 'the client to be online again');
    const back = timers.now();
    await timers.advance(5_000);
    fake.dropSocket('alice');
    await heard(2, 'the second drop');
    expect(policy.inputs[1]).toEqual({ phase: 'drop', evidence: { kind: 'closed', close: 'eof' }, attempt: 1, onlineAt: back, now: back + 5_000 });
  });

  it('reports a cookie the server no longer takes as cookie-refused', async () => {
    await start();
    await online();
    fake.voidCookies();
    fake.dropSocket('alice');
    await heard(1, 'the drop');
    await timers.advance(RETRY_MS);
    await heard(2, 'the attempt');
    expect(policy.inputs[1]).toMatchObject({ phase: 'attempt', attempt: 2, evidence: { kind: 'cookie-refused' } });
  });

  it('reports a server shutdown as an empty sign-off, then refused connects, until it is back', async () => {
    await start();
    await online();
    const port = fake.port;
    await fake.shutdown();
    await heard(1, 'the drop');
    await timers.advance(RETRY_MS);
    await heard(2, 'the first attempt');
    await timers.advance(RETRY_MS);
    await heard(3, 'the second attempt');
    await fake.resume();
    await timers.advance(RETRY_MS);
    await heard(4, 'the attempt after the restart');
    expect(policy.inputs.map((input) => [input.phase, input.attempt, input.evidence])).toEqual([
      ['drop', 1, { kind: 'empty-signoff' }],
      ['attempt', 2, { kind: 'connect-refused' }],
      ['attempt', 3, { kind: 'connect-refused' }],
      ['attempt', 4, { kind: 'cookie-refused' }],
    ]);
    expect([fake.port, h.client.state]).toEqual([port, 'reconnecting']);
  });

  it('reports the session cap at BOS', async () => {
    await start({ sixthSession: 'bos-signoff' });
    await online();
    fake.dropSocket('alice');
    await heard(1, 'the drop');
    for (let i = 0; i < 5; i++) await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
    await timers.advance(RETRY_MS);
    await heard(2, 'the attempt');
    expect(policy.inputs[1]).toMatchObject({ phase: 'attempt', attempt: 2, evidence: { kind: 'session-cap' } });
  });

  it('a first sign-on into a restarted server rejects with its evidence', async () => {
    await start();
    fake.voidCookies();
    h = makeClient(fake, { timers, reconnect: policy });
    const error = await h.client.signOnWith(storedTicketSource(issued), here()).catch((e: unknown) => e);
    expect([error instanceof SignOnError, (error as SignOnError).failure, (error as SignOnError).evidence]).toEqual([
      true,
      { kind: 'unreachable' },
      { kind: 'cookie-refused' },
    ]);
    await fake.shutdown();
    const down = await makeClient(fake, { timers }).client.signOnWith(storedTicketSource(issued), here()).catch((e: unknown) => e);
    expect((down as SignOnError).evidence).toEqual({ kind: 'connect-refused' });
    const login = await h.signOn().catch((e: unknown) => e);
    expect([(login as SignOnError).failure, (login as SignOnError).evidence]).toEqual([{ kind: 'unreachable' }, { kind: 'connect-refused' }]);
    expect(policy.inputs).toEqual([]);
  });

  const states = { drop: ['connecting', 'online', 'offline'], attempt: ['connecting', 'online', 'reconnecting', 'offline'] };
  it.each(['drop', 'attempt'] as const)('a stop goes offline with the reason the policy gave (%s)', async (phase) => {
    await start();
    policy = recording((input) => (input.phase === phase ? { retry: false, reason: { kind: 'unreachable' } } : { retry: true, delayMs: RETRY_MS }));
    await online();
    fake.voidCookies();
    fake.dropSocket('alice');
    await heard(1, 'the drop');
    if (phase === 'attempt') await timers.advance(RETRY_MS);
    await waitFor(() => h.client.state === 'offline', 'the client to go offline');
    expect(h.states.at(-1)).toEqual({ state: 'offline', reason: { kind: 'unreachable' } });
    expect(h.states.map((s) => s.state)).toEqual(states[phase]);
    await timers.advance(60_000);
    expect(policy.inputs).toHaveLength(phase === 'drop' ? 1 : 2);
  });

  it.each(['drop', 'attempt'] as const)('a policy that throws ends the session as unreachable (%s)', async (phase) => {
    await start();
    policy = recording((input) => {
      if (input.phase === phase) throw new Error('the policy broke');
      return { retry: true, delayMs: RETRY_MS };
    });
    await online();
    fake.voidCookies();
    fake.dropSocket('alice');
    await heard(1, 'the drop');
    if (phase === 'attempt') await timers.advance(RETRY_MS);
    await waitFor(() => h.client.state === 'offline', 'the client to go offline');
    expect(h.states.at(-1)).toEqual({ state: 'offline', reason: { kind: 'unreachable' } });
    expect(h.states.map((s) => s.state)).toEqual(states[phase]);
    const threw = h.logs.lines.filter((line) => line.msg === 'the reconnect policy threw');
    expect(threw.map((line) => [line.level, line.fields?.phase, line.fields?.error])).toEqual([['warn', phase, 'the policy broke']]);
    await timers.advance(60_000);
    expect(policy.inputs).toHaveLength(phase === 'drop' ? 1 : 2);
  });
});
