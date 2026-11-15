import {
  BUCP_LOGIN_REQUEST,
  FAMILY_BUCP,
  FAMILY_ICBM,
  FAMILY_OSERVICE,
  ICBM_MSG_TO_HOST,
  OSERVICE_RATE_PARAM_CHANGE,
  RATE_CODE_CLEAR,
  RATE_CODE_LIMITED,
} from '../src/wire/constants.js';
import { fakeRateChange } from '../test/fake/oscar-rooms.js';
import type { FakeOscarServer, FakePeer } from '../test/fake/oscar-server.js';
import type { DriverProcess } from './driver-process.js';
import type { DriverEvent, Reply } from './protocol.js';
import * as text from './text.js';

export type ScenarioContext = {
  fake: FakeOscarServer;
  server: { host: string; port: number };
  driver: DriverProcess;
  peer: FakePeer;
  signOn(password?: string): Promise<Reply>;
};
export type Scenario = { name: string; limitMs?: number; run(ctx: ScenarioContext): Promise<void> };

export class ScenarioFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioFailure';
  }
}

const IM_RATE_CLASS = 3;
const BURST_COUNT = 20;
// The test server's IM class lets three IMs go at once, then one about every 5 s: about 85 s for twenty.
const BURST_REPLY_MS = 120_000;
const BURST_SETTLE_MS = 5000;
const RECONNECT_ONLINE_MS = 15_000;
const BACKOFF_MIN_MS = 1000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
  throw new ScenarioFailure(message);
}

function expectOk(op: string, reply: Reply): void {
  if (!reply.ok) fail(text.REPLY_FAILED(op, reply.error));
}

async function event<E extends DriverEvent['event']>(
  ctx: ScenarioContext,
  name: E,
  ms: number,
  match: (e: Extract<DriverEvent, { event: E }>) => boolean = () => true,
): Promise<Extract<DriverEvent, { event: E }>> {
  try {
    const found = await ctx.driver.nextEvent((e) => e.event === name && match(e as Extract<DriverEvent, { event: E }>), ms);
    return found as Extract<DriverEvent, { event: E }>;
  } catch (error) {
    if (error instanceof Error && error.message === text.NO_EVENT(ms)) fail(text.WAITING_FOR(`${name} event`));
    throw error;
  }
}

async function signedOn(ctx: ScenarioContext): Promise<void> {
  expectOk('signOn', await ctx.signOn());
  await event(ctx, 'online', 10_000);
}

async function expectOneLogin(ctx: ScenarioContext, waitMs: number): Promise<void> {
  await sleep(waitMs);
  if (ctx.fake.bucpLogins.length !== 1) fail(text.EXTRA_LOGINS(ctx.fake.bucpLogins.length));
}

async function refusedWith(ctx: ScenarioContext, password: string, accepted: string[]): Promise<void> {
  const reply = await ctx.signOn(password);
  if (reply.ok) fail(text.REPLIED_OK);
  if (!accepted.includes(reply.error)) fail(text.EXPECTED_ERROR(accepted.join(' or '), reply.error));
  await expectOneLogin(ctx, 5000);
}

