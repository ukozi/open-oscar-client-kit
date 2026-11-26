import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OscarError } from '../../src/client/errors.js';
import { ByteReader, fromHex, toHex } from '../../src/wire/bytes.js';
import { RATE_CODE_CLEAR, RATE_CODE_LIMITED } from '../../src/wire/constants.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import type { RoomId } from '../../src/model/room.js';
import type { CommandError } from '../../src/model/session.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, RawClient, settle, tick, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

// Formatting the screen name and reading the email address on the test server's Admin food group (foodgroup/admin.go at 7af2464).

const LOBBY: RoomId = { exchange: 5, name: 'chimr-lobby' };
const MULTI_SESSION = 0x01;
const NOT_OFFERED: CommandError = { kind: 'account', reason: 'not-offered' };
const INVALID: CommandError = { kind: 'account', reason: 'invalid' };
const LOST: CommandError = { kind: 'connection-lost' };
const REFUSED_0: CommandError = { kind: 'refused', code: 0 };

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

const lists = (name: string): FeedbagItem[] =>
  withTypingPref([
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    { name, groupId: 1, itemId: 1, classId: 0, attrs: [] },
  ]);

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  fake.setFeedbag('Alice', lists('bob'));
  fake.setFeedbag('Bob', lists('alice'));
  fake.rooms.addRoom(LOBBY);
  h = makeClient(fake, { timers, random: () => 0 });
});

afterEach(async () => {
  fake.onSnacHook = null;
  await stopAllClients();
  await fake.stop();
});

const is = (family: number, subtype: number) => (s: SnacRecord): boolean => s.family === family && s.subtype === subtype;
const onAdmin = (): SnacRecord[] => fake.snacsFrom('alice').filter((s) => s.conn === 'admin');
const adminServiceRequests = (): SnacRecord[] =>
  fake.snacsFrom('alice').filter((s) => s.conn === 'bos' && is(0x01, 0x04)(s) && new ByteReader(s.body).u16() === 0x0007);
const changes = (): SnacRecord[] => onAdmin().filter(is(0x07, 0x04));
const asked = (count: number): Promise<void> => waitFor(() => changes().length >= count, `change request ${count} to reach the test server`);
const adminGone = (): Promise<void> => waitFor(() => !fake.openConnections('alice').includes('admin'), 'the Admin connection to close');
const adminCloses = (): unknown[] => h.logs.lines.filter((l) => l.msg === 'oscar connection closed' && l.fields?.conn === 'admin').map((l) => l.fields?.kind);
const selfNames = (from: number): string[] => h.selves.slice(from).map((self) => self.screenName);

function u16s(body: Uint8Array): number[] {
  const r = new ByteReader(body);
  const out: number[] = [];
  while (r.remaining >= 2) out.push(r.u16());
  return out;
}

async function failure(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OscarError) return error.info;
    throw error;
  }
  throw new Error('it did not fail');
}

// The client has read what the test server wrote to its sockets before now: loopback I/O, not the clock.
async function landed(): Promise<void> {
  await settle(fake.port);
  await tick();
}

