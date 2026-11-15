import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OscarError } from '../../src/client/errors.js';
import { ByteReader } from '../../src/wire/bytes.js';
import { FAMILY_ICBM, ICBM_ERROR_NOT_LOGGED_ON, ICBM_MSG_TO_HOST, ICBM_TLV_AUTO_RESPONSE, ICBM_TLV_STORE } from '../../src/wire/constants.js';
import { decodeTlvs, hasTlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { RichText } from '../../src/model/rich-text.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;
let bob: FakePeer;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Carol', 'carolpw1');
  fake.setFeedbag('alice', [
    { name: 'Buddies', groupId: 1, itemId: 0, classId: 1, attrs: [] },
    { name: 'bob', groupId: 1, itemId: 1, classId: 0, attrs: [] },
  ]);
  h = makeClient(fake, { timers });
  bob = fake.peer('Bob');
  await h.signOn();
  await waitFor(() => h.client.presenceOf('Bob')?.online === true, 'the arrival of Bob');
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const text = (words: string): RichText => [{ text: words }];

type SentSnac = { cookie: bigint; to: string; tlvs: Tlv[] };
// Every 0x04/0x06 the client wrote: cookie, channel, recipient, TLVs.
function sends(): SentSnac[] {
  return fake
    .snacsFrom('alice')
    .filter((s) => s.family === FAMILY_ICBM && s.subtype === ICBM_MSG_TO_HOST)
    .map((s) => {
      const r = new ByteReader(s.body);
      const cookie = r.u64();
      r.u16();
      return { cookie, to: r.str8(), tlvs: decodeTlvs(r.rest()) };
    });
}
const hex16 = (cookie: bigint | undefined): string => (cookie ?? 0n).toString(16).padStart(16, '0');
const stores = (): boolean[] => sends().map((s) => hasTlv(s.tlvs, ICBM_TLV_STORE));

async function refusalOf(promise: Promise<unknown>): Promise<OscarError['info'] | undefined> {
  return promise.then(
    () => undefined,
    (e: OscarError) => e.info,
  );
}

describe('the result of sendIm', () => {
  it('sendIm resolves to the cookie the server acknowledged and stored: true by default', async () => {
    const sent = await h.client.sendIm('Bob', text('hello'));
    expect(sends()).toHaveLength(1);
    expect(sent).toEqual({ id: hex16(sends()[0]?.cookie), stored: true });
    expect(sent.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('always, the default, sets the store TLV whatever the presence', async () => {
    await h.client.sendIm('Bob', text('to one online'));
    await h.client.sendIm('Carol', text('to one with no presence'), { store: 'always' });
    bob.signOff();
    await waitFor(() => h.client.presenceOf('Bob')?.online === false, 'the departure of Bob');
    expect(await h.client.sendIm('Bob', text('to one offline'), {})).toMatchObject({ stored: true });
    expect(stores()).toEqual([true, true, true]);
  });
});

describe('automatic', () => {
  it('automatic adds TLV 0x04 and the recipient sees an auto-response', async () => {
    await h.client.sendIm('Bob', text('by hand'));
    await h.client.sendIm('Bob', text('by itself'), { automatic: true });
    expect(sends().map((s) => hasTlv(s.tlvs, ICBM_TLV_AUTO_RESPONSE))).toEqual([false, true]);
    expect(bob.ims().map((im) => [im.html, hasTlv(im.tlvs, ICBM_TLV_AUTO_RESPONSE)])).toEqual([
      ['by hand', false],
      ['by itself', true],
    ]);
  });

  it('automatic false is the same as no option', async () => {
    await h.client.sendIm('Bob', text('one'), { automatic: false });
    expect(sends().map((s) => hasTlv(s.tlvs, ICBM_TLV_AUTO_RESPONSE))).toEqual([false]);
  });
});

describe('store when-offline', () => {
  it('when-offline sends no store TLV to a buddy whose presence is online', async () => {
    const sent = await h.client.sendIm('Bob', text('hi'), { store: 'when-offline' });
    expect(stores()).toEqual([false]);
    expect(sent).toEqual({ id: hex16(sends()[0]?.cookie), stored: false });
    expect(bob.ims().map((im) => im.html)).toEqual(['hi']);
  });

  it('when-offline sends the store TLV to a buddy whose presence is offline', async () => {
    bob.signOff();
    await waitFor(() => h.client.presenceOf('Bob')?.online === false, 'the departure of Bob');
    const sent = await h.client.sendIm('Bob', text('later'), { store: 'when-offline' });
    expect(stores()).toEqual([true]);
    expect(sent).toEqual({ id: hex16(sends()[0]?.cookie), stored: true });
    expect(fake.storedFor('bob')).toHaveLength(1);
  });

  it('when-offline sends no store TLV to a name with no presence', async () => {
    fake.peer('Dave');
    expect(h.client.presenceOf('Dave')).toBeUndefined();
    const sent = await h.client.sendIm('Dave', text('hi'), { store: 'when-offline' });
    expect(stores()).toEqual([false]);
    expect(sent.stored).toBe(false);
  });

  it('when-offline resends once with the store TLV and the same cookie after error 0x0004', async () => {
    expect(h.client.presenceOf('Carol')).toBeUndefined();
    const sent = await h.client.sendIm('Carol', text('for later'), { store: 'when-offline' });
    const [first, second] = sends();
    expect(sends()).toHaveLength(2);
    expect(stores()).toEqual([false, true]);
    expect(second?.cookie).toBe(first?.cookie);
    expect(sent).toEqual({ id: hex16(first?.cookie), stored: true });
    expect(fake.storedFor('carol').map((m) => m.cookie)).toEqual([first?.cookie]);
  });

  it('when-offline does not resend twice', async () => {
    const refusal = await refusalOf(h.client.sendIm('Nobody', text('anyone?'), { store: 'when-offline' }));
    expect(refusal).toEqual({ kind: 'refused', code: ICBM_ERROR_NOT_LOGGED_ON });
    expect(stores()).toEqual([false, true]);
  });

  it('when-offline does not resend after another error code', async () => {
    fake.failNext(FAMILY_ICBM, ICBM_MSG_TO_HOST, { code: 0x000a });
    const refusal = await refusalOf(h.client.sendIm('Bob', text('hi'), { store: 'when-offline' }));
    expect(refusal).toEqual({ kind: 'refused', code: 0x000a });
    expect(sends()).toHaveLength(1);
  });

  it('a send that carried the store TLV is not sent again after error 0x0004', async () => {
    const refusal = await refusalOf(h.client.sendIm('Nobody', text('anyone?')));
    expect(refusal).toEqual({ kind: 'refused', code: ICBM_ERROR_NOT_LOGGED_ON });
    expect(stores()).toEqual([true]);
  });
});
