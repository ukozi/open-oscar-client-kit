import { randomBytes } from 'node:crypto';
import { ByteReader, ByteWriter } from './bytes.js';
import { roomFromCookie } from './chatnav.js';
import {
  CAP_CHAT,
  CHAT_ENCODING_ASCII,
  CHAT_LANG,
  ICBM_CHANNEL_IM,
  ICBM_CHANNEL_RENDEZVOUS,
  ICBM_FRAGMENT_CAPS,
  ICBM_FRAGMENT_CAPS_TEXT,
  ICBM_FRAGMENT_TEXT,
  ICBM_FRAGMENT_VERSION,
  ICBM_TLV_AUTO_RESPONSE,
  ICBM_TLV_IM_DATA,
  ICBM_TLV_RENDEZVOUS,
  ICBM_TLV_REQUEST_HOST_ACK,
  ICBM_TLV_STORE,
  RDV_CANCEL_DECLINED,
  RDV_FRAGMENT_MIN_BYTES,
  RDV_TLV_CANCEL_REASON,
  RDV_TLV_CHARSET,
  RDV_TLV_INVITATION,
  RDV_TLV_LANG,
  RDV_TLV_SEQUENCE,
  RDV_TLV_SERVICE_DATA,
  RDV_TYPE_CANCEL,
  RDV_TYPE_PROPOSE,
} from './constants.js';
import { decodeSnacError, decodeUserInfo } from './snac.js';
import type { UserInfo } from './snac.js';
import { decodeWireText, normalizeScreenName, toAsciiEntities } from './text.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvU16 } from './tlv.js';
import type { Tlv } from './tlv.js';
import type { RoomRef } from './types.js';

export const ICBM_PARAM_QUERY = 0x0004;
export const ICBM_PARAM_REPLY = 0x0005;
export const ICBM_ERROR_SENDER_BLOCKS = 0x0010;
export const ICBM_SUBERROR_OFFLINE_FULL = 0x000f;
export const ICBM_ERROR_TLV_SUBCODE = 0x0008;

export function decodeImFragments(data: Uint8Array): { charset: number; text: Uint8Array }[] {
  const r = new ByteReader(data);
  const out: { charset: number; text: Uint8Array }[] = [];
  while (r.remaining > 0) {
    const id = r.u8();
    r.u8();
    const payload = new ByteReader(r.bytes(r.u16()));
    if (id !== ICBM_FRAGMENT_TEXT) continue;
    const charset = payload.u16();
    payload.u16();
    out.push({ charset, text: payload.rest() });
  }
  return out;
}

export function encodeImFragments(charset: number, text: Uint8Array): Uint8Array {
  return new ByteWriter()
    .u8(ICBM_FRAGMENT_CAPS)
    .u8(ICBM_FRAGMENT_VERSION)
    .u16(ICBM_FRAGMENT_CAPS_TEXT.length)
    .bytes(ICBM_FRAGMENT_CAPS_TEXT)
    .u8(ICBM_FRAGMENT_TEXT)
    .u8(ICBM_FRAGMENT_VERSION)
    .u16(4 + text.length)
    .u16(charset)
    .u16(0)
    .bytes(text)
    .toBytes();
}

export function newCookie(): bigint {
  // Cookie 0 means "no id" on this server: TOC clients and server notices all use it.
  for (;;) {
    const cookie = new ByteReader(new Uint8Array(randomBytes(8))).u64();
    if (cookie !== 0n) return cookie;
  }
}

export function encodeImToHost(cookie: bigint, to: string, charset: number, text: Uint8Array, store: boolean, auto = false): Uint8Array {
  const tlvs = [tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(charset, text)), tlv.empty(ICBM_TLV_REQUEST_HOST_ACK)];
  if (store) tlvs.push(tlv.empty(ICBM_TLV_STORE));
  // The relay copies the sender's TLVs and strips only 0x03, 0x06 and 0x16, so this is what marks the message automatic.
  if (auto) tlvs.push(tlv.empty(ICBM_TLV_AUTO_RESPONSE));
  return new ByteWriter().u64(cookie).u16(ICBM_CHANNEL_IM).str8(to).bytes(encodeTlvs(tlvs)).toBytes();
}

