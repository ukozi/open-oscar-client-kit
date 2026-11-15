# Rate limits and warnings

## Rate classes

The server puts each kind of SNAC in a rate class, and keeps a level for each class and each signed-on name. The level is a moving average of the milliseconds between sends in that class:

```
level = min(max, (level * (window - 1) + ms since the last send) / window)
```

Sending fast lowers the level. Each class sets the thresholds below, as Open OSCAR Server (OOS) applies them ([wire/rate_limit.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/rate_limit.go#L492-L529)).

| Level | Status | What OOS does |
| --- | --- | --- |
| At or above the alert level | clear | Handles the SNAC. |
| Below the alert level | alert | Handles the SNAC. It sends an alert notice if the client asked for notices on that class. |
| Below the limit level | limited | Drops the SNAC with no reply. |
| Below the disconnect level | disconnect | Closes the session. |

A limited class stays limited until its level climbs back to the clear level. OOS drops a limited SNAC before any handler sees it ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L607-L614)), and closes the session below the disconnect level ([state/session.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session.go#L469-L471)). When a class changes status, OOS sends a rate notice (SNAC 0x01/0x0A) with the code 2 for alert, 3 for limited or 4 for clear ([foodgroup/oservice.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/oservice.go#L560-L578)).

In OOS's default classes, outgoing IMs are in class 3 ([wire/rate_limit.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/rate_limit.go#L210)). Its alert level is 5000 ms ([wire/rate_limit.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/rate_limit.go#L69-L77)), so a steady pace of one IM every 5 s keeps it clear.

## Pacing in the client

At sign-on the client reads the server's classes. After that, every SNAC in a class waits its turn in that class's queue (`src/client/bos-link.ts`). Before each send, the client works out the level the send would leave, with the server's own arithmetic (`checkRate` in `src/wire/rate.ts`). It waits until that level is at or above the alert level, or at or above the clear level while the class is limited.

After an alert notice or a limited notice, the client holds the class's queue until the server reports the class clear. The program's sends wait in the queue and do not reach the server's limiter. So a fast loop of `sendIm` calls takes longer to resolve, and each call resolves when the server acknowledges its IM (`src/client/messaging.ts`). The simple API has no option that turns the pacing off.

A server can fail to send the clear notice. The client then ends the hold 60 s after the time when, by its own count from the last notice, the level is back. It logs a warning when it ends a hold this way (`src/client/bos-link.ts`).

A server's operator can mark an account as a bot. OOS then does not rate limit that account ([state/session.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session.go#L455-L457)). By default, the client paces it all the same, from the classes the server sends.

OOS marks each session of a bot account with the user flag 0x0400 ([foodgroup/auth.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/auth.go#L161-L163), [wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L331)). `OscarClient` has the `botFlagExempt` option for such an account. With `botFlagExempt: true`, the client reads the account's own user info at each connect. When that user info has the flag 0x0400, the client writes each send on the session's main connection, BOS, at once, with no pacing and no hold (`src/client/oscar-client.ts`, `src/client/bos-link.ts`). An account without the flag stays paced. Room sends stay paced in all cases, and the `rate` event of `OscarClient` still reports when the server limits the IM class or clears it. The default is `false`.

## The `rateLimited` event

`rateLimited` fires with `{ limited: true }` when the server reports the IM class limited. It fires with `{ limited: false }` when the class is no longer limited, and when the connection ends while it is limited (`lib/session.ts`, `src/client/oscar-client.ts`). It covers only the class that holds outgoing IMs.

## Rate limits in rooms

The simple API does not join rooms. In `OscarClient`, each room has its own connection with its own rate classes, and the `rate` event covers only the BOS connection. The `roomRate` event reports the send class of each room connection, as `{ roomId, status }`, where `status` is `clear`, `alert` or `limited` (`src/client/oscar-client.ts`, `src/model/room.ts`).

`roomRate` fires when a rate notice from the room connection changes the status of its send class. It also fires with `limited` when the server does not send back, within 10 s, a message that the client sent to the room. The server drops a limited message with no reply (`src/wire/chatroom.ts`).

## Warnings

A user who gets an IM from the session's name can warn that name. OOS adds 10% to the warned name's level for a warning that names the warner, and 3% for an anonymous one ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L504-L507)). The level goes from 0% to 100%.

Each warning also raises the alert, limit and clear levels of the IM class, so a warned name must send more slowly to stay clear ([state/session.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session.go#L552-L603)). The warning goes down by 5% every 5 minutes, and the thresholds come back down with it ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L21-L26), [foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L766-L783)). A sign-off does not clear it. At the next sign-on, OOS restores the stored level, less the decay for the time between ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L614-L659)).

The `warned` event fires when the server sends a warning notice. `level` is the new warning level in tenths of a percent, as the server sends it, so `100` is 10%. `by` is the warner's screen name, or `null` for an anonymous warning (`src/wire/oservice.ts`).

```js
session.on('warned', ({ level, by }) => {
  console.log(`warned to ${level / 10}% by ${by ?? 'someone anonymous'}`);
});
```

OOS refuses a warning against an account marked as a bot ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L492-L495)).

## No bulk send

The package has no call that sends one IM to many names. `sendIm` takes one name (`lib/session.ts`). A loop over many names goes through the same IM class as any other send, so the pacing spaces it out. Each IM a person did not ask for also gives them a warning to use, and every warning slows the name's later sends. The package leaves bulk send out because it makes flooding a server easy, and the package is for programs that answer people.

The [bot etiquette](bot-etiquette.md) guide covers what to do when warned.
