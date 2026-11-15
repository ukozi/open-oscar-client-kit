import { ByteReader } from '../wire/bytes.js';
import { BUDDY_ARRIVED, BUDDY_DEPARTED, FAMILY_BUDDY, FAMILY_ICBM, FAMILY_LOCATE, ICBM_CLIENT_EVENT, ICBM_MSG_TO_CLIENT } from '../wire/constants.js';
import { LOCATE_USER_INFO_REPLY } from '../wire/locate.js';
import type { Snac } from '../wire/snac.js';
import { normalizeScreenName } from '../model/screen-name.js';

/** Distinct senders told apart; senders past this many count together under `*`. */
export const SKIPPED_SENDERS_MAX = 1_000;

const ICBM_CLIENT_ERROR = 0x000b;
// An ICBM carries cookie and channel (10 bytes) before the name; the others open with it.
const ICBM_NAME_AT = 10;

function nameOffset(snac: Snac): number | null {
  if (snac.family === FAMILY_ICBM) {
    return snac.subtype === ICBM_MSG_TO_CLIENT || snac.subtype === ICBM_CLIENT_ERROR || snac.subtype === ICBM_CLIENT_EVENT ? ICBM_NAME_AT : null;
  }
  if (snac.family === FAMILY_BUDDY) return snac.subtype === BUDDY_ARRIVED || snac.subtype === BUDDY_DEPARTED ? 0 : null;
  return snac.family === FAMILY_LOCATE && snac.subtype === LOCATE_USER_INFO_REPLY ? 0 : null;
}

/** The sender's name, read without decoding the rest of the body; null when the SNAC has none or stops short. */
export function skippedSender(snac: Snac): string | null {
  const at = nameOffset(snac);
  if (at === null) return null;
  try {
    return new ByteReader(snac.body, at).str8();
  } catch {
    return null;
  }
}

/** Skipped SNACs per sender, by normalised name: `''` for an unknown sender, `*` for every name past the cap. */
export class SkipCounter {
  private readonly counts = new Map<string, number>();
  private named = 0;

  add(from: string | null): void {
    let key = from === null ? '' : normalizeScreenName(from);
    if (key !== '' && key !== '*' && !this.counts.has(key)) {
      if (this.named < SKIPPED_SENDERS_MAX) this.named++;
      else key = '*';
    }
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.counts);
  }
}