export function encodeTyping(to: string, event: number): Uint8Array {
  return new ByteWriter().u64(0n).u16(ICBM_CHANNEL_IM).str8(to).u16(event).toBytes();
}

export type InboundMessage = { cookie: bigint; channel: number; sender: UserInfo; tlvs: Tlv[] };

export function decodeImToClient(body: Uint8Array): InboundMessage {
  const r = new ByteReader(body);
  const cookie = r.u64();
  const channel = r.u16();
  const { info, next } = decodeUserInfo(body, r.offset);
  return { cookie, channel, sender: info, tlvs: decodeTlvs(body.subarray(next)) };
}

export type ChatInvite = { from: string; fromDisplay: string; room: RoomRef; roomCookie: string; html: string; cookie: bigint };

export function tolerantTlvs(buf: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const tag = buf.readUInt16BE(at);
    const len = buf.readUInt16BE(at + 2);
    if (at + 4 + len > buf.length) break;
    out.push({ tag, value: buf.subarray(at + 4, at + 4 + len) });
    at += 4 + len;
  }
  return out;
}

export function parseInvite(icbmBody: Uint8Array): ChatInvite | null {
  const b = Buffer.from(icbmBody.buffer, icbmBody.byteOffset, icbmBody.byteLength);
  if (b.length < 10 || b.readUInt16BE(8) !== ICBM_CHANNEL_RENDEZVOUS) return null;
  let fragment: Uint8Array | undefined;
  let display: string;
  try {
    const { info, next } = decodeUserInfo(b, 10);
    display = info.name;
    fragment = findTlv(tolerantTlvs(b.subarray(next)), ICBM_TLV_RENDEZVOUS);
  } catch {
    return null;
  }
  if (!fragment || fragment.length < RDV_FRAGMENT_MIN_BYTES) return null;
  const f = Buffer.from(fragment.buffer, fragment.byteOffset, fragment.byteLength);
  if (f.readUInt16BE(0) !== RDV_TYPE_PROPOSE) return null;
  if (!f.subarray(10, 26).equals(Buffer.from(CAP_CHAT))) return null;
  const inner = tolerantTlvs(f.subarray(RDV_FRAGMENT_MIN_BYTES));
  const data = findTlv(inner, RDV_TLV_SERVICE_DATA);
  if (!data || data.length < 3) return null;
  const d = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const exchange = d.readUInt16BE(0);
  const len = d.readUInt8(2);
  if (d.length < 3 + len) return null;
  const roomCookie = d.toString('utf8', 3, 3 + len);
  const ref = roomFromCookie(roomCookie);
  if (!ref || (exchange !== 4 && exchange !== 5)) return null;
  const charset = findTlv(inner, RDV_TLV_CHARSET);
  const text = findTlv(inner, RDV_TLV_INVITATION);
  return {
    from: normalizeScreenName(display),
    fromDisplay: display,
    room: { exchange, name: ref.name },
    roomCookie,
    html: text ? decodeWireText(text, charset ? Buffer.from(charset).toString('ascii') : undefined) : '',
    cookie: f.readBigUInt64BE(2),
  };
}

export type InviteRoom = { exchange: 4 | 5; cookie: string };

export function rendezvousHead(type: number, cookie: bigint, capability: Uint8Array): ByteWriter {
  return new ByteWriter().u16(type).u64(cookie).bytes(capability);
}

// The value of TLV 0x05 of a room proposal (wire/snacs.go ICBMCh2Fragment).
export function encodeChatInviteFragment(cookie: bigint, room: InviteRoom, text: string): Uint8Array {
  return rendezvousHead(RDV_TYPE_PROPOSE, cookie, CAP_CHAT)
    .bytes(
      encodeTlvs([
        tlv.u16(RDV_TLV_SEQUENCE, 1),
        tlv.bytes(RDV_TLV_INVITATION, new Uint8Array(Buffer.from(toAsciiEntities(text), 'ascii'))),
        tlv.str(RDV_TLV_CHARSET, CHAT_ENCODING_ASCII),
        tlv.str(RDV_TLV_LANG, CHAT_LANG),
        tlv.bytes(RDV_TLV_SERVICE_DATA, new ByteWriter().u16(room.exchange).str8(room.cookie).u16(0).toBytes()),
      ]),
    )
    .toBytes();
}

