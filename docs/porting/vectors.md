# Byte vectors

The vector files hold named byte strings for a codec's tests. The tests of this repository read them through `test/support/vectors.ts`, and a port can load the same files into its tests.

## The files

In the repository, the files are in `test/vectors/`. The build copies them into `dist/test/vectors/` (`package.json`), so after `npm install open-oscar-client-kit` they are in `node_modules/open-oscar-client-kit/dist/test/vectors/`. A port with no Node can copy them from the repository at a release tag, such as `v0.1.2`.

## The shape

Each file is one JSON object (`test/support/vectors.ts`):

```ts
type VectorFile = { source: string; vectors: Vector[] };
type Vector = { name: string; hex: string; note?: string; inputs?: Record<string, string> };
```

| Field | Meaning |
| --- | --- |
| `source` | Where the bytes come from: an Open OSCAR Server (OOS) commit and the code that produced them, a capture from an AIM client, a layout assembled by hand, or the core's `encodeFeedbagItems`. |
| `name` | The vector's name, unique in its file. |
| `hex` | The bytes, as lowercase hex with no spaces. |
| `note` | The layout of the bytes, or the OOS file and line that the value comes from. |
| `inputs` | The values that produced the bytes. Every value is a string, such as `"0x5a17"`, `"0"` or `"false"`. |

A vector whose name holds the word `body` holds a SNAC body, with no FLAP or SNAC header in front of it. `flap.json` holds whole frames, and `snac.json` holds SNAC headers.

From `flap.json`, a FLAP sign-on frame:

```json
{ "name": "server signon, sequence 100", "hex": "2a010064000400000001" }
```

From `auth.json`, the password hash with its inputs:

```json
{
  "name": "strong hash, password123 and authkey456",
  "hex": "b90791cccb5c5771bdcbc93982f79484",
  "note": "wire/user_test.go:55",
  "inputs": { "key": "authkey456", "password": "password123" }
}
```

`rooms.json` has another shape. Its `vectors` is an object keyed by name, and each value holds `struct`, the OOS struct that was marshaled, and `hex`.

## The files by source

These files hold bytes that the OOS marshaler produced:

| File | Covers |
| --- | --- |
| `auth.json` | The BUCP password hash, the challenge, the login request, the login replies and the login limiter's reply. |
| `flap.json` | FLAP frames: sign-on, keepalive, sign-off with and without TLVs, and a data frame. |
| `snac.json` | SNAC headers, request ids, the extended-info flag and error bodies. |
| `tlv.json` | TLV values, a block that fills the rest of its bytes, and blocks with a count or a length in front. |
| `icbm.json` | IM text fragments, IMs to and from the host, auto-responses, offline replay, server notices, a room invitation, the host ack and typing events. |
| `locate-buddy.json` | Away text, the chat capability, a buddy add, an arrival and a departure. |
| `oservice.json` | Host online, client versions, rate parameters and rate changes, client online, a user info update, and service requests and replies. |
| `odir.json` | Directory search, keyword list and directory info replies. |
| `rooms.json` | Room creation, ChatNav, chat service requests, room messages, whispers, joins and invitations. |

These files are assembled by hand from the OOS wire layouts:

| File | Covers |
| --- | --- |
| `hand-session.json` | The sign-on SNACs of a full client, feedbag replies, arrivals, a departure and an ICBM error. |
| `hand-lists-info.json` | Feedbag items for buddies, groups, privacy and buddy preferences; profile and away; user info; status; idle; warnings. |
| `hand-icons.json` | Buddy icon ids, icon feedbag items, and BART uploads and downloads. |
| `hand-admin.json` | Admin service queries and replies. |
| `hand-rooms.json` | Room creation, nav info, invitations and declines. |

The rest come from other sources:

| File | Covers |
| --- | --- |
| `hand-rendezvous.json` | Channel 2 messages assembled from their public layouts: Send File proposals, a counter-offer, accepts and cancels; Direct IM and Get File proposals; and a client error body. |
| `hand-oft.json` | OFT headers and file checksums, assembled from the layout in libpurple's source. |
| `hand-odc.json` | ODC frames and payloads, assembled from the layout in libpurple's source. |
| `aim-rendezvous.json` | Channel 2 proposals, a counter-offer, an accept and the client error body of a decline, captured from AIM clients. |
| `aim-oft.json` | OFT headers captured from AIM clients. |
| `aim-odc.json` | ODC frames captured from AIM clients. |
| `aim-get-file.json`, `aim-get-file-lst1.json` | Get File listings, requests and replies, captured on Get File links with AIM clients. `aim-get-file.json` also holds the client error body that AIM 5.1 sends on the server connection to refuse a Get File. AIM wrote some of the vectors and a test client wrote the others. The note of each vector names the writer. |
| `away-record.json` | The away record feedbag item, class 0x0C41, as the core's `encodeFeedbagItems` writes it. |
