import {
  CHATNAV_COOKIE_ATTEMPTS,
  CHATNAV_CREATE_ATTEMPTS,
  CHATNAV_CREATE_COOKIE,
  CHATNAV_CREATE_DETAIL,
  CHATNAV_CREATE_INSTANCE,
  CHATNAV_CREATE_ROOM,
  CHATNAV_ERR,
  CHATNAV_ERR_NO_MATCH,
  CHATNAV_NAV_INFO,
  CHATNAV_REQUEST_ROOM_INFO,
  CHATNAV_RETRY_BASE_MS,
  CHATNAV_ROOM_DETAIL,
  CHATNAV_TLV_ROOM_INFO,
  CHAT_ENCODING_ASCII,
  CHAT_LANG,
  FAMILY_CHAT,
  FAMILY_CHATNAV,
  FAMILY_OSERVICE,
  OSERVICE_RATE_PARAM_CHANGE,
  ROOM_JOIN_MAX_BYTES,
  ROOM_TLV_CHARSET,
  ROOM_TLV_CREATE_TIME,
  ROOM_TLV_LANG,
  ROOM_TLV_MAX_OCCUPANCY,
  ROOM_TLV_NAME,
  SERVICE_REQUEST_TIMEOUT_MS,
} from './constants.js';
import { decodeTlvBlock, decodeTlvs, encodeTlvBlock, findTlv } from './tlv.js';
import { OscarRoomError, type Logger, type RoomRef, type ServiceGrant, type SnacIn, type SnacLink } from './types.js';

/** `createdAt` (TLV 0xCA, Unix seconds, 0 is none) and `maxOccupancy` (TLV 0xD2) are absent when the block lacks them. */
export type RoomInfo = { exchange: 4 | 5; cookie: string; name: string; createdAt?: number; maxOccupancy?: number };

export type NavQuery =
  | { kind: 'create'; room: RoomRef }
  | { kind: 'cookie'; exchange: 4 | 5; cookie: string };

export type NavDeps = {
  open(): Promise<SnacLink>;
  sleep(ms: number): Promise<void>;
  random(): number;
  log: Logger;
  onStrayRate?(body: Uint8Array): void;
};

export function roomKey(room: RoomRef): string {
  return `${room.exchange}:${room.name.toLowerCase()}`;
}

export function roomCookie(room: RoomRef): string {
  return `${room.exchange}-0-${room.name.toLowerCase()}`;
}

export function roomFromCookie(cookie: string): RoomRef | null {
  const parts = cookie.split('-');
  if (parts.length < 3) return null;
  const exchange = Number(parts[0]);
  if (exchange !== 4 && exchange !== 5) return null;
  const name = parts.slice(2).join('-').toLowerCase();
  if (name.length === 0) return null;
  return { exchange, name };
}

export function str8(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 255) throw new OscarRoomError('too-long', 'room cookie does not fit a one-byte length');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

export function encodeCreateRoom(room: RoomRef): Uint8Array {
  return Buffer.concat([
    u16(room.exchange),
    str8(CHATNAV_CREATE_COOKIE),
    u16(CHATNAV_CREATE_INSTANCE),
    Buffer.from([CHATNAV_CREATE_DETAIL]),
    Buffer.from(
      encodeTlvBlock([
        { tag: ROOM_TLV_NAME, value: Buffer.from(room.name, 'utf8') },
        { tag: ROOM_TLV_CHARSET, value: Buffer.from(CHAT_ENCODING_ASCII, 'ascii') },
        { tag: ROOM_TLV_LANG, value: Buffer.from(CHAT_LANG, 'ascii') },
      ]),
    ),
  ]);
}

export function encodeRequestRoomInfo(exchange: 4 | 5, cookie: string): Uint8Array {
  return Buffer.concat([u16(exchange), str8(cookie), u16(0), Buffer.from([CHATNAV_ROOM_DETAIL])]);
}

export function decodeNavInfo(body: Uint8Array): RoomInfo | null {
  let value: Uint8Array | undefined;
  try {
    value = findTlv(decodeTlvs(body), CHATNAV_TLV_ROOM_INFO);
  } catch {
    return null;
  }
  if (!value || value.length < 3) return null;
  const b = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const exchange = b.readUInt16BE(0);
  const len = b.readUInt8(2);
  if (b.length < 3 + len) return null;
  const cookie = b.toString('utf8', 3, 3 + len);
  const ref = roomFromCookie(cookie);
  if ((exchange !== 4 && exchange !== 5) || !ref) return null;
  let name = '';
  let createdAt = 0;
  let maxOccupancy: number | undefined;
  try {
    const tlvs = decodeTlvBlock(value, 3 + len + 3).tlvs;
    const own = findTlv(tlvs, ROOM_TLV_NAME);
    if (own) name = Buffer.from(own).toString('utf8');
    const created = findTlv(tlvs, ROOM_TLV_CREATE_TIME);
    if (created?.length === 4) createdAt = Buffer.from(created).readUInt32BE(0);
    const most = findTlv(tlvs, ROOM_TLV_MAX_OCCUPANCY);
    if (most?.length === 2) maxOccupancy = Buffer.from(most).readUInt16BE(0);
  } catch {
    name = '';
  }
  if (name.length === 0) name = cookie.split('-').slice(2).join('-');
  return {
    exchange, cookie, name,
    ...(createdAt > 0 ? { createdAt } : {}),
    ...(maxOccupancy !== undefined && maxOccupancy > 0 ? { maxOccupancy } : {}),
  };
}

