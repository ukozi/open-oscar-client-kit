# Contributing

## Pull requests

Pull requests are welcome on every path other than `.github/core-paths.txt` and the paths that it lists. The simple API and the `open-oscar-client-kit` command are in `lib/`, and the port suite is in `suite/`.

The paths listed in `.github/core-paths.txt` are maintained separately. They take issues, not pull requests. A CI check fails any pull request that changes them or the list. The check takes the list and its own code from the base branch. If you find a bug in one of them, open an issue with the steps that show it.

Pull requests are merged by squashing.

## Running the checks

1. Install Node 22.18 or later and pnpm 10.7.1. CI uses the Node version in `.node-version`.
2. Run `pnpm install`.
3. Run `pnpm check`.

`pnpm check` runs the type checks, the linter, the build and the tests. The tests include the port suite against the driver in `suite/kit-driver.ts`.

## Naming a port

A port may not call itself open-oscar-client-kit. A port that passes the suite may say "passes the open-oscar-client-kit suite, version N". The MIT license covers the code, not the name.

A port is listed when it links a CI run that shows the suite passing. To have a port listed, open an issue with that link.
