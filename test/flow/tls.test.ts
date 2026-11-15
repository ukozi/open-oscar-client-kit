import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignOnError } from '../../src/client/errors.js';
import { memoryIconStore } from '../../src/client/icons.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import { bucpTicketSource, storedTicketSource } from '../../src/client/tickets.js';
import { FAMILY_BART } from '../../src/wire/bart.js';
import { ByteReader } from '../../src/wire/bytes.js';
import { isTlsError } from '../../src/wire/connection.js';
import { FAMILY_CHAT, FAMILY_CHATNAV, FAMILY_OSERVICE, OSERVICE_SERVICE_REQUEST, SERVICE_TLV_USE_SSL } from '../../src/wire/constants.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeTlvs } from '../../src/wire/tlv.js';
import type { DirectImStatus } from '../../src/model/direct-im.js';
import type { RoomId } from '../../src/model/room.js';
import { makeClient, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, captureLog, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord, StartOptions } from '../fake/oscar-server.js';
import { TEST_TLS_CERT } from '../fake/tls-fixture.js';
import { md5Hex, pngImage } from '../support/png.js';

const ROOM: RoomId = { exchange: 4, name: 'Secure Room' };
const PNG = pngImage(8, 8);
const HEX = md5Hex(PNG);
const ADVERTISED = 'oscar.example.invalid:5190';
// The default host online of the test server without the icon service, so that an icon needs a service connection.
const HOST_ONLINE_WITHOUT_ICONS = [0x0018, 0x0003, 0x0013, 0x0004, 0x0015, 0x0002, 0x0001, 0x0009, 0x000a, 0x0006, 0x0008, 0x000b];

type Options = Omit<Partial<OscarClientOptions>, 'now' | 'timers'>;

let dir: string;
let caFile: string;
let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kit-tls-'));
  caFile = join(dir, 'ca.pem');
  await writeFile(caFile, TEST_TLS_CERT);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const buddies = (names: string[]): FeedbagItem[] =>
  withTypingPref([
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    ...names.map((name, i): FeedbagItem => ({ name, groupId: 1, itemId: i + 1, classId: 0, attrs: [] })),
  ]);

async function start(options: StartOptions = {}, client: Options = {}): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, tls: true, ...options });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw123');
  fake.setFeedbag('Alice', buddies(['bob']));
  h = makeClient(fake, { timers, tls: { caFile }, ...client });
}

const here = (): { host: string; port: number } => ({ host: '127.0.0.1', port: fake.port });
const isServiceRequest = (s: SnacRecord): boolean => s.family === FAMILY_OSERVICE && s.subtype === OSERVICE_SERVICE_REQUEST;
// The food group and the SSL TLV of each service request, in order.
const serviceRequests = (name = 'alice'): [number, boolean][] =>
  fake
    .snacsFrom(name)
    .filter(isServiceRequest)
    .map((s) => [new ByteReader(s.body).u16(), decodeTlvs(s.body.subarray(2)).some((t) => t.tag === SERVICE_TLV_USE_SSL)]);
// Each connection the client opened: its label, its host and whether it used TLS.
const opened = (of: ClientHarness = h): { conn: unknown; host: unknown; tls: unknown }[] =>
  of.logs.lines
    .filter((line) => line.msg === 'oscar connection open')
    .map((line) => ({ conn: line.fields?.conn, host: line.fields?.host, tls: line.fields?.tls }));
const failure = (work: Promise<unknown>): Promise<unknown> => work.then(() => undefined, (error: unknown) => error);

