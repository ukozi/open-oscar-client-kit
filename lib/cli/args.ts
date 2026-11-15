import * as text from './text.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type TestServerArgs = {
  host: string;
  port: number;
  users: { screenName: string; password: string }[];
  peer: string;
};

// The server advertises "<host>:<port>", and a client cannot split it when the host has a colon.
const refusedHost = (host: string): boolean => host === '' || host.includes(':');

export function parseTestServerArgs(argv: string[]): TestServerArgs {
  let host = '127.0.0.1';
  let port = 5190;
  let peer = 'Alice';
  const users: TestServerArgs['users'] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag !== '--host' && flag !== '--port' && flag !== '--user' && flag !== '--peer') {
      throw new UsageError(text.USAGE_UNKNOWN(flag));
    }
    const value = argv[++i];
    if (value === undefined) throw new UsageError(text.USAGE_NEEDS_VALUE(flag));
    if (flag === '--host') {
      if (refusedHost(value)) throw new UsageError(text.USAGE_BAD_HOST(value));
      host = value;
    } else if (flag === '--port') {
      if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new UsageError(text.USAGE_BAD_PORT(value));
      port = Number(value);
    } else if (flag === '--peer') {
      peer = value;
    } else {
      const at = value.indexOf(':');
      if (at < 1) throw new UsageError(text.USAGE_BAD_USER(value));
      users.push({ screenName: value.slice(0, at), password: value.slice(at + 1) });
    }
  }
  if (users.length === 0) users.push({ screenName: 'Bot', password: 'botpass1' });
  return { host, port, users, peer };
}

export type SuiteArgs = { only?: string[]; json?: string; driver: string[] };

export function parseSuiteArgs(argv: string[]): SuiteArgs {
  const split = argv.indexOf('--');
  const flags = split < 0 ? argv : argv.slice(0, split);
  const driver = split < 0 ? [] : argv.slice(split + 1);
  const args: SuiteArgs = { driver };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] as string;
    if (flag !== '--only' && flag !== '--json') throw new UsageError(text.USAGE_UNKNOWN(flag));
    const value = flags[++i];
    if (value === undefined) throw new UsageError(text.USAGE_NEEDS_VALUE(flag));
    if (flag === '--only') args.only = value.split(',').filter((name) => name !== '');
    else args.json = value;
  }
  if (driver.length === 0) throw new UsageError(text.USAGE_NEEDS_DRIVER);
  return args;
}
