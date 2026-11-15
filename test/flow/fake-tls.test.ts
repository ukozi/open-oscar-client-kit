import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFlap, encodeSignonPayload } from '../../src/wire/flap.js';
import { decodeNavInfo, decodeSnacErrorCode, encodeCreateRoom, encodeServiceRoomInfo } from '../../src/wire/chatnav.js';
import { encodeRoomClientOnline } from '../../src/wire/chatroom.js';
import {
  FAMILY_CHAT,
  FAMILY_CHATNAV,
  FAMILY_OSERVICE,
  OSERVICE_ERR,
  OSERVICE_HOST_ONLINE,
  OSERVICE_SERVICE_RESPONSE,
  SERVICE_TLV_SSL_STATE,
} from '../../src/wire/constants.js';
import { decodeTlvs, findTlv, tlv, tlvU8 } from '../../src/wire/tlv.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { StartOptions } from '../fake/oscar-server.js';
import { TEST_TLS_CERT } from '../fake/tls-fixture.js';

let fake: FakeOscarServer | undefined;
const open: RawClient[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) client.close();
  await fake?.stop();
  fake = undefined;
});

async function start(opts: StartOptions): Promise<FakeOscarServer> {
  fake = await FakeOscarServer.start(opts);
  fake.addUser('Alice', 'alicepw1');
  return fake;
}

function secure(server: FakeOscarServer): { port: number; ca: string } {
  return { port: server.port, ca: TEST_TLS_CERT };
}

async function signOn(server: FakeOscarServer, overTls: boolean): Promise<RawClient> {
  const bos = await RawClient.signOn(overTls ? secure(server) : server.port, 'Alice', 'alicepw1');
  open.push(bos);
  return bos;
}