describe('a client with the tls option', () => {
  it("signs on over TLS with the kit's own login", async () => {
    await start();
    expect(await h.signOn()).toBe('online');
    expect(opened()).toEqual([
      { conn: 'auth', host: '127.0.0.1', tls: true },
      { conn: 'bos', host: '127.0.0.1', tls: true },
    ]);
  });

  it('signs on over TLS with a ticket from signOnWith', async () => {
    await start();
    const deps = { log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} }, tls: { caFile } };
    const issued = await bucpTicketSource({ ...deps, credentials: { screenName: 'Alice', password: 'alicepw1' }, server: here() }).ticket({ reconnect: false, track: () => {} });
    expect(await h.client.signOnWith(storedTicketSource(issued), here())).toBe('online');
    expect(opened()).toEqual([{ conn: 'bos', host: '127.0.0.1', tls: true }]);
  });

  it('joins a room over TLS: the service requests carry TLV 0x8C and both room sockets are TLS', async () => {
    await start();
    await h.signOn();
    expect((await h.client.joinRoom(ROOM)).state).toBe('joined');
    expect(serviceRequests()).toEqual([
      [FAMILY_CHATNAV, true],
      [FAMILY_CHAT, true],
    ]);
    expect(opened().slice(2)).toEqual([
      { conn: 'chatnav', host: '127.0.0.1', tls: true },
      { conn: 'chat', host: '127.0.0.1', tls: true },
    ]);
  });

  it('falls back to the configured address when the server refuses the SSL service request', async () => {
    await start({ refuseSsl: true, serviceHost: ADVERTISED });
    await h.signOn();
    expect((await h.client.joinRoom(ROOM)).state).toBe('joined');
    expect(serviceRequests()).toEqual([
      [FAMILY_CHATNAV, true],
      [FAMILY_CHATNAV, false],
      [FAMILY_CHAT, true],
      [FAMILY_CHAT, false],
    ]);
    expect(await h.client.probeService(FAMILY_CHATNAV)).toEqual({ ...here(), pinned: true });
    expect(opened().filter((line) => line.host !== '127.0.0.1' || line.tls !== true)).toEqual([]);
  });

  it('the fallback keeps the configured address also with followRedirects', async () => {
    await start({ refuseSsl: true, serviceHost: ADVERTISED }, { followRedirects: true });
    await h.signOn();
    expect(await h.client.probeService(FAMILY_CHATNAV)).toEqual({ ...here(), pinned: true });
  });

  it('asks a refused service one more time and no more, and rejects with the code', async () => {
    await start();
    await h.signOn();
    await expect(h.client.probeService(0x0777)).rejects.toMatchObject({ info: { kind: 'refused', code: 0x0005 } });
    expect(serviceRequests()).toEqual([
      [0x0777, true],
      [0x0777, false],
    ]);
  });

  it('does not follow a plaintext advertisement under TLS', async () => {
    await start({ sslHost: false, advertisedHost: ADVERTISED, serviceHost: ADVERTISED });
    await h.signOn();
    expect((await h.client.joinRoom(ROOM)).state).toBe('joined');
    expect(serviceRequests()).toEqual([
      [FAMILY_CHATNAV, true],
      [FAMILY_CHAT, true],
    ]);
    expect(opened().map((line) => [line.conn, line.host, line.tls])).toEqual([
      ['auth', '127.0.0.1', true],
      ['bos', '127.0.0.1', true],
      ['chatnav', '127.0.0.1', true],
      ['chat', '127.0.0.1', true],
    ]);
  });

  it('with followRedirects a plaintext advertisement under TLS fails the login as unreachable', async () => {
    await start({ sslHost: false }, { followRedirects: true });
    const error = await failure(h.signOn());
    expect(error).toBeInstanceOf(SignOnError);
    expect((error as SignOnError).failure).toEqual({ kind: 'unreachable' });
    expect(opened().map((line) => line.conn)).toEqual(['auth']);
  });

  it('with followRedirects a plaintext advertisement under TLS refuses a service request with code 0', async () => {
    await start({}, { followRedirects: true });
    await h.signOn();
    fake.setSslHost(false);
    await expect(h.client.probeService(FAMILY_CHATNAV)).rejects.toMatchObject({ name: 'OscarError', info: { kind: 'refused', code: 0 } });
    expect(serviceRequests()).toEqual([[FAMILY_CHATNAV, true]]);
    expect(opened().map((line) => line.conn)).toEqual(['auth', 'bos']);
  });

  it('a client with no caFile fails the sign-on and the SignOnError cause is the TLS error', async () => {
    await start({}, { tls: {} });
    const error = await failure(h.signOn());
    expect(error).toBeInstanceOf(SignOnError);
    expect((error as SignOnError).failure).toEqual({ kind: 'unreachable' });
    expect(isTlsError((error as SignOnError).cause)).toBe(true);
  });

  it('a Direct IM under tls still opens a plain peer socket', async () => {
    await start({ timers: timers.api, relay: true }, { directIm: {} });
    await h.signOn();
    const bob = makeClient(fake, { timers, tls: { caFile }, directIm: {} });
    await bob.signOn('Bob', 'bobpw123');
    const last = (of: ClientHarness, id: string): DirectImStatus | undefined => of.directIms.filter((status) => status.id === id).at(-1);
    const id = await h.client.openDirectIm('Bob');
    await waitFor(() => bob.directImOffers.length === 1, 'the offer');
    const offer = bob.directImOffers[0];
    if (!offer) throw new Error('no offer');
    await bob.client.acceptDirectIm(offer.id);
    // The listener of the relay is plain TCP: the two sides see the cookie of each other only on plain sockets.
    await waitFor(() => last(h, id)?.verified === true && last(bob, offer.id)?.verified === true, 'the cookie of each side');
    await h.client.sendDirectMessage(id, { body: [{ text: 'in the clear' }], pictures: [] });
    await waitFor(() => bob.directMessages.length === 1, 'the message');
    expect(fake.relayed().length).toBe(1);
    expect([...opened(), ...opened(bob)].every((line) => line.tls === true)).toBe(true);
  });

  it('fetches an icon and probes a service over TLS', async () => {
    await start({ hostOnline: HOST_ONLINE_WITHOUT_ICONS }, { iconStore: memoryIconStore() });
    fake.peer('Bob').setIcon(PNG);
    await h.signOn();
    await waitFor(() => h.client.iconOf('bob') === HEX, 'the icon of bob');
    expect(await h.client.probeService(FAMILY_CHATNAV)).toEqual({ ...here(), pinned: false });
    expect(serviceRequests()).toEqual([
      [FAMILY_BART, true],
      [FAMILY_CHATNAV, true],
    ]);
    expect(opened().slice(2)).toEqual([
      { conn: 'bart', host: '127.0.0.1', tls: true },
      { conn: 'probe', host: '127.0.0.1', tls: true },
    ]);
  });

  it('reads the account email and the directory keywords over TLS', async () => {
    await start();
    await h.signOn();
    await h.client.accountEmail();
    await h.client.directoryKeywords();
    expect(serviceRequests().every(([, ssl]) => ssl)).toBe(true);
    expect(opened().slice(2)).toEqual([
      { conn: 'admin', host: '127.0.0.1', tls: true },
      { conn: 'odir', host: '127.0.0.1', tls: true },
    ]);
  });
});

describe('a client with no tls option', () => {
  it('a refused TCP connect gives a SignOnError whose cause has code ECONNREFUSED', async () => {
    timers = new ManualTimers();
    fake = await FakeOscarServer.start({ now: timers.now });
    const gone = await FakeOscarServer.start();
    const port = gone.port;
    await gone.stop();
    const guarded: unknown[] = [];
    h = makeClient(fake, { timers, guard: (error) => guarded.push(error) });
    const error = await failure(h.client.signOn({ screenName: 'Alice', password: 'alicepw1' }, { host: '127.0.0.1', port }));
    expect(error).toBeInstanceOf(SignOnError);
    expect((error as SignOnError).evidence).toEqual({ kind: 'connect-refused' });
    expect(((error as SignOnError).cause as { code?: unknown }).code).toBe('ECONNREFUSED');
    // The connect error is not a defect: the log names the failure as before and the guard gets nothing.
    const logged = h.logs.lines.find((line) => line.msg === 'sign-on failed');
    expect(logged?.fields).toMatchObject({ kind: 'unreachable', evidence: 'connect-refused', cause: 'unreachable' });
    expect(guarded).toEqual([]);
  });
});
