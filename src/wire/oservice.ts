import { ByteReader, ByteWriter, OscarDecodeError, toHex } from './bytes.js';
import { parseHostPort } from './connection.js';
import {
  CAPABILITY_LENGTH,
  CLIENT_TOOL_ID,
  CLIENT_TOOL_VERSION,
  FOOD_GROUP_VERSION,
  SERVICE_TLV_COOKIE,
  SERVICE_TLV_RECONNECT_HERE,
  SERVICE_TLV_ROOM_INFO,
  SERVICE_TLV_SSL_STATE,
  SERVICE_TLV_USE_SSL,
  USER_INFO_STATUS,
  USER_STATUS_INVISIBLE,
} from './constants.js';
import { decodeUserInfo } from './snac.js';
import type { UserInfo } from './snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvU32, tlvU8 } from './tlv.js';
import type { Tlv } from './tlv.js';

export type ServiceRedirect = { host: string; port: number; cookie: Uint8Array; ssl: boolean };

export class ServiceRefusedError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`service request refused (0x${code.toString(16)})`);
    this.name = 'ServiceRefusedError';
    this.code = code;
  }
}

export function encodeClientVersions(families: readonly number[], versionOf: (family: number) => number = () => FOOD_GROUP_VERSION): Uint8Array {
  const w = new ByteWriter();
  for (const family of families) w.u16(family).u16(versionOf(family));
  return w.toBytes();
}

export function encodeClientOnline(families: readonly number[], versionOf: (family: number) => number = () => FOOD_GROUP_VERSION): Uint8Array {
  const w = new ByteWriter();
  for (const family of families) w.u16(family).u16(versionOf(family)).u16(CLIENT_TOOL_ID).u16(CLIENT_TOOL_VERSION);
  return w.toBytes();
}

// The (family, version) pairs of 0x01/0x18.
export function decodeHostVersions(body: Uint8Array): Map<number, number> {
  const r = new ByteReader(body);
  const versions = new Map<number, number>();
  while (r.remaining >= 4) versions.set(r.u16(), r.u16());
  return versions;
}

export function encodeServiceRequest(family: number, req: { useSsl: boolean; roomInfo?: Uint8Array }): Uint8Array {
  const tlvs: Tlv[] = [];
  if (req.roomInfo) tlvs.push(tlv.bytes(SERVICE_TLV_ROOM_INFO, req.roomInfo));
  if (req.useSsl) tlvs.push(tlv.empty(SERVICE_TLV_USE_SSL));
  return new ByteWriter().u16(family).bytes(encodeTlvs(tlvs)).toBytes();
}

// TLV 0x05 is "host" or "host:port", TLV 0x06 the cookie, TLV 0x8E whether the server expects TLS.
export function decodeServiceResponse(body: Uint8Array, defaultPort: number): ServiceRedirect {
  const tlvs = decodeTlvs(body);
  const address = findTlv(tlvs, SERVICE_TLV_RECONNECT_HERE);
  const cookie = findTlv(tlvs, SERVICE_TLV_COOKIE);
  if (!address) throw new OscarDecodeError('service response without an address (TLV 0x05)');
  if (!cookie) throw new OscarDecodeError('service response without a cookie (TLV 0x06)');
  const { host, port } = parseHostPort(Buffer.from(address).toString('utf8'), defaultPort);
  return { host, port, cookie: Uint8Array.from(cookie), ssl: (tlvU8(tlvs, SERVICE_TLV_SSL_STATE) ?? 0) !== 0 };
}

export function decodeHostOnline(body: Uint8Array): number[] {
  const r = new ByteReader(body);
  const families: number[] = [];
  while (r.remaining >= 2) families.push(r.u16());
  return families;
}

export function encodeStatus(invisible: boolean): Uint8Array {
  return encodeTlvs([tlv.u32(USER_INFO_STATUS, invisible ? USER_STATUS_INVISIBLE : 0)]);
}

// Seconds idle; 0 clears.
export function encodeIdle(seconds: number): Uint8Array {
  return new ByteWriter().u32(seconds).toBytes();
}

// No warner block means the warning was anonymous.
export function decodeEvilNotification(body: Uint8Array): { level: number; by: string | null } {
  const r = new ByteReader(body);
  const level = r.u16();
  return { level, by: r.remaining > 0 ? decodeUserInfo(body, r.offset).info.name : null };
}

export function userStatus(info: UserInfo): number {
  return tlvU32(info.tlvs, USER_INFO_STATUS) ?? 0;
}

export function decodeUserInfoUpdate(body: Uint8Array): UserInfo[] {
  const blocks: UserInfo[] = [];
  for (let offset = 0; offset < body.length; ) {
    const { info, next } = decodeUserInfo(body, offset);
    blocks.push(info);
    offset = next;
  }
  return blocks;
}

export function capabilityUuid(bytes: Uint8Array): string {
  if (bytes.length !== CAPABILITY_LENGTH) throw new OscarDecodeError(`a capability of ${bytes.length} bytes`);
  const hex = toHex(bytes).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
