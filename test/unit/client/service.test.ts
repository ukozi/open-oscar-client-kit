import { describe, expect, it } from 'vitest';
import { BosLink } from '../../../src/client/bos-link.js';
import { serviceResolver } from '../../../src/client/service.js';
import { FAMILY_CHATNAV, OSERVICE_ERR, OSERVICE_SERVICE_RESPONSE, SERVICE_TLV_SSL_STATE, SERVICE_TLV_USE_SSL } from '../../../src/wire/constants.js';
import { decodeTlvs, encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import { ManualTimers, captureLog } from '../../fake/oscar-client.js';
import { StubConn } from '../../fake/stub-conn.js';

const server = { host: '127.0.0.1', port: 5190 };
const COOKIE = Uint8Array.of(0xc0, 0x0c, 0x1e);

type Options = NonNullable<Parameters<typeof serviceResolver>[3]>;

// A BOS link over a stub; `answer` replies to the last 0x01/0x04 it wrote with 0x01/0x05 naming `host`, and `refuse` with 0x01/0x01.
function resolver(opts?: Options) {
  const timers = new ManualTimers();
  const conn = new StubConn(timers);
  const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captureLog().log });
  const resolve = opts ? serviceResolver(link, server, timers.now, opts) : serviceResolver(link, server, timers.now);
  const requests = () => conn.sent.filter((s) => s.family === 0x0001 && s.subtype === 0x0004);
  const last = () => {
    const sent = requests().at(-1);
    if (!sent) throw new Error('no service request was written');
    return sent;
  };
  const answer = (ssl?: number, host = 'chat.example.invalid:5190'): void => {
    conn.deliver({
      family: 0x0001,
      subtype: OSERVICE_SERVICE_RESPONSE,
      requestId: last().requestId,
      body: encodeTlvs([tlv.str(0x0005, host), tlv.bytes(0x0006, COOKIE), ...(ssl === undefined ? [] : [tlv.u8(SERVICE_TLV_SSL_STATE, ssl)])]),
    });
  };
  const refuse = (code: number): void => conn.deliver({ family: 0x0001, subtype: OSERVICE_ERR, requestId: last().requestId, body: Uint8Array.of(code >> 8, code & 0xff) });
  // Whether each request written has the SSL TLV, in order.
  const asksSsl = (): boolean[] => requests().map((s) => decodeTlvs((s.body ?? new Uint8Array(0)).subarray(2)).some((t) => t.tag === SERVICE_TLV_USE_SSL));
  const written = async (count: number): Promise<void> => {
    for (let i = 0; i < 20 && requests().length < count; i++) await Promise.resolve();
    expect(requests().length).toBe(count);
  };
  return { resolve, answer, refuse, asksSsl, written };
}

describe('serviceResolver', () => {
  it('follows the advertised host without a pin', async () => {
    const { resolve, answer } = resolver();
    const granted = resolve(FAMILY_CHATNAV);
    answer();
    expect(await granted).toMatchObject({ host: 'chat.example.invalid', port: 5190, pinned: false });
  });

  it('goes to the pinned address whatever host is advertised', async () => {
    const { resolve, answer } = resolver({ pin: { host: '127.0.0.1', port: 6000 } });
    const granted = resolve(FAMILY_CHATNAV);
    answer();
    expect(await granted).toMatchObject({ host: '127.0.0.1', port: 6000, pinned: true });
  });

  it('asks for no SSL address without tls, and pins an advertised loopback host of a server that is not loopback', async () => {
    const { resolve, answer, asksSsl } = resolver();
    const granted = resolve(FAMILY_CHATNAV);
    answer(undefined, '127.0.0.1:5190');
    expect(await granted).toMatchObject({ host: '127.0.0.1', port: 5190 });
    expect(asksSsl()).toEqual([false]);
  });

  it('with follow, goes to an unroutable advertised host that the default pins', async () => {
    const pinned = resolver();
    const kept = pinned.resolve(FAMILY_CHATNAV);
    pinned.answer(undefined, '0.0.0.0:7000');
    expect(await kept).toMatchObject({ host: '127.0.0.1', port: 5190, pinned: true });
    const followed = resolver({ follow: true });
    const gone = followed.resolve(FAMILY_CHATNAV);
    followed.answer(undefined, '0.0.0.0:7000');
    expect(await gone).toMatchObject({ host: '0.0.0.0', port: 7000, pinned: false });
  });

  it('a pin comes before follow', async () => {
    const { resolve, answer } = resolver({ pin: { host: '127.0.0.1', port: 6000 }, follow: true });
    const granted = resolve(FAMILY_CHATNAV);
    answer();
    expect(await granted).toMatchObject({ host: '127.0.0.1', port: 6000, pinned: true });
  });

  it('with tls, asks for the SSL address and goes to an advertised host that states SSL', async () => {
    const { resolve, answer, asksSsl } = resolver({ tls: {} });
    const granted = resolve(FAMILY_CHATNAV);
    answer(0x02);
    expect(await granted).toMatchObject({ host: 'chat.example.invalid', port: 5190, pinned: false });
    expect(asksSsl()).toEqual([true]);
  });

  it('with tls, pins an answer that states no SSL', async () => {
    const { resolve, answer } = resolver({ tls: {} });
    const granted = resolve(FAMILY_CHATNAV);
    answer(0x00);
    expect(await granted).toMatchObject({ host: '127.0.0.1', port: 5190, pinned: true });
  });

  it('with tls and follow, refuses an answer that states no SSL', async () => {
    const { resolve, answer } = resolver({ tls: {}, follow: true });
    const granted = resolve(FAMILY_CHATNAV);
    answer(0x00);
    await expect(granted).rejects.toMatchObject({ name: 'OscarError', info: { kind: 'refused', code: 0 } });
  });

  it('with tls, asks a refused request once more with no SSL TLV and uses that cookie at the configured address', async () => {
    const { resolve, answer, refuse, asksSsl, written } = resolver({ tls: {}, follow: true });
    const granted = resolve(FAMILY_CHATNAV);
    refuse(0x001c);
    await written(2);
    answer(0x00);
    expect(await granted).toMatchObject({ host: '127.0.0.1', port: 5190, pinned: true, cookie: COOKIE });
    expect(asksSsl()).toEqual([true, false]);
  });

  it('with tls, a second refusal rejects with its code and no third request goes out', async () => {
    const { resolve, refuse, asksSsl, written } = resolver({ tls: {} });
    const granted = resolve(FAMILY_CHATNAV);
    refuse(0x001c);
    await written(2);
    refuse(0x0005);
    await expect(granted).rejects.toMatchObject({ name: 'ServiceRefusedError', code: 0x0005 });
    expect(asksSsl()).toEqual([true, false]);
  });

  it('without tls, a refusal rejects after one request', async () => {
    const { resolve, refuse, asksSsl } = resolver();
    const granted = resolve(FAMILY_CHATNAV);
    refuse(0x0005);
    await expect(granted).rejects.toMatchObject({ name: 'ServiceRefusedError', code: 0x0005 });
    expect(asksSsl()).toEqual([false]);
  });
});
