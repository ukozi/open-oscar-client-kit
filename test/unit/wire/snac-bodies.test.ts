import { describe, expect, it, vi } from 'vitest';
import { encodeNameList } from '../../../src/wire/buddy.js';
import { fromHex, toHex } from '../../../src/wire/bytes.js';
import { CAP_CHAT, CAP_UTF8_MESSAGES } from '../../../src/wire/constants.js';
import { decodeImFragments, decodeImToClient, encodeImFragments, encodeImToHost, encodeTyping, newCookie } from '../../../src/wire/icbm.js';
import { encodeAway, encodeCapabilities } from '../../../src/wire/locate.js';
import { encodeClientOnline, encodeClientVersions, encodeServiceRequest } from '../../../src/wire/oservice.js';
import { decodeRateParamChange, decodeRateParamsReply } from '../../../src/wire/rate.js';
import { decodeUserInfo, userFlags } from '../../../src/wire/snac.js';
import { decodeWireText } from '../../../src/wire/text.js';
import { findTlv, hasTlv, tlvU32 } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';

const entropy = vi.hoisted(() => ({ queue: [] as Uint8Array[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: (size: number) => entropy.queue.shift() ?? actual.randomBytes(size) };
});

const oservice = loadVectors('oservice.json');
const icbm = loadVectors('icbm.json');
const locate = loadVectors('locate-buddy.json');
const handSession = loadVectors('hand-session.json');

describe('what the client sends', () => {
  const rows: [string, Uint8Array, string][] = [
    ['client versions', encodeClientVersions([1, 2, 3, 4]), vector(oservice, 'client versions body, every family at version 1').hex],
    ['client online', encodeClientOnline([1, 2, 3, 4]), vector(oservice, 'client online body').hex],
    ['service request with 0x8C', encodeServiceRequest(0x000d, { useSsl: true }), vector(oservice, 'service request body for ChatNav with TLV 0x8C').hex],
    ['service request without', encodeServiceRequest(0x000d, { useSsl: false }), vector(oservice, 'service request body for ChatNav without it').hex],
    ['chat capability', encodeCapabilities([CAP_CHAT]), vector(locate, 'locate set info body, chat capability').hex],
    ['away text', encodeAway('Working on something.'), vector(locate, 'locate set info body, away text').hex],
    ['away cleared', encodeAway(null), vector(locate, 'locate set info body, away cleared').hex],
    ['buddy list', encodeNameList(['alice', 'bob']), vector(locate, 'buddy add body').hex],
    ['fragments, ascii', encodeImFragments(0, fromHex('6869')), vector(icbm, 'fragment list, ascii').hex],
    ['fragments, utf-16', encodeImFragments(2, fromHex('006800e90020d83dde00')), vector(icbm, 'fragment list, utf-16be with a surrogate pair').hex],
    ['IM to someone online', encodeImToHost(0x1122334455667788n, 'alice', 0, fromHex('6869'), false), vector(icbm, 'message to host body, online recipient').hex],
    ['IM to someone offline', encodeImToHost(0x1122334455667788n, 'alice', 0, fromHex('6869'), true), vector(icbm, 'message to host body, offline recipient').hex],
    ['typing', encodeTyping('alice', 2), vector(icbm, 'typing event body').hex],
    ['client versions, BOS list', encodeClientVersions([0x0001, 0x0002, 0x0003, 0x0004, 0x0013]), vector(handSession, 'client versions body, BOS list').hex],
    ['client online, BOS list', encodeClientOnline([0x0001, 0x0002, 0x0003, 0x0004, 0x0013]), vector(handSession, 'client online body, BOS list').hex],
    ['client versions, BOS list with BART', encodeClientVersions([0x0001, 0x0002, 0x0003, 0x0004, 0x0013, 0x0010]), vector(handSession, 'client versions body, BOS list with BART').hex],
    ['client online, BOS list with BART', encodeClientOnline([0x0001, 0x0002, 0x0003, 0x0004, 0x0013, 0x0010]), vector(handSession, 'client online body, BOS list with BART').hex],
    ['UTF-8 and chat capabilities', encodeCapabilities([CAP_UTF8_MESSAGES, CAP_CHAT]), vector(handSession, 'locate set info body, UTF-8 and chat capabilities').hex],
  ];
  it.each(rows)('%s', (_name, got, want) => {
    expect(toHex(got)).toBe(want);
  });

  it('carries room info ahead of TLV 0x8C in a service request', () => {
    expect(toHex(encodeServiceRequest(0x000e, { useSsl: true, roomInfo: fromHex('0004') }))).toBe('000e' + '000100020004' + '008c0000');
  });

  it('marks an automatic reply with the auto-response TLV', () => {
    const plain = toHex(encodeImToHost(0x1122334455667788n, 'alice', 0, fromHex('6869'), false));
    const auto = toHex(encodeImToHost(0x1122334455667788n, 'alice', 0, fromHex('6869'), false, true));
    expect(auto).toBe(`${plain}00040000`);
  });

  it('refuses a capability list that is not whole 16-byte entries', () => {
    expect(() => encodeCapabilities([CAP_CHAT.subarray(0, 15)])).toThrow('multiple of 16');
    expect(() => encodeCapabilities([])).not.toThrow();
  });

  it('announces OService at version 1', () => {
    expect(toHex(encodeClientVersions([0x0001])).slice(0, 8)).toBe('00010001');
  });

  it('never makes a zero cookie', () => {
    for (let i = 0; i < 1000; i++) expect(newCookie()).not.toBe(0n);
  });

  it('draws again when the random bytes come back all zero', () => {
    entropy.queue.push(new Uint8Array(8), fromHex('0000000000000001'));
    expect(newCookie()).toBe(1n);
    expect(entropy.queue).toHaveLength(0);
  });
});

describe('what the client reads', () => {
  it('the default rate classes and their SNAC groups', () => {
    const reply = decodeRateParamsReply(bytesOf(oservice, 'rate params reply body, default classes, OService 1'));
    expect(reply.classes).toHaveLength(5);
    expect(reply.classes[2]).toEqual({
      id: 3,
      windowSize: 20,
      clearLevel: 5100,
      alertLevel: 5000,
      limitLevel: 4000,
      disconnectLevel: 3000,
      currentLevel: 6000,
      maxLevel: 6000,
    });
    expect(reply.classes[1]).toMatchObject({ id: 2, windowSize: 80, clearLevel: 3000, alertLevel: 2000, limitLevel: 1500, disconnectLevel: 1000 });
    expect(reply.classOf(0x0004, 0x0006)).toBe(3);
    expect(reply.classOf(0x0002, 0x0005)).toBe(3);
    expect(reply.classOf(0x0003, 0x0004)).toBe(2);
    expect(reply.classOf(0x0004, 0x0014)).toBe(1);
    expect(reply.classOf(0x000e, 0x0005)).toBeUndefined();
  });

  it('a rate change in both record sizes', () => {
    const v1 = decodeRateParamChange(bytesOf(oservice, 'rate change body, limited, class 3 at 3900, OService 1'));
    const v2 = decodeRateParamChange(bytesOf(oservice, 'rate change body, limited, class 3 at 3900, OService 2 or later'));
    expect(v1.code).toBe(3);
    expect(v1.params).toMatchObject({ id: 3, windowSize: 20, clearLevel: 5100, limitLevel: 4000, currentLevel: 3900, maxLevel: 6000 });
    expect(v2).toEqual(v1);
  });

  it('its own user info with the bot flag', () => {
    const { info } = decodeUserInfo(bytesOf(oservice, 'user info update body, bot account'), 0);
    expect([info.name, userFlags(info) & 0x0400]).toEqual(['Bot One', 0x0400]);
  });

  it('presence blocks', () => {
    const arrived = decodeUserInfo(bytesOf(locate, 'buddy arrived body, away bot'), 0).info;
    expect([arrived.name, userFlags(arrived)]).toEqual(['Bot Two', 0x0430]);
    const departed = decodeUserInfo(bytesOf(locate, 'buddy departed body'), 0).info;
    expect([departed.name, userFlags(departed)]).toEqual(['alice', 0]);
  });

  it('an IM, an auto-response, an offline replay, a server notice and an invitation', () => {
    const text = (name: string): string =>
      decodeImFragments(findTlv(decodeImToClient(bytesOf(icbm, name)).tlvs, 0x02) ?? new Uint8Array())
        .map((f) => decodeWireText(f.text, f.charset))
        .join('');
    expect(text('message to client body')).toBe('hi');

    const auto = decodeImToClient(bytesOf(icbm, 'message to client body, auto-response from an away sender'));
    expect([auto.cookie, hasTlv(auto.tlvs, 0x04), userFlags(auto.sender) & 0x0020]).toEqual([0n, true, 0x0020]);

    const replay = decodeImToClient(bytesOf(icbm, 'message to client body, offline replay'));
    expect([replay.sender.name, replay.sender.tlvs.length, tlvU32(replay.tlvs, 0x16), hasTlv(replay.tlvs, 0x06)]).toEqual(['alice', 0, 1790000000, true]);

    const notice = decodeImToClient(bytesOf(icbm, 'message to client body, server notice'));
    expect([notice.sender.name, notice.sender.tlvs.length, notice.cookie]).toEqual(['OOS System Msg', 0, 0n]);
    expect(text('message to client body, server notice')).toBe('You just received 2 IM(s) while you were offline.');

    const invite = decodeImToClient(bytesOf(icbm, 'message to client body, channel 2 chat invitation'));
    expect([invite.channel, invite.cookie, findTlv(invite.tlvs, 0x05)?.length]).toEqual([2, 0x0102030405060708n, 64]);
  });

  it('skips fragments that are not text and joins the ones that are', () => {
    const two = fromHex('0501000301010201010006000000006869' + '0101000700000000212121');
    expect(decodeImFragments(two).map((f) => Buffer.from(f.text).toString())).toEqual(['hi', '!!!']);
  });
});
