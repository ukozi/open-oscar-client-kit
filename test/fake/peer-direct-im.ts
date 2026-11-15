import { parseAimHtml } from '../../src/client/aim-html.js';
import type { PeerLink } from '../../src/client/peer-link.js';
import { rendezvousEnded } from '../../src/client/rendezvous.js';
import type { Rendezvous, RendezvousEnd } from '../../src/client/rendezvous.js';
import { ByteWriter, concatBytes } from '../../src/wire/bytes.js';
import { ICBM_CHANNEL_RENDEZVOUS, ODC_FLAG_AUTO, ODC_FLAG_HELLO } from '../../src/wire/constants.js';
import { decodeOdcHeader, decodeOdcMessage, encodeOdcHeader, encodeOdcMessage, odcHeaderLength, odcKind } from '../../src/wire/odc.js';
import type { OdcKind } from '../../src/wire/odc.js';
import { parseRendezvous } from '../../src/wire/rendezvous.js';
import type { RendezvousMessage } from '../../src/wire/rendezvous.js';
import { encodeUserInfo } from '../../src/wire/snac.js';
import { encodeTlvs } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import type { DirectAttachment, DirectMessage, DirectPart } from '../../src/model/direct-im.js';
import { normalizeScreenName } from '../../src/model/screen-name.js';

/** 'silent' sends no hello, as the oldest client does. */
export type PeerDirectImForm = 'speaks' | 'silent';
/** One Direct IM session of a scripted peer. Each send rejects when the session did not open. */
export type PeerDirectIm = {
  outcome: 'open' | RendezvousEnd['outcome'];
  /** The other side. */
  peer: string;
  cookie: bigint;
  sendPicture(name: string, bytes: Uint8Array, text?: string): Promise<void>;
  sendText(html: string): Promise<void>;
  sendRaw(bytes: Uint8Array): Promise<void>;
  /** Each message frame that came, in order. A frame with a wrong cookie is not left out. */
  received(): DirectMessage[];
  /** The kind of each frame that came, in order. */
  frames(): OdcKind[];
  /** The connection ended. */
  ended(): boolean;
  close(): void;
};
export type PeerDirectImDeps = {
  /** The name of the scripted peer. */
  name: string;
  /** The one Rendezvous of the peer. Each script of the peer uses it. */
  rendezvous: Rendezvous;
  cookie(): bigint;
  now(): number;
};

const HEAD_BYTES = 6;
const MAX_BINARIES = 64;

/** The Direct IM sessions of one scripted peer. It dials the relay only. */
export class PeerDirectIms {
  private readonly rendezvous: Rendezvous;
  private readonly links = new Set<PeerLink>();
  private readonly made: PeerDirectIm[] = [];
  private accepting: PeerDirectImForm | null = null;

  constructor(private readonly deps: PeerDirectImDeps) {
    this.rendezvous = deps.rendezvous;
  }

  /** Offers Direct IM. The result comes when the connection opened or the offer ended. */
  async open(to: string, form: PeerDirectImForm): Promise<PeerDirectIm> {
    const cookie = this.deps.cookie();
    return this.session(to, cookie, await this.rendezvous.offer(to, cookie, 'direct-im', null), form);
  }

  /** From now on, the peer accepts each Direct IM offer. */
  acceptEach(form: PeerDirectImForm): void {
    this.accepting = form;
  }

  /** Each session of this peer, in order. */
  sessions(): PeerDirectIm[] {
    return [...this.made];
  }

  /** One channel 2 message that the server delivered to the peer. */
  heard(from: string, tlvs: readonly Tlv[]): void {
    const sender = encodeUserInfo({ name: from, warning: 0, tlvs: [] });
    const message = parseRendezvous(new ByteWriter().u64(0n).u16(ICBM_CHANNEL_RENDEZVOUS).bytes(sender).bytes(encodeTlvs([...tlvs])).toBytes());
    if (message?.service !== 'direct-im') return;
    if (message.type !== 'propose' || message.sequence !== 1) this.rendezvous.heard(message);
    else if (this.accepting) void this.receive(message, this.accepting);
  }

  /** The client error of the other side for a cookie. */
  refused(cookie: bigint): void {
    this.rendezvous.refused(cookie);
  }