async function untilPeerHears(ctx: ScenarioContext, word: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ctx.peer.ims().some((im) => im.html.includes(word))) return;
    await sleep(50);
  }
  fail(text.NO_PEER_IM(ms));
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'sign-on',
    run: signedOn,
  },
  {
    name: 'wrong-password',
    run: (ctx) => refusedWith(ctx, 'wrongpw1', ['wrong-password']),
  },
  {
    name: 'refused-login',
    run: async (ctx) => {
      ctx.fake.addUser('Bot', 'botpass1', { loginError: 0x1d });
      await refusedWith(ctx, 'botpass1', ['login-rate-limited', 'too-many-sessions']);
    },
  },
  {
    name: 'receive-im',
    run: async (ctx) => {
      await signedOn(ctx);
      ctx.driver.markSeen();
      ctx.peer.sendIm('Bot', 'hello');
      await event(ctx, 'im', 5000, (e) => e.from === 'Alice' && e.text === 'hello');
    },
  },
  {
    name: 'send-im',
    run: async (ctx) => {
      await signedOn(ctx);
      expectOk('sendIm', await ctx.driver.request({ op: 'sendIm', to: 'Alice', text: 'hi' }));
      await untilPeerHears(ctx, 'hi', 5000);
    },
  },
  {
    name: 'buddy-list',
    run: async (ctx) => {
      ctx.peer.signOff();
      await signedOn(ctx);
      const reply = await ctx.driver.request({ op: 'buddies' });
      if (!reply.ok) return fail(text.REPLY_FAILED('buddies', reply.error));
      const alice = reply.buddies?.find((b) => b.screenName === 'Alice');
      if (!alice) fail(text.BUDDY_MISSING);
      if (alice.online) fail(text.BUDDY_WRONG(false));
      ctx.driver.markSeen();
      ctx.peer.signOn();
      await event(ctx, 'buddy', 5000, (e) => e.screenName === 'Alice' && e.online);
      ctx.driver.markSeen();
      ctx.peer.signOff();
      await event(ctx, 'buddy', 5000, (e) => e.screenName === 'Alice' && !e.online);
    },
  },
  {
    name: 'warning',
    run: async (ctx) => {
      await signedOn(ctx);
      expectOk('sendIm', await ctx.driver.request({ op: 'sendIm', to: 'Alice', text: 'hi' }));
      ctx.driver.markSeen();
      ctx.peer.warn('Bot');
      await event(ctx, 'warned', 5000, (e) => e.level > 0);
    },
  },
  {
    name: 'rate-limited',
    run: async (ctx) => {
      await signedOn(ctx);
      const change = (code: number): void =>
        ctx.fake.sendSnac('Bot', FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE, fakeRateChange(code, IM_RATE_CLASS));
      ctx.driver.markSeen();
      change(RATE_CODE_LIMITED);
      await event(ctx, 'rateLimited', 5000, (e) => e.limited);
      ctx.driver.markSeen();
      change(RATE_CODE_CLEAR);
      await event(ctx, 'rateLimited', 5000, (e) => !e.limited);
    },
  },
  {
    name: 'burst',
    limitMs: 150_000,
    run: async (ctx) => {
      await signedOn(ctx);
      const deadline = Date.now() + BURST_REPLY_MS;
      for (let i = 0; i < BURST_COUNT; i++) {
        const left = deadline - Date.now();
        if (left <= 0) fail(text.BURST_TOO_SLOW(BURST_COUNT, BURST_REPLY_MS));
        const reply = await ctx.driver.request({ op: 'sendIm', to: 'Alice', text: `burst ${i}` }, left).catch((error: unknown) => {
          if (Date.now() >= deadline) fail(text.BURST_TOO_SLOW(BURST_COUNT, BURST_REPLY_MS));
          throw error;
        });
        expectOk('sendIm', reply);
      }
      // A driver can reply before the server reads the IM. Wait until the server has them all, or has closed the connection.
      const read = (): number => ctx.fake.snacsFrom('Bot').filter((snac) => snac.family === FAMILY_ICBM && snac.subtype === ICBM_MSG_TO_HOST).length;
      const settleBy = Date.now() + BURST_SETTLE_MS;
      while (read() < BURST_COUNT && ctx.fake.openConnections('Bot').includes('bos') && Date.now() < settleBy) await sleep(20);
      if (!ctx.fake.openConnections('Bot').includes('bos')) fail(text.DISCONNECTED);
      if (ctx.fake.bucpLogins.length !== 1) fail(text.EXTRA_LOGINS(ctx.fake.bucpLogins.length));
    },
  },
  {
    name: 'reconnect',
    run: async (ctx) => {
      await signedOn(ctx);
      let secondLoginAt: number | undefined;
      const before = ctx.fake.onSnacHook;
      // The hook runs as the login request arrives, before the driver can report online.
      ctx.fake.onSnacHook = (snac) => {
        before?.(snac);
        if (snac.family === FAMILY_BUCP && snac.subtype === BUCP_LOGIN_REQUEST) secondLoginAt ??= Date.now();
      };
      try {
        ctx.driver.markSeen();
        const droppedAt = Date.now();
        ctx.fake.dropSocket('Bot');
        const retry = await event(ctx, 'reconnecting', 5000);
        if (retry.inMs < BACKOFF_MIN_MS) fail(text.BACKOFF_TOO_SHORT(retry.inMs));
        await event(ctx, 'online', droppedAt + RECONNECT_ONLINE_MS - Date.now());
        if (secondLoginAt === undefined) fail(text.NEVER_RECONNECTED);
        if (secondLoginAt - droppedAt < BACKOFF_MIN_MS) fail(text.RECONNECTED_EARLY(secondLoginAt - droppedAt));
      } finally {
        ctx.fake.onSnacHook = before;
      }
    },
  },
  {
    name: 'server-sign-off',
    run: async (ctx) => {
      await signedOn(ctx);
      ctx.driver.markSeen();
      ctx.fake.kick('Bot');
      await event(ctx, 'signedOff', 5000);
      await expectOneLogin(ctx, 10_000);
    },
  },
  {
    name: 'sign-off',
    run: async (ctx) => {
      await signedOn(ctx);
      expectOk('signOff', await ctx.driver.request({ op: 'signOff' }));
      await expectOneLogin(ctx, 5000);
    },
  },
];
