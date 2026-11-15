import { FEEDBAG_CLASS_BUDDY, FEEDBAG_CLASS_GROUP, orderAttr } from '../src/wire/feedbag.js';
import type { FeedbagItem } from '../src/wire/feedbag.js';

export function buddyListFeedbag(groups: { name: string; buddies: string[] }[]): FeedbagItem[] {
  const root: FeedbagItem = {
    name: '',
    groupId: 0,
    itemId: 0,
    classId: FEEDBAG_CLASS_GROUP,
    attrs: [orderAttr(groups.map((_, i) => i + 1))],
  };
  const items: FeedbagItem[] = [root];
  let nextItemId = 1;
  groups.forEach((group, i) => {
    const groupId = i + 1;
    const buddies = group.buddies.map(
      (name): FeedbagItem => ({ name, groupId, itemId: nextItemId++, classId: FEEDBAG_CLASS_BUDDY, attrs: [] }),
    );
    items.push(
      { name: group.name, groupId, itemId: 0, classId: FEEDBAG_CLASS_GROUP, attrs: [orderAttr(buddies.map((b) => b.itemId))] },
      ...buddies,
    );
  });
  return items;
}
