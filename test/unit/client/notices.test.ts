import { describe, expect, it } from 'vitest';
import { BosLink } from '../../../src/client/bos-link.js';
import { Messaging, isServerNotice } from '../../../src/client/messaging.js';
import { ByteWriter } from '../../../src/wire/bytes.js';
import { ICBM_TLV_IM_DATA, ICBM_TLV_SEND_TIME } from '../../../src/wire/constants.js';
import { encodeImFragments } from '../../../src/wire/icbm.js';
import { decodeRateParamsReply } from '../../../src/wire/rate.js';
import { encodeUserInfo } from '../../../src/wire/snac.js';
import { encodeTlvs, tlv } from '../../../src/wire/tlv.js';
import type { Tlv } from '../../../src/wire/tlv.js';
import type { IncomingIm } from '../../../src/model/buddy-list.js';
import { captureLog, ManualTimers } from '../../fake/oscar-client.js';
import { StubConn } from '../../fake/stub-conn.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const oservice = loadVectors('oservice.json');

function make(noticeSender: string | null = null) {
  const timers = new ManualTimers();
  const conn = new StubConn(timers);
  const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captureLog().log });
  link.seedRates(decodeRateParamsReply(bytesOf(oservice, 'rate params reply body, default classes, OService 1')));
  const ims: IncomingIm[] = [];
  const messaging = new Messaging({
    now: timers.now,
    log: captureLog().log,
    imLimit: () => 512,
    emit: (im) => ims.push(im),
    emitTyping: () => {},
    emitAutoResponse: () => {},
    decide: () => 'send',
    emitAnswered: () => {},
    variables: (to) => ({ name: to, date: '10/5/2026', time: '9:42 AM' }),
    noticeSender,
    presenceOf: () => undefined,
  });
  return { timers, conn, link, messaging, ims };
}

// A channel 1 message to the client from a sender whose user-info block carries the given TLVs.
function imFrom(name: string, senderTlvs: Tlv[], sentAt?: number): Uint8Array {
  const text = tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(0, Buffer.from('hello')));
  return new ByteWriter()
    .u64(0n)
    .u16(1)
    .bytes(encodeUserInfo({ name, warning: 0, tlvs: senderTlvs }))
    .bytes(encodeTlvs(sentAt === undefined ? [text] : [text, tlv.u32(ICBM_TLV_SEND_TIME, sentAt)]))
    .toBytes();
}

describe('isServerNotice', () => {
  it.each([
    ['a bare block with no send time, any name', 'Chimr Notices', [], undefined, null, true],
    ['a live IM with TLVs', 'OOS System Msg', [tlv.u16(1, 0x10)], undefined, null, false],
    ['a stored IM: bare block with a send time', 'OOS System Msg', [], 1_793_000_000, null, false],
    ['the configured sender with TLVs and no send time', 'OOS System Msg', [tlv.u16(1, 0x10)], undefined, 'OOS System Msg', true],
    ['the configured sender with a send time', 'OOS System Msg', [tlv.u16(1, 0x10)], 1_793_000_000, 'OOS System Msg', false],
  ] as [string, string, Tlv[], number | undefined, string | null, boolean][])('%s', (_n, name, tlvs, sentAt, configured, notice) => {
    expect(isServerNotice({ name, warning: 0, tlvs }, sentAt, configured)).toBe(notice);
  });

  it('matches the configured sender by its normalised name', () => {
    const sender = { name: 'oossystemmsg', warning: 0, tlvs: [tlv.u16(1, 0x10)] };
    expect(isServerNotice(sender, undefined, 'OOS System Msg')).toBe(true);
    expect(isServerNotice({ ...sender, name: 'OOS System Msg 2' }, undefined, 'OOS System Msg')).toBe(false);
  });
});

describe('Messaging.handle and server notices', () => {
  const deliver = ({ messaging, link }: ReturnType<typeof make>, body: Uint8Array) =>
    messaging.handle(link, { family: 4, subtype: 7, flags: 0, requestId: 0x80000000, body });

  it('marks a bare-block IM with no send time as a notice, whatever the sender is called', () => {
    const m = make();
    deliver(m, imFrom('Chimr Notices', []));
    deliver(m, imFrom('Bob', [tlv.u16(1, 0x10)]));
    expect(m.ims.map((im) => [im.from, im.serverNotice])).toEqual([['Chimr Notices', true], ['Bob', false]]);
  });

  it('marks a live IM from the configured sender as a notice, and one from anyone else not', () => {
    const m = make('OOS System Msg');
    deliver(m, imFrom('OOS System Msg', [tlv.u16(1, 0x10)]));
    deliver(m, imFrom('Bob', [tlv.u16(1, 0x10)]));
    deliver(m, imFrom('OOS System Msg', [tlv.u16(1, 0x10)], 1_793_000_000));
    expect(m.ims.map((im) => [im.from, im.serverNotice, im.offline])).toEqual([
      ['OOS System Msg', true, false],
      ['Bob', false, false],
      ['OOS System Msg', false, true],
    ]);
  });

  it('never answers a notice and never counts it towards a warning', async () => {
    const m = make();
    m.messaging.setAway([{ text: 'out' }]);
    deliver(m, imFrom('Chimr Notices', []));
    await m.timers.advance(0);
    expect(m.conn.sent.filter((s) => s.family === 4 && s.subtype === 6)).toEqual([]);
    expect(m.messaging.canWarn('Chimr Notices')).toBe(false);

    deliver(m, imFrom('Bob', [tlv.u16(1, 0x10)]));
    await m.timers.advance(0);
    expect(m.conn.sent.filter((s) => s.family === 4 && s.subtype === 6)).toHaveLength(1);
    expect(m.messaging.canWarn('Bob')).toBe(true);
  });
});
