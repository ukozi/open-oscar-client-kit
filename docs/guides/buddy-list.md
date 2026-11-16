# The buddy list

The server stores each account's buddy list in its feedbag, and the session reads it at sign-on. `session.buddies()` returns it as an array with one `Buddy` for each name (`lib/session.ts`):

```js
for (const buddy of session.buddies()) {
  console.log(`${buddy.group}: ${buddy.screenName} ${buddy.online ? 'online' : 'offline'}`);
}
```

A `Buddy` is `{ screenName, group, online, away, idleSince }`. `idleSince` is the time the buddy went idle, in milliseconds since the epoch, or `null` when the buddy is not idle.

## Groups

Every buddy is in a group, and `group` holds that group's name. `buddies()` lists the groups in the list's own order, and the names in each group in the group's order (`src/client/feedbag.ts`). A buddy whose group has no group item comes last, with `group` set to `''`.

On the test server, each account starts with one group, `Buddies`, which holds the peer `Alice` (`lib/cli/test-server.ts`).

## Arrivals and departures

The `buddy` event fires with a `Buddy` each time the server sends an arrival or a departure for a name. Open OSCAR Server (OOS) sends an arrival for a sign-on, and also for a change such as a new icon or a new warning level ([foodgroup/buddy.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/buddy.go#L204-L207)).

```js
session.on('buddy', (buddy) => {
  console.log(`${buddy.screenName} is ${buddy.online ? 'online' : 'offline'}${buddy.away ? ', away' : ''}`);
});
```

Arrivals come only for names on the session's own buddy list. OOS sends a user's arrival and departure to each user who has that user on their list, and skips any pair where one side blocks the other ([foodgroup/buddy.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/buddy.go#L208-L252)). An invisible user sends no arrival. When the session signs on, OOS sends it an arrival for each buddy who is online ([foodgroup/buddy.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/buddy.go#L320-L329)).

## Changing the list

The simple API reads the list and does not change it. `OscarClient` from `open-oscar-client-kit/client` has the full feedbag API (`src/client/oscar-client.ts`):

- `addBuddy`, `removeBuddy`, `moveBuddy` and `setAlias` for buddies;
- `addGroup`, `renameGroup` and `deleteGroup` for groups;
- `block`, `unblock`, `allow`, `disallow` and `setPrivacyMode` for privacy.

A program that changes its list uses `OscarClient` in place of `signOn`:

```js
import { OscarClient, clientIdFor } from 'open-oscar-client-kit/client';

const client = new OscarClient({ clientId: clientIdFor('my-bot', '1.0.0', process.platform) });
await client.signOn({ screenName: 'Bot', password: 'botpass1' }, { host: '127.0.0.1', port: 5190 });

const groupId = await client.addGroup('Friends');
await client.addBuddy({ screenName: 'Cathy', groupId, alias: null });
console.log(client.buddyList().groups);
```

`buddyList()` returns the groups with their ids, and each buddy with its `itemId`. `removeBuddy`, `moveBuddy` and `setAlias` take `{ groupId, itemId }`. A write changes `buddyList()`, and fires the `buddyList` event, only after the server confirms it. On `OscarClient`, arrivals and departures come as the `presence` event.

See [`OscarClient`](../api/open-oscar-client-kit/client/classes/OscarClient.md) in the API reference for each method's arguments and errors.

## A buddy list for the session only

`OscarClient` can watch names that the program gives, in place of the list that the server stores. Give the `sessionBuddies` option a function that returns the names (`src/client/oscar-client.ts`):

```js
const watched = new Set(['Alice', 'Bob']);
const client = new OscarClient({
  clientId: clientIdFor('my-bot', '1.0.0', process.platform),
  sessionBuddies: () => [...watched],
});
```

At each connect, the client calls the function and sends the names in SNAC 0x03/0x04. OOS keeps these names for the session and sends their arrivals and departures ([foodgroup/buddy.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/buddy.go#L58-L119)). The client sends each name one time, in the form that `normalizeScreenName` gives. It does not send an empty name or a name longer than 255 bytes. The client sends 0x03/0x04 also for an empty list, because the server then tells the account's watchers that the account is online.

When the names change, call `refreshSessionBuddies()`. The client calls the function again, sends the added names in 0x03/0x04 and the removed names in 0x03/0x05, and forgets the presence of each removed name. While the client is offline, `refreshSessionBuddies()` rejects with `not-signed-on`. After a reconnect, the client calls the function again and sends the whole list.

With `sessionBuddies`, the client does not keep the stored list, does not tell the server to use it (SNAC 0x13/0x07), and does not write the typing preference into it. `buddyList()` is empty. Each method that writes the stored list rejects with an `OscarError` whose `info` is `{ kind: 'local', code: 'invalid-argument' }`, and the client sends nothing. These methods include `addBuddy`, `block` and `setPrivacyMode`. The `sessionBuddies` option cannot go with the `awayRecord` option: with both, the constructor throws a `RangeError`.

### The icon of the account

`setOwnIcon` and `clearOwnIcon` work with `sessionBuddies`. The server keeps the icon of the account in one item of the stored list, so each call reads the stored list one time (SNAC 0x13/0x04) to find that item. The client then writes only that item. `setOwnIcon` adds the item when the list has none, and `clearOwnIcon` writes nothing when the list has none. The client keeps no copy of the list after the call: `buddyList()` stays empty, and no `buddyList` event fires. If the server refuses the read, the call rejects and the client writes nothing (`src/client/oscar-client.ts`).
