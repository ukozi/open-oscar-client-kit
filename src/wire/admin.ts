// Admin (0x07): format the screen name, read the email (open-oscar-server 7af2464 wire/snacs.go, foodgroup/admin.go).
import { ByteReader } from './bytes.js';
import { decodeTlvBlock, encodeTlvs, findTlv, tlv, tlvStr } from './tlv.js';

export const FAMILY_ADMIN = 0x0007;

export const ADMIN_ERR = 0x0001;
export const ADMIN_INFO_QUERY = 0x0002;
export const ADMIN_INFO_REPLY = 0x0003;
export const ADMIN_INFO_CHANGE = 0x0004;
export const ADMIN_INFO_CHANGE_REPLY = 0x0005;

export const ADMIN_TLV_SCREEN_NAME = 0x0001;
export const ADMIN_TLV_URL = 0x0004;
export const ADMIN_TLV_ERROR = 0x0008;
export const ADMIN_TLV_EMAIL = 0x0011;

// TLV 0x08 of a change reply (wire/snacs.go AdminInfoError*).
export const ADMIN_ERROR_NOT_SAME = 0x0001;
export const ADMIN_ERROR_INVALID = 0x0006;
export const ADMIN_ERROR_LENGTH = 0x000b;

export const ADMIN_REQUEST_TIMEOUT_MS = 10_000;

/** 0x07/0x03 or 0x07/0x05: `permissions` is always 3 at 7af2464; `email` is null for an empty TLV 0x11. */
export type AdminReply = { permissions: number; screenName?: string; email?: string | null; error?: number };

/** The body of 0x07/0x02: an empty TLV 0x11, with no count, asks for the email address. */
export function encodeAdminEmailQuery(): Uint8Array {
  return encodeTlvs([tlv.empty(ADMIN_TLV_EMAIL)]);
}

export function encodeAdminFormat(name: string): Uint8Array {
  return encodeTlvs([tlv.str(ADMIN_TLV_SCREEN_NAME, name)]);
}

export function decodeAdminReply(body: Uint8Array): AdminReply {
  const permissions = new ByteReader(body).u16();
  const { tlvs } = decodeTlvBlock(body, 2);
  const reply: AdminReply = { permissions };
  const name = tlvStr(tlvs, ADMIN_TLV_SCREEN_NAME);
  if (name !== undefined) reply.screenName = name;
  const email = findTlv(tlvs, ADMIN_TLV_EMAIL);
  if (email) reply.email = email.length === 0 ? null : Buffer.from(email).toString('utf8');
  const error = findTlv(tlvs, ADMIN_TLV_ERROR);
  if (error) reply.error = new ByteReader(error).u16();
  return reply;
}