describe('formatting the screen name', () => {
  it('formats the screen name on an Admin connection and closes it', async () => {
    await h.signOn();
    const instances = fake.instancesOf('alice');
    const seen: SnacRecord[] = [];
    fake.onSnacHook = (snac) => {
      if (snac.conn === 'admin' || (snac.conn === 'bos' && is(0x01, 0x04)(snac))) seen.push(snac);
    };
    expect(await h.client.formatScreenName('A Lice')).toBe('A Lice');
    expect(seen.map((s) => `${s.conn} ${s.family}/${s.subtype}`)).toEqual(['bos 1/4', 'admin 1/23', 'admin 1/2', 'admin 7/4']);
    const [service, versions, online] = seen;
    expect(new ByteReader(service?.body ?? new Uint8Array(0)).u16()).toBe(0x0007);
    expect(u16s(versions?.body ?? new Uint8Array(0))).toEqual([0x0001, 1, 0x0007, 1]);
    expect(u16s(online?.body ?? new Uint8Array(0)).filter((_, at) => at % 4 === 0)).toEqual([0x0001, 0x0007]);
    expect(fake.displayOf('alice')).toBe('A Lice');
    await adminGone();
    expect(adminCloses()).toEqual(['local']);
    expect(fake.instancesOf('alice')).toBe(instances);
    expect(h.client.state).toBe('online');
  });

  it('announces the negotiated OService version on an Admin connection', async () => {
    h = makeClient(fake, { timers, random: () => 0, oserviceVersion: 4 });
    await h.signOn();
    await h.client.formatScreenName('A Lice');
    const versions = onAdmin().find(is(0x01, 0x17));
    expect(u16s(versions?.body ?? new Uint8Array(0))).toEqual([0x0001, 4, 0x0007, 1]);
    expect(fake.oserviceVersionOf('alice', 0)).toBe(4);
  });

  it('emits self once whether the reply or the self info comes first', async () => {
    await h.signOn();
    for (const order of ['before', 'after'] as const) {
      fake.admin.selfInfoOrder = order;
      const mark = h.selves.length;
      expect(await h.client.formatScreenName('A Lice')).toBe('A Lice');
      await landed();
      expect(selfNames(mark), order).toEqual(['A Lice']);
      fake.admin.selfInfoOrder = 'none';
      expect(await h.client.formatScreenName('Alice')).toBe('Alice');
      await landed();
    }
  });

  it('updates self from the reply when the server sends no self info', async () => {
    await h.signOn();
    fake.admin.selfInfoOrder = 'none';
    const mark = h.selves.length;
    expect(await h.client.formatScreenName('A Lice')).toBe('A Lice');
    expect(selfNames(mark)).toEqual(['A Lice']);
    expect(h.client.self?.screenName).toBe('A Lice');
  });

  it('gives watchers an arrival with the new form, and none while invisible', async () => {
    const bob = makeClient(fake, { timers });
    await bob.signOn('Bob', 'bobpw1');
    await h.signOn();
    const aliceSeen = (from: number) => bob.presence.slice(from).filter((p) => p.screenName.replace(/ /g, '').toLowerCase() === 'alice');
    await waitFor(() => aliceSeen(0).some((p) => p.online), 'Bob to see Alice');

    let mark = bob.presence.length;
    expect(await h.client.formatScreenName('A Lice')).toBe('A Lice');
    await waitFor(() => aliceSeen(mark).length > 0, "Bob to hear of Alice's format");
    expect(aliceSeen(mark).map((p) => [p.screenName, p.online])).toEqual([['A Lice', true]]);
    expect(await h.client.formatScreenName('Alice')).toBe('Alice');
    await waitFor(() => bob.presence.at(-1)?.screenName === 'Alice', 'Bob to see Alice again');

    await h.client.setInvisible(true);
    await waitFor(() => bob.presence.at(-1)?.online === false, 'Alice to depart for Bob');
    mark = bob.presence.length;
    expect(await h.client.formatScreenName('A Lice')).toBe('A Lice');
    await landed();
    expect(aliceSeen(mark)).toEqual([]);
    await h.client.setInvisible(false);
    await waitFor(() => aliceSeen(mark).length > 0, 'Alice to arrive for Bob');
    expect(aliceSeen(mark).map((p) => [p.screenName, p.online])).toEqual([['A Lice', true]]);
  });

  it('maps codes 0x0001, 0x0006 and 0x000B to not-same and invalid, and any other code to not-offered', async () => {
    await h.signOn();
    const mark = h.selves.length;
    // The test server's own checks (state/user.go:70-95, admin.go:158-176).
    expect(await failure(h.client.formatScreenName('Bob'))).toEqual({ kind: 'account', reason: 'not-same' });
    expect(await failure(h.client.formatScreenName('Al!ce'))).toEqual(INVALID);
    expect(Buffer.byteLength('Alice Alice Alice')).toBe(17);
    expect(await failure(h.client.formatScreenName('Alice Alice Alice'))).toEqual(INVALID);
    for (const code of [0x0004, 0x0013]) {
      fake.admin.refuseNextChange(code);
      expect(await failure(h.client.formatScreenName('A Lice')), `code ${code}`).toEqual(NOT_OFFERED);
    }
    for (const code of [0x0008, 0x0005]) {
      fake.admin.answerAdminErr(code);
      expect(await failure(h.client.formatScreenName('A Lice')), `AdminErr ${code}`).toEqual(NOT_OFFERED);
    }
    fake.admin.answerAdminErr(null);
    await landed();
    expect(selfNames(mark)).toEqual([]);
    expect(h.client.self?.screenName).toBe('Alice');
    expect(fake.displayOf('alice')).toBe('Alice');
  });

  it('says not-offered when the server refuses the Admin service', async () => {
    await h.signOn();
    fake.admin.refuseService(true);
    expect(await failure(h.client.formatScreenName('A Lice'))).toEqual(NOT_OFFERED);
    expect(await failure(h.client.accountEmail())).toEqual(NOT_OFFERED);
    expect(adminServiceRequests()).toHaveLength(2);
    expect(onAdmin()).toEqual([]);
    expect(h.client.state).toBe('online');
  });

  it('fails as refused 0 on a reply cut short or with neither a name nor a code', async () => {
    await h.signOn();
    fake.admin.replaceNextReply(Uint8Array.of(0x00));
    expect(await failure(h.client.formatScreenName('A Lice'))).toEqual(REFUSED_0);
    await adminGone();
    fake.admin.replaceNextReply(fromHex('0003 0000'));
    expect(await failure(h.client.formatScreenName('A Lice'))).toEqual(REFUSED_0);
    await adminGone();
    expect(adminCloses()).toEqual(['local', 'local']);
  });

  describe('a request the server does not answer', () => {
    it('times out a dropped request after 10 s and keeps BOS up', async () => {
      await h.signOn();
      fake.admin.dropNext();
      const formatting = failure(h.client.formatScreenName('A Lice'));
      await asked(1);
      await timers.advance(10_000);
      expect(await formatting).toEqual({ kind: 'timeout', rateLimited: false });
      expect(h.client.state).toBe('online');
      await adminGone();
      expect(fake.openConnections('alice')).toEqual(['bos']);
    });

    // Whether another session of the account spending class 1 can still meet a dropped Admin SNAC; `annotate` records which branch ran.
    it('the governor: a format while another session of the account spends class 1', async ({ annotate }) => {
      await h.signOn();
      const other = await RawClient.signOn(fake.port, 'Alice', 'alicepw1', MULTI_SESSION);
      try {
        const limited = (): boolean => fake.rateNotices('alice').some((n) => n.classId === 1 && n.code === RATE_CODE_LIMITED);
        const queries = (): number => fake.snacsFrom('alice').filter((s) => s.conn === 'bos' && is(0x01, 0x0e)(s)).length;
        for (let id = 0x6000; !limited(); id++) {
          if (id > 0x6000 + 400) throw new Error('class 1 never became limited');
          const before = queries();
          other.snac(0x01, 0x0e, id);
          await waitFor(() => queries() > before, 'the query to reach the test server');
        }
        await waitFor(
          () => h.logs.lines.some((l) => l.msg === 'rate notice' && l.fields?.classId === 1 && l.fields?.code === RATE_CODE_LIMITED),
          "the client to hear that class 1 is limited",
        );
        const droppedBefore = fake.dropped('alice');
        let arrival: { limited: boolean; dropped: number } | null = null;
        fake.onSnacHook = (snac) => {
          if (snac.conn !== 'admin' || !is(0x07, 0x04)(snac)) return;
          const last = fake.rateNotices('alice').filter((n) => n.classId === 1).at(-1);
          arrival = { limited: last?.code !== RATE_CODE_CLEAR, dropped: fake.dropped('alice') };
        };
        let outcome: { value: string } | { error: CommandError } | null = null;
        h.client.formatScreenName('A Lice').then(
          (value) => {
            outcome = { value };
          },
          (error: unknown) => {
            outcome = { error: error instanceof OscarError ? error.info : LOST };
          },
        );
        await landed();
        // Until the class clears, the server's monitor finds it recovered after this long, and a step can time out.
        for (let step = 0; step < 30 && outcome === null; step++) {
          await timers.advance(5_000);
          fake.rateTick('alice');
          await landed();
        }
        await waitFor(() => outcome !== null, 'the format to settle', 5_000);
        const settled = outcome as { value: string } | { error: CommandError } | null;
        if (settled !== null && 'value' in settled) {
          expect(settled.value).toBe('A Lice');
          expect(arrival).toEqual({ limited: false, dropped: droppedBefore });
          expect(fake.dropped('alice')).toBe(droppedBefore);
          await annotate('governor branch: held until class 1 cleared');
        } else {
          expect(settled).toEqual({ error: { kind: 'timeout', rateLimited: true } });
          expect(fake.dropped('alice')).toBeGreaterThan(droppedBefore);
          await annotate('governor branch: dropped, timed out');
        }
      } finally {
        other.close();
      }
    });
  });

  it('fails as connection-lost when the Admin connection closes with no reply', async () => {
    await h.signOn();
    const states = h.states.length;
    fake.admin.hold();
    const destroyed = failure(h.client.formatScreenName('A Lice'));
    await asked(1);
    fake.dropAdmin('alice');
    expect(await destroyed).toEqual(LOST);
    fake.admin.release();
    await adminGone();

    // A sign-off frame on it, TLV 0x09 included, says nothing of the session.
    fake.admin.hold();
    const signedOff = failure(h.client.formatScreenName('A Lice'));
    await asked(2);
    fake.signOffAdmin('alice');
    expect(await signedOff).toEqual(LOST);
    fake.admin.release();
    await adminGone();
    await landed();
    expect(h.client.state).toBe('online');
    expect(h.states.slice(states)).toEqual([]);
    // The server ended both: a destroyed socket reads as an end or a reset by platform, the second as the sign-off frame.
    const [destroyedBy, signedOffBy] = adminCloses();
    expect(adminCloses()).toHaveLength(2);
    expect(['eof', 'error']).toContain(destroyedBy);
    expect(signedOffBy).toBe('signoff');
  });

  it('closes the Admin connection and fails the request when BOS is lost', async () => {
    await h.signOn();
    // The change reply is withheld, and with it the sign-off the server sends when its BOS ends: so only the client can close it.
    const release = fake.withhold(0x0007, 0x0005);
    const formatting = failure(h.client.formatScreenName('A Lice'));
    await asked(1);
    fake.dropInstance('Alice', 0);
    expect(await formatting).toEqual(LOST);
    await waitFor(() => h.client.state === 'reconnecting', 'the client to reconnect');
    expect(adminCloses()).toEqual(['local']);
    await adminGone();
    release();
  });

  it('closes the Admin connection at sign-off', async () => {
    await h.signOn();
    fake.admin.hold();
    const formatting = failure(h.client.formatScreenName('A Lice'));
    await asked(1);
    await h.client.signOff();
    expect(await formatting).toEqual(LOST);
    expect(adminCloses()).toEqual(['local']);
    await adminGone();
    fake.admin.release();
  });

  it('refuses a second format while one waits', async () => {
    await h.signOn();
    fake.admin.hold();
    const first = h.client.formatScreenName('A Lice');
    expect(await failure(h.client.formatScreenName('A Lice'))).toEqual({ kind: 'local', code: 'busy' });
    await asked(1);
    fake.admin.release();
    expect(await first).toBe('A Lice');
    expect(adminServiceRequests()).toHaveLength(1);
  });

  it('reads the email address, and none as null, asking one field', async () => {
    await h.signOn();
    fake.admin.setEmail('alice', 'alice@example.com');
    expect(await h.client.accountEmail()).toBe('alice@example.com');
    fake.admin.setEmail('alice', '');
    expect(await h.client.accountEmail()).toBeNull();
    // TLV 0x11 of length 0 alone, with no count.
    expect(onAdmin().filter(is(0x07, 0x02)).map((s) => toHex(s.body))).toEqual(['00110000', '00110000']);
    await adminGone();
  });

  it('joins rooms after a format with the new form as self', async () => {
    await h.signOn();
    expect(await h.client.formatScreenName('A Lice')).toBe('A Lice');
    const status = await h.client.joinRoom(LOBBY);
    expect(status.state).toBe('joined');
    // The server names the occupant by its display name when the client asks for the room's service (oservice.go:656-661).
    expect(status.occupants).toEqual(['A Lice']);
  });

  it('refuses Block of the own name in the new spelling after a format', async () => {
    await h.signOn();
    expect(await h.client.formatScreenName('A Lice')).toBe('A Lice');
    expect(await failure(h.client.block('alice'))).toEqual({ kind: 'local', code: 'own-screen-name' });
  });
});
