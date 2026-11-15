import { describe, expect, it } from 'vitest';
import {
  BART_CLEAR_HASH, BART_FLAG_CUSTOM, BART_FLAG_UNKNOWN, BART_TYPE_BUDDY_ICON,
  decodeBartDownloadReply, decodeBartIds, decodeBartInfo, decodeBartNotice, decodeBartUploadReply,
  encodeBartDownload, encodeBartInfo, encodeBartUpload, isClearHash, userIcon,
} from '../../../src/wire/bart.js';
import type { BartId } from '../../../src/wire/bart.js';
import { ByteReader, OscarDecodeError, fromHex, toHex } from '../../../src/wire/bytes.js';
import { USER_INFO_BART, USER_INFO_FLAGS } from '../../../src/wire/constants.js';
import {
  BART_ICON_ITEM_NAME, FEEDBAG_ATTR_BART_INFO, FEEDBAG_CLASS_BART, encodeFeedbagItems, readFeedbagItem, withAttr,
} from '../../../src/wire/feedbag.js';
import { decodeUserInfo } from '../../../src/wire/snac.js';
import { tlv } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';

const v = loadVectors('hand-icons.json');
const HASH = fromHex('1ac2109d47dbc72551f71df89d01ed18');
const ICON: BartId = { type: 1, flags: 0x01, hash: HASH };
const DATA = new Uint8Array(Buffer.from('GIF89a'));

const IDS_ICON_AND_STATUS = 'bart ids, an icon then a status string';
const IDS_STATUS_ONLY = 'bart ids, a status string only';
const IDS_NOT_UPLOADED = 'bart ids, an icon not yet uploaded';
const IDS_CLEARED = 'bart ids, the cleared icon';
const ARRIVAL = 'arrival body, Bob with an icon and a status string';
const ITEM_REAL = 'feedbag item, icon item 9 with a real icon';
const ITEM_CLEARED = 'feedbag item, icon item 9 cleared';
const ITEM_WITH_ALIAS = 'feedbag item, icon item 9 with another attribute before the icon';
const NOTICE_WANTED = 'bart notice body, upload wanted';
const NOTICE_HELD = 'bart notice body, already held';
const UPLOAD = 'bart upload body, type 1, GIF89a';
const UPLOAD_OK = 'bart upload reply body, success';
const UPLOAD_CODE_4 = 'bart upload reply body, code 4';
const DOWNLOAD = 'bart download body, bob';
const DOWNLOAD_REPLY = 'bart download reply body, bob, GIF89a';
const DOWNLOAD_REPLY_EMPTY = 'bart download reply body, bob, no data';

function iconItem(value: Uint8Array) {
  return { name: BART_ICON_ITEM_NAME, groupId: 0, itemId: 9, classId: FEEDBAG_CLASS_BART, attrs: [{ tag: FEEDBAG_ATTR_BART_INFO, value }] };
}

describe('BART ids in a user info', () => {
  it('reads a list of BART ids: the icon, then a status string', () => {
    const ids = decodeBartIds(bytesOf(v, IDS_ICON_AND_STATUS));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toEqual(ICON);
    expect(ids[1]?.type).toBe(2);
    expect(ids[1]?.flags).toBe(0x04);
  });

  it('finds the icon among the ids of a user info, and none when there is only a status string', () => {
    expect(userIcon(decodeUserInfo(bytesOf(v, ARRIVAL), 0).info)).toEqual(ICON);
    const statusOnly = { name: 'Bob', warning: 0, tlvs: [tlv.bytes(USER_INFO_BART, bytesOf(v, IDS_STATUS_ONLY))] };
    expect(userIcon(statusOnly)).toBeNull();
    expect(userIcon({ name: 'Bob', warning: 0, tlvs: [tlv.u16(USER_INFO_FLAGS, 0x0010)] })).toBeNull();
  });

  it.each(Array.from({ length: 31 }, (_, length) => length))(
    'an icon list cut short ends where it is cut and throws nothing (%i bytes)',
    (length) => {
      const ids = decodeBartIds(bytesOf(v, IDS_ICON_AND_STATUS).subarray(0, length));
      expect(ids).toEqual(length < 20 ? [] : [ICON]);
    },
  );

  it('tells the cleared hash and the not-yet-uploaded flag', () => {
    const cleared = decodeBartIds(bytesOf(v, IDS_CLEARED));
    expect(cleared).toHaveLength(1);
    expect(cleared.map((id) => isClearHash(id.hash))).toEqual([true]);
    const pending = decodeBartIds(bytesOf(v, IDS_NOT_UPLOADED));
    expect(pending).toHaveLength(1);
    expect((pending[0]?.flags ?? 0) & BART_FLAG_UNKNOWN).not.toBe(0);
    expect(isClearHash(HASH)).toBe(false);
  });
});

