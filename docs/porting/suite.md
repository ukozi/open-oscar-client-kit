# The suite

The suite checks a port through its [driver](driver-protocol.md). For each scenario, it starts a new test server and a new driver process, sends the driver commands, and checks the replies, the events and what the test server saw (`suite/runner.ts`).

## Installing Node

The suite runs on Node 22.12 or later, whatever language the port is in.

1. Install Node with the command for your system, below.
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

## Running the suite

1. Go to the folder that holds your driver.
2. Run `npx open-oscar-client-kit suite -- <driver command>`.

In PowerShell, put the `--` in quotes, and put each list of names in quotes:

```
npx open-oscar-client-kit suite "--" python driver.py
npx open-oscar-client-kit suite --only "sign-on,receive-im" "--" python driver.py
```

The suite starts the driver command in the folder it runs in, so a relative path in the command works. It starts the command with no shell (`suite/driver-process.ts`). For a command that needs a shell, name the shell in the command, such as `-- sh -c "cd build && ./driver"`.

The output gives the suite's version, one line for each scenario and the count that passed:

```
suite 0.1.1, driver protocol 1
ok   sign-on (0.1 s)
FAIL wrong-password: signOn replied other, not wrong-password
...
11 of 12 passed
```

When the suite kept text from the driver, a failed line ends with the first line of that text, as `(the driver wrote: ...)`. The text holds what the driver wrote to stderr, and also each protocol error that the suite found in the driver's stdout (`suite/driver-process.ts`). So the first line can be the suite's own message about a bad line. The command exits with 0 when every scenario passes, 1 when any fails, and 2 for a usage error or an unknown scenario name (`lib/cli/main.ts`).

## Options

`--only` takes a list of scenario names, separated by commas, and runs those in the suite's order. Put the list and the `--` in double quotes, which sh, PowerShell and cmd.exe all accept:

```
npx open-oscar-client-kit suite --only "sign-on,receive-im" "--" python driver.py
```

`--json FILE` also writes the results to `FILE`:

```json
{
  "suite": "0.1.1",
  "protocol": 1,
  "results": [
    {
      "name": "sign-on",
      "ok": true,
      "ms": 78
    },
    {
      "name": "wrong-password",
      "ok": false,
      "reason": "signOn replied other, not wrong-password",
      "ms": 64
    }
  ]
}
```

## Scenarios

At the start of every scenario, the test server has the account `Bot` with the password `botpass1`, Bot's buddy list holds `Alice` in the group `Buddies`, and Alice is online. The driver signs on to `127.0.0.1` at a free port that the `signOn` command gives. In a scenario that signs on, the driver has to pass the checks of `sign-on` first. A scenario passes when every check passes before its time limit.

The scenarios are in `suite/scenarios.ts`, in this order:

| Scenario | The suite | The driver passes when |
| --- | --- | --- |
| `sign-on` | Sends `signOn`. | It replies ok, and writes `online` within 10 s. |
| `wrong-password` | Sends `signOn` with the password `wrongpw1`. | It replies `wrong-password`, and 5 s later the server has seen one login. |
| `refused-login` | Makes the server answer Bot's login with error 0x1D, then sends `signOn`. | It replies `login-rate-limited` or `too-many-sessions`, and 5 s later the server has seen one login. |
| `receive-im` | Sends `signOn`, then sends `hello` from Alice. | It writes an `im` event from `Alice` with the text `hello` within 5 s. |
| `send-im` | Sends `signOn`, then `sendIm` to Alice with `hi`. | It replies ok, and Alice gets the IM within 5 s. |
| `buddy-list` | Signs Alice off, sends `signOn` and `buddies`, then signs Alice on and off again. | Its reply lists Alice offline, then `buddy` events show Alice online and then offline, each within 5 s. |
| `warning` | Sends `signOn` and a `sendIm` to Alice, then has Alice warn Bot. | It writes `warned` with a level above 0 within 5 s. |
| `rate-limited` | Sends `signOn`, then a rate change for the IM class: limited, then clear. | It writes `rateLimited` with `true`, then with `false`, each within 5 s. |
| `burst` | Sends `signOn`, then 20 `sendIm` commands to Alice, each one after the reply to the one before. | It replies to all 20 within 120 s, Bot still has its BOS connection, and the server has seen one login. |
| `reconnect` | Sends `signOn`, then drops Bot's connection. | It writes `reconnecting` within 5 s with an `inMs` of at least 1000, logs in again at least 1000 ms after the drop, and writes `online` within 15 s of the drop. |
| `server-sign-off` | Sends `signOn`, then signs Bot off with a reason in TLV 0x09. | It writes `signedOff` within 5 s, and 10 s later the server has seen one login. |
| `sign-off` | Sends `signOn`, then `signOff`. | It replies ok, and 5 s later the server has seen one login. |

`burst` has a time limit of 150 s. Every other scenario has 60 s. The suite waits 10 s for each reply (`suite/driver-process.ts`), except the 20 `sendIm` replies of `burst`, which share the 120 s.

The client keeps the IM rate class at or above its alert level: 3 IMs at once, then about one every 5 s, so `burst` takes the driver of open-oscar-client-kit about 85 s. A port that lets the class go lower finishes sooner. Below the limit level, the server drops each IM until the class is back at its clear level. The suite's server checks each class once a second, and sends a rate notice when the status of a class changed (`suite/runner.ts`). So the driver gets the clear notice with no further send. A port that sends the IMs at once goes past the class's disconnect level, and the server signs it off.

## Running the suite in CI

This GitHub Actions workflow runs the suite on each push and pull request:

```yaml
name: Suite

on:
  push:
  pull_request:

jobs:
  suite:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # Set up the port's language and build the driver here.
      - run: npx --yes open-oscar-client-kit@0.1.1 suite --json suite.json -- python3 driver.py
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: suite
          path: suite.json
```

Pin the suite to one version, as `@0.1.1` does here. The job fails when a scenario fails, because the command then exits with 1. A run of this job that passes is what a port links to when it asks to be [listed](../ports.md).
