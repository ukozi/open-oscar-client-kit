# Quirks

No specification describes the behavior on this page. Each entry is something OOS does that the core works around, taken from a note in the core that cites the OOS source. Links point to OOS at commit `7bdd674`, and the code paths name the core file that holds the workaround.

## Connections and sign-on

### The probe request closes the connection

OService has a probe request, 0x01/0x1F. OOS answers it with a reply that has no body ([foodgroup/oservice.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/oservice.go#L362-L373)). That reply fails to encode, and the server closes the connection. The core never sends the probe. To check that a connection is alive, it sends the user info query, 0x01/0x0E, which every connection answers (`src/wire/constants.ts`, `src/wire/connection.ts`).

### The login limit answers as BUCP after one BUCP login

When a source address is over the login limit, OOS answers with error 0x1D before the login starts. OOS keeps a limiter entry for each address, and marks the entry when a BUCP login from that address gets past the limit. Nothing clears the mark while the entry lasts. With the mark, the answer is a login reply SNAC, and without it the answer is a FLAP signoff with TLV 0x08 ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L415-L452), [server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L707-L734)). A BUCP client can get either. The core reads the code from both, and from TLV 0x08 at either width, u16 or u8 (`src/wire/auth.ts`).

### Login error 0x0008 is ambiguous

OOS defines the code 0x0008 twice: for a deleted account, and for an ICQ number with no account ([wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L123), [wire/snacs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/snacs.go#L131)). The core reads 0x0008 for a screen name of digits as an unknown name, and for any other name as an account that is not available. It tests for digits as OOS does, with Unicode's decimal digits and not only 0 to 9 ([state/user.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/user.go#L97-L108), `isUin` in `src/wire/auth.ts`).

## Feedbag

### One open cluster for each session

OOS keeps one open edit cluster for each session. It starts with 0x13/0x11 and ends with 0x13/0x12 ([state/session.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session.go#L1290-L1297), [state/session.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session.go#L1331-L1345)). Two changes whose clusters overlap would share it. The core runs one change at a time, and writes the start, the edits and the end of a cluster in one turn, so nothing gets between them (`src/client/feedbag.ts`).

### Names come back normalized

OOS stores the name of a buddy, allow or block item in lowercase and with no spaces, whatever the client wrote ([state/user_store.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/user_store.go#L1032-L1038)). The core changes the names in its copy the same way when an edit succeeds, so its copy matches the next read (`src/client/feedbag.ts`).

### The valid mask places the preference bits

OOS finds a buddy preference's byte from the length of attribute 0x00D6, the valid mask, and uses that place in attribute 0x00C9 too, whatever 0x00C9's own length ([wire/buddy_prefs.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/wire/buddy_prefs.go#L260-L280)). The core reads the bits the same way, so it agrees with the server on a mask that another client wrote with two lengths (`buddyPref` in `src/wire/feedbag.ts`).

### The server's block rule

Whether one user blocks another depends on the privacy mode and on the user's lists, in a rule OOS applies in SQL ([state/relationship.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/relationship.go#L109-L116)). The core applies the same rule to its copy of the list (`blocks` in `src/model/privacy.ts`).

## Rooms

### A line that starts with //roll

OOS replaces a room line whose text is `//roll`, with optional dice and sides, by a dice roll from OnlineHost. It reads the first text of the line's HTML, with entities decoded ([foodgroup/chat.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/chat.go#L32-L34), [foodgroup/chat.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/chat.go#L130-L134), [foodgroup/chat.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/chat.go#L193-L215)). `toWireHtml` puts a space in front of a leading `//roll`, so the server relays the line with the space. `isRollCommand` tells whether the server will roll a line, with the server's pattern. In that pattern, Go's `\s` matches ASCII whitespace only, and JavaScript's `\s` also matches U+00A0, so the core writes the characters out (`src/wire/text.ts`).

### A rewritten line keeps its id

When OOS rolls dice for a line, the roll goes out under the message id of the line it replaced, from OnlineHost ([foodgroup/chat.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/chat.go#L60-L68), [foodgroup/chat.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/chat.go#L130-L134)). The core takes the roll as the receipt for its line, and resolves the send with the roll's text (`src/wire/chatroom.ts`, `src/client/rooms.ts`).

OnlineHost is never in a room's roster ([foodgroup/chat.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/chat.go#L21-L30)). A person's screen name can normalize to `onlinehost` too, so the core takes a line from that name as the server's only when it answers one of the client's own lines or the name is not in the roster (`src/wire/chatroom.ts`).

### Room connections end with BOS

When the account's last BOS session ends, OOS removes the user from every room ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L247-L266)). The room connections and BOS can close in either order. When a room connection ends with a signoff or a closed stream, the core waits 2 s before it acts on the close, which leaves time for a BOS close to arrive (`ROOM_CLOSE_SETTLE_MS` in `src/client/rooms.ts`).

### A second connection takes the seat

OOS holds one session for each name in a room. A new connection for the same name and room ends the old one ([state/session_manager.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session_manager.go#L375-L390), [state/session_manager.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session_manager.go#L251-L260)). The core keeps at most one join for each room, and a second call to join the same room gets the first join's result (`src/client/rooms.ts`).

### A stale cookie closes the connection

OOS sends its FLAP signon on a room connection, then reads the cookie in the client's signon ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L206-L221)). When it cannot read the cookie, it closes the connection with no signoff and no SNAC ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L224-L239)). The core reads a close that comes before any SNAC as a stale cookie. It asks ChatNav for the room again, once (`src/client/rooms.ts`).

### The roster has no order

OOS lists a room's occupants by walking a Go map, so their order changes from one list to the next ([state/session_manager.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session_manager.go#L344-L355)). The core keeps the order the server sent, and puts no meaning in it (`src/model/room.ts`).
