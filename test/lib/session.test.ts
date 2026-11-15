import { afterEach, describe, expect, it } from 'vitest';
import { parseAimHtml } from '../../src/client/aim-html.js';
import { clientIdFor } from '../../src/client/client-id.js';
import { signOn, SignOnFailedError, VERSION } from '../../lib/index.js';
import type { Session, SessionEvents, SignOnOptions } from '../../lib/index.js';
import { openSession } from '../../lib/session.js';
import * as text from '../../lib/text.js';
import { waitFor } from '../fake/oscar-client.js';
import { fakeRateChange } from '../fake/oscar-rooms.js';
import type { FakeOscarServer } from '../fake/oscar-server.js';
import { IM_RATE_CLASS, startFake } from './support.js';

let fake: FakeOscarServer;
let server: { host: string; port: number };
let session: Session | undefined;
// The login budget is shared by the process and spaces sign-ons; a test needs none.
const open = (options: SignOnOptions) => openSession(options, { loginBudget: { take: async () => {} } });
const login = (extra: object = {}) => ({ screenName: 'Bot', password: 'botpass1', app: 'Echo', server, ...extra });

async function start(): Promise<void> {
  ({ fake, server } = await startFake());
}

function collect<E extends keyof SessionEvents>(s: Session, event: E): SessionEvents[E][] {
  const seen: SessionEvents[E][] = [];
  s.on(event, (payload) => seen.push(payload));
  return seen;
}

afterEach(async () => {
  await session?.signOff();
  session = undefined;
  await fake?.stop();
});

describe('signOn', () => {
  it('signs on and reports online', async () => {
    await start();
    session = await signOn(login());
    expect(session.screenName).toBe('Bot');
  });

  it("sends the program's name in the client ID", async () => {
    await start();
    session = await open(login());
    expect(fake.bucpLogins[0]?.clientId).toBe(clientIdFor('Echo (open-oscar-client-kit)', VERSION, process.platform));
  });

  it('fails a wrong password with its kind', async () => {
    await start();
    const error = await open(login({ password: 'nope' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignOnFailedError);
    expect((error as SignOnFailedError).kind).toBe('wrong-password');
    expect((error as SignOnFailedError).message).toBe(text.SIGN_ON_FAILED('wrong-password'));
  });

  it('refuses a bad app name before connecting', async () => {
    await start();
    await expect(open(login({ app: '' }))).rejects.toThrow(new TypeError(text.APP_NAME_INVALID));
    await expect(open(login({ app: 'x'.repeat(65) }))).rejects.toThrow(new TypeError(text.APP_NAME_INVALID));
    expect(fake.bucpLogins).toEqual([]);
  });
});

describe('a session', () => {
  it('receives an IM as text and HTML', async () => {
    await start();
    session = await open(login());
    const ims = collect(session, 'im');
    fake.peer('Alice').sendIm('Bot', '<b>a &amp; b</b>');
    await waitFor(() => ims.length === 1, 'the IM');
    expect(ims[0]).toMatchObject({ from: 'Alice', text: 'a & b', autoResponse: false });
    expect(ims[0]?.html).toMatch(/<b>/i);
    expect(ims[0]?.html).toContain('&amp;');
  });

  it('sends an IM', async () => {
    await start();
    const peer = fake.peer('Alice');
    session = await open(login());
    await session.sendIm('Alice', 'hi');
    await waitFor(() => peer.ims().length > 0, 'the IM at the peer');
    const html = peer.ims()[0]?.html ?? '';
    expect(parseAimHtml(html).map((run) => run.text).join('')).toBe('hi');
  });

  it('skips server notices', async () => {
    await start();
    session = await open(login());
    const ims = collect(session, 'im');
    const second = await open(login());
    await new Promise((resolve) => setTimeout(resolve, 500));
    await second.signOff();
    expect(ims).toEqual([]);
  });

  it('refuses an empty IM', async () => {
    await start();
    session = await open(login());
    await expect(session.sendIm('Alice', '')).rejects.toThrow(new TypeError(text.IM_EMPTY));
  });

  it('lists the buddy list and reports arrivals and departures', async () => {
    await start();
    const peer = fake.peer('Alice');
    peer.signOff();
    session = await open(login());
    expect(session.buddies()).toEqual([{ screenName: 'Alice', group: 'Buddies', online: false, away: false, idleSince: null }]);
    const seen = collect(session, 'buddy');
    peer.signOn();
    await waitFor(() => seen.some((b) => b.online), 'the arrival');
    expect(seen[0]).toMatchObject({ screenName: 'Alice', group: 'Buddies' });
    peer.signOff();
    await waitFor(() => seen.some((b) => !b.online), 'the departure');
  });

  it('reports a warning', async () => {
    await start();
    const peer = fake.peer('Alice');
    session = await open(login());
    const warned = collect(session, 'warned');
    await session.sendIm('Alice', 'hi');
    await waitFor(() => peer.ims().length > 0, 'the IM at the peer');
    peer.warn('Bot');
    await waitFor(() => warned.length > 0, 'the warning');
    expect(warned[0]?.level).toBeGreaterThan(0);
  });

  it('reports rate limiting', async () => {
    await start();
    session = await open(login());
    const limits = collect(session, 'rateLimited');
    fake.sendSnac('Bot', 1, 0x0a, fakeRateChange(3, IM_RATE_CLASS));
    await waitFor(() => limits.some((l) => l.limited), 'the rate notice');
  });

  it('keeps running when a listener throws', async () => {
    await start();
    session = await open(login());
    const warnings: Error[] = [];
    const onWarning = (w: Error): void => void warnings.push(w);
    process.on('warning', onWarning);
    try {
      const boom = new Error('listener failed');
      session.on('im', () => {
        throw boom;
      });
      const ims = collect(session, 'im');
      fake.peer('Alice').sendIm('Bot', 'hello');
      await waitFor(() => ims.length === 1 && warnings.length > 0, 'the second listener and the warning');
      expect(warnings).toContain(boom);
      fake.peer('Alice').sendIm('Bot', 'again');
      await waitFor(() => ims.length === 2, 'a second IM');
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('signs off', async () => {
    await start();
    session = await open(login());
    const off = collect(session, 'signedOff');
    await session.signOff();
    expect(off).toEqual([{ reason: 'signed-off' }]);
  });
});

describe('a dropped connection', () => {
  it('reconnects by default', async () => {
    await start();
    session = await open(login());
    const waits = collect(session, 'reconnecting');
    const online = collect(session, 'online');
    fake.dropSocket('Bot');
    await waitFor(() => waits.length > 0, 'the reconnect notice');
    expect(waits[0]?.inMs).toBeGreaterThanOrEqual(1500);
    expect(waits[0]?.inMs).toBeLessThanOrEqual(2500);
    await waitFor(() => online.length > 0, 'the session online again', 10_000);
  });

  it('stays off when reconnect is false', async () => {
    await start();
    session = await open(login({ reconnect: false }));
    const off = collect(session, 'signedOff');
    fake.dropSocket('Bot');
    await waitFor(() => off.length > 0, 'the sign-off');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(fake.bucpLogins.length).toBe(1);
  });
});
