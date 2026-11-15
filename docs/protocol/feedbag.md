# Feedbag

The feedbag, family 0x0013, is the server's copy of an account's lists: the buddy list with its groups, the allow and block lists, the privacy mode and some preferences. Every session of the account reads the same feedbag. The codec is `src/wire/feedbag.ts`, and the core's list logic is `src/client/feedbag.ts`.

## Items

The feedbag is a flat list of items ([wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L2817-L2823), `encodeFeedbagItems`, `readFeedbagItem`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Length of the name, n |
| 2 | n | Name |
| 2+n | 2 | Group id |
| 4+n | 2 | Item id |
| 6+n | 2 | Class |
| 8+n | 2 | Length of the attributes, m |
| 10+n | m | Attributes, as TLVs |

`00 03 62 6f 62 00 01 00 05 00 00 00 09 01 31 00 05 42 6f 62 62 79` is the buddy `bob` in group 1, item 5, class 0, with the alias `Bobby` in attribute 0x0131 (`test/vectors/hand-lists-info.json`).

The classes the core reads ([wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L1686-L1705)):

| Class | Item | Name |
| --- | --- | --- |
| 0x0000 | A buddy | The buddy's screen name |
| 0x0001 | A group, or the root when group id and item id are both 0 | The group's name, or empty for the root |
| 0x0002 | A name on the allow list | That name |
| 0x0003 | A name on the block list | That name |
| 0x0004 | The privacy item | Empty |
| 0x0005 | The buddy preferences item | Empty |
| 0x0014 | The buddy icon item | `1` |

Items of other classes stay in the core's copy of the list as the server sent them.

The attributes the core reads:

| Attribute | On | Value |
| --- | --- | --- |
| 0x00C8 | A group or the root | The order, a list of u16 ids |
| 0x0131 | A buddy | The alias, as text |
| 0x0066 | A buddy | Empty: the buddy has not yet authorized the listing |
| 0x00CA | The privacy item | The mode, u8 |
| 0x00C9, 0x00D6 | The buddy preferences item | The preference bits and the bits that are set |
| 0x00D5 | The buddy icon item | The icon's flags and hash |

The numbers come from `src/wire/feedbag.ts` and [wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L1719-L1753).

## Groups and order

A buddy belongs to the group whose group id it carries. The root lists the group ids in its order attribute, and each group lists the item ids of its buddies in its own. The core shows the groups in the root's order, and the buddies of each group in that group's order. An id that is in no order comes after the ordered ones, by id. Other clients write the same list, so an order can name an id that is gone or one id twice, and the core skips those. A buddy whose group has no group item comes last, in a group with no name (`buildBuddyList` in `src/client/feedbag.ts`).

In the hand-made feedbag reply in `test/vectors/hand-session.json`, the root is `00 00 00 00 00 00 00 01 00 08 00 c8 00 04 00 02 00 01`: no name, group id 0, item id 0, class 1, and an order attribute that lists group 2, then group 1.

A new item needs an id. The core picks the lowest item id from 1 to 0x7FFF that no item of any class uses, and the lowest free group id for a new group (`takeId`).

## Reading the list

At sign-on, before client online (`Feedbag.load` and `Feedbag.use`):

1. The client asks for the limits with 0x13/0x02. The reply, 0x13/0x03, holds TLVs: the most items of each class in TLV 0x04, as a list of u16s by class, and the most buddies in a group in TLV 0x0C. The core uses 61 buddies, 61 groups, 100 allowed, 100 blocked and 200 to a group where the reply says nothing (`feedbagLimits`).
2. The client asks for the list with 0x13/0x04, and reads the reply, 0x13/0x06.
3. The client sends 0x13/0x07, with no body, to start using the list. The core does not wait for an answer.

The reply 0x13/0x06 ([wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L1870-L1874), `decodeFeedbagReply`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Version |
| 1 | 2 | Number of items, n |
| 3 | varies | The n items, each as in [Items](#items) |
| after them | 4 | Time of the last change |

An empty list is `00 00 00 00 00 00 00`: version 0, no items and time 0 (`test/vectors/hand-session.json`).

## Changing the list

The edits are 0x13/0x08 to insert, 0x13/0x09 to update and 0x13/0x0A to delete. Each body is one or more items, back to back. The server answers each edit with 0x13/0x0E, or with the error 0x13/0x01. The body of 0x13/0x0E holds one status for each item of the edit, in the order of the items (`decodeFeedbagStatus`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Status of the first item. 0 is success. |
| 2 | 2 | Status of the second item, and so on to the end of the body |

`00 00 00 0e` says that the first item was written and the second needs authorization (`test/vectors/hand-lists-info.json`).

An update replaces the whole item, attributes included. So a change to one attribute sends every attribute of the item again (`withAttr`).

One change to the list is often more than one edit (`src/client/feedbag.ts`):

| Change | Edits |
| --- | --- |
| Add a buddy | Insert the buddy, update its group's order |
| Remove a buddy | Delete the buddy, update its group's order |
| Move a buddy | Delete it, insert it in the new group, update both orders |
| Add a group | Insert the group, update the root's order. With no root, insert the root first. |
| Delete a group | Delete its buddies, delete the group, update the root's order |

When a change has more than one list edit, the core sends 0x13/0x11 before them and 0x13/0x12 after them, all in one turn. A write of the privacy mode goes after that cluster, alone and outside it (see [Privacy](#privacy)). OOS keeps one open cluster for each session, so another change must not start inside it (see [the quirk](quirks.md#one-open-cluster-for-each-session)). The core runs one change at a time, and changes its copy of the list only after the server confirms every edit. When an edit fails after another one could have been written, the core reads the whole list again (`Feedbag.write`).

### Changes from other sessions

When another session of the account changes the list, the server sends this session the same insert, update and delete SNACs, at times between 0x13/0x11 and 0x13/0x12. The core applies them to its copy as the server applies them: an insert or an update replaces the item with the same group id and item id, or goes last (`applyWrite`). The server answers the session's own edits with 0x13/0x0E or 0x13/0x01 only, so an edit SNAC from the server always comes from another session (`Feedbag.handle`).

OOS stores the names of buddy, allow and block items in lowercase, with no spaces, and the core changes the names in its own copy the same way (see [the quirk](quirks.md#names-come-back-normalized)).

## Privacy

The privacy item, class 0x0004, holds the mode in attribute 0x00CA ([wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L1840-L1855), `src/model/privacy.ts`):

| Mode | Who can see the user and send to them |
| --- | --- |
| 1 | Everyone. This is the default when there is no privacy item. |
| 2 | No one |
| 3 | Only the names on the allow list |
| 4 | Everyone but the names on the block list |
| 5 | Only the names on the buddy list |

The privacy item `00 00 00 00 00 07 00 04 00 05 00 ca 00 01 04` is mode 4 (`test/vectors/hand-lists-info.json`). When a change writes list items and the mode, the core sends the mode last, in an edit of its own, after the list edits and outside any cluster (`Feedbag.enqueue` in `src/client/feedbag.ts`).

## Buddy preferences

The buddy preferences item, class 0x0005, holds preferences as bits. Attribute 0x00C9 holds their values, and attribute 0x00D6 marks which bits are set. Preferences 0 to 31 count from the right end of the bytes: preference p is bit p mod 8 of byte p / 8, rounded down, where the last byte is byte 0 ([wire/buddy_prefs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/buddy_prefs.go#L140-L146), `buddyPref`). The length of attribute 0x00D6 sets where that end is, in both attributes (see [the quirk](quirks.md#the-valid-mask-places-the-preference-bits)).

Preference 0x16 allows typing events ([wire/buddy_prefs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/buddy_prefs.go#L67)). In `00 00 00 00 00 09 00 05 00 10 00 c9 00 04 00 40 00 01 00 d6 00 04 00 40 00 01`, it is set and on, and in the same item with `00 00 00 01` as the values, it is set and off (`test/vectors/hand-lists-info.json`). A preference that is not set takes the server's default, which for typing events is on ([wire/buddy_prefs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/buddy_prefs.go#L181)). [ICBM](icbm.md) explains why the core writes this item.
