import { afterEach, describe, expect, it } from 'vitest';
import { ByteWriter } from '../../src/wire/bytes.js';
import { decodeSnacErrorCode, encodeCreateRoom } from '../../src/wire/chatnav.js';
import {
  FAMILY_CHATNAV,
  FAMILY_OSERVICE,
  ICBM_TLV_REQUEST_HOST_ACK,
  ICBM_TLV_SEND_TIME,
  ICBM_TLV_STORE,
  OSERVICE_ERR,
  OSERVICE_RATE_PARAM_CHANGE,
  OSERVICE_SERVICE_RESPONSE,
  RATE_CODE_LIMITED,
  SERVICE_TLV_SSL_STATE,
} from '../../src/wire/constants.js';
import { decodeImToClient, encodeImToHost } from '../../src/wire/icbm.js';
import { decodeRateParamChange } from '../../src/wire/rate.js';
import { decodeSnac } from '../../src/wire/snac.js';
import type { Snac } from '../../src/wire/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, hasTlv, tlv, tlvU8 } from '../../src/wire/tlv.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import type { RawTarget } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { StartOptions } from '../fake/oscar-server.js';
import { TEST_TLS_CERT } from '../fake/tls-fixture.js';

const SENT_AT = 1_790_000_000;
const IM_RATE_CLASS = 3;
const GENERATIONS = ['v0.24', 'main'] as const;

let fake: FakeOscarServer | undefined;
const open: RawClient[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) client.close();
  await fake?.stop();
  fake = undefined;
});

async function start(opts: StartOptions = {}): Promise<FakeOscarServer> {
  fake = await FakeOscarServer.start(opts);
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw123');
  return fake;
}

function target(server: FakeOscarServer, overTls = false): RawTarget {
  return overTls ? { port: server.port, ca: TEST_TLS_CERT } : server.port;
}

async function signOn(server: FakeOscarServer, name: string, password: string, overTls = false): Promise<RawClient> {
  const bos = await RawClient.signOn(target(server, overTls), name, password);
  open.push(bos);
  return bos;
}

function snacsOf(client: RawClient): Snac[] {
  return client.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload));
}

function of(client: RawClient, family: number, subtype: number): Snac[] {
  return snacsOf(client).filter((s) => s.family === family && s.subtype === subtype);
}

// The test server handles one connection's SNACs in order: when this echo is back, all it wrote before has arrived.
let marker = 0x7000;
async function roundTrip(client: RawClient): Promise<void> {
  const requestId = marker++;
  client.snac(1, 0x17, requestId);
  await waitFor(() => snacsOf(client).some((s) => s.subtype === 0x18 && s.requestId === requestId), 'the version echo');
}

async function subscribe(client: RawClient): Promise<void> {
  const w = new ByteWriter();
  for (const id of [1, 2, 3, 4, 5]) w.u16(id);
  client.snac(1, 0x08, marker++, w.toBytes());
  await roundTrip(client);
}

async function openNav(server: FakeOscarServer, bos: RawClient): Promise<RawClient> {
  const nav = await RawClient.service(server.port, await bos.requestService(FAMILY_CHATNAV));
  open.push(nav);
  await nav.nextSnac();
  return nav;
}

// A ChatNav request and its answer: all the test server wrote to this connection before has arrived.
async function navRoundTrip(nav: RawClient, name: string): Promise<void> {
  const requestId = marker++;
  nav.snac(FAMILY_CHATNAV, 0x08, requestId, encodeCreateRoom({ exchange: 4, name }));
  await waitFor(() => snacsOf(nav).some((s) => s.requestId === requestId), 'the ChatNav answer');
}

// An IM with the host-ack and store TLVs that encodeImToHost writes, and a send-time TLV after them.
function imWithEveryTlv(to: string): Uint8Array {
  const body = encodeImToHost(0x1122334455667788n, to, 0, new Uint8Array(Buffer.from('hi', 'latin1')), true);
  return new ByteWriter().bytes(body).bytes(encodeTlvs([tlv.u32(ICBM_TLV_SEND_TIME, SENT_AT)])).toBytes();
}

async function relayedTlvs(server: FakeOscarServer): Promise<number[]> {
  const alice = await signOn(server, 'Alice', 'alicepw1');
  const bob = await signOn(server, 'Bob', 'bobpw123');
  alice.snac(4, 0x06, marker++, imWithEveryTlv('Bob'));
  await waitFor(() => of(bob, 4, 0x07).length === 1, 'the relayed IM');
  const [im] = of(bob, 4, 0x07);
  if (!im) throw new Error('no IM');
  return decodeImToClient(im.body).tlvs.map((t) => t.tag);
}

