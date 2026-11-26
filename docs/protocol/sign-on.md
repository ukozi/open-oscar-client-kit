# Sign-on

A sign-on takes two connections. The login connection checks the password and returns a cookie. The BOS connection presents the cookie and becomes the session. The core does the login in `src/wire/auth.ts` and the rest in `src/client/sign-on.ts`.

## The login

The core takes a slot from the login budget before it connects (`src/client/login-budget.ts`). After the FLAP signons, with no cookie in the client's, the login is BUCP, family 0x0017:

1. The client sends the challenge request, 0x17/0x06, with the screen name in TLV 0x01.
2. The server answers with the challenge response, 0x17/0x07, which holds a key. For a name it does not know, OOS answers with a login reply that holds error 0x0001 ([foodgroup/auth.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/auth.go#L264-L292)).
3. The client sends the login request, 0x17/0x02, with the hash of the key and the password.
4. The server answers with the login reply, 0x17/0x03: the BOS address and a cookie, or an error code.
5. The client closes the login connection.

The core waits up to 20 s for each answer (`REQUEST_TIMEOUT_MS` in `src/wire/constants.ts`).

### The key

The body of the challenge response, 0x17/0x07 (`bucpLogin` in `src/wire/auth.ts`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Length of the key, n |
| 2 | n | Key |

`00 0a 61 75 74 68 6b 65 79 34 35 36` is the key `authkey456` (`test/vectors/auth.json`).

### The hash

The client never sends the password. It sends this 16-byte hash in TLV 0x25 (`strongHash` in `src/wire/auth.ts`, [wire/user.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/user.go#L19-L30)):

```
MD5( key + MD5(password) + "AOL Instant Messenger (SM)" )
```

The key, the password and the fixed text go in as UTF-8 bytes. For the password `password123` and the key `authkey456`, the hash is `b90791cccb5c5771bdcbc93982f79484` (`test/vectors/auth.json`).

### The login request

The core sends these TLVs, in this order (`bucpLogin` in `src/wire/auth.ts`):

| TLV | Value |
| --- | --- |
| 0x01 | Screen name |
| 0x25 | The hash |
| 0x03 | Client ID, a text such as `echo-bot (open-oscar-client-kit), version 0.1.2/LINUX` (`src/client/client-id.ts`, `lib/session.ts`) |
| 0x4A | Multi-connection flag, u8 0x01: this client can share the account with other sessions |
| 0x133A | Cookie lifetime in seconds, u32. Only when the program sets `tokenTtlSeconds`. |

### The login reply

On success the reply holds the screen name as the server formats it in TLV 0x01, the BOS address in TLV 0x05, the cookie in TLV 0x06, and whether BOS expects TLS in TLV 0x8E ([foodgroup/auth.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/auth.go#L693-L698)). On failure it holds the error code in TLV 0x08. `parseLoginReply` reads both, and `loginFailure` turns a code into the failure the session reports (`src/wire/auth.ts`, `src/client/sign-on.ts`):

| Code | Failure |
| --- | --- |
| 0x0001, 0x0007 | `unknown-screen-name` |
| 0x0005 | `wrong-password` |
| 0x0008 | `unknown-screen-name` for an all-digit ICQ number, otherwise `account-unavailable` |
| 0x0009, 0x0011, 0x0022 | `account-unavailable` |
| 0x001D | `login-rate-limited` or `too-many-sessions`, as the next section explains |
| Any other | `refused`, with the code |

## Error 0x1D

OOS sends error 0x001D for the login limit and for the session cap. The core tells them apart by when it comes (`loginFailure` in `src/client/sign-on.ts`).

The login limit counts logins from each source address. Over the limit, OOS answers before it reads the challenge request ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L415-L436)). So a 0x1D that comes before the client has sent its login request is the login limit, `login-rate-limited`. It can come as a login reply SNAC or as a FLAP signoff, and the core reads both (see [the quirk](quirks.md#the-login-limit-answers-as-bucp-after-one-bucp-login)). [Staying signed on](../guides/staying-signed-on.md) gives the limit's numbers.

The session cap counts the sessions of one account. When the login request carries multi-connection flag 0x01 and the account already has 5 sessions, OOS answers the login request with 0x1D ([foodgroup/auth.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/auth.go#L631-L640)). So a 0x1D after the login request is the session cap, `too-many-sessions`.

The cap can also stop a session at BOS, when other sessions sign on between the login and BOS. OOS then sends a FLAP signoff with TLV 0x08 that holds the u8 0x18 ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L269-L281)). The core reads TLV 0x08 of either width on a BOS signoff as the session cap (`dropEvidence` in `src/client/reconnect.ts`). The two signoffs are `2a 04 00 65 00 06 00 08 00 02 00 1d` from the login limit and `2a 04 00 65 00 05 00 08 00 01 18` from the session cap (`test/vectors/flap.json`).

## The BOS cookie

The cookie is opaque to the client, which sends it back in TLV 0x06 of its signon on BOS. OOS signs it, and pads it to 256 bytes ([state/cookie.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/cookie.go#L53-L85)). `readOosCookieExpiry` reads the expiry time from its head (`src/wire/auth.ts`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Length of the data after this field. The core reads no expiry when it is less than 4 or longer than the rest of the cookie. |
| 2 | 4 | Expiry time, in seconds since 1970 |

The head `00 04 6a df 02 40` gives an expiry time of 1793000000 (`test/unit/wire/token-ttl.test.ts`).

The address in TLV 0x05 is the host OOS is set to advertise. OOS's default settings advertise 127.0.0.1:5190, which only works for a client on the same machine ([config/settings.env](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/config/settings.env#L34)). So the core connects to the advertised address only when it is routable, or when the client also dialed a loopback address. Otherwise it connects to the address it dialed for the login (`decideRedirect` in `src/wire/connection.ts`). The program can fix the BOS address with `pinRedirects` (`src/client/sign-on.ts`).

## Before client online

On BOS, the core sends these SNACs in this order (`bringUp` in `src/client/sign-on.ts`). Each step that has a reply waits for it. An error SNAC in the step's family ends the attempt with the failure `refused`.

1. The server sends host online, 0x01/0x03, which lists the families it serves.
2. The client sends its versions, 0x01/0x17, for 0x0001, 0x0002, 0x0003, 0x0004 and 0x0013, and for 0x0010 when host online listed it. The server answers with its versions, 0x01/0x18.
3. The client asks for the rate classes, 0x01/0x06, and reads the reply, 0x01/0x07. It subscribes to every class with 0x01/0x08. [Rate limits and warnings](../guides/rate-limits.md) covers what the classes do.
4. The client asks for the Locate limits, 0x02/0x02, and reads the reply, 0x02/0x03. It writes its capabilities, its profile and any away message with 0x02/0x04.
5. The client asks for the ICBM limits, 0x04/0x04, and reads the reply, 0x04/0x05.
6. The client reads the feedbag limits, 0x13/0x02, and the feedbag, 0x13/0x04, then sends 0x13/0x07 to start using it. See [Feedbag](feedbag.md).
7. When the server granted OService version 4 or later, the client asks for its own user info, 0x01/0x0E, to see its other sessions.
8. The client writes what must hold before its buddies see it: invisible status with 0x01/0x1E, then idle time with 0x01/0x11, each only when the program asks for it. A program that keeps an away record writes it between the two (`src/client/away-record.ts`).
9. The client sends client online, 0x01/0x02. This SNAC has no reply.
10. The client asks for its own user info, 0x01/0x0E. The reply, 0x01/0x0F, holds a user info block, and the session is online.

After that, the core asks for stored IMs with 0x04/0x10, and writes the typing preference if the list needs it (`src/client/oscar-client.ts`).

The core sends client online after the writes in step 8 because OOS tells the account's buddies about the session when client online arrives ([foodgroup/oservice.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/oservice.go#L776-L786)). Status written after it reaches them as a change.

### The version and online bodies

Host online is a list of families (`decodeHostOnline` in `src/wire/oservice.ts`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Family |

The 2 bytes repeat for each family. `00 18 00 10 00 03 00 13 00 04 00 15 00 02 00 01 00 09 00 0a 00 06 00 08 00 0b` is host online on BOS, with families 0x0018, 0x0010, 0x0003 and so on (`test/vectors/oservice.json`).

Client versions and the server's versions have the same body (`encodeClientVersions`, `decodeHostVersions`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Family |
| 2 | 2 | Version |

The 4 bytes repeat for each family. Client versions with each family at version 1, for the first four families, is `00 01 00 01 00 02 00 01 00 03 00 01 00 04 00 01` (`test/vectors/oservice.json`). The client asks for OService version 1 unless the program sets `oserviceVersion`, and uses the lower of that and the server's (`src/client/sign-on.ts`).

Client online repeats each family and version, and adds a tool id and a tool version (`encodeClientOnline` in `src/wire/oservice.ts`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Family |
| 2 | 2 | Version |
| 4 | 2 | Tool id, 0x0110 |
| 6 | 2 | Tool version, 0x0629 |

The 8 bytes repeat for each family: `00 01 00 01 01 10 06 29`, then `00 02 00 01 01 10 06 29`, and so on (`test/vectors/oservice.json`).

### The ICBM limits

The reply to 0x04/0x04 is fixed fields (`decodeIcbmParams` in `src/wire/icbm.ts`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Slots |
| 2 | 4 | Flags |
| 6 | 2 | Longest IM the server takes, in bytes |
| 8 | 2 | Highest warning level of a sender |
| 10 | 2 | Highest warning level of a recipient |
| 12 | 4 | Shortest interval between IMs |

`00 64 00 00 00 03 02 00 03 e7 03 e7 00 00 00 00` gives 100 slots, flags 3 and IMs of up to 512 bytes (`test/vectors/hand-session.json`). The core uses 512 when the field is 0 or the reply does not decode, and refuses a longer IM before it sends it (`src/client/sign-on.ts`, `src/client/messaging.ts`).