export function decodeSnacErrorCode(body: Uint8Array): number {
  return body.length >= 2 ? ((body[0] ?? 0) << 8) | (body[1] ?? 0) : 0;
}

export async function resolveRoom(query: NavQuery, deps: NavDeps): Promise<RoomInfo> {
  const attempts = query.kind === 'create' ? CHATNAV_CREATE_ATTEMPTS : CHATNAV_COOKIE_ATTEMPTS;
  const subtype = query.kind === 'create' ? CHATNAV_CREATE_ROOM : CHATNAV_REQUEST_ROOM_INFO;
  const body =
    query.kind === 'create' ? encodeCreateRoom(query.room) : encodeRequestRoomInfo(query.exchange, query.cookie);

  let asked = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let reply: SnacIn | undefined;
    let link: SnacLink | undefined;
    asked = false;
    try {
      link = await deps.open();
      const off = link.onSnac((snac) => {
        // open-oscar-server v0.24.0 can send a BOS rate notice on this socket, because the socket shares the BOS session.
        if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_RATE_PARAM_CHANGE) {
          deps.onStrayRate?.(snac.body);
        }
      });
      try {
        asked = true;
        reply = await link.request(FAMILY_CHATNAV, subtype, body, SERVICE_REQUEST_TIMEOUT_MS);
      } finally {
        off();
      }
    } catch (err) {
      if (err instanceof OscarRoomError) throw err;
      deps.log.debug('chatnav attempt ended without a reply', { attempt, kind: query.kind });
    } finally {
      link?.close();
    }

    if (reply && reply.family === FAMILY_CHATNAV && reply.subtype === CHATNAV_NAV_INFO) {
      const info = decodeNavInfo(reply.body);
      if (info) return info;
      throw new OscarRoomError('unavailable', 'room info reply did not parse');
    }
    if (reply && reply.family === FAMILY_CHATNAV && reply.subtype === CHATNAV_ERR) {
      const code = decodeSnacErrorCode(reply.body);
      if (code === CHATNAV_ERR_NO_MATCH) throw new OscarRoomError('no-such-room');
      throw new OscarRoomError('unavailable', `chatnav error ${code}`);
    }
    if (attempt < attempts) {
      // The server drops the socket of the loser when two clients create one room at the same time.
      await deps.sleep(Math.round(CHATNAV_RETRY_BASE_MS * 3 ** (attempt - 1) * (0.8 + 0.4 * deps.random())));
    }
  }
  // For an unknown cookie, the server drops the socket and does not answer. A socket that did not open tells nothing about the room.
  throw new OscarRoomError(query.kind === 'cookie' && asked ? 'no-such-room' : 'unavailable');
}

export type ServiceResolver = (family: number, roomInfo?: Uint8Array) => Promise<ServiceGrant>;

export type ServiceRequest = {
  foodGroup: number;
  room?: RoomInfo;
  screenName: string;
};

export function joinTooLong(screenName: string, roomCookie: string): boolean {
  return Buffer.byteLength(screenName, 'utf8') + Buffer.byteLength(roomCookie, 'utf8') > ROOM_JOIN_MAX_BYTES;
}

export function encodeServiceRoomInfo(room: RoomInfo): Uint8Array {
  const ex = Buffer.alloc(2);
  ex.writeUInt16BE(room.exchange, 0);
  return Buffer.concat([ex, str8(room.cookie), Buffer.alloc(2)]);
}

export async function requestService(resolve: ServiceResolver, req: ServiceRequest): Promise<ServiceGrant> {
  let roomInfo: Uint8Array | undefined;
  if (req.foodGroup === FAMILY_CHAT) {
    if (!req.room) throw new OscarRoomError('unavailable', 'a chat service request needs a room resolved through chatnav');
    // The server cannot make the service cookie for a long screen name and room cookie. It drops BOS and does not answer.
    if (joinTooLong(req.screenName, req.room.cookie)) throw new OscarRoomError('too-long');
    roomInfo = encodeServiceRoomInfo(req.room);
  }
  try {
    return await resolve(req.foodGroup, roomInfo);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'ServiceRefusedError' || name === 'RedirectRefusedError') {
      throw new OscarRoomError('unavailable', (err as Error).message);
    }
    throw new OscarRoomError('not-online');
  }
}
