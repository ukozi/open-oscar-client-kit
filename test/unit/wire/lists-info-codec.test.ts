import { describe, expect, it } from 'vitest';
import { decodePresence } from '../../../src/wire/buddy.js';
import { ByteReader, fromHex, toHex } from '../../../src/wire/bytes.js';
import { CAP_CHAT, CAP_UTF8_MESSAGES } from '../../../src/wire/constants.js';
import {
  BUDDY_PREF_ACCEPT_NON_LIST_BART, BUDDY_PREF_DISCLOSE_TYPING, FEEDBAG_ATTR_ALIAS, FEEDBAG_ATTR_ORDER, FEEDBAG_ATTR_PREFS,
  FEEDBAG_ATTR_PREFS_VALID, FEEDBAG_CLASS_BUDDY, FEEDBAG_CLASS_BUDDY_PREFS, FEEDBAG_CLASS_DENY, FEEDBAG_CLASS_GROUP,
  PD_MODE_DENY_SOME, PD_MODE_PERMIT_ALL, buddyPref, decodeFeedbagError, decodeFeedbagStatus, encodeFeedbagItems,
  orderAttr, privacyMode, readFeedbagItem, typingPref, withAttr, withBuddyPref, withTypingEnabled,
} from '../../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../../src/wire/feedbag.js';
import { decodeTyping, decodeWarnReply, encodeWarn } from '../../../src/wire/icbm.js';
import {
  LOCATE_MIME, LOCATE_QUERY_AWAY, LOCATE_QUERY_PROFILE, decodeUserInfoReply, encodeLocateInfo, encodeUserInfoQuery,
  mimeCharset,
} from '../../../src/wire/locate.js';
import { decodeEvilNotification, encodeIdle, encodeStatus, userStatus } from '../../../src/wire/oservice.js';
import { decodeUserInfo } from '../../../src/wire/snac.js';
import { decodeTlvs, findTlv, tlv } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';

const v = loadVectors('hand-lists-info.json');
const icbm = loadVectors('icbm.json');

function itemOf(name: string): FeedbagItem {
  return readFeedbagItem(new ByteReader(bytesOf(v, name)));
}

function prefsItem(attrs: FeedbagItem['attrs']): FeedbagItem {
  return { name: '', groupId: 0, itemId: 9, classId: FEEDBAG_CLASS_BUDDY_PREFS, attrs };
}

function hexOf(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : toHex(bytes);
}

function ascii(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : Buffer.from(bytes).toString('ascii');
}

