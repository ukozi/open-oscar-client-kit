// BART (0x10): buddy icons, as open-oscar-server wire/snacs.go BARTInfo, BARTID and SNAC_0x10_*.
import { ByteReader, ByteWriter } from './bytes.js';
import { USER_INFO_BART } from './constants.js';
import type { UserInfo } from './snac.js';
import { findTlv } from './tlv.js';

export const FAMILY_BART = 0x0010;

export const BART_ERR = 0x0001;
export const BART_UPLOAD = 0x0002;
export const BART_UPLOAD_REPLY = 0x0003;
export const BART_DOWNLOAD = 0x0004;
export const BART_DOWNLOAD_REPLY = 0x0005;

export const BART_TYPE_BUDDY_ICON = 0x0001;

export const BART_FLAG_CUSTOM = 0x01;
export const BART_FLAG_UNKNOWN = 0x40;

// The hash that stands for "no icon" (wire/snacs.go GetClearIconHash).
export const BART_CLEAR_HASH: Uint8Array = Uint8Array.of(0x02, 0x01, 0xd2, 0x04, 0x72);

export const BART_DATA_MAX = 0xffff;

const BART_DOWNLOAD_COMMAND = 0x01;
const BART_ID_HEAD_BYTES = 4;
const BART_HASH_MAX = 0xff;

export type BartId = { type: number; flags: number; hash: Uint8Array };

function writeBartInfo(w: ByteWriter, flags: number, hash: Uint8Array): ByteWriter {
  if (hash.length > BART_HASH_MAX) throw new RangeError('BART hash longer than 255 bytes');
  return w.u8(flags).u8(hash.length).bytes(hash);
}

export function encodeBartId(id: BartId): Uint8Array {
  return writeBartInfo(new ByteWriter().u16(id.type), id.flags, id.hash).toBytes();
}

export function readBartId(r: ByteReader): BartId {
  const type = r.u16();
  const flags = r.u8();
  return { type, flags, hash: r.bytes(r.u8()) };
}

/** The value of user info TLV 0x1D. An entry cut short ends the list at the cut; nothing throws. */
export function decodeBartIds(value: Uint8Array): BartId[] {
  const r = new ByteReader(value);
  const out: BartId[] = [];
  while (r.remaining >= BART_ID_HEAD_BYTES) {
    const type = r.u16();
    const flags = r.u8();
    const length = r.u8();
    if (r.remaining < length) break;
    out.push({ type, flags, hash: r.bytes(length) });
  }
  return out;
}

export function userIcon(info: UserInfo): BartId | null {
  const value = findTlv(info.tlvs, USER_INFO_BART);
  if (!value) return null;
  return decodeBartIds(value).find((id) => id.type === BART_TYPE_BUDDY_ICON) ?? null;
}

export function isClearHash(hash: Uint8Array): boolean {
  return hash.length === BART_CLEAR_HASH.length && hash.every((byte, i) => byte === BART_CLEAR_HASH[i]);
}

export function encodeBartInfo(flags: number, hash: Uint8Array): Uint8Array {
  return writeBartInfo(new ByteWriter(), flags, hash).toBytes();
}

export function decodeBartInfo(value: Uint8Array): { flags: number; hash: Uint8Array } | null {
  const r = new ByteReader(value);
  if (r.remaining < 2) return null;
  const flags = r.u8();
  const length = r.u8();
  return r.remaining < length ? null : { flags, hash: r.bytes(length) };
}

export function decodeBartNotice(body: Uint8Array): BartId {
  return readBartId(new ByteReader(body));
}

export function encodeBartUpload(type: number, data: Uint8Array): Uint8Array {
  if (data.length > BART_DATA_MAX) throw new RangeError('BART data longer than 65535 bytes');
  return new ByteWriter().u16(type).u16(data.length).bytes(data).toBytes();
}

export function decodeBartUploadReply(body: Uint8Array): { code: number; id: BartId } {
  const r = new ByteReader(body);
  const code = r.u8();
  return { code, id: readBartId(r) };
}

export function encodeBartDownload(screenName: string, id: BartId): Uint8Array {
  return new ByteWriter().str8(screenName).u8(BART_DOWNLOAD_COMMAND).bytes(encodeBartId(id)).toBytes();
}

// The data is empty when the server holds no bytes for the id.
export function decodeBartDownloadReply(body: Uint8Array): { screenName: string; id: BartId; data: Uint8Array } {
  const r = new ByteReader(body);
  const screenName = r.str8();
  const id = readBartId(r);
  return { screenName, id, data: r.bytes(r.u16()) };
}