export function encodeRendezvousToHost(cookie: bigint, to: string, tlvs: readonly Tlv[]): Uint8Array {
  return new ByteWriter().u64(cookie).u16(ICBM_CHANNEL_RENDEZVOUS).str8(to).bytes(encodeTlvs(tlvs)).toBytes();
}

export function encodeChatInvite(cookie: bigint, to: string, room: InviteRoom, text: string): Uint8Array {
  return encodeRendezvousToHost(cookie, to, [
    tlv.bytes(ICBM_TLV_RENDEZVOUS, encodeChatInviteFragment(cookie, room, text)),
    tlv.empty(ICBM_TLV_REQUEST_HOST_ACK),
  ]);
}

// The full 26-byte head: the server signs off a client whose channel 2 fragment is shorter.
export function encodeChatInviteCancel(cookie: bigint, to: string): Uint8Array {
  const fragment = rendezvousHead(RDV_TYPE_CANCEL, cookie, CAP_CHAT)
    .bytes(encodeTlvs([tlv.u16(RDV_TLV_CANCEL_REASON, RDV_CANCEL_DECLINED)]))
    .toBytes();
  return encodeRendezvousToHost(cookie, to, [tlv.bytes(ICBM_TLV_RENDEZVOUS, fragment)]);
}

export type ChatInviteCancel = { from: string; fromDisplay: string; cookie: bigint };

export function parseInviteCancel(icbmBody: Uint8Array): ChatInviteCancel | null {
  const b = Buffer.from(icbmBody.buffer, icbmBody.byteOffset, icbmBody.byteLength);
  if (b.length < 10 || b.readUInt16BE(8) !== ICBM_CHANNEL_RENDEZVOUS) return null;
  let fragment: Uint8Array | undefined;
  let display: string;
  try {
    const { info, next } = decodeUserInfo(b, 10);
    display = info.name;
    fragment = findTlv(tolerantTlvs(b.subarray(next)), ICBM_TLV_RENDEZVOUS);
  } catch {
    return null;
  }
  if (!fragment || fragment.length < RDV_FRAGMENT_MIN_BYTES) return null;
  const f = Buffer.from(fragment.buffer, fragment.byteOffset, fragment.byteLength);
  if (f.readUInt16BE(0) !== RDV_TYPE_CANCEL) return null;
  if (!f.subarray(10, 26).equals(Buffer.from(CAP_CHAT))) return null;
  return { from: normalizeScreenName(display), fromDisplay: display, cookie: f.readBigUInt64BE(2) };
}

export function decodeIcbmParams(body: Uint8Array): {
  maxSlots: number;
  flags: number;
  maxIncomingLength: number;
  maxSourceEvil: number;
  maxDestinationEvil: number;
  minInterval: number;
} {
  const r = new ByteReader(body);
  const maxSlots = r.u16();
  const flags = r.u32();
  const maxIncomingLength = r.u16();
  const maxSourceEvil = r.u16();
  const maxDestinationEvil = r.u16();
  return { maxSlots, flags, maxIncomingLength, maxSourceEvil, maxDestinationEvil, minInterval: r.u32() };
}

export function decodeHostAck(body: Uint8Array): { cookie: bigint; channel: number; screenName: string } {
  const r = new ByteReader(body);
  const cookie = r.u64();
  const channel = r.u16();
  return { cookie, channel, screenName: r.str8() };
}

export function decodeIcbmError(body: Uint8Array): { code: number; subcode?: number } {
  const { code, tlvs } = decodeSnacError(body);
  const subcode = tlvU16(tlvs, ICBM_ERROR_TLV_SUBCODE);
  return subcode === undefined ? { code } : { code, subcode };
}

// u16 0 is a normal warning; 1 is an anonymous one.
export function encodeWarn(screenName: string): Uint8Array {
  return new ByteWriter().u16(0).str8(screenName).toBytes();
}

export function decodeWarnReply(body: Uint8Array): { delta: number; level: number } {
  const r = new ByteReader(body);
  const delta = r.u16();
  return { delta, level: r.u16() };
}

export function decodeTyping(body: Uint8Array): { screenName: string; event: number } {
  const r = new ByteReader(body);
  r.u64();
  r.u16();
  const screenName = r.str8();
  return { screenName, event: r.u16() };
}