describe('feedbag codec', () => {
  it('encodes a buddy with its alias and a group with its order list', () => {
    const name = 'feedbag items body, buddy bob with alias Bobby (group 1, item 5), group Buddies with order 1, 5';
    const items: FeedbagItem[] = [
      { name: 'bob', groupId: 1, itemId: 5, classId: FEEDBAG_CLASS_BUDDY, attrs: [tlv.str(FEEDBAG_ATTR_ALIAS, 'Bobby')] },
      { name: 'Buddies', groupId: 1, itemId: 0, classId: FEEDBAG_CLASS_GROUP, attrs: [orderAttr([1, 5])] },
    ];
    expect(toHex(encodeFeedbagItems(items))).toBe(vector(v, name).hex);
    const r = new ByteReader(bytesOf(v, name));
    expect([readFeedbagItem(r), readFeedbagItem(r)]).toEqual(items);
    expect(r.remaining).toBe(0);
  });

  it('reads the privacy mode, and permit-all when the item or the mode is missing', () => {
    const item = itemOf('feedbag item, privacy item 7 in deny-some mode');
    expect(privacyMode(item)).toBe(4);
    expect(privacyMode(item)).toBe(PD_MODE_DENY_SOME);
    expect(privacyMode(undefined)).toBe(1);
    expect(privacyMode({ ...item, attrs: [] })).toBe(1);
    expect(PD_MODE_PERMIT_ALL).toBe(privacyMode(undefined));
  });

  it('reads typing as unset, disabled and enabled', () => {
    expect(typingPref(itemOf('feedbag item, empty buddy preferences item 9'))).toBe('unset');
    expect(typingPref(itemOf('feedbag item, buddy preferences with typing disabled'))).toBe('disabled');
    expect(typingPref(itemOf('feedbag item, buddy preferences with typing enabled'))).toBe('enabled');
    const twoByteValid = prefsItem([tlv.bytes(FEEDBAG_ATTR_PREFS, fromHex('00400001')), tlv.bytes(FEEDBAG_ATTR_PREFS_VALID, fromHex('4001'))]);
    expect(typingPref(twoByteValid)).toBe('unset');
    expect(typingPref(prefsItem([tlv.bytes(FEEDBAG_ATTR_PREFS_VALID, fromHex('00400001'))]))).toBe('unset');
    const oneByteValue = prefsItem([tlv.bytes(FEEDBAG_ATTR_PREFS, fromHex('40')), tlv.bytes(FEEDBAG_ATTR_PREFS_VALID, fromHex('00400001'))]);
    expect(typingPref(oneByteValue)).toBe('unset');
  });

  it('enables typing and keeps every other bit and attribute', () => {
    const disabled = itemOf('feedbag item, buddy preferences with typing disabled');
    const unknown = { tag: 0x0999, value: Uint8Array.of(1) };
    const before: FeedbagItem = { ...disabled, attrs: [unknown, ...disabled.attrs] };
    const after = withTypingEnabled(before);
    expect(typingPref(after)).toBe('enabled');
    expect(hexOf(findTlv(after.attrs, FEEDBAG_ATTR_PREFS))).toBe('00400001');
    expect(hexOf(findTlv(after.attrs, FEEDBAG_ATTR_PREFS_VALID))).toBe('00400001');
    expect(after.attrs.map((a) => a.tag)).toEqual([0x0999, FEEDBAG_ATTR_PREFS, FEEDBAG_ATTR_PREFS_VALID]);
    expect(hexOf(after.attrs[0]?.value)).toBe('01');
    expect([after.name, after.groupId, after.itemId, after.classId]).toEqual(['', 0, 9, FEEDBAG_CLASS_BUDDY_PREFS]);
    expect(typingPref(before)).toBe('disabled');
  });

  it('withAttr replaces in place, appends, removes, and touches nothing else', () => {
    const a = tlv.str(FEEDBAG_ATTR_ALIAS, 'Bobby');
    const b = tlv.bytes(0x0999, Uint8Array.of(1));
    const c = orderAttr([1, 5]);
    const item: FeedbagItem = { name: 'bob', groupId: 1, itemId: 5, classId: FEEDBAG_CLASS_BUDDY, attrs: [a, b, c] };
    const snapshot = toHex(encodeFeedbagItems([item]));
    const flat = (it: FeedbagItem) => it.attrs.map((t) => [t.tag, toHex(t.value)]);

    const replaced = withAttr(item, 0x0999, Uint8Array.of(7, 7));
    expect(flat(replaced)).toEqual([[0x0131, toHex(a.value)], [0x0999, '0707'], [0x00c8, '00010005']]);
    const added = withAttr(item, 0x0066, new Uint8Array(0));
    expect(flat(added)).toEqual([[0x0131, toHex(a.value)], [0x0999, '01'], [0x00c8, '00010005'], [0x0066, '']]);
    const removed = withAttr(item, 0x0131, null);
    expect(flat(removed)).toEqual([[0x0999, '01'], [0x00c8, '00010005']]);
    for (const out of [replaced, added, removed]) {
      expect([out.name, out.groupId, out.itemId, out.classId]).toEqual(['bob', 1, 5, FEEDBAG_CLASS_BUDDY]);
    }
    expect(toHex(encodeFeedbagItems([item]))).toBe(snapshot);
    expect(item.attrs).toEqual([a, b, c]);
  });

  it('writes a deny item, and reads a status list and an error code', () => {
    const deny: FeedbagItem = { name: 'carol', groupId: 0, itemId: 8, classId: FEEDBAG_CLASS_DENY, attrs: [] };
    expect(toHex(encodeFeedbagItems([deny]))).toBe(vector(v, 'feedbag item, deny item 8 for carol').hex);
    expect(decodeFeedbagStatus(bytesOf(v, 'feedbag status body, success then authorisation required'))).toEqual([0x0000, 0x000e]);
    expect(decodeFeedbagError(fromHex('000d'))).toBe(0x000d);
    expect(decodeFeedbagError(fromHex('000d00080002abcd'))).toBe(0x000d);
    expect(decodeFeedbagError(fromHex('0d'))).toBe(0);
    expect(decodeFeedbagError(new Uint8Array(0))).toBe(0);
  });

  it('writes the order attribute as one u16 per id', () => {
    expect(orderAttr([1, 5, 0x1234]).tag).toBe(FEEDBAG_ATTR_ORDER);
    expect(toHex(orderAttr([1, 5, 0x1234]).value)).toBe('000100051234');
    expect(toHex(orderAttr([]).value)).toBe('');
  });
});