  /** Each Direct IM connection closes. The owner of the Rendezvous resets it after. */
  reset(): void {
    for (const link of this.links) link.close();
    this.links.clear();
  }

  private async receive(proposal: RendezvousMessage, form: PeerDirectImForm): Promise<void> {
    // The next offer meets the relay when the first frame of this one came, or when this one ended.
    let paired: () => void = () => {};
    const met = await this.rendezvous.accept(proposal, new Promise<void>((resolve) => (paired = resolve)));
    this.session(proposal.fromDisplay, proposal.cookie, met, form, paired);
  }

  private session(peer: string, cookie: bigint, met: PeerLink | RendezvousEnd, form: PeerDirectImForm, paired: () => void = () => {}): PeerDirectIm {
    const { name, now } = this.deps;
    const messages: DirectMessage[] = [];
    const kinds: OdcKind[] = [];
    const link = rendezvousEnded(met) ? null : met;
    let over = link === null;
    const write = async (bytes: Uint8Array): Promise<void> => {
      if (!link || over) throw new Error('the session is not open');
      await link.write(bytes);
    };
    const frame = (flags: number, payload: Uint8Array): Uint8Array =>
      concatBytes([encodeOdcHeader({ cookie, payloadBytes: payload.length, encoding: 0, flags, screenName: name }), payload]);
    const one: PeerDirectIm = {
      outcome: rendezvousEnded(met) ? met.outcome : 'open',
      peer,
      cookie,
      sendPicture: (label, bytes, text = '') => write(frame(0, encodeOdcMessage(text, [{ id: 1, name: label, bytes, width: 0, height: 0 }]))),
      sendText: (html) => write(frame(0, encodeOdcMessage(html, []))),
      sendRaw: write,
      received: () => [...messages],
      frames: () => [...kinds],
      ended: () => over,
      close: () => {
        over = true;
        link?.close();
      },
    };
    this.made.push(one);
    if (!link) {
      paired();
      return one;
    }
    this.links.add(link);
    if (form === 'speaks') void link.write(frame(ODC_FLAG_HELLO, new Uint8Array(0))).catch(() => {});
    const id = `${normalizeScreenName(peer)}:${cookie.toString(16).padStart(16, '0')}`;
    void this.read(link, (kind, message) => {
      paired();
      kinds.push(kind);
      if (message) messages.push({ id, from: peer, at: now(), ...message });
    }).finally(() => {
      paired();
      over = true;
      link.close();
      this.links.delete(link);
    });
    return one;
  }

  // The read ends when the connection closes or a frame has no valid header.
  private async read(link: PeerLink, took: (kind: OdcKind, message: Omit<DirectMessage, 'id' | 'from' | 'at'> | null) => void): Promise<void> {
    try {
      for (;;) {
        const head = await link.read(HEAD_BYTES);
        const length = odcHeaderLength(head);
        const header = decodeOdcHeader(concatBytes([head, await link.read(length - HEAD_BYTES)]));
        const payload = await link.read(header.payloadBytes);
        const kind = odcKind(header);
        if (kind !== 'message') {
          took(kind, null);
          continue;
        }
        const decoded = decodeOdcMessage(payload, header.encoding, MAX_BINARIES);
        const attachments: DirectAttachment[] = decoded.binaries.map((binary) => ({ id: binary.id, name: '', bytes: binary.bytes.slice() }));
        const named = new Set<number>();
        const parts: DirectPart[] = [];
        for (const segment of decoded.segments) {
          if ('text' in segment) {
            parts.push({ kind: 'text', body: parseAimHtml(segment.text) });
            continue;
          }
          const index = attachments.findIndex((attachment) => attachment.id === segment.image.id);
          const attachment = attachments[index];
          if (!attachment) {
            parts.push({ kind: 'missing' });
            continue;
          }
          attachment.name = segment.image.name;
          named.add(index);
          parts.push({ kind: 'attachment', index });
        }
        took(kind, {
          autoResponse: (header.flags & ODC_FLAG_AUTO) !== 0, parts, attachments, unreferenced: attachments.length - named.size, damaged: decoded.damaged,
        });
      }
    } catch {
      // The session is over.
    }
  }
}
