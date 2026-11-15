# FLAP

FLAP is the framing layer. Every byte on an OSCAR connection belongs to a FLAP frame, and a frame starts with a 6-byte header (`src/wire/flap.ts`).

## The frame

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Start marker, always 0x2A |
| 1 | 1 | Frame type |
| 2 | 2 | Sequence number |
| 4 | 2 | Payload length |
| 6 | length | Payload |

A keepalive with sequence number 7 is `2a 05 00 07 00 00`. A data frame with sequence number 5 that holds a 10-byte SNAC is `2a 02 00 05 00 0a`, then the SNAC (`test/vectors/flap.json`).

The payload is at most 0xFFF9 bytes. `encodeFlap` refuses a longer one, and OOS has the same limit ([wire/frames.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/frames.go#L23-L33)).

`FlapDecoder` collects bytes until a whole frame is there. A frame that does not start with 0x2A is an error, and the core closes the connection (`src/wire/connection.ts`).

## Frame types

| Type | Name | Payload |
| --- | --- | --- |
| 0x01 | Signon | The FLAP version, then TLVs |
| 0x02 | Data | One SNAC |
| 0x03 | Error | OOS defines it ([wire/frames.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/frames.go#L15-L21)). The core skips it. |
| 0x04 | Signoff | TLVs, or nothing |
| 0x05 | Keepalive | Nothing |

The type is also called the channel. It is not the same thing as an ICBM channel, which is a field inside an [IM](icbm.md).

## Signon

The server speaks first, with a signon frame whose payload is the FLAP version, u32 1. The client answers with its own signon frame. If the server's first frame is not a signon, the core closes the connection (`src/wire/connection.ts`).

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 4 | FLAP version, 1 |
| 4 | rest | TLVs |

On a login connection the client's signon has no TLVs. On BOS and on a service it holds the cookie in TLV 0x06. The client signon `2a 01 00 00 00 0c 00 00 00 01 00 06 00 04 de ad be ef` carries a 4-byte cookie (`test/vectors/flap.json`). OOS sends its signon before it reads the client's, and routes the connection on that TLV ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L206-L221)).

## Sequence numbers

Each side numbers its own frames. The core starts each connection at 0 and adds 1 for every frame it sends, signon and keepalive included, and wraps from 0xFFFF to 0 (`src/wire/connection.ts`). OOS starts its count at 100 ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L206)). The core reads the server's sequence numbers and does not check them.

## Keepalive

The core sends a keepalive frame every 60 s on each connection (`KEEPALIVE_INTERVAL_MS` in `src/wire/constants.ts`). A keepalive gets no answer, so it tells the client nothing about the server. For that, the core sends the user info query, SNAC 0x01/0x0E, every 90 s, and closes the connection when no reply with that request id comes in 20 s (`src/wire/connection.ts`).

## Signoff

The core ends a connection with an empty signoff frame, then closes the socket (`src/wire/connection.ts`).

A signoff from the server can carry TLVs that say why:

| TLV | Value | What the core does |
| --- | --- | --- |
| 0x09 | Disconnect reason, u8 | Ends the session with `signed-off-by-server`. |
| 0x08 | Error code, u16 or u8 | Reads it as the login error on an auth connection, and as the session cap on BOS. See [Sign-on](sign-on.md). |
| 0x0B | A URL for more information | Nothing. |

The signoff OOS sends when it closes a session and keeps running is `2a 04 00 65 00 32`, then TLV 0x09 with the value 0x01 and TLV 0x0B with OOS's project URL ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L643-L658), `test/vectors/flap.json`). A signoff with no TLVs, such as the one OOS sends when it shuts down, leads to a reconnect ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L660-L669), `src/client/reconnect.ts`).

### The short signoff

To a session with multi-connection flag 0, OOS ends with a signoff of 4 bytes, with no length field, then the end of the connection ([wire/frames.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/frames.go#L166-L183), [server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L643-L669)):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Start marker, 0x2A |
| 1 | 1 | Frame type, 0x04 |
| 2 | 2 | Sequence number |

`2a 04 00 65` is a short signoff with sequence number 101 (`test/vectors/flap.json`). The core logs in with flag 0x01, so its BOS connection gets the full signoff, but the core meets the short one at the end of every chat connection (`src/wire/flap.ts`). A decoder that waits for the length field never sees this frame. `FlapDecoder.end()` reads 4 bytes left over at the end of the connection as a signoff with `truncated: true` (`src/wire/flap.ts`).
