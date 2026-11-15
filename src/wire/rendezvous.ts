import { ByteReader, ByteWriter } from './bytes.js';
import {
  CAPABILITY_LENGTH,
  CAP_DIRECT_IM,
  CAP_GET_FILE,
  CAP_SEND_FILE,
  ICBM_CHANNEL_RENDEZVOUS,
  ICBM_TLV_RENDEZVOUS,
  ICBM_TLV_REQUEST_HOST_ACK,
  MAX_OFFER_BYTES,
  RDV_FILE_ONE,
  RDV_FILE_GET, RDV_FILE_SEVERAL,
  RDV_FRAGMENT_MIN_BYTES,
  RDV_TLV_CANCEL_REASON,
  RDV_TLV_CHARSET,
  RDV_TLV_INVITATION,
  RDV_TLV_IP_XOR,
  RDV_TLV_PORT,
  RDV_TLV_PORT_XOR,
  RDV_TLV_RDV_IP,
  RDV_TLV_REQUESTER_IP,
  RDV_TLV_REQUEST_HOST_CHECK,
  RDV_TLV_SEQUENCE,
  RDV_TLV_SERVICE_DATA,
  RDV_TLV_USE_PROXY,
  RDV_TLV_VERIFIED_IP,
  RDV_TYPE_ACCEPT,
  RDV_TYPE_CANCEL,
  RDV_TYPE_PROPOSE,
} from './constants.js';
import { encodeRendezvousToHost, rendezvousHead, tolerantTlvs } from './icbm.js';
import { decodeUserInfo } from './snac.js';
import { decodeWireText, normalizeScreenName } from './text.js';
import { encodeTlvs, findTlv, hasTlv, tlv, tlvU16 } from './tlv.js';
import type { Tlv } from './tlv.js';

export type RendezvousService = 'send-file' | 'direct-im' | 'get-file';
export type PeerAddress = { ip: string; port: number };
export type FileDescription = { multiple: boolean; count: number; totalBytes: number; name: string };
export type RendezvousMessage = {
  from: string;
  fromDisplay: string;
  cookie: bigint;
  service: RendezvousService;
  type: 'propose' | 'cancel' | 'accept';
  sequence: number | null;
  address: PeerAddress | null;
  useProxy: boolean;
  cancelReason: number | null;
  file: FileDescription | null;
  invitation: string | null;
};

const SERVICES: readonly [RendezvousService, Uint8Array][] = [
  ['send-file', CAP_SEND_FILE],
  ['direct-im', CAP_DIRECT_IM],
  ['get-file', CAP_GET_FILE],
];

const TYPES: Record<number, RendezvousMessage['type']> = {
  [RDV_TYPE_PROPOSE]: 'propose',
  [RDV_TYPE_CANCEL]: 'cancel',
  [RDV_TYPE_ACCEPT]: 'accept',
};

// The first tag that is present wins.
const ADDRESS_TAGS = [RDV_TLV_VERIFIED_IP, RDV_TLV_REQUESTER_IP, RDV_TLV_RDV_IP];
const FILE_BLOCK_HEAD_BYTES = 8;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function serviceOf(capability: Uint8Array): RendezvousService | null {
  return SERVICES.find(([, bytes]) => sameBytes(bytes, capability))?.[0] ?? null;
}

export function capabilityOf(service: RendezvousService): Uint8Array {
  const found = SERVICES.find(([name]) => name === service);
  if (!found) throw new RangeError(`unknown service ${String(service)}`);
  return found[1];
}

function readAddress(inner: readonly Tlv[]): PeerAddress | null {
  const tag = ADDRESS_TAGS.find((t) => hasTlv(inner, t));
  const ip = tag === undefined ? undefined : findTlv(inner, tag);
  const port = tlvU16(inner, RDV_TLV_PORT);
  if (ip?.length !== 4 || !port || ip.every((byte) => byte === 0)) return null;
  return { ip: ip.join('.'), port };
}

function readFile(data: Uint8Array | undefined): FileDescription | null {
  if (!data || data.length < FILE_BLOCK_HEAD_BYTES) return null;
  const r = new ByteReader(data);
  const kind = r.u16();
  const count = r.u16();
  const totalBytes = r.u32();
  const rest = r.rest();
  const end = rest.indexOf(0);
  const name = decodeWireText(end < 0 ? rest : rest.subarray(0, end), undefined);
  return { multiple: kind === RDV_FILE_SEVERAL, count, totalBytes, name };
}

