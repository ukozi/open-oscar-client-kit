# Changelog

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
