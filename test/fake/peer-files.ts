import { OftError, receiveFiles, sendFiles } from '../../src/client/oft-session.js';
import type { OftFailure, OftSignal } from '../../src/client/oft-session.js';
import type { PeerLink } from '../../src/client/peer-link.js';
import { rendezvousEnded } from '../../src/client/rendezvous.js';
import type { Rendezvous, RendezvousEnd } from '../../src/client/rendezvous.js';
import { ByteWriter } from '../../src/wire/bytes.js';
import { ICBM_CHANNEL_RENDEZVOUS } from '../../src/wire/constants.js';
import { parseRendezvous } from '../../src/wire/rendezvous.js';
import type { FileDescription, RendezvousMessage } from '../../src/wire/rendezvous.js';
import { encodeUserInfo } from '../../src/wire/snac.js';
import { encodeTlvs } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { FileSink, OutgoingFile } from '../../src/model/transfer.js';

/** How one file transfer of a scripted peer ended. `peer` is the other side. */
export type PeerTransfer = {
  peer: string;
  cookie: bigint;
  direction: 'in' | 'out';
  outcome: 'done' | RendezvousEnd['outcome'] | OftFailure;
};
/** One file of a folder: the parts of its path below the folder, and its content. */
export type PeerFolderFile = { path: readonly string[]; bytes: Uint8Array };
export type PeerFilesDeps = {
  /** The one Rendezvous of the peer. Each script of the peer uses it. */
  rendezvous: Rendezvous;
  cookie(): bigint;
  now(): number;
};

const CHUNK_BYTES = 16 * 1024;

/** The file transfers of one scripted peer. It dials the relay only. */
export class PeerFiles {
  private readonly rendezvous: Rendezvous;
  // The cookie of each offer that did not meet the other side yet.
  private readonly waiting = new Set<bigint>();
  private readonly open = new Set<{ signal: OftSignal; link: PeerLink }>();
  private readonly ended: PeerTransfer[] = [];
  private sink: FileSink | null = null;

  constructor(private readonly deps: PeerFilesDeps) {
    this.rendezvous = deps.rendezvous;
  }

  /** Offers one file. The result tells how the transfer ended. */
  offer(to: string, name: string, bytes: Uint8Array): Promise<PeerTransfer> {
    return this.propose(to, { multiple: false, count: 1, totalBytes: bytes.length, name }, [this.source(name, bytes)]);
  }

  /**
   * Offers a folder the way the old clients do. The name in the offer is the folder, with a backslash and a star for 'star'.
   * The name in each header is the path below the folder, with the byte 0x01 between its parts.
   */
  offerFolder(to: string, folder: string, files: readonly PeerFolderFile[], form: 'star' | 'plain'): Promise<PeerTransfer> {
    const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
    const name = form === 'star' ? `${folder}\\*` : folder;
    const sources = files.map((file) => this.source(file.path.join('\u0001'), file.bytes));
    return this.propose(to, { multiple: true, count: files.length, totalBytes, name }, sources);
  }

  private source(name: string, bytes: Uint8Array): OutgoingFile {
    return {
      name,
      bytes: bytes.length,
      modifiedAt: Math.floor(this.deps.now() / 1000),
      read: async function* () {
        for (let at = 0; at < bytes.length; at += CHUNK_BYTES) yield bytes.subarray(at, at + CHUNK_BYTES);
      },
    };
  }

  private async propose(to: string, file: FileDescription, sources: readonly OutgoingFile[]): Promise<PeerTransfer> {
    const cookie = this.deps.cookie();
    const met = await this.met(cookie, this.rendezvous.offer(to, cookie, 'send-file', file));
    return this.move({ peer: to, cookie, direction: 'out' }, met, (link, signal) => sendFiles(link, cookie, sources, () => {}, signal, this.deps.now));
  }

  /** From now on, the peer accepts each Send File offer into the sink. */
  acceptInto(sink: FileSink): void {
    this.sink = sink;
  }

  /** Each transfer that ended, in order. */
  transfers(): PeerTransfer[] {
    return this.ended.map((end) => ({ ...end }));
  }

  /** One channel 2 message that the server delivered to the peer. */
  heard(from: string, tlvs: readonly Tlv[]): void {
    const sender = encodeUserInfo({ name: from, warning: 0, tlvs: [] });
    const message = parseRendezvous(new ByteWriter().u64(0n).u16(ICBM_CHANNEL_RENDEZVOUS).bytes(sender).bytes(encodeTlvs([...tlvs])).toBytes());
    if (!message) return;
    if (message.type !== 'propose' || message.sequence !== 1) this.rendezvous.heard(message);
    else if (this.sink && message.service === 'send-file') void this.receive(message, this.sink);
  }

  /** The client error of the other side for a cookie. */
  refused(cookie: bigint): void {
    this.rendezvous.refused(cookie);
  }

  /** Each file offer ends and each file connection closes. Nothing is sent. */
  reset(): void {
    for (const one of this.open) {
      one.signal.cancelled = true;
      one.link.close();
    }
    for (const cookie of [...this.waiting]) this.rendezvous.refused(cookie);
  }

  private async met(cookie: bigint, meeting: Promise<PeerLink | RendezvousEnd>): Promise<PeerLink | RendezvousEnd> {
    this.waiting.add(cookie);
    try {
      return await meeting;
    } finally {
      this.waiting.delete(cookie);
    }
  }

  private async receive(proposal: RendezvousMessage, sink: FileSink): Promise<void> {
    const cookie = proposal.cookie;
    // The next offer meets the relay when the first file of this one begins, or when this one ends.
    let paired: () => void = () => {};
    const met = await this.met(cookie, this.rendezvous.accept(proposal, new Promise<void>((resolve) => (paired = resolve))));
    const told: FileSink = {
      begin: (file) => {
        paired();
        return sink.begin(file);
      },
    };
    await this.move({ peer: proposal.fromDisplay, cookie, direction: 'in' }, met, (link, signal) =>
      receiveFiles(link, cookie, told, () => {}, signal, this.deps.now),
    );
    paired();
  }

  private async move(
    transfer: Omit<PeerTransfer, 'outcome'>,
    met: PeerLink | RendezvousEnd,
    run: (link: PeerLink, signal: OftSignal) => Promise<void>,
  ): Promise<PeerTransfer> {
    let outcome: PeerTransfer['outcome'] = 'done';
    if (rendezvousEnded(met)) outcome = met.outcome;
    else {
      const one = { signal: { cancelled: false }, link: met };
      this.open.add(one);
      try {
        await run(met, one.signal);
      } catch (error) {
        outcome = error instanceof OftError ? error.failure : 'failed';
      } finally {
        this.open.delete(one);
      }
    }
    const end = { ...transfer, outcome };
    this.ended.push(end);
    return end;
  }
}