// The "several" kind names a folder. Some clients put a backslash and a star after the name.
export function offeredFolder(file: FileDescription | null): string | null {
  if (!file?.multiple) return null;
  const name = file.name.replace(/[\\/]\*$/, '');
  return name === '' ? null : name;
}

// The sender's name and the fragment of a channel 2 message, or null when the fragment has no full head.
function fragmentOf(icbmBody: Uint8Array): { display: string; fragment: Uint8Array } | null {
  const b = asBuffer(icbmBody);
  if (b.length < 10 || b.readUInt16BE(8) !== ICBM_CHANNEL_RENDEZVOUS) return null;
  try {
    const { info, next } = decodeUserInfo(b, 10);
    const fragment = findTlv(tolerantTlvs(b.subarray(next)), ICBM_TLV_RENDEZVOUS);
    return fragment && fragment.length >= RDV_FRAGMENT_MIN_BYTES ? { display: info.name, fragment } : null;
  } catch {
    return null;
  }
}

// The capability a channel 2 message names, or null when it has none to read.
export function rendezvousCapability(icbmBody: Uint8Array): Uint8Array | null {
  return fragmentOf(icbmBody)?.fragment.subarray(10, 10 + CAPABILITY_LENGTH) ?? null;
}

// The result is null for a room invitation, for an unknown service and for a damaged message.
export function parseRendezvous(icbmBody: Uint8Array): RendezvousMessage | null {
  const found = fragmentOf(icbmBody);
  if (!found) return null;
  const { display, fragment } = found;
  const f = asBuffer(fragment);
  const type = TYPES[f.readUInt16BE(0)];
  const service = serviceOf(f.subarray(10, 10 + CAPABILITY_LENGTH));
  if (!type || !service) return null;
  const inner = tolerantTlvs(f.subarray(RDV_FRAGMENT_MIN_BYTES));
  const charset = findTlv(inner, RDV_TLV_CHARSET);
  const text = findTlv(inner, RDV_TLV_INVITATION);
  return {
    from: normalizeScreenName(display),
    fromDisplay: display,
    cookie: f.readBigUInt64BE(2),
    service,
    type,
    sequence: tlvU16(inner, RDV_TLV_SEQUENCE) ?? null,
    address: readAddress(inner),
    useProxy: hasTlv(inner, RDV_TLV_USE_PROXY),
    cancelReason: type === 'cancel' ? (tlvU16(inner, RDV_TLV_CANCEL_REASON) ?? null) : null,
    file: readFile(findTlv(inner, RDV_TLV_SERVICE_DATA)),
    invitation: text ? decodeWireText(text, charset ? Buffer.from(charset).toString('ascii') : undefined) : null,
  };
}

function ipBytes(ip: string): Uint8Array {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)?.slice(1).map(Number) ?? [];
  if (parts.length !== 4 || parts.some((part) => part > 0xff)) throw new RangeError('the address is not IPv4');
  return Uint8Array.from(parts);
}

function inverted(bytes: Uint8Array): Uint8Array {
  return bytes.map((byte) => byte ^ 0xff);
}

