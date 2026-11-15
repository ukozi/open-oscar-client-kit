# ICBM

ICBM, family 0x0004, carries messages between users. An ICBM has a channel: channel 1 is an IM, and channel 2 is a proposal, such as a room invitation. The codec is `src/wire/icbm.ts`, and the core's IM logic is `src/client/messaging.ts`.

## Sending an IM

The client sends 0x04/0x06:

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 8 | Cookie, the message's id |
| 8 | 2 | Channel, 1 |
| 10 | 1 | Length of the recipient's screen name, n |
| 11 | n | Recipient |
| 11+n | rest | TLVs |

The TLVs the core writes (`encodeImToHost`):

| TLV | Value |
| --- | --- |
| 0x02 | The message, as fragments |
| 0x03 | Empty: send an acknowledgment |
| 0x06 | Empty: store the message if the recipient is offline. By default, the core writes it in every IM. With the send option `store: 'when-offline'`, the core writes it only when the recipient's presence is offline, and in the second copy that it sends after error 0x0004 ([Bot etiquette](../guides/bot-etiquette.md)). |
| 0x04 | Empty, and only in an auto-response |

An IM to `alice` without the store TLV is `11 22 33 44 55 66 77 88 00 01 05 61 6c 69 63 65`, then TLV 0x02 with 17 bytes of fragments, then `00 03 00 00` (`test/vectors/icbm.json`).

The cookie is 8 random bytes. The core never uses 0, which server notices and TOC clients use on OOS to mean no id (`newCookie`).

### Fragments

The value of TLV 0x02 is a list of fragments, back to back. Each fragment:

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Fragment id: 5 for capabilities, 1 for text |
| 1 | 1 | Version. The core writes 1. |
| 2 | 2 | Length of the payload, n |
| 4 | n | Payload |

The core writes a capabilities fragment, id 5 with the payload `01 01 02`, then a text fragment, id 1 (`encodeImFragments`). The payload of the text fragment:

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Charset |
| 2 | 2 | Language, 0 |
| 4 | rest | Text |

`hi` in ASCII is `05 01 00 03 01 01 02`, then `01 01 00 06 00 00 00 00 68 69` (`test/vectors/icbm.json`). On a received IM, `decodeImFragments` skips every fragment but the text ones, and the core joins their texts.

| Charset | Text |
| --- | --- |
| 0 | ASCII |
| 2 | UTF-16BE |
| 3 | Latin-1 |

The core sends charset 0 when every character is 7-bit ASCII, and charset 2 otherwise (`encodeImText` in `src/wire/text.ts`). The text is AIM's form of HTML, which `src/client/aim-html.ts` writes and reads. The longest IM the server takes comes from the ICBM limits at sign-on, and the core refuses a longer one before it sends it. See [Sign-on](sign-on.md).

### The answer

With TLV 0x03 in the IM, OOS answers with an acknowledgment, 0x04/0x0C ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L293-L306), `decodeHostAck`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 8 | Cookie, the same as the IM's |
| 8 | 2 | Channel |
| 10 | 1 | Length of the recipient's screen name, n |
| 11 | n | Recipient |

The acknowledgment of the IM to `alice` above is `11 22 33 44 55 66 77 88 00 01 05 61 6c 69 63 65` (`test/vectors/icbm.json`). Or OOS answers with the error 0x04/0x01. The core takes the acknowledgment whose cookie matches, or an error with the IM's request id, and waits up to 15 s (`src/client/messaging.ts`).

| Error | When OOS sends it | Core reason |
| --- | --- | --- |
| 0x0004 | The recipient is offline and cannot get stored IMs, or blocks the sender | `unavailable` |
| 0x0004 with subcode 0x000F | The recipient's store of offline IMs is full | `offlineInboxFull` |
| 0x0010 | The sender blocks the recipient | `youBlocked` |

OOS answers 0x0004 to a blocked sender, the same as for an offline name, so the sender cannot tell a block from an absence ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L104-L136), [foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L282-L291), `imFailureReason`).

## Receiving an IM

The server sends 0x04/0x07:

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 8 | Cookie |
| 8 | 2 | Channel |
| 10 | varies | The sender's [user info block](tlv.md) |
| after it | rest | TLVs |

OOS copies the sender's TLVs into the IM, except 0x03, 0x06 and 0x16 ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L159-L199)). So TLV 0x04 reaches the recipient, and the core reads it as an auto-response (`src/client/messaging.ts`).

The core tells received IMs apart:

- A stored IM carries TLV 0x16, the time it was sent in seconds. OOS adds it when it replays the IM, after the client asks with 0x04/0x10 ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L565-L583)). The stored IMs arrive before the reply 0x04/0x17 that ends the retrieval.
- A server notice has a user info block with no TLVs, and no send time. The program can also name a sender whose IMs count as notices (`isServerNotice`).
- Every other IM is live.

## Auto-responses

While the session has an away message, the core answers the first live IM from each name with the away message, once in each away period. The answer is an IM with TLV 0x04. The core never answers an auto-response, a stored IM or a server notice, so two away clients do not answer each other without end (`src/client/messaging.ts`). Before the core sends the answer, it replaces `%n`, `%d` and `%t` with the screen name of the one who wrote, the date and the time, and cuts the text to the IM limit (`src/model/aim-variables.ts`, `truncateToFit` in `src/client/messaging.ts`).

