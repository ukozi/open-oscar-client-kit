# The test server

The test server is an OSCAR server for tests. It signs clients on, delivers IMs, reports buddy arrivals and departures, and applies warnings and rate classes. Its code follows Open OSCAR Server (OOS) and cites the OOS source for the rules it copies (`test/fake/oscar-server.ts`). It keeps everything in memory, so each start begins with only the accounts its flags give.

## Running it with Node

1. Install Node 22.12 or later.
2. Run `npx open-oscar-client-kit test-server`.

The server prints its address, its accounts and how to talk to it:

```
test OSCAR server on 127.0.0.1:5190
accounts: Bot (password botpass1)
Alice is online. Type a line to send it as Alice to the account that signed on last. Start a line with @Name to send it to that name.
```

Press Ctrl+C to stop it.

## Flags

The flags are in `lib/cli/args.ts`:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host HOST` | `127.0.0.1` | The address to listen on. `0.0.0.0` listens on every interface. An IPv6 address is refused. |
| `--port PORT` | `5190` | The port to listen on. `0` takes any free port, and the first line shows which. |
| `--user NAME:PASSWORD` | `Bot:botpass1` | An account. Give the flag once for each account. When any `--user` is given, `Bot` is not added. |
| `--peer NAME` | `Alice` | The buddy that the server plays. |

## Accounts and the peer

Each account's buddy list has one group, `Buddies`, with the peer in it. The peer is online from the start (`lib/cli/test-server.ts`).

The terminal plays the peer:

- A line you type goes as an IM from the peer to the account that signed on last. Before any sign-on, it goes to the first account.
- A line that starts with `@Name`, a space and text sends the text to that account. A line of `@Name` alone, or with only spaces after it, goes as text, by the rule above.
- The server sends the text as you typed it, with `<`, `>` and `&` escaped.
- An IM to the peer prints as `Bot: hi`.
- Each sign-on and sign-off prints as `Bot signed on` or `Bot signed off`.
- A line for an account that is not online prints `Bot is not online`, and nothing is sent.

The server keeps running when its input ends.

## Rate notices

The command runs the server's rate monitor (`rateMonitor` in `test/fake/oscar-server.ts`). Once a second, the monitor checks each rate class that a signed-on client subscribed to, and sends a rate notice (SNAC 0x01/0x0A) when the status of the class changed. So a client gets the clear notice when a class recovers, with no further send. For a class below its disconnect level the monitor sends no notice, and the next send in that class signs the client off.

## Session buddy lists

The server answers SNAC 0x03/0x04 and SNAC 0x03/0x05, which add names to the session's own buddy list and remove names from it (`test/fake/oscar-server.ts`). A client uses them to watch names without the stored buddy list, as [the buddy list](../guides/buddy-list.md) guide shows. After 0x03/0x04, the server sends an arrival for each added name that is online. After 0x03/0x05, it sends the account no departure and no later arrival for a removed name. An empty 0x03/0x04 also counts, and the server then tells the account's watchers that the account is online. The names last until the account's last session ends. The command answers these SNACs too, because it runs the same server. In JavaScript, the `sessionBuddiesOf(name)` method of `FakeOscarServer` returns the names that an account holds, in the form that `normalizeScreenName` gives, in the order added.

## Running it in a container

The image is for authors who do not have Node:

1. Install Docker.
2. Run `docker run -it -p 5190:5190 ghcr.io/ukozi/open-oscar-client-kit-test-server:<version>`.

Replace `<version>` with a release, such as `0.1.2`. The `-it` flags let you type lines as the peer.

The image runs the same command with `--host 0.0.0.0` (`Dockerfile`). Flags after the image name go to the command, such as `--user Me:secret1`. The login reply sends the client to `127.0.0.1` and the server's own port (`advertisedHost` in `test/fake/oscar-server.ts`). Run the client on the same machine, and keep the same port on both sides of `-p`.

## Using it from JavaScript

`open-oscar-client-kit/testing` exports `FakeOscarServer`, which the command runs. Tests in JavaScript or TypeScript can start it in the test process and script it there. `FakeOscarServer.start` leaves the rate monitor off. Pass `rateMonitor: true` to run it, or call `rateTick` for one check of an account. The [API reference](../api/README.md) lists its methods.

## Options for tests in JavaScript

`FakeOscarServer.start` and `addUser` take options that the command does not pass through. Each option below is a library option only (`test/fake/oscar-server.ts`):

| Option | Default | Meaning |
| --- | --- | --- |
| `tls: true` | plain TCP | Each listener uses TLS with the test certificate `TEST_TLS_CERT` and its key `TEST_TLS_KEY` (`test/fake/tls-fixture.ts`). The certificate is self-signed for `localhost` and `127.0.0.1`. |
| `sslHost` | `true` | With `false`, a TLS server says in the login reply and in each service reply that its address does not take TLS. `setSslHost` changes it while the server runs. |
| `generation` | `'main'` | The release of Open OSCAR Server that the server acts as: `'main'` or `'v0.24'`. |
| `checkPasswords` | `true` | With `false`, a login accepts any password, and a login for a name with no account makes the account with the password `welcome1`. The server then does not apply its cap on sessions for each name. A login error set with `addUser` still refuses the login. |
| `addUser(name, password, { bot: true })` | not a bot | The account is a bot account. Its user info has the user flag 0x0400, and the server refuses each warning against it. |

Open OSCAR Server does not rate limit a bot account ([state/session.go](https://github.com/mk6i/open-oscar-server/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/state/session.go#L455-L457)). The test server rate limits a bot account as it does any other account.

A client trusts the test certificate when it reads the certificate from a file:

```js
import { writeFileSync } from 'node:fs';
import { OscarClient, clientIdFor } from 'open-oscar-client-kit/client';
import { FakeOscarServer, TEST_TLS_CERT } from 'open-oscar-client-kit/testing';

const server = await FakeOscarServer.start({ tls: true });
server.addUser('Bot', 'botpass1');
writeFileSync('test-cert.pem', TEST_TLS_CERT);
const client = new OscarClient({
  clientId: clientIdFor('my-bot', '1.0.0', process.platform),
  tls: { caFile: 'test-cert.pem' },
});
await client.signOn({ screenName: 'Bot', password: 'botpass1' }, { host: '127.0.0.1', port: server.port });
```

With `generation: 'v0.24'`, the server differs from `'main'` in these ways (`FakeGeneration` in `test/fake/oscar-rooms.ts`):

- The login reply says that the address does not take TLS, and a service request that asks for a TLS address (TLV 0x8C) gets error 0x01/0x01.
- A relayed IM keeps its store request (TLV 0x06) and its send time (TLV 0x16).
- A retrieval of stored IMs before the client sends client online (0x01/0x02) deletes them and delivers none.
- A rate notice for the BOS connection goes to the account's ChatNav connection, which finds rooms, while the account has one.
