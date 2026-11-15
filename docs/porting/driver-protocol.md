# The driver protocol

A driver is a small program, written with the port, that the [suite](suite.md) starts for each scenario. It reads commands, calls the port's API, and writes back replies and the port's events. This page describes version 1 of the protocol, from `suite/protocol.ts`.

## Lines

Every message is one JSON object on one line, in UTF-8, ending with a newline. The suite writes commands to the driver's stdin. The driver writes replies and events to its stdout. The suite keeps what the driver writes to stderr, and shows its first line when a scenario fails (`suite/runner.ts`).

## Commands and replies

| Suite to driver | Driver reply |
| --- | --- |
| `{"id":1,"op":"signOn","host":"127.0.0.1","port":5190,"screenName":"Bot","password":"botpass1"}` | `{"id":1,"ok":true}` or `{"id":1,"ok":false,"error":"<kind>"}` |
| `{"id":2,"op":"sendIm","to":"Alice","text":"hi"}` | `{"id":2,"ok":true}` or `{"id":2,"ok":false,"error":"<kind>"}` |
| `{"id":3,"op":"buddies"}` | `{"id":3,"ok":true,"buddies":[{"screenName":"Alice","online":true,"away":false}]}` |
| `{"id":4,"op":"signOff"}` | `{"id":4,"ok":true}` |
| `{"id":5,"op":"exit"}` | `{"id":5,"ok":true}`, then the process ends |

A reply carries the `id` of its command. A reply with `"ok":false` needs an `error` string. The reply to `buddies` holds each buddy with `screenName`, `online` and `away`.

A failed `signOn` gives one of these kinds as its `error`:

| Kind | Meaning |
| --- | --- |
| `wrong-password` | The server refused the password. |
| `unknown-screen-name` | The server does not know the screen name. |
| `login-rate-limited` | The server refused the login because of its login limit. |
| `too-many-sessions` | The screen name has as many sessions as the server allows. |
| `unreachable` | The driver could not connect to the server. |
| `refused` | The server refused the sign-on for another reason. |
| `other` | Any other failure. |

## Events

The driver writes an event whenever it happens, between replies or before them:

| Event | When |
| --- | --- |
| `{"event":"online"}` | The session is online, after `signOn` and after each reconnect. |
| `{"event":"im","from":"Alice","text":"hello"}` | An IM arrives. `text` is the plain text, with no markup. |
| `{"event":"buddy","screenName":"Alice","online":true,"away":false}` | A buddy on the list changes state. |
| `{"event":"warned","level":100}` | The server reports a new warning level. |
| `{"event":"rateLimited","limited":true}` | The IM rate class becomes limited (`true`) or clear (`false`). |
| `{"event":"reconnecting","attempt":1,"inMs":2000}` | The port waits `inMs` milliseconds before reconnect attempt `attempt`. |
| `{"event":"signedOff","reason":"signed-off-by-server"}` | The session ends, and the port does not reconnect. |

The suite ignores fields it does not use. It treats a line with an unknown event, or with a field of the wrong type, as a protocol error: it ignores the line and logs the error with the driver's stderr (`suite/driver-process.ts`).

## Timing

The suite waits 10 s for each reply. In the `burst` scenario, the 20 `sendIm` replies share one limit of 120 s (`suite/scenarios.ts`). After it sends `exit`, it waits 2 s, then kills the process if it still runs.

## Writing a driver

1. Read stdin one line at a time.
2. Parse each line as a JSON object.
3. Call the port's API for the command's `op`.
4. Write one reply line with the command's `id`.
5. Write `ok` as `false` and an `error` kind when the call fails.
6. Use `other` for a failure that has no kind.
7. Write an `online` event each time the session comes online.
8. Write an event line for each event of the port's session.
9. Flush stdout after each line.
10. Write log lines to stderr, never to stdout.
11. On `exit`, sign off.
12. Write the reply to `exit`.
13. End the process.

The driver of open-oscar-client-kit, `suite/kit-driver.ts`, is an example on the simple API.

## An example session

This session comes from the driver of open-oscar-client-kit against the test server. `->` marks a line from the suite, and `<-` a line from the driver. After the `buddies` reply, Alice sends `hello` through the test server, and the driver writes the `im` event. After the `sendIm` reply, Alice signs off, and the driver writes the `buddy` event:

```
-> {"id":1,"op":"signOn","host":"127.0.0.1","port":62845,"screenName":"Bot","password":"botpass1"}
<- {"id":1,"ok":true}
<- {"event":"online"}
-> {"id":2,"op":"buddies"}
<- {"id":2,"ok":true,"buddies":[{"screenName":"Alice","online":true,"away":false}]}
<- {"event":"im","from":"Alice","text":"hello"}
-> {"id":3,"op":"sendIm","to":"Alice","text":"hi"}
<- {"id":3,"ok":true}
<- {"event":"buddy","screenName":"Alice","online":false,"away":false}
-> {"id":4,"op":"signOff"}
<- {"event":"signedOff","reason":"signed-off"}
<- {"id":4,"ok":true}
-> {"id":5,"op":"exit"}
<- {"id":5,"ok":true}
```
