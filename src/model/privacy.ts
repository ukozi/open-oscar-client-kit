import { normalizeScreenName } from './screen-name.js';

export type PrivacyMode = 'allow-all' | 'allow-buddies' | 'allow-list' | 'block-all' | 'block-list' | 'unknown';
export const PRIVACY_MODES = ['allow-all', 'allow-buddies', 'allow-list', 'block-all', 'block-list'] as const;
/** The Allow list holds the permit items and the Block list the deny items, names normalised. */
export type Privacy = { mode: PrivacyMode; allow: readonly string[]; block: readonly string[] };
/** What Block or Unblock of one name writes: nothing, a change the mode can express, or a conversion to allow-list. */
export type PrivacyChange =
  | { kind: 'none' }
  | { kind: 'direct'; needed: number; fits: boolean }
  | { kind: 'convert'; others: number; buddies: number; needed: number; fits: boolean };

export type ChosenMode = Exclude<PrivacyMode, 'unknown'>;

// TLV 0x00CA's values (wire/snacs.go:1882-1893 at 7af2464).
const WIRE: Record<ChosenMode, 1 | 2 | 3 | 4 | 5> = { 'allow-all': 1, 'block-all': 2, 'allow-list': 3, 'block-list': 4, 'allow-buddies': 5 };

export function modeOf(wire: number): PrivacyMode {
  return PRIVACY_MODES.find((mode) => WIRE[mode] === wire) ?? 'unknown';
}

export function wireOf(mode: ChosenMode): 1 | 2 | 3 | 4 | 5 {
  return WIRE[mode];
}

/** The server's rule (state/relationship.go:109-116 at 7af2464), applied with or without a relationship row. */
export function blocks(privacy: Privacy, buddies: ReadonlySet<string>, name: string, self: string | null): boolean {
  const ident = normalizeScreenName(name);
  if (self !== null && normalizeScreenName(self) === ident) return privacy.mode === 'block-list' && privacy.block.includes(ident);
  switch (privacy.mode) {
    case 'block-all':
      return true;
    case 'allow-list':
      return !privacy.allow.includes(ident);
    case 'block-list':
      return privacy.block.includes(ident);
    case 'allow-buddies':
      return !buddies.has(ident);
    default:
      return false;
  }
}

export function privacyChange(privacy: Privacy, buddies: ReadonlySet<string>, name: string, want: 'block' | 'unblock', permits: number): PrivacyChange {
  const ident = normalizeScreenName(name);
  const blocked = blocks(privacy, buddies, ident, null);
  if (blocked === (want === 'block')) return { kind: 'none' };
  const allowed = new Set(privacy.allow);
  if (privacy.mode === 'allow-buddies' || privacy.mode === 'block-all') {
    const inserted = new Set(privacy.mode === 'block-all' ? [] : [...buddies].filter((buddy) => buddy !== ident && !allowed.has(buddy)));
    const after = new Set([...allowed, ...inserted]);
    if (want === 'block') after.delete(ident);
    else after.add(ident);
    const added = [...after].filter((each) => !allowed.has(each)).length;
    const others = [...allowed].filter((each) => each !== ident && (privacy.mode === 'block-all' || !buddies.has(each))).length;
    return { kind: 'convert', others, buddies: inserted.size, needed: after.size, fits: added === 0 || after.size <= permits };
  }
  if (privacy.mode === 'allow-list' && want === 'unblock') return { kind: 'direct', needed: allowed.size + 1, fits: allowed.size + 1 <= permits };
  return { kind: 'direct', needed: allowed.size, fits: true };
}

export function settledBuddies(groups: readonly { buddies: readonly { screenName: string; pending: boolean }[] }[]): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => group.buddies.filter((buddy) => !buddy.pending).map((buddy) => normalizeScreenName(buddy.screenName))));
}

export function privacyOfView(view: { mode: PrivacyMode; allow: readonly { name: string }[]; block: readonly { name: string }[] }): Privacy {
  return { mode: view.mode, allow: view.allow.map((entry) => entry.name), block: view.block.map((entry) => entry.name) };
}