describe('locate codec', () => {
  it('writes the profile and the away message with their type, and clears away with an empty text', () => {
    expect(toHex(encodeLocateInfo({ profile: '<B>hi</B> caf&#233; &#128512;' }))).toBe(vector(v, 'locate set info body, profile').hex);
    expect(toHex(encodeLocateInfo({ away: 'brb &#9749;' }))).toBe(vector(v, 'locate set info body, away with its type').hex);
    expect(toHex(encodeLocateInfo({ away: '' }))).toBe(vector(v, 'locate set info body, away cleared with its type').hex);
    const all = decodeTlvs(encodeLocateInfo({ capabilities: [CAP_UTF8_MESSAGES, CAP_CHAT], profile: 'p', away: 'a' }));
    expect(all.map((t) => t.tag)).toEqual([0x05, 0x01, 0x02, 0x03, 0x04]);
    expect(all[0]?.value).toHaveLength(32);
    expect(hexOf(all[0]?.value)).toBe(toHex(CAP_UTF8_MESSAGES) + toHex(CAP_CHAT));
  });

  it('refuses a capability that is not 16 bytes', () => {
    expect(() => encodeLocateInfo({ capabilities: [new Uint8Array(15)] })).toThrow('capability block must be a multiple of 16 bytes');
  });

  it('asks for the profile and away message with the newer query', () => {
    expect(toHex(encodeUserInfoQuery(LOCATE_QUERY_PROFILE | LOCATE_QUERY_AWAY, 'bob'))).toBe(vector(v, 'user info query body, profile and away, bob').hex);
    expect(toHex(encodeUserInfoQuery(LOCATE_QUERY_AWAY, 'bob'))).toBe(vector(v, 'user info query body, away only, bob').hex);
  });

  it('reads an info reply: the user, the profile with its type, the away message', () => {
    const body = bytesOf(v, 'user info reply body, Bob away and idle with a profile');
    const reply = decodeUserInfoReply(body);
    expect(reply.info.name).toBe('Bob');
    expect(reply.info.warning).toBe(100);
    expect(decodePresence(reply.info)).toEqual({ away: true, signedOnAt: 1790000000, idleMinutes: 14, warnLevel: 100 });
    expect(reply.profile?.mime).toBe(LOCATE_MIME);
    expect(ascii(reply.profile?.bytes)).toBe('caf&#233;');
    expect(ascii(reply.away)).toBe('brb');

    const bare = decodeUserInfoReply(body.subarray(0, decodeUserInfo(body, 0).next));
    expect(bare.info).toEqual(reply.info);
    expect('profile' in bare).toBe(false);
    expect('away' in bare).toBe(false);
  });

  it('reads the charset of a type', () => {
    expect(mimeCharset(LOCATE_MIME)).toBe('us-ascii');
    expect(mimeCharset('text/x-aolrtf; charset=UTF-8')).toBe('utf-8');
    expect(mimeCharset('text/plain')).toBeUndefined();
  });
});