describe('the icon item of the buddy list', () => {
  it('writes the icon attribute for a real icon and for the cleared one', () => {
    expect(toHex(encodeFeedbagItems([iconItem(encodeBartInfo(BART_FLAG_CUSTOM, HASH))]))).toBe(vector(v, ITEM_REAL).hex);
    expect(toHex(encodeFeedbagItems([iconItem(encodeBartInfo(0, BART_CLEAR_HASH))]))).toBe(vector(v, ITEM_CLEARED).hex);
  });

  it("replacing the icon attribute keeps the item's other attributes and their order", () => {
    const item = readFeedbagItem(new ByteReader(bytesOf(v, ITEM_WITH_ALIAS)));
    const cleared = withAttr(item, FEEDBAG_ATTR_BART_INFO, encodeBartInfo(0, BART_CLEAR_HASH));
    // name "1", group 0, item 9, class 0x14, 15 bytes of attributes: 0x0131 empty, then 0x00D5
    expect(toHex(encodeFeedbagItems([cleared]))).toBe('000131000000090014000f' + '01310000' + '00d50007' + '00' + '05' + '0201d20472');
  });

  it('reads the icon attribute back, and null from one cut short', () => {
    expect(decodeBartInfo(encodeBartInfo(1, HASH))).toEqual({ flags: 1, hash: HASH });
    expect(decodeBartInfo(Uint8Array.of(1, 16, 0xaa))).toBeNull();
    expect(decodeBartInfo(new Uint8Array(0))).toBeNull();
  });

  it('reads the notice: which icon, and whether the server wants it uploaded', () => {
    const wanted = decodeBartNotice(bytesOf(v, NOTICE_WANTED));
    expect(wanted.flags).toBe(0x41);
    expect(wanted.hash).toEqual(HASH);
    expect(decodeBartNotice(bytesOf(v, NOTICE_HELD)).flags).toBe(0x01);
  });
});

describe('BART upload and download', () => {
  it('an upload is the type, the length and the bytes', () => {
    expect(toHex(encodeBartUpload(BART_TYPE_BUDDY_ICON, DATA))).toBe(vector(v, UPLOAD).hex);
    expect(() => encodeBartUpload(1, new Uint8Array(65_536))).toThrow(RangeError);
    expect(encodeBartUpload(1, new Uint8Array(65_535))).toHaveLength(4 + 65_535);
  });

  it("reads an upload reply's code and id", () => {
    expect(decodeBartUploadReply(bytesOf(v, UPLOAD_OK))).toEqual({ code: 0, id: ICON });
    expect(decodeBartUploadReply(bytesOf(v, UPLOAD_CODE_4)).code).toBe(4);
  });

  it('a download names the screen name and the icon', () => {
    expect(toHex(encodeBartDownload('bob', ICON))).toBe(vector(v, DOWNLOAD).hex);
  });

  it('reads a download reply: whose, which, and the bytes; empty when the server holds none', () => {
    expect(decodeBartDownloadReply(bytesOf(v, DOWNLOAD_REPLY))).toEqual({ screenName: 'bob', id: ICON, data: DATA });
    expect(decodeBartDownloadReply(bytesOf(v, DOWNLOAD_REPLY_EMPTY)).data).toHaveLength(0);
  });

  it('a download reply cut inside its data throws', () => {
    const whole = bytesOf(v, DOWNLOAD_REPLY);
    expect(() => decodeBartDownloadReply(whole.subarray(0, whole.length - 1))).toThrow(OscarDecodeError);
  });
});
