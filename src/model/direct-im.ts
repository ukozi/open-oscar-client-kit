import type { RichText } from './rich-text.js';

export type DirectImOffer = { id: string; from: string; at: number };
export type DirectImState = 'waiting' | 'connecting' | 'open' | 'closed';
export type DirectImEnd =
  | 'closed' | 'declined' | 'cancelled' | 'timed-out' | 'refused-address' | 'taken-elsewhere'
  | 'peer-closed' | 'bad-cookie' | 'bad-frame' | 'too-large' | 'signed-off';
export type DirectImStatus = {
  id: string;
  peer: string;
  role: 'offering' | 'receiving';
  state: DirectImState;
  end?: DirectImEnd;
  by?: 'self' | 'peer';
  /** The peer showed the cookie of the offer. */
  verified: boolean;
};
export type DirectAttachment = { id: number; name: string; bytes: Uint8Array };
/** `index` is a position in the `attachments` of the message. */
export type DirectPart = { kind: 'text'; body: RichText } | { kind: 'attachment'; index: number } | { kind: 'missing' };
export type DirectMessage = {
  id: string;
  from: string;
  at: number;
  autoResponse: boolean;
  parts: DirectPart[];
  attachments: DirectAttachment[];
  /** Attached data that no part names. */
  unreferenced: number;
  /** A declared length did not match the bytes that came, or the text names more pictures than the limit. */
  damaged: boolean;
};
export type OutgoingPicture = { name: string; bytes: Uint8Array; width: number; height: number };
export type OutgoingDirectMessage = { body?: RichText; pictures: readonly OutgoingPicture[] };
