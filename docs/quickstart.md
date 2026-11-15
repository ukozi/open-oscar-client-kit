# Quickstart

The echo bot on this page signs on to the test server that comes with open-oscar-client-kit, prints its buddy list and answers each IM. The test server runs on your computer and needs no account.

## Installing Node

1. Install Node 22.12 or later with the command for your system, below.
2. Open a new terminal.
3. Run `node --version`.
4. Make sure that the output is `v22.12.0` or a later version.

| System | Command |
| --- | --- |
| Windows, in PowerShell | `winget install OpenJS.NodeJS.LTS` |
| macOS, with Homebrew | `brew install node` |

On Linux, install nvm, then install Node 22 with nvm, as [nodejs.org/en/download](https://nodejs.org/en/download) shows:

```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 22
```

## Running the echo bot

The commands work in PowerShell, cmd.exe and sh.

1. Run `mkdir echo-bot`.
2. Run `cd echo-bot`.
3. Run `npm init -y`.
4. Run `npm install open-oscar-client-kit`.
5. Run `npx open-oscar-client-kit test-server`. This terminal is terminal 1.
6. Make sure that terminal 1 shows the test server's start lines:

   ```
   test OSCAR server on 127.0.0.1:5190
   accounts: Bot (password botpass1)
   Alice is online. Type a line to send it as Alice to the account that signed on last. Start a line with @Name to send it to that name.
   ```

7. Save this code as `echo-bot.mjs` in the `echo-bot` folder:

   ```js
   import { signOn } from 'open-oscar-client-kit';

   const host = process.env.OSCAR_HOST ?? '127.0.0.1';
   const port = Number(process.env.OSCAR_PORT ?? 5190);
   const screenName = process.env.OSCAR_SCREEN_NAME ?? 'Bot';
   const password = process.env.OSCAR_PASSWORD ?? 'botpass1';

   const session = await signOn({
     screenName,
     password,
     app: 'echo-bot',
     server: { host, port },
   });

   const status = (buddy) => `${buddy.screenName} is ${buddy.online ? 'online' : 'offline'}${buddy.away ? ', away' : ''}`;

   for (const buddy of session.buddies()) console.log(`${buddy.group}: ${status(buddy)}`);

   session.on('buddy', (buddy) => console.log(status(buddy)));

   session.on('im', async (im) => {
     if (im.autoResponse) return;
     console.log(`${im.from}: ${im.text}`);
     await session.sendIm(im.from, `You said: ${im.text}`);
   });
   ```

8. Open a second terminal. This terminal is terminal 2.
9. In terminal 2, go to the `echo-bot` folder.
10. In terminal 2, run `node echo-bot.mjs`.
11. Make sure that terminal 2 shows `Buddies: Alice is online`.
12. In terminal 1, type `hello`.
13. Press Enter.
14. Make sure that terminal 1 shows `Bot: You said: hello`.

Terminal 2 shows `Alice: hello`. To stop the bot or the test server, press Ctrl+C in its terminal.

If terminal 2 shows `sign-on failed: unreachable`, the test server is not running in terminal 1. Start it, then run the bot again.

## What each part of the echo bot does

`signOn` signs on and resolves with a `Session`. When the sign-on fails, it rejects with a `SignOnFailedError`, whose `kind` gives the reason, such as `wrong-password` or `unreachable` (`lib/session.ts`). After the sign-on, the session reconnects by itself when its connection drops. [Staying signed on](guides/staying-signed-on.md) gives the waits and the cases that end the session.

`app` names the program. The session puts it in the client ID that the login sends. [Bot etiquette](guides/bot-etiquette.md) gives the format.

`session.buddies()` returns the buddy list that the server stores for the account. On the test server, the list has one group, `Buddies`, with the peer `Alice` in it (`lib/cli/test-server.ts`). The `buddy` event fires each time the server reports that a buddy signed on, signed off or changed. [The buddy list](guides/buddy-list.md) gives the details.

The `im` event fires for each IM sent to the bot's screen name. `im.text` is the IM as plain text, and `im.html` is the IM as AIM HTML, with its formatting. The bot does not answer an auto-response, which is an away message that a client sent by itself.

`session.sendIm` sends plain text and resolves when the server acknowledges the IM (`src/client/messaging.ts`). The client keeps to the server's rate limits, so a fast run of sends waits its turn. [Rate limits and warnings](guides/rate-limits.md) gives the rules.

A listener that throws, or that returns a promise that rejects, does not stop the session. The session reports the error as a process warning (`lib/session.ts`).

## Using a real server

The bot can sign on to an Open OSCAR Server (OOS) in place of the test server. Use an account made for the bot on that server, as [Bot etiquette](guides/bot-etiquette.md) asks.

The bot reads the account and the server from the environment, so `echo-bot.mjs` stays as it is:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OSCAR_SCREEN_NAME` | `Bot` | The account's screen name. |
| `OSCAR_PASSWORD` | `botpass1` | The account's password. |
| `OSCAR_HOST` | `127.0.0.1` | The server's host name or address. |
| `OSCAR_PORT` | `5190` | The server's OSCAR port. |

1. Get the server's host name and OSCAR port from its operator.
2. In the `echo-bot` folder, run the bot with the command for your shell, below.

In sh:

```
OSCAR_SCREEN_NAME=MyBot OSCAR_PASSWORD=secret1 OSCAR_HOST=oscar.example.com OSCAR_PORT=5190 node echo-bot.mjs
```

In PowerShell:

```
$env:OSCAR_SCREEN_NAME = "MyBot"
$env:OSCAR_PASSWORD = "secret1"
$env:OSCAR_HOST = "oscar.example.com"
$env:OSCAR_PORT = "5190"
node echo-bot.mjs
```

Replace `MyBot` and `secret1` with the account's screen name and password. Replace `oscar.example.com` and `5190` with the server's host name and port. In PowerShell, the values stay set until you close the terminal.

A password typed on a command line stays in the shell's history. In bash or zsh, this procedure keeps the password out of the history:

1. Run `read -rs OSCAR_PASSWORD && export OSCAR_PASSWORD`. The command waits for a line of text.
2. Type the password. The terminal does not show it.
3. Press Enter.
4. Run the bot as above, without `OSCAR_PASSWORD` in the command.

## Next steps

- The guides: [Staying signed on](guides/staying-signed-on.md), [The buddy list](guides/buddy-list.md), [Rate limits and warnings](guides/rate-limits.md) and [Bot etiquette](guides/bot-etiquette.md).
- The [test server](porting/test-server.md): its flags, its accounts and its container image.
- The [protocol guide](protocol/overview.md), for the bytes on the wire.
- The [API reference](api/README.md), for every exported function and type.
- [Porting open-oscar-client-kit](porting/overview.md), for a client in another language.