function isCount(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function fileBlock(file: FileDescription): Uint8Array {
  if (!isCount(file.count, 0xffff) || file.count === 0) throw new RangeError('the file count is out of range');
  if (!isCount(file.totalBytes, MAX_OFFER_BYTES)) throw new RangeError('the offer is larger than the limit');
  return new ByteWriter()
    .u16(file.multiple ? RDV_FILE_SEVERAL : RDV_FILE_ONE)
    .u16(file.count)
    .u32(file.totalBytes)
    .bytes(new Uint8Array(Buffer.from(file.name, 'utf8')))
    .u8(0)
    .toBytes();
}

// The address tags in the order a proposal carries them.
function addressTlvs(address: PeerAddress): Tlv[] {
  const ip = ipBytes(address.ip);
  if (!isCount(address.port, 0xffff)) throw new RangeError('the port is out of range');
  const port = new ByteWriter().u16(address.port).toBytes();
  return [
    tlv.bytes(RDV_TLV_RDV_IP, ip),
    tlv.bytes(RDV_TLV_IP_XOR, inverted(ip)),
    tlv.bytes(RDV_TLV_REQUESTER_IP, ip),
    tlv.bytes(RDV_TLV_PORT, port),
    tlv.bytes(RDV_TLV_PORT_XOR, inverted(port)),
  ];
}

function encodeProposal(cookie: bigint, to: string, capability: Uint8Array, inner: readonly Tlv[]): Uint8Array {
  const fragment = rendezvousHead(RDV_TYPE_PROPOSE, cookie, capability).bytes(encodeTlvs(inner)).toBytes();
  return encodeRendezvousToHost(cookie, to, [tlv.bytes(ICBM_TLV_RENDEZVOUS, fragment), tlv.empty(ICBM_TLV_REQUEST_HOST_ACK)]);
}

export function encodeFileProposal(
  cookie: bigint,
  to: string,
  p: { sequence: 1 | 2; address: PeerAddress; file: FileDescription; invitation?: string },
): Uint8Array {
  const address = addressTlvs(p.address);
  const inner: Tlv[] = [tlv.u16(RDV_TLV_SEQUENCE, p.sequence), tlv.empty(RDV_TLV_REQUEST_HOST_CHECK)];
  if (p.invitation !== undefined) inner.push(tlv.str(RDV_TLV_INVITATION, p.invitation));
  inner.push(...address, tlv.bytes(RDV_TLV_SERVICE_DATA, fileBlock(p.file)));
  return encodeProposal(cookie, to, CAP_SEND_FILE, inner);
}

// A proposal with no file block: the sequence, the check request and the address.
function addressOnly(p: { sequence: 1 | 2; address: PeerAddress }): Tlv[] {
  return [tlv.u16(RDV_TLV_SEQUENCE, p.sequence), tlv.empty(RDV_TLV_REQUEST_HOST_CHECK), ...addressTlvs(p.address)];
}

// A Direct IM proposal has no file block.
export function encodeDirectImProposal(cookie: bigint, to: string, p: { sequence: 1 | 2; address: PeerAddress }): Uint8Array {
  return encodeProposal(cookie, to, CAP_DIRECT_IM, addressOnly(p));
}

// The 12 bytes of tag 0x2711 in a Get File proposal: the kind, the number 1 and zeros. A client can stop when the tag is absent.
function getFileBlock(): Uint8Array {
  return new ByteWriter().u16(RDV_FILE_GET).u16(1).u32(0).u32(0).toBytes();
}

/**
 * The number of a Get File proposal: the second field of tag 0x2711. AIM 5.1 writes 1 and AIM 5.9 writes 2.
 * The result is null for a message that is not a Get File proposal.
 * It is null also for a tag that is absent or has less than 4 bytes.
 */
export function getFileProposalNumber(icbmBody: Uint8Array): number | null {
  const fragment = fragmentOf(icbmBody)?.fragment;
  if (!fragment) return null;
  const f = asBuffer(fragment);
  if (f.readUInt16BE(0) !== RDV_TYPE_PROPOSE || serviceOf(f.subarray(10, 10 + CAPABILITY_LENGTH)) !== 'get-file') return null;
  const block = findTlv(tolerantTlvs(f.subarray(RDV_FRAGMENT_MIN_BYTES)), RDV_TLV_SERVICE_DATA);
  return block && block.length >= 4 ? asBuffer(block).readUInt16BE(2) : null;
}

export function encodeGetFileProposal(cookie: bigint, to: string, p: { sequence: 1 | 2; address: PeerAddress }): Uint8Array {
  return encodeProposal(cookie, to, CAP_GET_FILE, [...addressOnly(p), tlv.bytes(RDV_TLV_SERVICE_DATA, getFileBlock())]);
}

export function encodeRendezvousAccept(cookie: bigint, to: string, service: RendezvousService): Uint8Array {
  const fragment = rendezvousHead(RDV_TYPE_ACCEPT, cookie, capabilityOf(service)).toBytes();
  return encodeRendezvousToHost(cookie, to, [tlv.bytes(ICBM_TLV_RENDEZVOUS, fragment)]);
}

// The server signs off a client that sends a fragment shorter than the 26-byte head.
export function encodeRendezvousCancel(cookie: bigint, to: string, service: RendezvousService, reason: number): Uint8Array {
  const fragment = rendezvousHead(RDV_TYPE_CANCEL, cookie, capabilityOf(service))
    .bytes(encodeTlvs([tlv.u16(RDV_TLV_CANCEL_REASON, reason)]))
    .toBytes();
  return encodeRendezvousToHost(cookie, to, [tlv.bytes(ICBM_TLV_RENDEZVOUS, fragment)]);
}

export function decodeClientError(body: Uint8Array): { cookie: bigint; channel: number; screenName: string; code: number } {
  const r = new ByteReader(body);
  const cookie = r.u64();
  const channel = r.u16();
  const screenName = r.str8();
  return { cookie, channel, screenName, code: r.u16() };
}
