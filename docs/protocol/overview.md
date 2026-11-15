# Protocol overview

These pages describe OSCAR as Open OSCAR Server (OOS) speaks it and as the core of open-oscar-client-kit implements it. The core is the part of the source that is copied from the OSCAR client library that Chimr uses, and `.github/core-paths.txt` lists its paths. It holds the wire codec, the client, the data model, the code of the test server, the byte vectors and the tests of these parts. Each fact names the core file that implements it, or the OOS source at commit `7bdd674`, the commit that the server-made vectors in `test/vectors` come from.

## Layers

A connection is TCP. Every byte on it belongs to a [FLAP](flap.md) frame. A data frame carries one [SNAC](snac.md), a request or a reply in a numbered family. Most SNAC bodies end in a list of [TLVs](tlv.md), fields that carry their own tag and length.

Every integer is big-endian (`src/wire/bytes.ts`). A string carries a length before it: one byte for a screen name, two bytes for a password key or a feedbag item name. The text of a string is UTF-8, unless a field names another charset.

## Connections

A session uses more than one connection, each one with a role:

| Connection | Role | Opened with |
| --- | --- | --- |
| Auth | Checks the password and issues a cookie. | No cookie |
| BOS | Carries the session: IMs, buddy arrivals, the feedbag. | The cookie from auth |
| A service | ChatNav finds rooms, a Chat connection holds one room, BART carries buddy icons, Admin changes account settings. | A cookie from BOS |

The client asks BOS for a service with SNAC 0x01/0x04, which names the family. The reply, 0x01/0x05, holds the address in TLV 0x05 and a cookie in TLV 0x06 (`src/client/service.ts`, `src/wire/oservice.ts`).

OOS serves auth, BOS and the services on one listener. The first frame the client sends decides the role: with a cookie in TLV 0x06 it is BOS or a service, with no cookie it is a login ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L217-L221)). So the address the client first dialed is always a valid place to go, and the core can use it in place of an address the server advertises (`src/wire/connection.ts`).

## A session from start to end

1. The client connects to auth. It sends the screen name, gets a key, and sends a hash of the key and the password. The server answers with the BOS address and a cookie, and the client closes the connection.
2. The client connects to BOS with the cookie. The server lists its families, and the client reads the rate classes, the profile limits, the IM limits and the feedbag.
3. The client sends client online. From then on it is visible to its buddies.
4. While online, IMs, typing events, arrivals and feedbag changes come as SNACs. The client sends a keepalive frame every 60 s and a liveness query every 90 s (`src/wire/connection.ts`).
5. The session ends with a sign-off frame from either side, or when the connection drops.

[Sign-on](sign-on.md) gives steps 1 to 3 SNAC by SNAC. [Staying signed on](../guides/staying-signed-on.md) covers what the core does after a drop.

## The pages

- [FLAP](flap.md): the frame, its types and its sequence numbers.
- [SNAC](snac.md): the header, the families, request ids and errors.
- [TLV](tlv.md): the field layout, and the tags a client meets most.
- [Sign-on](sign-on.md): the login, the BOS cookie, the order before client online, and how error 0x1D can mean the login limit or the session cap.
- [ICBM](icbm.md): IMs, auto-responses, typing events, warnings and room invitations.
- [Feedbag](feedbag.md): the stored buddy list, its items and how a client edits it.
- [Quirks](quirks.md): OOS behavior that no specification describes, and what the core does about it.

The [API reference](../api/README.md) documents the codec functions these pages name, which `open-oscar-client-kit/wire` exports.
