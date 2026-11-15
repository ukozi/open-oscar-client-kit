import {
  FEEDBAG_ATTR_PENDING,
  FEEDBAG_CLASS_BUDDY,
  FEEDBAG_CLASS_DENY,
  FEEDBAG_CLASS_PDINFO,
  FEEDBAG_CLASS_PERMIT,
  privacyMode,
} from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { normalizeScreenName } from '../../src/wire/text.js';

function names(feedbag: readonly FeedbagItem[], classId: number, them: string, counts: (item: FeedbagItem) => boolean = () => true): boolean {
  const ident = normalizeScreenName(them);
  return feedbag.some((item) => item.classId === classId && normalizeScreenName(item.name) === ident && counts(item));
}

// state/relationship.go:32, :59 at 7af2464: mode 5 skips a buddy item with TLV 0x0066 (state/user_store.go:1048-1049).
const settled = (item: FeedbagItem): boolean => !item.attrs.some((attr) => attr.tag === FEEDBAG_ATTR_PENDING);

// The youBlock column of state/relationship.go:110-124, with the class 4 item's mode, 1 when it or its TLV 0x00CA is missing
// (state/relationship.go:83, state/user_store.go:1039-1046). A mode the table does not list blocks nobody.
export function blocks(feedbag: readonly FeedbagItem[], them: string): boolean {
  switch (privacyMode(feedbag.find((item) => item.classId === FEEDBAG_CLASS_PDINFO))) {
    case 2:
      return true;
    case 3:
      return !names(feedbag, FEEDBAG_CLASS_PERMIT, them);
    case 4:
      return names(feedbag, FEEDBAG_CLASS_DENY, them);
    case 5:
      return !names(feedbag, FEEDBAG_CLASS_BUDDY, them, settled);
    default:
      return false;
  }
}

// A relationship row: either holds a buddy, permit or deny item naming the other (state/relationship.go:27-78).
// Without one nobody blocks anybody, whatever the modes say (state/relationship.go:180-184).
export function related(mine: readonly FeedbagItem[], me: string, theirs: readonly FeedbagItem[], them: string): boolean {
  const listed = [FEEDBAG_CLASS_BUDDY, FEEDBAG_CLASS_PERMIT, FEEDBAG_CLASS_DENY];
  return listed.some((classId) => names(mine, classId, them) || names(theirs, classId, me));
}
