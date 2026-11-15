# SNAC

A SNAC is the payload of a FLAP data frame: a 10-byte header, then a body whose layout depends on the family and the subtype (`src/wire/snac.ts`).

## The header

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Family |
| 2 | 2 | Subtype |
| 4 | 2 | Flags |
| 6 | 4 | Request id |
| 10 | rest | Body |

The probe request with request id 9 is `00 01 00 1f 00 00 00 00 00 09`: family 0x0001, subtype 0x001F, no flags and no body (`test/vectors/snac.json`). The core never sends this SNAC, for the reason in [Quirks](quirks.md). Pages and code name a SNAC by its family and subtype, as in 0x01/0x1F.

When flag 0x8000 is set, a u16 length and that many bytes of TLVs come between the header and the body. `decodeSnac` skips them, and reads no other flag. In `00 13 00 1c 80 00 00 00 00 00`, then `00 06 00 01 00 02 00 03`, then `ca fe`, the body is `ca fe` (`test/vectors/snac.json`, [wire/frames.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/frames.go#L53-L67)).

## Families

| Family | Name | What it carries |
| --- | --- | --- |
| 0x0001 | OService | The connection itself: host online, versions, rate classes, service requests, self info, warnings |
| 0x0002 | Locate | The profile, the away message and the capabilities |
| 0x0003 | Buddy | Arrivals (0x03/0x0B) and departures (0x03/0x0C) |
| 0x0004 | ICBM | IMs, typing events, warnings and channel 2 proposals |
| 0x0007 | Admin | Account settings |
| 0x0008 | Popup | Notices from the server |
| 0x000D | ChatNav | Finding and creating rooms |
| 0x000E | Chat | One room, on its own connection |
| 0x000F | ODir | The directory |
| 0x0010 | BART | Buddy icons |
| 0x0013 | Feedbag | The stored buddy list |
| 0x0017 | BUCP | The login |

The numbers come from `src/wire/constants.ts`, `src/wire/feedbag.ts`, `src/wire/admin.ts`, `src/wire/odir.ts` and `src/wire/bart.ts`. Before client online, the client tells the server which families it will use and at which version. See [Sign-on](sign-on.md).

## Request ids

The client picks the request id. The core counts from 1 on each connection, up to 0x7FFFFFFF, then starts at 1 again (`src/wire/connection.ts`). A reply carries the id of its request.

A SNAC the server sends of its own accord has the high bit set, as in `00 01 00 13 00 00 80 00 00 00` ([wire/frames.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/frames.go#L58-L62), `test/vectors/snac.json`). The core uses that bit to tell a self info update from the server apart from the reply to its own user info query (`src/client/sign-on.ts`).

The id alone does not make a SNAC a reply. OOS relays a peer's typing event and a peer's client error with the request id that peer chose, which can equal one of the client's own ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L425-L430), [foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L443-L450)). So the core also checks the family and the subtype of a reply, and for an IM, the cookie in the acknowledgment (`src/client/bos-link.ts`, `src/client/messaging.ts`).

## Errors

Subtype 0x0001 is the error in every family. Its body is a u16 code, then optional TLVs ([wire/frames.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/frames.go#L10-L13), `decodeSnacError`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Error code |
| 2 | rest | TLVs. In ICBM errors, TLV 0x08 holds a u16 subcode. |

The ICBM error `00 04 00 08 00 02 00 0f` has code 0x0004 and subcode 0x000F (`test/vectors/snac.json`). [ICBM](icbm.md) lists what the IM codes mean.

The core takes an error in the family of a request, with the request's id, as the answer to that request. During sign-on, such an error ends the attempt with the failure `refused` and the code (`src/client/sign-on.ts`). A body too short to hold a code reads as code 0 (`src/client/messaging.ts`, `src/wire/chatnav.ts`).
