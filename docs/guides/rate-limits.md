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

A limited class stays limited until its level climbs back to the clear level. A SNAC that OOS drops lowers the level like any other, so each send to a limited class makes the wait longer. OOS drops a limited SNAC before any handler sees it ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L607-L614)), and closes the session below the disconnect level ([state/session.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session.go#L469-L471)). When a class changes status, OOS sends a rate notice (SNAC 0x01/0x0A) with the code 2 for alert, 3 for limited or 4 for clear ([foodgroup/oservice.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/oservice.go#L560-L578)).

In OOS's default classes, outgoing IMs are in class 3 ([wire/rate_limit.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/rate_limit.go#L210)). Its alert level is 5000 ms ([wire/rate_limit.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/rate_limit.go#L69-L77)), so a steady pace of one IM every 5 s keeps it clear.

## Pacing in the client

At sign-on the client reads the server's classes. After that, every SNAC in a class waits its turn in that class's queue (`src/client/bos-link.ts`). Before each send, the client works out the level the send would leave, with the server's own arithmetic (`checkRate` in `src/wire/rate.ts`). It waits until that level is a margin above the alert level, or a margin above the clear level while the class is limited. The level it waits for is never above the maximum level of the class.

The server counts the time between the arrivals of two sends, and the client counts the time between the sends. The network can deliver a send nearer to the send before it, so the server's level can be lower than the client's level. The margin covers that difference. In units of level, the margin is `ceil(paceMarginMs / window) + window` (`RateGovernor` in `src/wire/rate.ts`). The first part covers arrivals that move by up to `paceMarginMs` milliseconds. The second part covers the server's rounding, and it stays when `paceMarginMs` is 0.

`paceMarginMs` is an option of `OscarClient`, and its default is 250 (`PACE_MARGIN_MS` in `src/wire/rate.ts`). It applies to the BOS connection and to each room connection. A value that is not a number of 0 or more makes the constructor throw a `RangeError` (`src/client/oscar-client.ts`). The simple API uses the default and has no option for it.

The margin makes the client slower. In a class with a window of 20, the default margin is 33. With an alert level of 5000 ms, the client keeps the level at or above 5033 ms, so a steady pace is one send every 5033 ms. A burst meets its first wait sooner, and its first waits are about 660 ms longer in total, which is the margin times the window. In a class with a window of 80, the default margin is 84, and a burst falls behind by about 6720 ms.

After an alert notice or a limited notice, the client holds the class's queue and sends nothing in that class. The hold ends when the server reports the class clear. The hold also ends when, by the client's own count, a send would leave the level a margin above the alert level, or a margin above the clear level after a limited notice. A held class sends nothing, and a server can send no notice for a class that sends nothing, so the client does not wait for the clear notice (`src/client/bos-link.ts`).

A limited notice carries the level of the class at the moment the server made it. A send that the client wrote just before the notice arrived can reach the server after that moment. The server drops that send and lowers the level again, and the notice does not show it. So the client also counts each send that it wrote less than 2 s before the notice arrived (`NOTICE_FLIGHT_MS` in `src/wire/rate.ts`), and it does the same for an alert notice that arrives while the class is limited. The next send then goes when the server's level is back at the clear level, and the server does not drop it.

That count has two limits. If a send and its notice take more than 2 s together, the client does not count the send. The client also cannot count a send from another session of the same name. In both cases the server's level can be lower than the client's count, and the server can drop one more send.

The program's sends wait in the queue and do not reach the server's limiter. So a fast loop of `sendIm` calls takes longer to resolve, and each call resolves when the server acknowledges its IM (`src/client/messaging.ts`). The simple API has no option that turns the pacing off.

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