## Typing events

Both directions use 0x04/0x14 (`encodeTyping`, `decodeTyping`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 8 | Cookie. The core sends 0. |
| 8 | 2 | Channel, 1 |
| 10 | 1 | Length of the screen name, n |
| 11 | n | Screen name: the recipient when sent, the typist when received |
| 11+n | 2 | Event: 0 stopped, 1 typed and paused, 2 typing |

`00 00 00 00 00 00 00 00 00 01 05 61 6c 69 63 65 00 02` is "typing", for `alice` (`test/vectors/icbm.json`).

OOS relays a typing event unless one of the two users blocks the other ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L415-L441)). It adds the empty TLV 0x0B to the IMs of a session that wants typing events. It reads that wish from the account's buddy preferences item, and without the item the session wants none ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L201-L204), [foodgroup/feedbag.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/feedbag.go#L1004-L1013)). After sign-on, the core inserts that item when the list has none, and turns the typing preference on when the item turns it off (`src/client/feedbag.ts`). [Feedbag](feedbag.md) shows where the preference sits.

## Warnings

A warning is 0x04/0x08 (`encodeWarn`, [wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L995-L998)):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | 0 for a warning that names the warner, 1 for an anonymous one. The core writes 0. |
| 2 | 1 | Length of the screen name, n |
| 3 | n | The screen name to warn |

The reply is 0x04/0x09 (`decodeWarnReply`, [wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L1000-L1003)):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | The increase, in tenths of a percent |
| 2 | 2 | The new level, in tenths of a percent |

Two bodies from `test/vectors/hand-lists-info.json`:

| Bytes | Meaning |
| --- | --- |
| `00 00 03 62 6f 62` | Warn `bob`, naming the warner |
| `00 64 00 64` | An increase of 10%, to a level of 10% |

OOS answers error 0x000D when it refuses a warning: the name is a bot, it is at 100%, or the warner has warned it too often for the IMs it has had from it ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L492-L519)). The core's `warn` sends the request in every case, and fails with a `refused` error that holds the code when the server refuses. `canWarn` tells the program whether OOS will accept a warning by the last of those rules. It is true when the client has had more live IMs from that name in the last hour than it has warned that name, counting up to three of each. It does not check the bot flag or the name's level (`src/client/messaging.ts`).

The warned user gets 0x01/0x10 (`decodeEvilNotification` in `src/wire/oservice.ts`):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | The new level, in tenths of a percent |
| 2 | rest | The warner's [user info block](tlv.md). It is absent for an anonymous warning. |

`00 64 03 42 6f 62 00 00 00 00` is a warning from `Bob` that leaves the level at 10%. `00 1e` is an anonymous warning that leaves the level at 3% (`test/vectors/hand-lists-info.json`). [Rate limits and warnings](../guides/rate-limits.md) covers what a warning does to a name's sending.

## Room invitations on channel 2

Channel 2 carries proposals between clients. The core reads room invitations here. Direct IM and file offers also travel on channel 2, and `src/client/rendezvous.ts` handles them.

An invitation is an ICBM on channel 2 whose TLV 0x05 holds this value (`encodeChatInviteFragment`, [wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L851-L862)):

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Type: 0 proposal, 1 cancel, 2 accept |
| 2 | 8 | Cookie, the same as the ICBM's |
| 10 | 16 | Capability. For a room, `748F2420-6287-11D1-8222-444553540000`. |
| 26 | rest | TLVs |

The TLVs of an invitation:

| TLV | Value |
| --- | --- |
| 0x0A | Sequence, u16 1 |
| 0x0C | The invitation's text |
| 0x0D | The text's charset, such as `us-ascii` |
| 0x0E | The text's language, such as `en` |
| 0x2711 | The room, in the layout below |

The value of TLV 0x2711:

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Exchange |
| 2 | 1 | Length of the room cookie, n |
| 3 | n | Room cookie |
| 3+n | 2 | Instance. The core writes 0. |

In the invitation in `test/vectors/icbm.json`, TLV 0x2711 is `00 04 0c 34 2d 30 2d 74 65 73 74 72 6f 6f 6d 00 00`: exchange 4, the room cookie `4-0-testroom`, and instance 0. A room cookie starts with the exchange, and the room name follows its second dash. `parseInvite` accepts exchange 4 or 5 only, and needs the room capability (`src/wire/icbm.ts`, `roomFromCookie` in `src/wire/chatnav.ts`).

The core sends its invitations with an empty TLV 0x03 after TLV 0x05, and the text as ASCII with HTML entities for other characters (`encodeChatInvite`). It reports a received invitation to the program, which can join the room through ChatNav or decline (`src/client/rooms.ts`). A decline is a cancel with the same cookie and TLV 0x0B, the reason, u16 1 (`encodeChatInviteCancel`).

The cancel keeps the full 26-byte head, with the capability, though it carries no room. OOS reads the head of every channel 2 TLV 0x05 it relays, and a shorter value fails that read ([foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L182-L186), [foodgroup/icbm.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/icbm.go#L311-L320)). The core's note on `encodeChatInviteCancel` records that the server then signs the sender off.
