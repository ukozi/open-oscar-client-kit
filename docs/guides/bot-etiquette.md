# Bot etiquette

A bot shares the server with people. The client keeps to the server's rate classes by itself. The rules on this page are the program's to keep.

## Answer only IMs sent to the bot

The `im` event carries the IMs sent to the session's own name, and the simple API skips server notices (`lib/session.ts`). Answer those IMs and nothing else.

Do not answer an IM whose `autoResponse` is `true`. An auto-response is an away message that a client sent by itself, so no one is there to read the answer.

## Never message names that did not write first

Send an IM to a name only to answer an IM from that name. On Open OSCAR Server (OOS), each IM the bot sends to a person gives that person one warning to use within the hour, up to 3 an hour ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L820-L897)). The [rate limits](rate-limits.md) guide says what a warning costs.

## Stay out of rooms unless invited

The simple API does not join rooms. With `OscarClient` from `open-oscar-client-kit/client`, an invitation comes as the `roomInvite` event, and `joinRoom` joins a room (`src/client/oscar-client.ts`). Join a room only when someone invites the bot, and leave it when the people in it ask.

## Back off when warned

The `warned` event gives the new level and the name of the warner, or `null` for an anonymous warning. Stop answering a name that warned the bot. When the level climbs, slow down or stop for a while: each warning raises the levels the IM class must stay above.

```js
import { normalizeScreenName } from 'open-oscar-client-kit/model';

const quiet = new Set();
session.on('warned', ({ by }) => {
  if (by !== null) quiet.add(normalizeScreenName(by));
});
session.on('im', async (im) => {
  if (im.autoResponse || quiet.has(normalizeScreenName(im.from))) return;
  await session.sendIm(im.from, `You said: ${im.text}`);
});
```

`normalizeScreenName` removes spaces and lowers the case, so `Alice`, `alice` and `A lice` compare equal (`src/model/screen-name.ts`).

## Identify the bot

Give `signOn` an `app` name that says what the bot is. The session puts it in the client ID that the login sends, as `<app> (open-oscar-client-kit), version <package version>/<platform>`, such as `echo-bot (open-oscar-client-kit), version 0.1.0/MAC`. The platform is `MAC`, `WIN32` or `LINUX`, and any other platform name in capitals (`lib/session.ts`, `src/client/client-id.ts`). OOS keeps the client ID with the session ([foodgroup/auth.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/auth.go#L167-L168)).

Say in the bot's profile that it is a bot, and who runs it. The simple API sets no profile. `OscarClient` sets one with `setProfile`, or with the `profile` option of `signOn` (`src/client/oscar-client.ts`):

```js
await client.setProfile([{ text: 'Echo bot. It repeats what you send it. Run by Sam (sam@example.com).' }]);
```

## Mark automatic answers

`OscarClient.sendIm` takes options as its third argument (`src/client/messaging.ts`). With `automatic: true`, the IM goes out as an auto-response (TLV 0x04), and the recipient sees it as one. Use it when the bot sends an answer that does not depend on what the person wrote, such as an away message. A bot that keeps to this page does not answer an auto-response, so two such bots do not answer each other without end.

```js
await client.sendIm('Alice', [{ text: 'I am away. I read IMs once a day.' }], { automatic: true });
```

## Ask for storage only when the recipient is offline

By default, each IM asks the server to store it when the recipient is offline (TLV 0x06). With `store: 'when-offline'`, the IM carries that request only when the client's presence for the recipient is offline. A name with no presence, such as a name that is not on the buddy list, gets the IM with no store request. When the server answers that IM with error 0x0004, which says that the recipient is not signed on, the client sends the IM once more with the store request and the same cookie.

`sendIm` resolves with `{ id, stored }`. `id` is the cookie of the IM as 16 hex digits. `stored` is `true` when the IM that the server accepted carried the store request.

## Keep HTML bodies within the server's limit

`sendIm`, `sendRoomMessage` and `setAway` take a body of `{ html }` in place of rich text. The client sends that HTML byte for byte, with no change (`src/model/wire-detail.ts`). It encodes the text as ASCII when each character is 7-bit, and as UTF-16BE when one is not.

For a rich-text IM, the client compares the encoded size with the IM limit that the server gives at sign-on. It rejects a longer IM with the code `message-too-long`. For an `{ html }` IM, the client checks only that the IM fits in one frame on the wire, which holds 65,017 bytes of encoded text (`src/client/messaging.ts`). The program must then keep the size within the server's limit itself. The client still checks an `{ html }` room message against the room's limit (`message-too-long`), and an `{ html }` away message against the server's limit (`text-too-long`).

## Keep each message as it came

With the `wireDetail: true` option, each `im`, `roomMessage` and `roomInvite` event of `OscarClient` has a `wire` field (`src/model/wire-detail.ts`). For an IM or a room message, `wire` is `{ cookie, html }`. `cookie` is the message cookie as 16 lowercase hex digits, and `html` is the text as it came, before the client parses it. For an invitation, `wire` is `{ html }`. A notice from the server has the cookie `0000000000000000`. The default is `false`, and the events then have no `wire` field.

## Fetch no icons that the bot does not show

By default, `OscarClient` fetches the icon of each buddy and room member who has one (`iconsFrom: 'buddies'`). The fetches use a service request, one more connection to the server's icon service, and memory for the icon bytes (`src/client/icons.ts`). With `iconsFrom: 'none'`, the client asks for no icon and opens no connection for icons, and `iconOf` returns `null`. `setIconsFrom` changes the setting while the client runs, and the new setting holds across reconnects. The simple API keeps the default and has no option for it.

## Respect a server's rules

Each server sets its own rules for bots. Read them before the bot signs on, run the bot on an account made for it, and stop the bot when the server's operator asks. An operator can mark an account as a bot. OOS then sets the bot flag on its sessions ([foodgroup/auth.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/auth.go#L161-L163)), does not rate limit it, and refuses warnings against it (see [rate limits](rate-limits.md)).
