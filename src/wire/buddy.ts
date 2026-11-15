import { ByteWriter } from './bytes.js';
import { CAPABILITY_LENGTH, USER_FLAG_AWAY, USER_FLAG_WIRELESS, USER_INFO_CAPABILITIES } from './constants.js';
import { capabilityUuid } from './oservice.js';
import { userFlags } from './snac.js';
import type { UserInfo } from './snac.js';
import { findTlv, tlvU16, tlvU32 } from './tlv.js';

const USER_INFO_SIGNED_ON_AT = 0x0003;
const USER_INFO_IDLE_MINUTES = 0x0004;

export function encodeNameList(names: readonly string[]): Uint8Array {
  const w = new ByteWriter();
  for (const name of names) w.str8(name);
  return w.toBytes();
}

export type DecodedPresence = { away: boolean; signedOnAt?: number; idleMinutes?: number; warnLevel: number; mobile?: true; capabilities?: string[] };

// Whole 16-byte entries only. An empty list gives undefined.
function readCapabilities(bytes: Uint8Array | undefined): string[] | undefined {
  const ids: string[] = [];
  for (let at = 0; bytes !== undefined && at + CAPABILITY_LENGTH <= bytes.length; at += CAPABILITY_LENGTH) {
    ids.push(capabilityUuid(bytes.subarray(at, at + CAPABILITY_LENGTH)));
  }
  return ids.length > 0 ? ids : undefined;
}

// signedOnAt is in Unix seconds, as received.
export function decodePresence(info: UserInfo): DecodedPresence {
  const presence: DecodedPresence = {
    away: (userFlags(info) & USER_FLAG_AWAY) !== 0,
    warnLevel: info.warning,
  };
  if ((userFlags(info) & USER_FLAG_WIRELESS) !== 0) presence.mobile = true;
  const signedOnAt = tlvU32(info.tlvs, USER_INFO_SIGNED_ON_AT);
  if (signedOnAt !== undefined) presence.signedOnAt = signedOnAt;
  const idleMinutes = tlvU16(info.tlvs, USER_INFO_IDLE_MINUTES);
  if (idleMinutes !== undefined) presence.idleMinutes = idleMinutes;
  const capabilities = readCapabilities(findTlv(info.tlvs, USER_INFO_CAPABILITIES));
  if (capabilities !== undefined) presence.capabilities = capabilities;
  return presence;
}
