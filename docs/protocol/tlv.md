# TLV

A TLV is a tag, a length and a value. Most SNAC bodies end in a list of TLVs, so a reader can skip a tag it does not know (`src/wire/tlv.ts`).

## Layout

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | Tag |
| 2 | 2 | Length of the value |
| 4 | length | Value |

The value has no type on the wire. The tag and the place it appears decide how to read it:

| Bytes | Value |
| --- | --- |
| `00 4a 00 01 03` | Tag 0x4A, the u8 3 |
| `00 08 00 02 00 1d` | Tag 0x08, the u16 0x001D |
| `00 01 00 06 62 6f 74 6f 6e 65` | Tag 0x01, the text `botone` |
| `00 03 00 00` | Tag 0x03, empty |

These come from `test/vectors/tlv.json`. An empty TLV is a flag: its presence is the whole message.

`tlvU8`, `tlvU16` and `tlvU32` read a number from the first TLV with a tag, and give `undefined` when there is no such TLV or its value is too short. `tlvStr` reads the value as UTF-8 (`src/wire/tlv.ts`).

## Lists

A list of TLVs has one of these forms ([wire/tlv.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/tlv.go#L100-L117)):

| Form | Prefix | Example in the protocol | Core functions |
| --- | --- | --- | --- |
| Rest | None. The TLVs run to the end of the body. | A login reply | `encodeTlvs`, `decodeTlvs` |
| Count | A u16 count of TLVs | The user info block | `encodeTlvBlock`, `decodeTlvBlock` |
| Length | A u16 count of bytes | The attributes of a feedbag item | `encodeTlvs` after a u16 length |

`00 02 00 01 00 02 04 10 00 03 00 04 6a b1 3b 80` is a count list of 2 TLVs. `00 06 00 01 00 02 00 03` is a length list of 6 bytes that holds one TLV (`test/vectors/tlv.json`).

`decodeTlvs` throws when a TLV runs past the end of its bytes. Channel 2 messages come from other clients, so the core reads their TLVs with `tolerantTlvs`, which stops at the first TLV that does not fit (`src/wire/icbm.ts`).

## The user info block

Many SNACs describe a user with the same block: an arrival, a received IM, self info and a warning notice (`decodeUserInfo` in `src/wire/snac.ts`, [wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L2801-L2805)).

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Length of the screen name, n |
| 1 | n | Screen name, as the user formats it |
| 1+n | 2 | Warning level, in tenths of a percent |
| 3+n | 2 | Count of TLVs |
| 5+n | rest | TLVs |

`05 41 6c 69 63 65 00 00 00 02 00 01 00 02 00 10 00 03 00 04 6a b1 3b 80` is `Alice` at warning level 0, with flags 0x0010 and a sign-on time (`test/vectors/icbm.json`, inside the body of a received IM).

## Tags a client meets most

In a user info block (`src/wire/constants.ts`, `src/wire/buddy.ts`):

| Tag | Value |
| --- | --- |
| 0x01 | User flags, u16. 0x0020 is away, 0x0080 is a mobile device, 0x0400 is a bot. |
| 0x03 | Sign-on time, u32 seconds since the epoch |
| 0x04 | Idle time, u16 minutes |
| 0x06 | Status, u32. 0x00000100 is invisible. |
| 0x0D | Capabilities, 16 bytes each |
| 0x1D | Buddy icon hashes |

In the login request and reply (`src/wire/constants.ts`):

| Tag | Value |
| --- | --- |
| 0x01 | Screen name |
| 0x03 | Client ID text |
| 0x05 | BOS address, `host:port` |
| 0x06 | Cookie |
| 0x08 | Error code, u16 |
| 0x25 | Password hash, 16 bytes |
| 0x4A | Multi-connection flag, u8 |
| 0x8E | Whether the server expects TLS, u8 |

In an IM (`src/wire/constants.ts`):

| Tag | Value |
| --- | --- |
| 0x02 | The message, as fragments |
| 0x03 | Empty. The sender asks for an acknowledgment. |
| 0x04 | Empty. The message is an auto-response. |
| 0x05 | Channel 2 data, such as a room invitation |
| 0x06 | Empty. The server stores the message if the recipient is offline. |
| 0x16 | Send time, u32 seconds, on a stored message |

[Sign-on](sign-on.md) and [ICBM](icbm.md) show these TLVs in their SNACs. The feedbag uses TLVs as item attributes, listed in [Feedbag](feedbag.md).
