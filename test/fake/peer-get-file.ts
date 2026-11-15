import { readOftFrame } from '../../src/client/oft-session.js';
import type { OftSignal } from '../../src/client/oft-session.js';
import type { PeerLink } from '../../src/client/peer-link.js';
import { rendezvousEnded } from '../../src/client/rendezvous.js';
import type { Rendezvous, RendezvousEnd } from '../../src/client/rendezvous.js';
import { ByteReader, ByteWriter } from '../../src/wire/bytes.js';
import { CAP_GET_FILE, ICBM_CHANNEL_RENDEZVOUS, ICBM_TLV_RENDEZVOUS, RDV_FRAGMENT_MIN_BYTES, RDV_TLV_SERVICE_DATA, RDV_TYPE_PROPOSE } from '../../src/wire/constants.js';
import {
  encodeListing, encodeLst1Listing, listingAck, listingDone, listingHeader, listingLength, readListing, requestedFile,
} from '../../src/wire/listing.js';
import type { ListingEntry } from '../../src/wire/listing.js';
import {
  OFT_ACK, OFT_CHECKSUM_START, OFT_DONE, OFT_FILE_REQUEST, OFT_FLAGS, OFT_FLAG_LST1, OFT_FLAG_RECEIVED, OFT_LISTING, OFT_LISTING_ACK,
  OFT_LISTING_DONE, OFT_LISTING_UNREAD, OFT_PROMPT, answerOftFrame, decodeOftFrame, encodeOftHeader, latin1NameEncoding, oftChecksum,
  sameOftChecksum,
} from '../../src/wire/oft.js';
import type { OftFrame, OftHeader, OftNameForm } from '../../src/wire/oft.js';
import { parseRendezvous } from '../../src/wire/rendezvous.js';
import type { RendezvousMessage } from '../../src/wire/rendezvous.js';
import { encodeUserInfo } from '../../src/wire/snac.js';
import { decodeTlvs, encodeTlvs, tlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { SharedEntry, SharedSource } from '../../src/model/get-file.js';
import type { OutgoingFile } from '../../src/model/transfer.js';
import type { PeerFolderFile } from './peer-files.js';

/** 'serves' accepts each request. 'asks' accepts after `allow`. 'refuses' declines each request. */
export type PeerShareForm = 'serves' | 'asks' | 'refuses';
/**
 * The client that a scripted peer acts as. Each one does what that client did on a Get File connection.
 * '5.1' as holder: the text listing. It closes the connection for an answer that is not its header sent back.
 * '5.1' as requester: a proposal with the number 1. Each answer is the header of the holder sent back. Byte 0x01 divides the parts of a request.
 * '5.9' as holder: the Lst1 listing with the folder name first. After an answer that has bit 0x10 it answers no request and stays open.
 * '5.9' as requester: a proposal with the number 2. A request is a header with only the type, the cookie and the name.
 * It shows a text listing below the header of this kit as an empty list, and sends the type 0x120e after it.
 * '3.5' as requester: as '5.1', with a backslash between the parts of a request. No holder of '3.5' was seen: it is the holder of '5.1'.
 */
export type PeerClient = '5.1' | '5.9' | '3.5';
/** The name of the folder in each path of the listing of a '5.9' holder. */
export const PEER_SHARE_FOLDER = 'share';
/**
 * `firstCookie`: the cookie of the first header, in place of the cookie of the offer.
 * `listing`: the header of the listing has a wrong count of files or a wrong checksum.
 */
export type PeerShareOdd = { firstCookie?: bigint; listing?: 'count' | 'checksum' };
/**
 * `taken`: each file that went out whole, in order. `stop`: the capability goes and each connection closes.
 * `drop`: the holder does not have that file from now on. A listing that went out keeps its line.
 */
export type PeerShare = { taken(): { path: string[]; bytes: number }[]; stop(): void; drop(path: readonly string[]): void };
/**
 * `ack`: 'none' sends no answer to the first listing header. A cookie sends the answer with that cookie.
 * `plain`: that answer does not have bit 0 of the flags. `fresh`: that answer is a new header, not the header of the holder sent back.
 * A holder as strict as AIM 5.1 closes the connection for each `plain` and each `fresh`.
 */
export type PeerBrowseOdd = { ack?: 'none' | bigint; plain?: 'listing-done' | 'file-done'; fresh?: 'listing-ack' | 'file-ack' };
/** One Get File connection that a scripted peer asked for. `outcome` is 'failed' when the connection closed before the first listing. */
export type PeerBrowse = {
  outcome: 'open' | RendezvousEnd['outcome'];
  cookie: bigint;
  /** The listing: each file of the whole shared folder. A path is as the holder wrote it. */
  root: ListingEntry[];
  /** The flags of the header of the listing: bit 0x10 marks the Lst1 form. */
  flags: number;
  /** The bytes of one file. It rejects when the connection ends first: a holder closes it for a name that it does not have. */
  take(path: string[]): Promise<Uint8Array | 'refused'>;
  /** Asks for one file and answers its header with DONE, as a client that has the file. */
  have(path: string[]): Promise<void>;
  /** Sends a request with that name, also a name that the codec refuses. The result is the header that answers. */
  ask(name: string): Promise<OftHeader>;
  sendRaw(header: OftHeader): Promise<void>;
  /** With `ack`: the count of bytes that came after the first listing header. */
  stray(): number;
  /** The connection ended. */
  ended(): boolean;
  close(): void;
};
export type PeerGetFileDeps = {
  /** The one Rendezvous of the peer. Each script of the peer uses it. */
  rendezvous: Rendezvous;
  cookie(): bigint;
  now(): number;
};

type Shared = { tree: PeerFolderFile[]; form: PeerShareForm; odd: PeerShareOdd; client: PeerClient; taken: { path: string[]; bytes: number }[] };

const CHUNK_BYTES = 16 * 1024;
const DIVIDER = '\u0001';
const FLAGS_AT = 100;
const NAME_FIELDS_AT = 188;
const MARK_AT = 120;
const MARK = Uint8Array.of(0x6f, 0x77, 0x6e);
const COUNT_AT = 20;
const FORK_AT = 56;
// The block of tag 0x2711 in a Get File proposal of AIM 5.9: the number 2. Tag 0x2712 follows it.
const LATER_BLOCK = Uint8Array.of(0x00, 0x12, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00);
const LATER_CHARSET_TAG = 0x2712;
// The bytes that an answer can change. They hold the type, the two checksums of the resource fork, and the id text.
// They hold the count and the checksum of the bytes that came too.
const ANSWER_FIELDS: readonly (readonly [number, number])[] = [[6, 8], [44, 48], [56, 100]];

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

// True for the header `own` sent back, as AIM 5.1 sends one back. Bit 0 of the flags can be set. AIM writes the name of a file in its own way.
function sentBack(own: OftFrame, answer: OftFrame, named: boolean): boolean {
  if (own.bytes.length !== answer.bytes.length) return false;
  const end = named ? own.bytes.length : NAME_FIELDS_AT;
  for (let at = 0; at < end; at++) {
    if (ANSWER_FIELDS.some(([from, to]) => at >= from && at < to)) continue;
    const mask = at === FLAGS_AT ? 0xff & ~OFT_FLAG_RECEIVED : 0xff;
    if (((own.bytes[at] ?? 0) & mask) !== ((answer.bytes[at] ?? 0) & mask)) return false;
  }
  return true;
}

// The answer after a listing or after a file, as AIM 5.1 needs it: bit 0 of the flags, the count and the checksum.
function tookAll(answer: OftFrame, bytes: number, checksum: number): boolean {
  const { received, receivedChecksum } = answer.header;
  return (answer.flags & OFT_FLAG_RECEIVED) !== 0 && received === bytes && sameOftChecksum(receivedChecksum, checksum);
}

// A header of the holder with a mark in the bytes that no field uses. A new header does not have the mark, as it does not have the bytes of AIM.
function marked(header: OftHeader, form?: OftNameForm, flags?: number): OftFrame {
  const bytes = encodeOftHeader(header, form, flags);
  bytes.set(MARK, MARK_AT);
  return decodeOftFrame(bytes);
}

// A header as AIM 5.9 writes one that is not an answer: the type, the cookie and the name. Each count, size, time and checksum is zero.
function blank(type: number, cookie: bigint, name: string): Uint8Array {
  const bytes = encodeOftHeader({
    type, cookie, totalFiles: 0, filesLeft: 0, totalParts: 0, partsLeft: 0, totalBytes: 0, bytes: 0, modifiedAt: 0, checksum: 0, received: 0,
    receivedChecksum: OFT_CHECKSUM_START, nameEncoding: latin1NameEncoding(name), name,
  }, 'latin-1');
  bytes.fill(0, FORK_AT, FORK_AT + 2);
  return bytes;
}

// The same header with zero in the count of the files, as AIM 5.9 writes each answer to a listing.
function noCount(frame: OftFrame): OftFrame {
  const bytes = frame.bytes.slice();
  bytes.fill(0, COUNT_AT, COUNT_AT + 2);
  return decodeOftFrame(bytes);
}

// The proposal of a body to the host with the block of AIM 5.9 in the place of the block of this kit.
function laterProposal(body: Uint8Array): Uint8Array {
  const r = new ByteReader(body);
  const head = new ByteWriter().u64(r.u64()).u16(r.u16()).str8(r.str8());
  const outer = decodeTlvs(r.rest()).map((one) => {
    if (one.tag !== ICBM_TLV_RENDEZVOUS) return one;
    const inner = decodeTlvs(one.value.subarray(RDV_FRAGMENT_MIN_BYTES)).map((tag) => (tag.tag === RDV_TLV_SERVICE_DATA ? tlv.bytes(tag.tag, LATER_BLOCK) : tag));
    inner.push(tlv.bytes(LATER_CHARSET_TAG, new Uint8Array(Buffer.from('us-ascii', 'ascii'))));
    return tlv.bytes(one.tag, new ByteWriter().bytes(one.value.subarray(0, RDV_FRAGMENT_MIN_BYTES)).bytes(encodeTlvs(inner)).toBytes());
  });
  return head.bytes(encodeTlvs(outer)).toBytes();
}

// The cookie of a body to the host that is a Get File proposal, or null.
function proposedCookie(body: Uint8Array): bigint | null {
  try {
    const r = new ByteReader(body);
    const cookie = r.u64();
    if (r.u16() !== ICBM_CHANNEL_RENDEZVOUS) return null;
    r.str8();
    const fragment = decodeTlvs(r.rest()).find((one) => one.tag === ICBM_TLV_RENDEZVOUS)?.value;
    if (!fragment || fragment.length < RDV_FRAGMENT_MIN_BYTES) return null;
    const f = new ByteReader(fragment);
    if (f.u16() !== RDV_TYPE_PROPOSE) return null;
    f.u64();
    return CAP_GET_FILE.every((byte, i) => fragment[10 + i] === byte) ? cookie : null;
  } catch {
    return null;
  }
}

// The same header without bit 0 of the flags.
function plain(frame: OftFrame): OftFrame {
  const bytes = frame.bytes.slice();
  bytes[FLAGS_AT] = (bytes[FLAGS_AT] ?? 0) & ~OFT_FLAG_RECEIVED;
  return decodeOftFrame(bytes);
}

function below(path: readonly string[], folder: readonly string[]): boolean {
  return path.length > folder.length && folder.every((part, i) => path[i] === part);
}

// The entries of one folder of the tree, or null when the tree has no such folder.
function entriesOf(tree: readonly PeerFolderFile[], folder: readonly string[], modifiedAt: number): SharedEntry[] | null {
  const inside = tree.filter((file) => below(file.path, folder));
  if (folder.length > 0 && inside.length === 0) return null;
  const files = inside.filter((file) => file.path.length === folder.length + 1);
  const folders = new Set(inside.filter((file) => file.path.length > folder.length + 1).map((file) => file.path[folder.length] as string));
  return [
    ...files.map((file) => ({ path: [...file.path], folder: false, bytes: file.bytes.length, modifiedAt })),
    ...[...folders].map((name) => ({ path: [...folder, name], folder: true, bytes: 0, modifiedAt })),
  ];
}

function outgoing(file: PeerFolderFile, name: string, modifiedAt: number): OutgoingFile {
  const { bytes } = file;
  return {
    name,
    bytes: bytes.length,
    modifiedAt,
    read: async function* () {
      for (let at = 0; at < bytes.length; at += CHUNK_BYTES) yield bytes.subarray(at, at + CHUNK_BYTES);
    },
  };
}

/** A source in memory with the files of the tree. `modifiedAt` is the date of each entry, in seconds. */
export function treeSource(tree: readonly PeerFolderFile[], modifiedAt = 0): SharedSource {
  return {
    list: async (folder) => entriesOf(tree, folder, modifiedAt),
    open: async (path) => {
      const file = tree.find((held) => samePath(held.path, path));
      return file ? outgoing(file, path[path.length - 1] ?? '', modifiedAt) : null;
    },
  };
}

/** The shared files of one scripted peer. It dials the relay only, and it speaks first on each connection. */
export class PeerGetFile {
  private readonly rendezvous: Rendezvous;
  private readonly open = new Set<{ signal: OftSignal; link: PeerLink }>();
  private readonly asking = new Set<PeerLink>();
  // The cookies of the offers that have the proposal of AIM 5.9.
  private readonly later = new Set<bigint>();
  // The requests of the form 'asks' that wait for `allow`.
  private asked: RendezvousMessage[] = [];
  private shared: Shared | null = null;

  constructor(private readonly deps: PeerGetFileDeps) {
    this.rendezvous = deps.rendezvous;
  }

  /** From now on, the peer answers each Get File request with the files of the tree, as the holder of `client`. */
  share(tree: readonly PeerFolderFile[], form: PeerShareForm, odd: PeerShareOdd, client: PeerClient = '5.1'): PeerShare {
    const shared: Shared = { tree: [...tree], form, odd, client, taken: [] };
    this.shared = shared;
    return {
      taken: () => shared.taken.map((one) => ({ path: [...one.path], bytes: one.bytes })),
      drop: (path) => {
        shared.tree = shared.tree.filter((held) => !samePath(held.path, path));
      },
      stop: () => {
        if (this.shared === shared) this.reset();
      },
    };
  }

  /** Asks a member for its files, as the requester of `client`. The result comes when the first listing came or the offer ended. */
  async browse(to: string, odd: PeerBrowseOdd, client: PeerClient = '5.1'): Promise<PeerBrowse> {
    const cookie = this.deps.cookie();
    if (client === '5.9') this.later.add(cookie);
    return this.requested(cookie, await this.rendezvous.offer(to, cookie, 'get-file', null), odd, client);
  }

  /** A body that the Rendezvous of the peer sends, as the client of the offer writes it. The owner of the Rendezvous calls this for each body. */
  outgoing(body: Uint8Array): Uint8Array {
    const cookie = proposedCookie(body);
    return cookie !== null && this.later.has(cookie) ? laterProposal(body) : body;
  }

  /** Accepts each request that waits. */
  allow(): void {
    const shared = this.shared;
    if (!shared) return;
    for (const proposal of this.asked.splice(0)) void this.serve(proposal, shared);
  }

  /** One channel 2 message that the server delivered to the peer. */
  heard(from: string, tlvs: readonly Tlv[]): void {
    const sender = encodeUserInfo({ name: from, warning: 0, tlvs: [] });
    const message = parseRendezvous(new ByteWriter().u64(0n).u16(ICBM_CHANNEL_RENDEZVOUS).bytes(sender).bytes(encodeTlvs([...tlvs])).toBytes());
    if (message?.service !== 'get-file') return;
    if (message.type !== 'propose' || message.sequence !== 1) {
      if (message.type === 'cancel') this.asked = this.asked.filter((proposal) => proposal.cookie !== message.cookie);
      this.rendezvous.heard(message);
      return;
    }
    const shared = this.shared;
    if (!shared) return;
    if (shared.form === 'refuses') void this.rendezvous.decline(message).catch(() => {});
    else if (shared.form === 'asks') this.asked.push(message);
    else void this.serve(message, shared);
  }

  /** The client error of the other side for a cookie. */
  refused(cookie: bigint): void {
    this.rendezvous.refused(cookie);
  }

  /** The sharing stops and each Get File connection closes. Nothing is sent. */
  reset(): void {
    this.shared = null;
    this.asked = [];
    for (const one of this.open) {
      one.signal.cancelled = true;
      one.link.close();
    }
    for (const link of this.asking) link.close();
    this.asking.clear();
    this.later.clear();
  }

  private async requested(cookie: bigint, met: PeerLink | RendezvousEnd, odd: PeerBrowseOdd, client: PeerClient): Promise<PeerBrowse> {
    const later = client === '5.9';
    const divider = client === '3.5' ? '\\' : DIVIDER;
    const link = rendezvousEnded(met) ? null : met;
    let over = link === null;
    let stray = 0;
    const end = (): void => {
      over = true;
      link?.close();
    };
    // Each read that fails ends the connection.
    const guarded = async <T>(run: (link: PeerLink) => Promise<T>): Promise<T> => {
      if (!link || over) throw new Error('the connection is not open');
      try {
        return await run(link);
      } catch (error) {
        end();
        throw error;
      }
    };
    const header = async (from: PeerLink): Promise<OftFrame> => {
      const read = await readOftFrame(from);
      if (read.header.cookie !== cookie) throw new Error('the holder did not show the cookie');
      return read;
    };
    // The last answer that the peer wrote. A request is made from it, as AIM 5.1 makes one.
    let last: OftFrame | null = null;
    // The answers and the body of the listing that `first` announces. AIM 5.1 closes for a count or a checksum that is wrong.
    const listing = async (from: PeerLink, first: OftFrame): Promise<ListingEntry[]> => {
      const ack = later ? noCount(listingAck(first)) : listingAck(first);
      await from.write(odd.fresh === 'listing-ack' ? encodeOftHeader({ ...first.header, type: OFT_LISTING_ACK }) : ack.bytes);
      const length = listingLength(first.header);
      const body = length > 0 ? await from.read(length) : new Uint8Array(0);
      // AIM 5.9 showed the text listing of this kit as an empty list. The older clients read the two forms.
      const unread = later && (first.flags & OFT_FLAG_LST1) === 0;
      const { entries } = unread ? { entries: [] } : readListing(first, body, Number.MAX_SAFE_INTEGER);
      if (!unread && entries.length !== first.header.totalFiles) throw new Error('the count of the listing is wrong');
      if (!sameOftChecksum(oftChecksum(body), first.header.checksum)) throw new Error('the checksum of the listing is wrong');
      last = later ? noCount(listingDone(first, body)) : listingDone(first, body);
      if (odd.plain === 'listing-done') last = plain(last);
      await from.write(last.bytes);
      if (unread) await from.write(blank(OFT_LISTING_UNREAD, cookie, ''));
      return entries;
    };
    const request = async (from: PeerLink, name: string): Promise<void> => {
      if (!last) throw new Error('no listing came');
      await from.write(later ? blank(OFT_FILE_REQUEST, cookie, name) : answerOftFrame(last, { type: OFT_FILE_REQUEST, name }).bytes);
    };
    // The file that `first` announces. Each answer is that header sent back.
    const file = async (from: PeerLink, first: OftFrame): Promise<Uint8Array> => {
      await from.write(odd.fresh === 'file-ack' ? encodeOftHeader({ ...first.header, type: OFT_ACK }) : answerOftFrame(first, { type: OFT_ACK }).bytes);
      const { bytes, checksum } = first.header;
      const data = bytes > 0 ? await from.read(bytes) : new Uint8Array(0);
      if (!sameOftChecksum(oftChecksum(data), checksum)) throw new Error('the checksum of the file is wrong');
      last = answerOftFrame(first, { type: OFT_DONE, received: { bytes: data.length, checksum: oftChecksum(data) } });
      if (odd.plain === 'file-done') last = plain(last);
      await from.write(last.bytes);
      return data;
    };
    const one: PeerBrowse = {
      outcome: rendezvousEnded(met) ? met.outcome : 'open',
      cookie,
      root: [],
      flags: 0,
      take: (path) => guarded(async (from) => {
        await request(from, path.join(divider));
        const first = await header(from);
        if (first.header.type !== OFT_PROMPT) return 'refused';
        return file(from, first);
      }),
      have: (path) => guarded(async (from) => {
        await request(from, path.join(divider));
        const first = await header(from);
        if (first.header.type !== OFT_PROMPT) throw new Error('the holder did not send the file');
        await from.write(answerOftFrame(first, { type: OFT_DONE }).bytes);
      }),
      ask: (name) => guarded(async (from) => {
        await request(from, name);
        return (await header(from)).header;
      }),
      sendRaw: (raw) => guarded((from) => from.write(encodeOftHeader(raw))),
      stray: () => stray,
      ended: () => over || link?.closed === true,
      close: end,
    };
    if (!link) return one;
    this.asking.add(link);
    try {
      const first = await header(link);
      if (first.header.type !== OFT_LISTING) throw new Error('the holder did not send a listing');
      one.flags = first.flags;
      if (odd.ack === undefined) {
        one.root = await listing(link, first);
        return one;
      }
      if (odd.ack !== 'none') await link.write(encodeOftHeader({ ...listingAck(first).header, cookie: odd.ack }));
    } catch {
      end();
      return { ...one, outcome: 'failed' };
    }
    // Each byte that comes now is a byte that the holder had to keep.
    void (async () => {
      try {
        for (;;) {
          const piece = await link.readSome(64 * 1024);
          if (piece === null) break;
          stray += piece.length;
        }
      } catch {
        // The connection is over.
      }
      end();
    })();
    return one;
  }

  private async serve(proposal: RendezvousMessage, shared: Shared): Promise<void> {
    // The next offer meets the relay when the requester showed the cookie, or when this connection ended.
    let paired: () => void = () => {};
    const met = await this.rendezvous.accept(proposal, new Promise<void>((resolve) => (paired = resolve)));
    if (rendezvousEnded(met) || this.shared !== shared) {
      if (!rendezvousEnded(met)) met.close();
      paired();
      return;
    }
    const one = { signal: { cancelled: false }, link: met };
    this.open.add(one);
    try {
      if (shared.client === '5.9') await this.serveLater(one, proposal.cookie, shared, paired);
      else {
        await this.listing(met, proposal.cookie, shared, paired);
        for (;;) await this.request(one, proposal.cookie, shared);
      }
    } catch {
      // The connection is over.
    } finally {
      paired();
      met.close();
      this.open.delete(one);
    }
  }

  // One listing holds each file of the tree. No byte of it goes out before the requester shows the cookie.
  // The holder is as strict as AIM 5.1. Each answer is its own header sent back.
  // The answer after the listing has bit 0, the count and the checksum.
  private async listing(link: PeerLink, cookie: bigint, shared: Shared, paired: () => void): Promise<void> {
    const now = Math.floor(this.deps.now() / 1000);
    const listing = encodeListing(shared.tree.map((file) => ({ path: file.path, bytes: file.bytes.length, modifiedAt: now })));
    const header = listingHeader(shared.odd.firstCookie ?? cookie, listing, now);
    if (shared.odd.listing === 'count') header.totalFiles += 1;
    if (shared.odd.listing === 'checksum') header.checksum = (header.checksum ^ 0x0001_0000) >>> 0;
    const own = marked(header);
    await link.write(own.bytes);
    const ack = await readOftFrame(link);
    if (ack.header.cookie !== cookie || ack.header.type !== OFT_LISTING_ACK) throw new Error('the requester did not show the cookie');
    paired();
    if (!sentBack(own, ack, true)) throw new Error('the answer is not the header of the listing sent back');
    await link.write(listing.bytes);
    const done = await readOftFrame(link);
    if (done.header.cookie !== cookie || done.header.type !== OFT_LISTING_DONE) throw new Error('the requester did not take the listing');
    if (!sentBack(own, done, true) || !tookAll(done, listing.bytes.length, oftChecksum(listing.bytes))) throw new Error('the answer after the listing is not as AIM needs it');
  }

  // The holder of '5.9': the Lst1 listing, then one file for each request. It does not compare an answer with its own header.
  // After an answer to the listing that has bit 0x10 it reads each request and answers none.
  // A name that is not in the listing ends the connection. That case was not seen with AIM 5.9.
  private async serveLater(one: { signal: OftSignal; link: PeerLink }, cookie: bigint, shared: Shared, paired: () => void): Promise<void> {
    const { link, signal } = one;
    const now = Math.floor(this.deps.now() / 1000);
    const listing = encodeLst1Listing(shared.tree.map((file) => ({ path: file.path, bytes: file.bytes.length, modifiedAt: now })), PEER_SHARE_FOLDER);
    const header = listingHeader(shared.odd.firstCookie ?? cookie, listing, now);
    if (shared.odd.listing === 'count') header.totalFiles += 1;
    if (shared.odd.listing === 'checksum') header.checksum = (header.checksum ^ 0x0001_0000) >>> 0;
    await link.write(encodeOftHeader(header, 'utf-8', OFT_FLAGS | OFT_FLAG_LST1));
    const ack = await readOftFrame(link);
    if (ack.header.cookie !== cookie || ack.header.type !== OFT_LISTING_ACK) throw new Error('the requester did not show the cookie');
    paired();
    await link.write(listing.bytes);
    const done = await readOftFrame(link);
    if (done.header.cookie !== cookie || done.header.type !== OFT_LISTING_DONE) throw new Error('the requester did not take the listing');
    const silent = ((ack.flags | done.flags) & OFT_FLAG_LST1) !== 0;
    for (;;) {
      const request = await readOftFrame(link);
      if (request.header.cookie !== cookie) throw new Error('the header does not have the cookie');
      if (silent) continue;
      const asked = requestedFile(request);
      const path = asked?.path[0] === PEER_SHARE_FOLDER ? asked.path.slice(1) : null;
      const file = path && shared.tree.find((held) => samePath(held.path, path));
      if (!asked || !path || !file) throw new Error('the name is not in the listing');
      const data = file.bytes;
      await link.write(encodeOftHeader({
        type: OFT_PROMPT, cookie, totalFiles: 1, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: data.length, bytes: data.length,
        modifiedAt: now, checksum: oftChecksum(data), received: 0, receivedChecksum: OFT_CHECKSUM_START,
        nameEncoding: latin1NameEncoding(asked.name), name: asked.name,
      }, 'latin-1'));
      const answer = await readOftFrame(link);
      if (answer.header.cookie !== cookie) throw new Error('the header does not have the cookie');
      if (answer.header.type === OFT_DONE) continue;
      if (answer.header.type !== OFT_ACK) throw new Error('the header is not an answer to the file');
      for (let at = 0; at < data.length; at += CHUNK_BYTES) {
        if (signal.cancelled) throw new Error('the sharing stopped');
        await link.write(data.subarray(at, at + CHUNK_BYTES));
      }
      const end = await readOftFrame(link);
      if (end.header.cookie !== cookie || end.header.type !== OFT_DONE) throw new Error('the requester did not take the file');
      shared.taken.push({ path: [...path], bytes: data.length });
    }
  }

  // One request: a file goes out. A name that is not in the tree ends the connection, and nothing is sent.
  private async request(one: { signal: OftSignal; link: PeerLink }, cookie: bigint, shared: Shared): Promise<void> {
    const { link, signal } = one;
    const request = await readOftFrame(link);
    if (request.header.cookie !== cookie || request.header.type !== OFT_FILE_REQUEST) throw new Error('the header is not a request');
    const path = requestedFile(request)?.path ?? null;
    const file = path && shared.tree.find((held) => samePath(held.path, path));
    if (!path || !file) throw new Error('the name is not in the tree');
    const data = file.bytes;
    const name = path.join(DIVIDER);
    const own = marked({
      type: OFT_PROMPT, cookie, totalFiles: 1, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: data.length, bytes: data.length,
      modifiedAt: Math.floor(this.deps.now() / 1000), checksum: oftChecksum(data), received: 0, receivedChecksum: OFT_CHECKSUM_START,
      nameEncoding: latin1NameEncoding(name), name,
    }, 'latin-1');
    await link.write(own.bytes);
    // AIM writes the name of a file in its own way in each answer, thus the name is not compared.
    const ack = await readOftFrame(link);
    if (ack.header.cookie !== cookie || !sentBack(own, ack, false)) throw new Error('the answer is not the header of the file sent back');
    // A requester that has the file answers DONE and takes no byte.
    if (ack.header.type === OFT_DONE) return;
    if (ack.header.type !== OFT_ACK) throw new Error('the header is not an answer to the file');
    for (let at = 0; at < data.length; at += CHUNK_BYTES) {
      if (signal.cancelled) throw new Error('the sharing stopped');
      await link.write(data.subarray(at, at + CHUNK_BYTES));
    }
    const done = await readOftFrame(link);
    if (done.header.cookie !== cookie || done.header.type !== OFT_DONE) throw new Error('the requester did not take the file');
    if (!sentBack(own, done, false) || !tookAll(done, data.length, oftChecksum(data))) throw new Error('the answer after the file is not as AIM needs it');
    shared.taken.push({ path: [...path], bytes: data.length });
  }
}
