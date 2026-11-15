import { describe, expect, it } from 'vitest';
import { toHex } from '../../../src/wire/bytes.js';
import {
  LOCATE_GET_DIR_INFO,
  LOCATE_GET_DIR_REPLY,
  LOCATE_SET_DIR_INFO,
  LOCATE_SET_DIR_REPLY,
  LOCATE_SET_KEYWORD_INFO,
  LOCATE_SET_KEYWORD_REPLY,
} from '../../../src/wire/locate.js';
import {
  FAMILY_ODIR,
  ODIR_ERR,
  ODIR_INFO_QUERY,
  ODIR_INFO_REPLY,
  ODIR_KEYWORD_LIST_QUERY,
  ODIR_KEYWORD_LIST_REPLY,
  decodeGetDirReply,
  decodeInfoReply,
  decodeKeywordListReply,
  encodeGetDirInfo,
  encodeInterestSearch,
  encodeNameSearch,
  encodeSetDirInfo,
  encodeSetKeywordInfo,
} from '../../../src/wire/odir.js';
import { decodeTlvs } from '../../../src/wire/tlv.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const v = loadVectors('odir.json');

const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const tags = (body: Uint8Array) => decodeTlvs(body).map((t) => t.tag);

describe('the directory codec', () => {
  it('numbers the Locate and ODir subtypes as the server does', () => {
    expect([LOCATE_SET_DIR_INFO, LOCATE_SET_DIR_REPLY, LOCATE_GET_DIR_INFO, LOCATE_GET_DIR_REPLY]).toEqual([0x09, 0x0a, 0x0b, 0x0c]);
    expect([LOCATE_SET_KEYWORD_INFO, LOCATE_SET_KEYWORD_REPLY]).toEqual([0x0f, 0x10]);
    expect(FAMILY_ODIR).toBe(0x000f);
    expect([ODIR_ERR, ODIR_INFO_QUERY, ODIR_INFO_REPLY, ODIR_KEYWORD_LIST_QUERY, ODIR_KEYWORD_LIST_REPLY]).toEqual([1, 2, 3, 4, 5]);
  });

  it('writes a listing as ten TLVs, the five not shown left empty', () => {
    const body = encodeSetDirInfo({ firstName: 'Ada', lastName: 'Lovelace', city: 'Marylebone', state: 'London', country: 'UK' });
    const list = decodeTlvs(body);
    expect(list.map((t) => t.tag)).toEqual([0x0001, 0x0002, 0x0003, 0x0004, 0x0006, 0x0007, 0x0008, 0x000c, 0x000d, 0x0021]);
    const byTag = new Map(list.map((t) => [t.tag, text(t.value)]));
    expect(byTag.get(0x0001)).toBe('Ada');
    expect(byTag.get(0x0002)).toBe('Lovelace');
    expect(byTag.get(0x0006)).toBe('UK');
    expect(byTag.get(0x0007)).toBe('London');
    expect(byTag.get(0x0008)).toBe('Marylebone');
    for (const tag of [0x0003, 0x0004, 0x000c, 0x000d, 0x0021]) expect(byTag.get(tag)).toBe('');
  });

  it('writes interests as one TLV 0x000B each, and refuses more than five', () => {
    const list = decodeTlvs(encodeSetKeywordInfo(['Rock', 'Hiking']));
    expect(list.map((t) => [t.tag, text(t.value)])).toEqual([
      [0x000b, 'Rock'],
      [0x000b, 'Hiking'],
    ]);
    expect(encodeSetKeywordInfo([])).toHaveLength(0);
    expect(() => encodeSetKeywordInfo(['a', 'b', 'c', 'd', 'e', 'f'])).toThrow();
  });

  it('asks for a listing by screen name with a u8 length', () => {
    expect(toHex(encodeGetDirInfo('Ada Byron'))).toBe(`09${toHex(Buffer.from('Ada Byron'))}`);
  });

  it('searches by trimmed names, leaving out an empty one, and never with both empty', () => {
    const first = decodeTlvs(encodeNameSearch('  Ada ', ''));
    expect(first.map((t) => [t.tag, text(t.value)])).toEqual([[0x0001, 'Ada']]);
    const last = decodeTlvs(encodeNameSearch(' ', 'Lovelace '));
    expect(last.map((t) => [t.tag, text(t.value)])).toEqual([[0x0002, 'Lovelace']]);
    expect(tags(encodeNameSearch('Ada', 'Lovelace'))).toEqual([0x0001, 0x0002]);
    expect(() => encodeNameSearch('', '  ')).toThrow();
    expect(() => encodeNameSearch('\t', '')).toThrow();
  });

  it('searches by interest with TLV 0x000B', () => {
    const list = decodeTlvs(encodeInterestSearch('Jazz'));
    expect(list.map((t) => [t.tag, text(t.value)])).toEqual([[0x000b, 'Jazz']]);
  });

  it('never sends the email TLV 0x0005', () => {
    const bodies = [
      encodeNameSearch('Ada', ''),
      encodeNameSearch('', 'Lovelace'),
      encodeNameSearch('Ada', 'Lovelace'),
      encodeInterestSearch('Jazz'),
      encodeSetDirInfo({ firstName: 'a', lastName: 'b', city: 'c', state: 'd', country: 'e' }),
      encodeSetKeywordInfo(['Rock']),
    ];
    for (const body of bodies) expect(tags(body)).not.toContain(0x0005);
  });

  it('reads the search reply the server marshals', () => {
    const reply = decodeInfoReply(bytesOf(v, 'odir info reply body, two results'));
    expect(reply.status).toBe(0x0005);
    expect(reply.results).toEqual([
      { screenName: 'Ada Byron', firstName: 'Ada', lastName: 'Lovelace', city: '', state: 'London', country: 'UK' },
      { screenName: 'gracehopper', firstName: 'Grace', lastName: 'Hopper', city: 'New York', state: 'NY', country: 'US' },
    ]);
  });

  it('reads a search reply with no results block, as the server sends for a missing name', () => {
    // SNAC_0x0F_0x03_InfoReply{Status: 4}: status, unknown, a zero count.
    expect(decodeInfoReply(new Uint8Array([0, 4, 0, 0, 0, 0]))).toEqual({ status: 4, results: [] });
  });

  it('reads the keyword list the server marshals, a top-level keyword in the null group', () => {
    expect(decodeKeywordListReply(bytesOf(v, 'odir keyword list reply body'))).toEqual([
      { category: 'Music', keywords: ['Jazz', 'Rock'] },
      { category: null, keywords: ['Hiking'] },
    ]);
  });

  it('reads the listing the server marshals', () => {
    expect(decodeGetDirReply(bytesOf(v, 'locate get dir reply body, ten fields'))).toEqual({
      ok: true,
      listing: { firstName: 'Ada', lastName: 'Lovelace', city: 'Marylebone', state: 'London', country: 'UK' },
    });
  });

  it('reads a listing reply with no TLVs as empty fields', () => {
    expect(decodeGetDirReply(new Uint8Array([0, 1, 0, 0]))).toEqual({
      ok: true,
      listing: { firstName: '', lastName: '', city: '', state: '', country: '' },
    });
    expect(decodeGetDirReply(new Uint8Array([0, 2, 0, 0])).ok).toBe(false);
  });
});
