import { describe, expect, it } from 'vitest';
import { ByteReader, toHex } from '../../../src/wire/bytes.js';
import {
  FEEDBAG_ATTR_PENDING, PD_MODE_DENY_ALL, PD_MODE_DENY_SOME, PD_MODE_PERMIT_ALL, PD_MODE_PERMIT_ON_LIST, PD_MODE_PERMIT_SOME,
  decodeFeedbagReply, decodeFeedbagRights, decodeFeedbagStatus, encodeFeedbagItems,
  feedbagAlias, feedbagOrder, readFeedbagItem,
} from '../../../src/wire/feedbag.js';
import { bytesOf, loadVectors, vector } from '../../support/vectors.js';

const v = loadVectors('hand-session.json');

describe('feedbag codec', () => {
  it('decodes the reply into its items', () => {
    const reply = decodeFeedbagReply(bytesOf(v, 'feedbag reply body, six items'));
    expect([reply.version, reply.lastUpdate, reply.items.length]).toEqual([0, 1790000000, 6]);
    expect(reply.items.map((i) => [i.name, i.groupId, i.itemId, i.classId])).toEqual([
      ['', 0, 0, 1], ['Buddies', 1, 0, 1], ['chimrdev2', 1, 10, 0], ['alice', 1, 11, 0], ['Work', 2, 0, 1], ['', 0, 5, 9],
    ]);
    expect(reply.items.map(feedbagOrder)).toEqual([[2, 1], [11, 10], [], [], [], []]);
    expect(reply.items.map(feedbagAlias)).toEqual([null, null, 'Dev Two', null, null, null]);
  });

  it('decodes an empty reply', () => {
    expect(decodeFeedbagReply(bytesOf(v, 'feedbag reply body, empty'))).toEqual({ version: 0, items: [], lastUpdate: 0 });
  });

  it('re-encodes every item to the bytes it was read from, unknown attributes included', () => {
    const body = bytesOf(v, 'feedbag reply body, six items');
    const { items } = decodeFeedbagReply(body);
    expect(toHex(encodeFeedbagItems(items))).toBe(toHex(body.subarray(3, body.length - 4)));
    expect(toHex(encodeFeedbagItems([readFeedbagItem(new ByteReader(bytesOf(v, 'feedbag item, buddy with alias')))]))).toBe(vector(v, 'feedbag item, buddy with alias').hex);
  });

  it('reads the advertised limits', () => {
    const rights = decodeFeedbagRights(bytesOf(v, 'feedbag rights reply body'));
    expect(rights.maxItemAttrs).toBe(200);
    expect(rights.maxByClass).toHaveLength(21);
    expect([rights.maxByClass[0], rights.maxByClass[1], rights.maxByClass[2], rights.maxByClass[3], rights.maxByClass[0x14]]).toEqual([61, 61, 100, 100, 200]);
    expect([rights.maxItemNameLength, rights.maxBuddiesPerGroup]).toEqual([200, 200]);
    expect(decodeFeedbagRights(new Uint8Array(0))).toEqual({ maxByClass: [] });
  });

  it('reads one result per item from a status reply', () => {
    expect(decodeFeedbagStatus(bytesOf(v, 'feedbag status body, two successes'))).toEqual([0, 0]);
  });

  it('ignores a trailing odd byte in an order list and treats an empty alias as none', () => {
    const item = { name: 'g', groupId: 1, itemId: 0, classId: 1, attrs: [{ tag: 0x00c8, value: Uint8Array.of(0, 7, 9) }, { tag: 0x0131, value: new Uint8Array(0) }] };
    expect([feedbagOrder(item), feedbagAlias(item)]).toEqual([[7], null]);
  });
});

describe('privacy constants', () => {
  it('names the five modes of TLV 0x00CA and the pending attribute of a buddy item (wire/snacs.go:1760, :1882-1893 at 7af2464)', () => {
    expect([PD_MODE_PERMIT_ALL, PD_MODE_DENY_ALL, PD_MODE_PERMIT_SOME, PD_MODE_DENY_SOME, PD_MODE_PERMIT_ON_LIST]).toEqual([1, 2, 3, 4, 5]);
    expect(FEEDBAG_ATTR_PENDING).toBe(0x0066);
  });
});