// A BOS connection that has not sent client online.
async function beforeClientOnline(server: FakeOscarServer): Promise<RawClient> {
  const { tlvs, client: auth } = await RawClient.login(server.port, 'Alice', 'alicepw1');
  auth.close();
  const bos = await RawClient.connect(server.port);
  open.push(bos);
  bos.signon([tlv.bytes(0x06, findTlv(tlvs, 0x06) ?? new Uint8Array(0))]);
  await bos.nextSnac();
  return bos;
}

async function retrieve(client: RawClient): Promise<void> {
  const requestId = marker++;
  client.snac(4, 0x10, requestId);
  await waitFor(() => snacsOf(client).some((s) => s.subtype === 0x17 && s.requestId === requestId), 'the end of the offline messages');
}

describe('the test server generation', () => {
  it.each(GENERATIONS)('%s: the store TLV of an IM reaches the recipient or stops at the server', async (generation) => {
    const tags = await relayedTlvs(await start({ generation }));
    const kept = generation === 'v0.24';
    expect(tags.includes(ICBM_TLV_STORE)).toBe(kept);
    expect(tags.includes(ICBM_TLV_SEND_TIME)).toBe(kept);
    expect(tags.includes(ICBM_TLV_REQUEST_HOST_ACK)).toBe(false);
  });

  it.each(GENERATIONS)('%s: the sender of a relayed IM gets its host ack', async (generation) => {
    const server = await start({ generation });
    const alice = await signOn(server, 'Alice', 'alicepw1');
    await signOn(server, 'Bob', 'bobpw123');
    const requestId = marker++;
    alice.snac(4, 0x06, requestId, imWithEveryTlv('Bob'));
    await waitFor(() => snacsOf(alice).some((s) => s.requestId === requestId), 'the answer');
    expect(snacsOf(alice).find((s) => s.requestId === requestId)?.subtype).toBe(0x0c);
  });

  it('v0.24 states no SSL in the login reply of a TLS server; main states it', async () => {
    const stated = async (generation: 'v0.24' | 'main'): Promise<number | undefined> => {
      const server = await start({ tls: true, generation });
      const { tlvs, client } = await RawClient.login(target(server, true), 'Alice', 'alicepw1');
      client.close();
      await server.stop();
      fake = undefined;
      return tlvU8(tlvs, 0x8e);
    };
    expect(await stated('v0.24')).toBe(0x00);
    expect(await stated('main')).toBe(0x02);
  });

  it('v0.24 refuses a service request that asks for SSL; main answers it', async () => {
    const old = await signOn(await start({ tls: true, generation: 'v0.24' }), 'Alice', 'alicepw1', true);
    const refused = await old.askService(FAMILY_CHATNAV, { useSsl: true });
    expect([refused.family, refused.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_ERR]);
    expect(decodeSnacErrorCode(refused.body)).toBe(0x001c);
    const plain = await old.askService(FAMILY_CHATNAV, { useSsl: false });
    expect([plain.family, plain.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE]);
    expect(tlvU8(decodeTlvs(plain.body), SERVICE_TLV_SSL_STATE)).toBe(0x00);
    await fake?.stop();

    const current = await signOn(await start({ tls: true, generation: 'main' }), 'Alice', 'alicepw1', true);
    const answered = await current.askService(FAMILY_CHATNAV, { useSsl: true });
    expect([answered.family, answered.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE]);
    expect(tlvU8(decodeTlvs(answered.body), SERVICE_TLV_SSL_STATE)).toBe(0x02);
  });

  it('v0.24 refuses a service request that asks for SSL on a plain server too', async () => {
    const bos = await signOn(await start({ generation: 'v0.24' }), 'Alice', 'alicepw1');
    const refused = await bos.askService(FAMILY_CHATNAV, { useSsl: true });
    expect([refused.family, refused.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_ERR]);
  });

  it('v0.24 deletes stored messages retrieved before client online; main keeps them', async () => {
    const old = await start({ generation: 'v0.24', notices: false });
    old.storeOffline('Alice', 'Bob', 'while you were out', SENT_AT);
    const early = await beforeClientOnline(old);
    await retrieve(early);
    expect(of(early, 4, 0x07)).toEqual([]);
    expect(old.storedFor('Alice')).toEqual([]);
    await fake?.stop();

    const current = await start({ generation: 'main', notices: false });
    current.storeOffline('Alice', 'Bob', 'while you were out', SENT_AT);
    const kept = await beforeClientOnline(current);
    await retrieve(kept);
    const delivered = of(kept, 4, 0x07).map((s) => decodeImToClient(s.body));
    expect(delivered.map((im) => im.sender.name)).toEqual(['bob']);
    expect(hasTlv(delivered[0]?.tlvs ?? [], ICBM_TLV_SEND_TIME)).toBe(true);
    expect(current.storedFor('Alice')).toEqual([]);
  });

  it('v0.24 delivers stored messages retrieved after client online', async () => {
    const server = await start({ generation: 'v0.24', notices: false });
    server.storeOffline('Alice', 'Bob', 'while you were out', SENT_AT);
    const alice = await signOn(server, 'Alice', 'alicepw1');
    await retrieve(alice);
    expect(of(alice, 4, 0x07).map((s) => decodeImToClient(s.body).sender.name)).toEqual(['bob']);
    expect(server.storedFor('Alice')).toEqual([]);
  });

  it('v0.24 sends a BOS rate notice on the ChatNav connection; main sends it on BOS', async () => {
    const notices = async (generation: 'v0.24' | 'main'): Promise<{ bos: number[]; nav: number[] }> => {
      const server = await start({ generation });
      const bos = await signOn(server, 'Alice', 'alicepw1');
      await subscribe(bos);
      const nav = await openNav(server, bos);
      server.setRateParams('Alice', IM_RATE_CLASS, {});
      await roundTrip(bos);
      await navRoundTrip(nav, 'Dev Room');
      const classes = (client: RawClient): number[] =>
        of(client, FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE).map((s) => decodeRateParamChange(s.body).params.id);
      const heard = { bos: classes(bos), nav: classes(nav) };
      expect(server.rateNotices('Alice').length).toBe(1);
      await server.stop();
      fake = undefined;
      return heard;
    };
    expect(await notices('v0.24')).toEqual({ bos: [], nav: [IM_RATE_CLASS] });
    expect(await notices('main')).toEqual({ bos: [IM_RATE_CLASS], nav: [] });
  });

  it('v0.24 sends a BOS rate notice on BOS while the account has no ChatNav connection', async () => {
    const server = await start({ generation: 'v0.24' });
    const bos = await signOn(server, 'Alice', 'alicepw1');
    await subscribe(bos);
    const nav = await openNav(server, bos);
    nav.close();
    await waitFor(() => !server.openConnections('Alice').includes('chatnav'), 'the ChatNav connection to end');
    server.setRateParams('Alice', IM_RATE_CLASS, {});
    await roundTrip(bos);
    expect(of(bos, FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE).length).toBe(1);
  });

  it('v0.24 sends the armed stray rate notice on the next ChatNav request; main sends none', async () => {
    const stray = async (generation: 'v0.24' | 'main'): Promise<number[]> => {
      const server = await start({ generation });
      const bos = await signOn(server, 'Alice', 'alicepw1');
      const nav = await openNav(server, bos);
      server.rooms.strayRateOnNextNav();
      await navRoundTrip(nav, 'Dev Room');
      await navRoundTrip(nav, 'Other Room');
      const codes = of(nav, FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE).map((s) => decodeRateParamChange(s.body).code);
      await server.stop();
      fake = undefined;
      return codes;
    };
    expect(await stray('v0.24')).toEqual([RATE_CODE_LIMITED]);
    expect(await stray('main')).toEqual([]);
  });

  it('the default generation is main', async () => {
    const tags = await relayedTlvs(await start());
    expect(tags.includes(ICBM_TLV_STORE)).toBe(false);
    expect(tags.includes(ICBM_TLV_SEND_TIME)).toBe(false);
    await fake?.stop();

    const server = await start({ tls: true });
    const { tlvs, client } = await RawClient.login(target(server, true), 'Alice', 'alicepw1');
    client.close();
    expect(tlvU8(tlvs, 0x8e)).toBe(0x02);
    const bos = await signOn(server, 'Alice', 'alicepw1', true);
    const answered = await bos.askService(FAMILY_CHATNAV, { useSsl: true });
    expect([answered.family, answered.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE]);
  });
});
