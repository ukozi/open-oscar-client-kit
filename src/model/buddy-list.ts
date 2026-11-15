import type { Privacy } from './privacy.js';
import type { RichText } from './rich-text.js';
import type { MessageWire } from './wire-detail.js';

/** The capability of a client that takes a file offer, as `BuddyPresence.capabilities` lists it. */
export const SEND_FILE_CAPABILITY = '09461343-4C7F-11D1-8222-444553540000';
/** The capability of a client that takes a Direct IM offer. */
export const DIRECT_IM_CAPABILITY = '09461345-4C7F-11D1-8222-444553540000';
/** The capability of a client that shares files. */
export const GET_FILE_CAPABILITY = '09461348-4C7F-11D1-8222-444553540000';

/** `pending`: the buddy item carries TLV 0x0066, waiting for authorisation, which the server's mode 5 does not count. */
export type BuddyEntry = { itemId: number; screenName: string; alias: string | null; pending: boolean };
/** `stray`: no group item has this id, so the group has no name and no order list. */
export type BuddyGroup = { id: number; name: string; buddies: BuddyEntry[]; stray?: true };
/** `acceptNonListIcons`: null when the account's buddy prefs do not mark that pref as valid. */
export type BuddyList = { groups: BuddyGroup[]; privacy: Privacy; acceptNonListIcons: boolean | null };
export type BuddyRef = { groupId: number; itemId: number };
export type BuddyPresence = Readonly<{
  screenName: string;          // as the server sent it
  online: boolean;
  away: boolean;
  idleSince: number | null;    // ms
  signedOnAt: number | null;   // ms
  warnLevel: number;           // tenths of a percent, as received
  mobile?: true;               // present only while the server's wireless flag is set
  capabilities?: readonly string[]; // uppercase ids with dashes; absent when the server sent none
}>;
export type IncomingIm = {
  from: string; body: RichText; autoResponse: boolean; at: number; offline: boolean; serverNotice: boolean;
  /** The cookie and the HTML as they came. Only the `wireDetail` option of the client sets it. */
  wire?: MessageWire;
};
export type UserInfoResult =
  | { status: 'ok'; screenName: string; away: boolean; idleSince: number | null; signedOnAt: number | null; warnLevel: number; profile: RichText; awayMessage: RichText | null; mobile?: true }
  | { status: 'unavailable' };
