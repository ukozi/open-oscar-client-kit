import { blocks, settledBuddies } from './privacy.js';
import type { Privacy } from './privacy.js';
import { normalizeScreenName } from './screen-name.js';

export type ListedGroups = readonly { readonly buddies: readonly { readonly screenName: string; readonly pending: boolean }[] }[];
export type SenderContext = { groups: ListedGroups; privacy: Privacy; self: string | null };
export type KnockState = { knockKnock: boolean; knocking: boolean; accepted: boolean };

function isSelf(self: string | null, name: string): boolean {
  return self !== null && normalizeScreenName(self) === normalizeScreenName(name);
}

/** Whether to drop an IM, typing or invitation from `from` because the privacy setting blocks the sender. */
export function excludedSender(context: SenderContext, from: string, serverNotice: boolean): boolean {
  if (serverNotice) return false;
  if (isSelf(context.self, from)) return false;
  return blocks(context.privacy, settledBuddies(context.groups), from, context.self);
}

/** Whether to mark a room line or whisper from `from`: the sender is among the deny items, whatever the mode. */
export function roomLineBlocked(privacy: Privacy, from: string): boolean {
  return privacy.block.includes(normalizeScreenName(from));
}

export function knocksWith(context: SenderContext, state: KnockState, im: { from: string; serverNotice: boolean }): boolean {
  if (im.serverNotice) return false;
  if (state.knocking) return true;
  if (!state.knockKnock || state.accepted) return false;
  if (isSelf(context.self, im.from)) return false;
  const name = normalizeScreenName(im.from);
  const listed = context.groups.some((group) => group.buddies.some((buddy) => normalizeScreenName(buddy.screenName) === name));
  return !blocks(context.privacy, settledBuddies(context.groups), name, context.self) && !listed;
}

export function heldForDelivery<B extends { screenName: string }>(groups: readonly { readonly buddies: readonly B[] }[], recipient: string, online: (buddy: B) => boolean): boolean {
  const name = normalizeScreenName(recipient);
  const rows = groups.flatMap((group) => group.buddies.filter((buddy) => normalizeScreenName(buddy.screenName) === name));
  return rows.length > 0 && rows.every((buddy) => !online(buddy));
}
