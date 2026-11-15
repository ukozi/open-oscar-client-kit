# open-oscar-client-kit

open-oscar-client-kit is a library for Node.js that signs on to OSCAR servers, with a test server and a test suite for clients in other languages.

OSCAR (Open System for Communication in Realtime) is the instant-messaging protocol of AOL Instant Messenger. Servers such as [Open OSCAR Server](https://github.com/mk6i/open-oscar-server) use it today. A client signs on with a screen name and a password, and it then exchanges instant messages (IMs) with other screen names.

## Contents of the package

- The simple API (application programming interface) in `open-oscar-client-kit` signs on with one call. The session that it gives sends and receives IMs and shows the buddy list.
- The full client in `open-oscar-client-kit/client` also changes the buddy list, joins rooms, sets away messages and transfers files. It reconnects by itself and keeps to the rate limits of the server.
- The wire codec in `open-oscar-client-kit/wire` reads and writes the bytes of each message. The data model in `open-oscar-client-kit/model` holds the data types of a session and does no input or output.
- The command `npx open-oscar-client-kit test-server` starts a test server on your computer. The test server keeps its data in memory and needs no account. Tests in JavaScript can start the same server from `open-oscar-client-kit/testing`.
- The command `npx open-oscar-client-kit suite` runs the port suite. The suite checks a client in another language through a small program called a driver.
- The docs give a quickstart, guides, a protocol guide, the porting docs and an API reference.

open-oscar-client-kit is for people who write bots or clients for OSCAR servers in JavaScript or TypeScript. It is also for people who write an OSCAR client in another language. They can test their client against the test server and the byte vectors, and then check it with the port suite.

## Requirements

You need Node.js 22.12 or a later version. To sign on to a real server, you need an account on an OSCAR server. To try the package, the test server is enough.

open-oscar-client-kit is an independent project. It is not a part of a server project.

## A first bot

Install the package and start the test server:

```
npm install open-oscar-client-kit
npx open-oscar-client-kit test-server
```

The test server listens on 127.0.0.1, port 5190. It has the account `Bot` with the password `botpass1`, and it plays the buddy `Alice`. In a second terminal, save this code as `echo-bot.mjs` and run `node echo-bot.mjs`:

```js
import { signOn } from 'open-oscar-client-kit';

const session = await signOn({
  screenName: 'Bot',
  password: 'botpass1',
  app: 'echo-bot',
  server: { host: '127.0.0.1', port: 5190 },
});

session.on('im', async (im) => {
  if (im.autoResponse) return;
  await session.sendIm(im.from, `You said: ${im.text}`);
});
```

Type a line in the terminal of the test server and press Enter. The test server sends the line to the bot as an IM from `Alice`, and the bot sends it back. The [quickstart](docs/quickstart.md) gives each step for Windows, macOS and Linux.

## Documentation

- The [quickstart](docs/quickstart.md) builds the echo bot step by step.
- The guides describe how the client behaves and how a bot must behave: [Staying signed on](docs/guides/staying-signed-on.md), [The buddy list](docs/guides/buddy-list.md), [Rate limits and warnings](docs/guides/rate-limits.md) and [Bot etiquette](docs/guides/bot-etiquette.md).
- The [protocol guide](docs/protocol/overview.md) describes the bytes on the wire.
- The [porting docs](docs/porting/overview.md) tell how to write and test a client in another language. The [ports page](docs/ports.md) lists the ports that pass the suite.
- The API reference documents each exported function and type. The command `pnpm docs:api` writes it into `docs/api` from the source code, and the npm package includes it at `docs/api/README.md`.

## Origin

This repository is the downstream, public version of the OSCAR client library that [Chimr](https://chimr.im) uses. Chimr's library is developed first. At each release, a part of it is copied into this repository file for file. That part is the wire codec, the client, the data model, the code of the test server, the byte vectors and the tests of these parts. This repository adds the simple API, the test server command, the port suite and the docs.

A change to a copied file is made in Chimr's library first, and it comes to this repository with the next copy. A check fails each pull request that changes a copied file. To report a bug in a copied file, open an issue with the steps that show it. Pull requests on the other folders are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) gives the details, the file that lists the copied paths, and the steps to run the checks.

## The port suite

A port is an OSCAR client library in another language. For each scenario, the suite starts a new test server and a new driver process, and it checks the replies and events of the driver and what the test server saw. A port may not call itself open-oscar-client-kit. A port that passes the suite may say "passes the open-oscar-client-kit suite, version N".

## License

open-oscar-client-kit is under the MIT license, which [LICENSE](LICENSE) gives in full. The code in `test/fake`, which includes the test server, and the byte vectors in `test/vectors` derive from a different project. They are used under the MIT license of that project. [NOTICE](NOTICE) names the project and gives its license.
