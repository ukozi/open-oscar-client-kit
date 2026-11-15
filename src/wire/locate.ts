import { ByteWriter } from './bytes.js';
import { CAPABILITY_LENGTH, LOCATE_TLV_AWAY_TEXT, LOCATE_TLV_CAPABILITIES } from './constants.js';
import { decodeUserInfo } from './snac.js';
import type { UserInfo } from './snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvStr, tlvU16 } from './tlv.js';
import type { Tlv } from './tlv.js';

export const LOCATE_ERR = 0x0001;
export const LOCATE_RIGHTS_QUERY = 0x0002;
export const LOCATE_RIGHTS_REPLY = 0x0003;
export const LOCATE_USER_INFO_REPLY = 0x0006;
export const LOCATE_USER_INFO_QUERY2 = 0x0015;
// The directory listing and interests; odir.ts builds and reads their bodies.
export const LOCATE_SET_DIR_INFO = 0x0009;
export const LOCATE_SET_DIR_REPLY = 0x000a;
export const LOCATE_GET_DIR_INFO = 0x000b;
export const LOCATE_GET_DIR_REPLY = 0x000c;
export const LOCATE_SET_KEYWORD_INFO = 0x000f;
export const LOCATE_SET_KEYWORD_REPLY = 0x0010;
export const LOCATE_ERROR_NOT_LOGGED_ON = 0x0004;
export const LOCATE_MIME = 'text/aolrtf; charset="us-ascii"';
export const LOCATE_QUERY_PROFILE = 0x00000001;
export const LOCATE_QUERY_AWAY = 0x00000002;

const LOCATE_TLV_PROFILE_MIME = 0x0001;
const LOCATE_TLV_PROFILE_TEXT = 0x0002;
const LOCATE_TLV_AWAY_MIME = 0x0003;

const LOCATE_RIGHTS_TLV_MAX_SIGNATURE_LENGTH = 0x0001;

function capabilityTlv(caps: readonly Uint8Array[]): Tlv {
  // A caps TLV that is not a multiple of 16 bytes drops the connection server-side.
  const block = new ByteWriter();
  for (const cap of caps) {
    if (cap.length !== CAPABILITY_LENGTH) throw new Error('capability block must be a multiple of 16 bytes');
    block.bytes(cap);
  }
  return tlv.bytes(LOCATE_TLV_CAPABILITIES, block.toBytes());
}

export function encodeCapabilities(caps: readonly Uint8Array[]): Uint8Array {
  return encodeTlvs([capabilityTlv(caps)]);
}

// An empty text is an empty TLV: that is how a client clears away.
export function encodeLocateInfo(info: { capabilities?: readonly Uint8Array[]; profile?: string; away?: string }): Uint8Array {
  const tlvs: Tlv[] = [];
  if (info.capabilities !== undefined) tlvs.push(capabilityTlv(info.capabilities));
  if (info.profile !== undefined) tlvs.push(tlv.str(LOCATE_TLV_PROFILE_MIME, LOCATE_MIME), tlv.str(LOCATE_TLV_PROFILE_TEXT, info.profile));
  if (info.away !== undefined) tlvs.push(tlv.str(LOCATE_TLV_AWAY_MIME, LOCATE_MIME), tlv.str(LOCATE_TLV_AWAY_TEXT, info.away));
  return encodeTlvs(tlvs);
}

export function encodeUserInfoQuery(types: number, screenName: string): Uint8Array {
  return new ByteWriter().u32(types).str8(screenName).toBytes();
}

export function decodeUserInfoReply(body: Uint8Array): { info: UserInfo; profile?: { mime: string; bytes: Uint8Array }; away?: Uint8Array } {
  const { info, next } = decodeUserInfo(body, 0);
  const tlvs = decodeTlvs(body.subarray(next));
  const reply: { info: UserInfo; profile?: { mime: string; bytes: Uint8Array }; away?: Uint8Array } = { info };
  const profile = findTlv(tlvs, LOCATE_TLV_PROFILE_TEXT);
  if (profile) reply.profile = { mime: tlvStr(tlvs, LOCATE_TLV_PROFILE_MIME) ?? '', bytes: profile };
  const away = findTlv(tlvs, LOCATE_TLV_AWAY_TEXT);
  if (away) reply.away = away;
  return reply;
}

export function mimeCharset(mime: string): string | undefined {
  for (const part of mime.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    const value = part.slice(eq + 1).trim().replace(/^"|"$/g, '').trim().toLowerCase();
    return value === '' ? undefined : value;
  }
  return undefined;
}

export function encodeAway(text: string | null): Uint8Array {
  return encodeTlvs([tlv.str(LOCATE_TLV_AWAY_TEXT, text ?? '')]);
}

export function decodeLocateRights(body: Uint8Array): { maxSignatureLength?: number } {
  const maxSignatureLength = tlvU16(decodeTlvs(body), LOCATE_RIGHTS_TLV_MAX_SIGNATURE_LENGTH);
  return maxSignatureLength === undefined ? {} : { maxSignatureLength };
}