describe('oservice codec', () => {
  it('writes only the invisible bit', () => {
    expect(toHex(encodeStatus(true))).toBe(vector(v, 'status body, invisible').hex);
    expect(toHex(encodeStatus(false))).toBe(vector(v, 'status body, visible').hex);
  });

  it('writes idle seconds, and zero to clear', () => {
    expect(toHex(encodeIdle(600))).toBe(vector(v, 'idle body, 600 seconds').hex);
    expect(toHex(encodeIdle(0))).toBe('00000000');
  });

  it('reads a warning notice with and without the warner', () => {
    expect(decodeEvilNotification(bytesOf(v, 'warning notice body, level 10% from Bob'))).toEqual({ level: 100, by: 'Bob' });
    expect(decodeEvilNotification(bytesOf(v, 'warning notice body, level 3%, anonymous'))).toEqual({ level: 30, by: null });
  });

  it('reads the status of a user', () => {
    const { info } = decodeUserInfo(bytesOf(v, 'self info body, Alice invisible at warn level 5%'), 0);
    expect(userStatus(info)).toBe(0x100);
    expect(userStatus({ ...info, tlvs: info.tlvs.filter((t) => t.tag !== 0x0006) })).toBe(0);
  });
});

describe('buddy prefs by number', () => {
  const masks = (value: string, valid: string): FeedbagItem =>
    prefsItem([tlv.bytes(FEEDBAG_ATTR_PREFS, fromHex(value)), tlv.bytes(FEEDBAG_ATTR_PREFS_VALID, fromHex(valid))]);
  const hexes = (item: FeedbagItem): [string | undefined, string | undefined] =>
    [hexOf(findTlv(item.attrs, FEEDBAG_ATTR_PREFS)), hexOf(findTlv(item.attrs, FEEDBAG_ATTR_PREFS_VALID))];
  const empty = prefsItem([]);

  it('numbers the prefs as the server does', () => {
    expect(BUDDY_PREF_ACCEPT_NON_LIST_BART).toBe(0x0c);
    expect(BUDDY_PREF_DISCLOSE_TYPING).toBe(0x16);
  });

  it('reads a pref as on, off or not valid', () => {
    expect(buddyPref(masks('00001000', '00001000'), 0x0c)).toBe(true);
    expect(buddyPref(masks('00000000', '00001000'), 0x0c)).toBe(false);
    expect(buddyPref(masks('00001000', '00000000'), 0x0c)).toBeNull();
    expect(buddyPref(prefsItem([tlv.bytes(FEEDBAG_ATTR_PREFS, fromHex('00001000'))]), 0x0c)).toBeNull();
    expect(buddyPref(prefsItem([tlv.bytes(FEEDBAG_ATTR_PREFS_VALID, fromHex('00001000'))]), 0x0c)).toBeNull();
    expect(buddyPref(empty, 0x0c)).toBeNull();
  });

  it('reads a pref from the right end of a mask of any length', () => {
    expect(buddyPref(masks('1000', '1000'), 0x0c)).toBe(true);
    expect(buddyPref(masks('0000000000001000', '0000000000001000'), 0x0c)).toBe(true);
    expect(buddyPref(masks('0000000010000000', '0000000010000000'), 0x0c)).toBeNull();
  });

  it('reads no pref from a mask too short to hold it', () => {
    expect(buddyPref(masks('10', '10'), 0x0c)).toBeNull();
    expect(buddyPref(masks('10', '00001000'), 0x0c)).toBeNull();
  });

  it('reads pref 0 at the last bit and pref 31 at the first', () => {
    expect(buddyPref(masks('00000001', '00000001'), 0)).toBe(true);
    expect(buddyPref(masks('80000000', '80000000'), 31)).toBe(true);
  });

  it('writes a pref and its valid bit into an empty item', () => {
    const on = withBuddyPref(empty, 0x0c, true);
    expect(hexes(on)).toEqual(['00001000', '00001000']);
    expect(hexes(withBuddyPref(on, 0x0c, false))).toEqual(['00000000', '00001000']);
    expect(hexes(withBuddyPref(empty, 0x0c, false))).toEqual(['00000000', '00001000']);
    expect(hexes(on)).toEqual(['00001000', '00001000']);
    expect(empty.attrs).toEqual([]);
  });

  it('keeps every other bit of both masks', () => {
    const item = itemOf('feedbag item, buddy preferences with typing enabled');
    const on = withBuddyPref(item, 0x0c, true);
    expect(typingPref(on)).toBe('enabled');
    expect(hexes(on)).toEqual(['00401001', '00401001']);
    expect(hexes(item)).toEqual(['00400001', '00400001']);
    expect(hexes(withBuddyPref(on, 0x0c, false))).toEqual(['00400001', '00401001']);
    const wide = withBuddyPref(masks('0100000000000001', '0100000000000001'), 0x0c, true);
    expect(hexes(wide)).toEqual(['0100000000001001', '0100000000001001']);
  });

  it('left-pads a short mask to four bytes, and a value mask to the valid mask', () => {
    expect(hexes(withBuddyPref(masks('0040', '0040'), 0x0c, true))).toEqual(['00001040', '00001040']);
    expect(hexes(withBuddyPref(masks('01', '00001000'), 0x0c, true))).toEqual(['00001001', '00001000']);
    expect(hexes(withBuddyPref(masks('1000', '0000000000001000'), 0x0c, false))).toEqual(['0000000000000000', '0000000000001000']);
  });

  it('reads back what it wrote at each mask length', () => {
    for (const [value, valid] of [['1000', '1000'], ['00', '10'], ['00001000', '00000000'], ['0000000000000000', '0000000000000000']] as const) {
      expect(buddyPref(withBuddyPref(masks(value, valid), 0x0c, true), 0x0c)).toBe(true);
      expect(buddyPref(withBuddyPref(masks(value, valid), 0x0c, false), 0x0c)).toBe(false);
    }
  });

  it('refuses a pref outside 0 to 31', () => {
    for (const pref of [32, 0x4c, -1, 1.5]) {
      expect(() => buddyPref(empty, pref)).toThrow(RangeError);
      expect(() => withBuddyPref(empty, pref, true)).toThrow(RangeError);
    }
  });

  it('leaves an item unchanged when typing cannot be enabled in its masks', () => {
    const none = itemOf('feedbag item, empty buddy preferences item 9');
    expect(withTypingEnabled(none)).toBe(none);
    const valueOnly = prefsItem([tlv.bytes(FEEDBAG_ATTR_PREFS, fromHex('00000001'))]);
    expect(withTypingEnabled(valueOnly)).toBe(valueOnly);
    const short = masks('0001', '0001');
    expect(withTypingEnabled(short)).toBe(short);
  });
});

describe('icbm codec', () => {
  it('writes a normal warning and reads its reply', () => {
    expect(toHex(encodeWarn('bob'))).toBe(vector(v, 'warn request body, normal, bob').hex);
    expect(decodeWarnReply(bytesOf(v, 'warn reply body, 10% applied, level 10%'))).toEqual({ delta: 100, level: 100 });
    expect(decodeWarnReply(fromHex('001e0082'))).toEqual({ delta: 30, level: 130 });
  });

  it('reads a typing event', () => {
    expect(decodeTyping(bytesOf(icbm, 'typing event body'))).toEqual({ screenName: 'alice', event: 2 });
  });
});
