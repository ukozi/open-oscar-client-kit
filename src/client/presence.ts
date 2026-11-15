import { decodePresence } from '../wire/buddy.js';
import { BUDDY_ARRIVED, BUDDY_DEPARTED, FAMILY_BUDDY } from '../wire/constants.js';
import { decodeUserInfo } from '../wire/snac.js';
import type { Snac, UserInfo } from '../wire/snac.js';
import { normalizeScreenName } from '../wire/text.js';
import type { BuddyPresence } from '../model/buddy-list.js';

export class Presence {
  private readonly held = new Map<string, BuddyPresence>();

  // `watched` absent: each name counts.
  constructor(private readonly deps: { now: () => number; emit: (presence: BuddyPresence) => void; watched?: (name: string) => boolean }) {}

  handle(snac: Snac): boolean {
    if (snac.family !== FAMILY_BUDDY || (snac.subtype !== BUDDY_ARRIVED && snac.subtype !== BUDDY_DEPARTED)) return false;
    const { info } = decodeUserInfo(snac.body, 0);
    const key = normalizeScreenName(info.name);
    // A notice for a name removed from the list can still be on its way.
    if (this.deps.watched?.(key) === false) return true;
    const next = Object.freeze(snac.subtype === BUDDY_ARRIVED ? this.arrived(info) : this.departed(info.name, this.held.get(key)));
    this.held.set(key, next);
    this.deps.emit(next);
    return true;
  }

  get(screenName: string): BuddyPresence | undefined {
    return this.held.get(normalizeScreenName(screenName));
  }

  forget(screenName: string): void {
    this.held.delete(normalizeScreenName(screenName));
  }

  reset(): void {
    this.held.clear();
  }

  // An arrival carries the whole state: this clears what it leaves out (idle, signed-on time, capabilities) and keeps none of it.
  private arrived(info: UserInfo): BuddyPresence {
    const { away, idleMinutes, signedOnAt, warnLevel, mobile, capabilities } = decodePresence(info);
    return {
      screenName: info.name,
      online: true,
      away,
      idleSince: idleMinutes === undefined ? null : this.deps.now() - idleMinutes * 60_000,
      signedOnAt: signedOnAt === undefined ? null : signedOnAt * 1000,
      warnLevel,
      ...(mobile && { mobile }),
      ...(capabilities && { capabilities: Object.freeze(capabilities) }),
    };
  }

  // A departure carries the name only; the name and warn level held before stay.
  private departed(name: string, before: BuddyPresence | undefined): BuddyPresence {
    return { screenName: before?.screenName ?? name, online: false, away: false, idleSince: null, signedOnAt: null, warnLevel: before?.warnLevel ?? 0 };
  }
}
