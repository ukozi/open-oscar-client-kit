// ODir (0x0F): directory search and the keyword list; the Locate subtypes that set and read the listing and interests
// (open-oscar-server 1ab851e wire/snacs.go, foodgroup/locate.go, foodgroup/odir.go).
import { ByteReader, ByteWriter, OscarDecodeError } from './bytes.js';
import { decodeTlvBlock, encodeTlvs, readTlv, tlv, tlvStr } from './tlv.js';
import type { Tlv } from './tlv.js';

export const FAMILY_ODIR = 0x000f;

export const ODIR_ERR = 0x0001;
export const ODIR_INFO_QUERY = 0x0002;
export const ODIR_INFO_REPLY = 0x0003;
export const ODIR_KEYWORD_LIST_QUERY = 0x0004;
export const ODIR_KEYWORD_LIST_REPLY = 0x0005;

const ODIR_TLV_FIRST_NAME = 0x0001;
const ODIR_TLV_LAST_NAME = 0x0002;
const ODIR_TLV_MIDDLE_NAME = 0x0003;
const ODIR_TLV_MAIDEN_NAME = 0x0004;
const ODIR_TLV_COUNTRY = 0x0006;
const ODIR_TLV_STATE = 0x0007;
const ODIR_TLV_CITY = 0x0008;
const ODIR_TLV_SCREEN_NAME = 0x0009;
const ODIR_TLV_INTEREST = 0x000b;
const ODIR_TLV_NICKNAME = 0x000c;
const ODIR_TLV_ZIP = 0x000d;
const ODIR_TLV_ADDRESS = 0x0021;

const ODIR_KEYWORD_CATEGORY = 0x01;
const ODIR_KEYWORD = 0x02;

const LOCATE_GET_DIR_REPLY_OK = 0x0001;

// The server keeps five interests and drops the rest.
export const MAX_INTERESTS = 5;

export type DirListing = { firstName: string; lastName: string; city: string; state: string; country: string };

export type DirResult = { screenName: string; firstName: string; lastName: string; city: string; state: string; country: string };

// `category` is null for the top-level keywords.
export type KeywordGroup = { category: string | null; keywords: string[] };

// All ten fields the server stores go, so the five not in a DirListing go as empty TLVs, which clears them.
export function encodeSetDirInfo(listing: DirListing): Uint8Array {
  return encodeTlvs([
    tlv.str(ODIR_TLV_FIRST_NAME, listing.firstName),
    tlv.str(ODIR_TLV_LAST_NAME, listing.lastName),
    tlv.empty(ODIR_TLV_MIDDLE_NAME),
    tlv.empty(ODIR_TLV_MAIDEN_NAME),
    tlv.str(ODIR_TLV_COUNTRY, listing.country),
    tlv.str(ODIR_TLV_STATE, listing.state),
    tlv.str(ODIR_TLV_CITY, listing.city),
    tlv.empty(ODIR_TLV_NICKNAME),
    tlv.empty(ODIR_TLV_ZIP),
    tlv.empty(ODIR_TLV_ADDRESS),
  ]);
}

export function encodeSetKeywordInfo(interests: readonly string[]): Uint8Array {
  if (interests.length > MAX_INTERESTS) throw new RangeError(`at most ${MAX_INTERESTS} interests`);
  return encodeTlvs(interests.map((name) => tlv.str(ODIR_TLV_INTEREST, name)));
}

export function encodeGetDirInfo(screenName: string): Uint8Array {
  return new ByteWriter().str8(screenName).toBytes();
}

function listingOf(tlvs: readonly Tlv[]): DirListing {
  return {
    firstName: tlvStr(tlvs, ODIR_TLV_FIRST_NAME) ?? '',
    lastName: tlvStr(tlvs, ODIR_TLV_LAST_NAME) ?? '',
    city: tlvStr(tlvs, ODIR_TLV_CITY) ?? '',
    state: tlvStr(tlvs, ODIR_TLV_STATE) ?? '',
    country: tlvStr(tlvs, ODIR_TLV_COUNTRY) ?? '',
  };
}

export function decodeGetDirReply(body: Uint8Array): { ok: boolean; listing: DirListing } {
  const status = new ByteReader(body).u16();
  const { tlvs } = decodeTlvBlock(body, 2);
  return { ok: status === LOCATE_GET_DIR_REPLY_OK, listing: listingOf(tlvs) };
}

// Throws when both names are empty, because the server builds an empty clause from them.
export function encodeNameSearch(first: string, last: string): Uint8Array {
  const firstName = first.trim();
  const lastName = last.trim();
  if (firstName === '' && lastName === '') throw new RangeError('a name search needs a first or a last name');
  const tlvs: Tlv[] = [];
  if (firstName !== '') tlvs.push(tlv.str(ODIR_TLV_FIRST_NAME, firstName));
  if (lastName !== '') tlvs.push(tlv.str(ODIR_TLV_LAST_NAME, lastName));
  return encodeTlvs(tlvs);
}

export function encodeInterestSearch(keyword: string): Uint8Array {
  return encodeTlvs([tlv.str(ODIR_TLV_INTEREST, keyword)]);
}

export function decodeInfoReply(body: Uint8Array): { status: number; results: DirResult[] } {
  const r = new ByteReader(body);
  const status = r.u16();
  r.u16();
  const count = r.u16();
  const results: DirResult[] = [];
  for (let i = 0; i < count; i++) {
    const tlvs: Tlv[] = [];
    for (let n = r.u16(); n > 0; n--) tlvs.push(readTlv(r));
    results.push({ screenName: tlvStr(tlvs, ODIR_TLV_SCREEN_NAME) ?? '', ...listingOf(tlvs) });
  }
  return { status, results };
}

// A keyword joins its category's group; id 0 is the top level, a group with a null category that comes last.
export function decodeKeywordListReply(body: Uint8Array): KeywordGroup[] {
  const r = new ByteReader(body);
  r.u16();
  const count = r.u16();
  const groups: KeywordGroup[] = [];
  const byId = new Map<number, KeywordGroup>();
  const other: KeywordGroup = { category: null, keywords: [] };
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    const id = r.u8();
    const name = r.str16();
    if (type === ODIR_KEYWORD_CATEGORY) {
      const group: KeywordGroup = { category: name, keywords: [] };
      byId.set(id, group);
      groups.push(group);
    } else if (type === ODIR_KEYWORD) {
      const group = id === 0 ? other : byId.get(id);
      if (!group) throw new OscarDecodeError(`keyword ${name} names category ${id}, which the list has not opened`);
      group.keywords.push(name);
    }
  }
  if (other.keywords.length > 0) groups.push(other);
  return groups;
}