describe('the test server over TLS', () => {
  it('a TLS client that trusts the test certificate reaches host online', async () => {
    const server = await start({ tls: true });
    const { tlvs, client: auth } = await RawClient.login(secure(server), 'Alice', 'alicepw1');
    auth.close();
    const cookie = findTlv(tlvs, 0x06);
    expect(cookie).toBeDefined();
    const bos = await RawClient.connect(secure(server));
    open.push(bos);
    bos.signon([tlv.bytes(0x06, cookie ?? new Uint8Array(0))]);
    const first = await bos.nextSnac();
    expect([first.family, first.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_HOST_ONLINE]);
  });

  it('a plain client cannot sign on to a TLS test server', async () => {
    const server = await start({ tls: true });
    const socket = net.connect({ host: '127.0.0.1', port: server.port });
    const received: Buffer[] = [];
    let closed = false;
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      closed = true;
    });
    socket.write(encodeFlap(1, 0, encodeSignonPayload([])));
    await waitFor(() => closed, 'the TLS listener to close a plain connection');
    // A FLAP frame starts with 0x2A; a TLS alert record starts with 0x15.
    expect(Buffer.concat(received).at(0)).not.toBe(0x2a);
  });

  it('the login reply states SSL to a TLS client, and not with sslHost false', async () => {
    const stated = async (opts: StartOptions): Promise<number | undefined> => {
      const server = await start(opts);
      const { tlvs, client } = await RawClient.login(opts.tls ? secure(server) : server.port, 'Alice', 'alicepw1');
      client.close();
      await server.stop();
      fake = undefined;
      return tlvU8(tlvs, 0x8e);
    };
    expect(await stated({ tls: true })).toBe(0x02);
    expect(await stated({ tls: true, sslHost: false })).toBe(0x00);
    expect(await stated({})).toBe(0x00);
  });

  it('a service response states SSL when the request asks for it on a TLS test server', async () => {
    const bos = await signOn(await start({ tls: true }), true);
    const asked = await bos.askService(FAMILY_CHATNAV, { useSsl: true });
    expect([asked.family, asked.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE]);
    expect(tlvU8(decodeTlvs(asked.body), SERVICE_TLV_SSL_STATE)).toBe(0x02);
    const plain = await bos.askService(FAMILY_CHATNAV, { useSsl: false });
    expect(tlvU8(decodeTlvs(plain.body), SERVICE_TLV_SSL_STATE)).toBe(0x00);
  });

  it('with sslHost false a service request with TLV 0x8C is answered at the plain address with SSL state 0x00', async () => {
    const server = await start({ tls: true, sslHost: false, serviceHost: '127.0.0.1:1' });
    const bos = await signOn(server, true);
    const asked = await bos.askService(FAMILY_CHATNAV, { useSsl: true });
    expect([asked.family, asked.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE]);
    const tlvs = decodeTlvs(asked.body);
    expect(tlvU8(tlvs, SERVICE_TLV_SSL_STATE)).toBe(0x00);
    expect(Buffer.from(findTlv(tlvs, 0x05) ?? []).toString('utf8')).toBe('127.0.0.1:1');
    const nav = await RawClient.service(secure(server), findTlv(tlvs, 0x06) ?? new Uint8Array(0));
    open.push(nav);
    expect(nav.closed).toBe(false);
  });

  it('with sslHost false and no tls the replies state no SSL', async () => {
    const server = await start({ sslHost: false });
    const { tlvs, client } = await RawClient.login(server.port, 'Alice', 'alicepw1');
    client.close();
    expect(tlvU8(tlvs, 0x8e)).toBe(0x00);
    const asked = await (await signOn(server, false)).askService(FAMILY_CHATNAV, { useSsl: true });
    expect([asked.family, asked.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE]);
    expect(tlvU8(decodeTlvs(asked.body), SERVICE_TLV_SSL_STATE)).toBe(0x00);
  });

  it('setSslHost changes the login reply and the service replies while the test server runs', async () => {
    const server = await start({ tls: true });
    const bos = await signOn(server, true);
    server.setSslHost(false);
    const off = await bos.askService(FAMILY_CHATNAV, { useSsl: true });
    expect(tlvU8(decodeTlvs(off.body), SERVICE_TLV_SSL_STATE)).toBe(0x00);
    const login = await RawClient.login(secure(server), 'Alice', 'alicepw1');
    login.client.close();
    expect(tlvU8(login.tlvs, 0x8e)).toBe(0x00);
    server.setSslHost(true);
    const on = await bos.askService(FAMILY_CHATNAV, { useSsl: true });
    expect(tlvU8(decodeTlvs(on.body), SERVICE_TLV_SSL_STATE)).toBe(0x02);
  });

  it('with refuseSsl a service request with TLV 0x8C is refused 0x01/0x01 general failure, and answered without it', async () => {
    const server = await start({ tls: true, refuseSsl: true });
    const bos = await signOn(server, true);
    const refused = await bos.askService(FAMILY_CHATNAV, { useSsl: true });
    expect([refused.family, refused.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_ERR]);
    expect(decodeSnacErrorCode(refused.body)).toBe(0x001c);
    const answered = await bos.askService(FAMILY_CHATNAV, { useSsl: false });
    expect([answered.family, answered.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE]);
    expect(tlvU8(decodeTlvs(answered.body), SERVICE_TLV_SSL_STATE)).toBe(0x00);
  });

  it('rooms.resetChat ends a TLS room connection', async () => {
    const server = await start({ tls: true });
    const bos = await signOn(server, true);
    const nav = await RawClient.service(secure(server), await bos.requestService(FAMILY_CHATNAV));
    open.push(nav);
    await nav.nextSnac();
    nav.snac(FAMILY_CHATNAV, 0x08, 1, encodeCreateRoom({ exchange: 4, name: 'Dev Room' }));
    const info = decodeNavInfo((await nav.nextSnac()).body);
    if (!info) throw new Error('the room did not resolve');
    const room = await RawClient.service(secure(server), await bos.requestService(FAMILY_CHAT, encodeServiceRoomInfo(info)));
    open.push(room);
    room.snac(FAMILY_OSERVICE, 0x02, 1, encodeRoomClientOnline());
    await waitFor(() => server.rooms.occupants({ exchange: 4, name: 'Dev Room' }).length === 1, 'the join');
    server.rooms.resetChat('Alice', { exchange: 4, name: 'Dev Room' });
    await waitFor(() => room.closed, 'the reset');
  });

  it('with no tls option the test server listens on plain TCP', async () => {
    const server = await start({});
    const bos = await signOn(server, false);
    const asked = await bos.askService(FAMILY_CHATNAV, { useSsl: true });
    expect([asked.family, asked.subtype]).toEqual([FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE]);
    expect(tlvU8(decodeTlvs(asked.body), SERVICE_TLV_SSL_STATE)).toBe(0x00);
    const raw = await RawClient.connect(server.port);
    open.push(raw);
    expect(raw.frames[0]?.type).toBe(1);
  });
});
