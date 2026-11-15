# Staying signed on

A session from `signOn` reconnects by itself when its connection drops. It keeps trying until an attempt succeeds, it meets one of the cases below, or the program calls `signOff()` (`src/client/oscar-client.ts`).

## The wait before each attempt

`backoffDelay` in `src/client/reconnect.ts` sets the wait, from the constants in `src/wire/constants.ts`. The wait starts at 2 s and doubles after each failed attempt, up to 120 s. From the third attempt on, it is at least 60 s.

| Attempt | Wait |
| --- | --- |
| 1 | 2 s |
| 2 | 4 s |
| 3 to 5 | 60 s |
| 6 | 64 s |
| 7 and later | 120 s |

Each wait varies at random by up to 20% either way, so sessions that drop together spread their attempts out.

## The end of a session

`desktopReconnectPolicy` in `src/client/reconnect.ts` ends the session in these cases:

- The server signs the session off with a reason. Open OSCAR Server (OOS) gives a reason when it closes the session and keeps running ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L643-L658)).
- The server refuses a reconnect attempt: it answers the login with an error, such as a wrong password or the login rate limit, or a sign-on step answers with an error.
- A reconnect attempt meets the server's cap on sessions for the name.

Every other drop leads to a reconnect: a closed connection, a socket error, a missed liveness check, a sign-off with no reason, or a server that cannot be reached.

A server restart leads to a reconnect too. When OOS shuts down, it signs each session off with no reason ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L660-L669)).

A first sign-on that fails does not retry. `signOn` rejects with a `SignOnFailedError`, and its `kind` names the failure, such as `wrong-password` or `login-rate-limited` (`lib/session.ts`).

## Events

`reconnecting` fires before each wait, with `attempt` (1 for the first) and `inMs`, the wait in milliseconds.

`online` fires each time a reconnect succeeds. The first sign-on fires it before `signOn` resolves, so a listener added after `signOn` hears only reconnects.

`signedOff` fires once, when the session ends. Its `reason` is `signed-off` after the program's own `signOff()`. In the other cases it is the reason the session stopped, such as `signed-off-by-server`, `too-many-sessions` or `wrong-password`.

```js
session.on('reconnecting', ({ attempt, inMs }) => {
  console.log(`attempt ${attempt} in ${Math.round(inMs / 1000)} s`);
});
session.on('online', () => console.log('back online'));
session.on('signedOff', ({ reason }) => console.log(`signed off: ${reason}`));
```

While the session waits, `sendIm` rejects with an `OscarError` whose `info.kind` is `not-signed-on`, and `buddies()` shows every buddy offline. When the session comes back, OOS sends an arrival for each buddy who is online ([foodgroup/buddy.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/foodgroup/buddy.go#L320-L329)).

## Turning reconnect off

`signOn({ ..., reconnect: false })` ends the session at the first drop. `signedOff` then fires with the reason `unreachable`, whatever ended the connection (`lib/session.ts`).

## Connections over TLS

The simple API connects with plain TCP. `OscarClient` with the `tls` option opens each server connection with TLS (Transport Layer Security): the login connection, the BOS connection that carries the session, and each service connection, such as a room. Peer connections, such as a Direct IM, stay plain (`src/client/oscar-client.ts`).

```js
import { OscarClient, clientIdFor } from 'open-oscar-client-kit/client';

const client = new OscarClient({
  clientId: clientIdFor('my-bot', '1.0.0', process.platform),
  tls: { caFile: 'oscar-ca.pem' },
});
```

`caFile` names a PEM file of the certificates to trust. The client gives them to Node as the `ca` option of `tls.connect`, so they replace the certificate authorities that Node trusts by default. Without `caFile`, Node's default certificate authorities apply. When the host is a name and not an IP address, the client sends it as the TLS server name (`src/wire/connection.ts`).

## The address after the login

The login reply gives the address of the BOS server, and the reply to each service request gives the address of that service. By default, the client connects to that address, except in these cases (`decideRedirect` in `src/wire/connection.ts`):

- The address is a loopback address, and the server that the program gave is not on loopback.
- The address is empty, malformed or unroutable, such as `0.0.0.0` or a link-local address.
- The session uses TLS, and the reply says that the address does not take TLS.

In these cases, the client connects to the host and port that the program gave to `signOn`.

Two options of `OscarClient` change this rule (`src/client/connect-options.ts`):

- `pinRedirects: { host, port }` sends the BOS connection and every service connection to that address, whatever the server gives.
- `followRedirects: true` connects to each address that the server gives, also a loopback or unroutable one. Under TLS, an address that does not take TLS then fails. The login rejects as `unreachable`, and a service request rejects with an `OscarError` whose `info.kind` is `refused`.

`pinRedirects` comes first. With both options, the client uses the pinned address.

Under TLS, a service request asks the server for an address that takes TLS (TLV 0x8C). When the server refuses that request, the client asks one more time without TLV 0x8C and connects to the address that the program gave, also with `followRedirects` (`src/client/service.ts`).

## The cause of a failed sign-on

When `OscarClient.signOn` cannot open a connection, it rejects with a `SignOnError` whose `failure.kind` is `unreachable`. The `cause` of that error is the error from Node (`src/client/sign-on.ts`). For a certificate that the client does not trust, `cause` is the TLS error. For a refused TCP connection, `cause.code` is `ECONNREFUSED`. The simple API's `SignOnFailedError` gives only `kind` (`lib/session.ts`).

## The login budget

Every login takes a slot from the budget in `src/client/login-budget.ts`. That includes the first sign-on and each reconnect attempt. The budget allows 8 logins in any 60 s, at least 2 s apart, and every session in the process shares it. A login with no free slot waits for one, so an attempt can start later than its `inMs` said.

OOS limits auth connections for each source address. Each address gets about 10 logins in the minute from its first login. After that minute, the count starts again at the next login ([cmd/server/factory.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/cmd/server/factory.go#L356), [server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L680-L734)). A login over that limit gets error 0x1D before the password exchange ([server/oscar/server.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/server/oscar/server.go#L414-L436)). The budget belongs to one process. Two programs behind one address each have their own budget, and they share the server's count for that address.

For the events and options in full, see the [API reference](../api/README.md). To run a first session, see the [quickstart](../quickstart.md).
