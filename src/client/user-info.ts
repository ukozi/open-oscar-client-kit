import { decodePresence } from '../wire/buddy.js';
import { OscarDecodeError } from '../wire/bytes.js';
import {
  CAPABILITY_LENGTH,
  USER_FLAG_AWAY,
  USER_FLAG_WIRELESS,
  USER_INFO_CAPABILITIES,
  USER_INFO_EXTERNAL_IP_TEXT,
  USER_INFO_INSTANCE,
  USER_STATUS_INVISIBLE,
} from '../wire/constants.js';
import { capabilityUuid, decodeUserInfoUpdate, userStatus } from '../wire/oservice.js';
import { decodeUserInfo, userFlags } from '../wire/snac.js';
import type { UserInfo } from '../wire/snac.js';
import { findTlv, tlvStr, tlvU8 } from '../wire/tlv.js';
import { MOBILE_CAPABILITY } from '../model/instances.js';
import type { InstanceInfo, UserInfoSnapshot } from '../model/instances.js';

export function readUserInfoUpdate(body: Uint8Array, opts: { at: number; multiInstance: boolean; mobileAdvertised: boolean }): UserInfoSnapshot {
  const [first, ...rest] = opts.multiInstance ? decodeUserInfoUpdate(body) : [decodeUserInfo(body, 0).info];
  if (!first) throw new OscarDecodeError('a user info update with no block');
  const session = readInstance(first);
  const instances = rest.map(readInstance);
  const matches =
    opts.mobileAdvertised && session.externalIp !== null
      ? instances.filter((i) => i.externalIp === session.externalIp && i.capabilities?.includes(MOBILE_CAPABILITY) === true)
      : [];
  const self = matches.length === 1 ? (matches[0] ?? null) : null;
  return { at: opts.at, multiInstance: opts.multiInstance, session, instances, self, selfMatches: matches.length };
}

function readInstance(info: UserInfo): InstanceInfo {
  const flags = userFlags(info);
  const status = userStatus(info);
  const { signedOnAt, idleMinutes } = decodePresence(info);
  return {
    instance: tlvU8(info.tlvs, USER_INFO_INSTANCE) ?? null,
    flags,
    status,
    capabilities: readCapabilities(findTlv(info.tlvs, USER_INFO_CAPABILITIES)),
    externalIp: tlvStr(info.tlvs, USER_INFO_EXTERNAL_IP_TEXT) ?? null,
    idleMinutes: idleMinutes ?? null,
    signedOnAt: signedOnAt === undefined ? null : signedOnAt * 1000,
    away: (flags & USER_FLAG_AWAY) !== 0,
    invisible: (status & USER_STATUS_INVISIBLE) !== 0,
    mobile: (flags & USER_FLAG_WIRELESS) !== 0,
  };
}

function readCapabilities(bytes: Uint8Array | undefined): string[] | null {
  if (bytes === undefined) return null;
  const uuids: string[] = [];
  for (let at = 0; at < bytes.length; at += CAPABILITY_LENGTH) uuids.push(capabilityUuid(bytes.subarray(at, at + CAPABILITY_LENGTH)));
  return uuids;
}
