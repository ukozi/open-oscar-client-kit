# Changelog

## 0.1.2 - 2026-11-25

### Added

- The `setServices` method and the `services` method of `OscarClient`. `setServices` turns file transfer, Direct IM and Get File on or off while the client runs, and `services` says which are on. A service that is off ignores offers and refuses to start a session, as it does without its option. A session or transfer that runs goes on. Online, the client writes the new capabilities to the server. `setServices` with `true` for a service whose option the client did not get throws a `RangeError`. The `ServiceSwitch` type is exported.
- The `localAddress` option of `OscarClient`. The login (when the client logs in itself), the BOS connection and each peer connection bind this local address. Service connections do not bind. The default lets the system choose.
- The `peerRoute` option of `OscarClient`. The client asks `allowDial` with the address that a rendezvous message names, then dials the host and port that `peerRoute` returns. The default dials the address.
- The `checksum` field of `OutgoingFile`. When you give the OFT checksum of the file, the client does not read the file to get it, and calls `read` one time. A wrong checksum shows in the check after the send.

### Changed

- A service connection (directory, buddy icons, account) announces the OService version that the BOS connection negotiated. It announced version 1 before. A server that keeps one version table for a session then left the list of the instances of the user out of later user info replies. With the default options, the bytes on the wire do not change.
- A room invitation that the client sent is kept for 1 hour, and the client keeps the 64 newest. A decline that comes after that does nothing. Before, the client kept every invitation until the session ended.

## 0.1.1 - 2026-11-16

### Added

- The `allowOffer` rule of the `fileTransfer` and `directIm` options of `OscarClient`. The client drops a file offer or a Direct IM offer that the rule does not allow, and sends nothing to the sender.
- The `paceMarginMs` option of `OscarClient`, which sets the pacing margin. The default is 250 ms.
- `setOwnIcon` and `clearOwnIcon` work on a client with `sessionBuddies`.

### Changed

- The client paces each rate class a margin above the alert level of the server. A burst of sends takes longer. The 20 IMs of the `burst` scenario take approximately 1 s more.
- A rate hold ends when the level of the class is back, by the count of the client. The client no longer waits 60 s for a clear notice that does not come.
- After a limited notice, the client also counts the sends that it wrote in the 2 s before the notice arrived. The server drops those sends, and each one lowers its level. The next send goes when the server is back at the clear level, so the server does not drop it.

## 0.1.0 - 2026-11-15

- The first release.
