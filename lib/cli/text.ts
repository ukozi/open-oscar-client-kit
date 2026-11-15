export const USAGE = [
  'usage: open-oscar-client-kit <command>',
  '',
  'commands:',
  '  test-server [--host HOST] [--port PORT] [--user NAME:PASSWORD]... [--peer NAME]',
  '  suite [--only NAME,NAME] [--json FILE] -- <driver command...>',
].join('\n');

export const STARTED = (host: string, port: number): string => `test OSCAR server on ${host}:${port}`;
export const ACCOUNTS = (users: { screenName: string; password: string }[]): string =>
  `accounts: ${users.map((u) => `${u.screenName} (password ${u.password})`).join(', ')}`;
export const PEER_HELP = (peer: string): string =>
  `${peer} is online. Type a line to send it as ${peer} to the account that signed on last. Start a line with @Name to send it to that name.`;
export const SIGNED_ON = (name: string): string => `${name} signed on`;
export const SIGNED_OFF = (name: string): string => `${name} signed off`;
export const IM_TO_PEER = (from: string, text: string): string => `${from}: ${text}`;
export const OFFLINE = (name: string): string => `${name} is not online`;

export const USAGE_BAD_PORT = (value: string): string => `--port needs a number from 0 to 65535, not "${value}"`;
export const USAGE_BAD_USER = (value: string): string => `--user needs NAME:PASSWORD, not "${value}"`;
export const USAGE_BAD_HOST = (value: string): string =>
  `--host needs an IPv4 address or a host name, such as 127.0.0.1 or 0.0.0.0, not "${value}"`;
export const USAGE_NEEDS_VALUE = (flag: string): string => `${flag} needs a value`;
export const USAGE_UNKNOWN = (arg: string): string => `unknown argument "${arg}"`;
export const USAGE_NEEDS_DRIVER = 'suite needs a driver command after --';

export const CORE_GUARD_USAGE = 'usage: node scripts/core-guard.mjs <base-ref>';
export const CORE_GUARD_MESSAGE =
  'These files are maintained separately and take issues, not pull requests. See CONTRIBUTING.md.';
