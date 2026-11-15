import { describe, expect, it } from 'vitest';
import { parseTestServerArgs, UsageError } from '../../../lib/cli/args.js';
import * as text from '../../../lib/cli/text.js';

describe('parseTestServerArgs', () => {
  it('has defaults', () => {
    expect(parseTestServerArgs([])).toEqual({
      host: '127.0.0.1',
      port: 5190,
      users: [{ screenName: 'Bot', password: 'botpass1' }],
      peer: 'Alice',
    });
  });

  it('keeps everything after the first colon as the password', () => {
    const args = parseTestServerArgs(['--user', 'A:pw:x', '--port', '6000', '--peer', 'Q']);
    expect(args.users).toEqual([{ screenName: 'A', password: 'pw:x' }]);
    expect(args.port).toBe(6000);
    expect(args.peer).toBe('Q');
  });

  it('takes more than one user', () => {
    expect(parseTestServerArgs(['--user', 'A:1', '--user', 'B:2']).users).toHaveLength(2);
  });

  it.each([
    [['--port', '70000']],
    [['--port', 'abc']],
    [['--user', 'nocolon']],
    [['--user', ':pw']],
    [['--nope']],
    [['--port']],
  ])('refuses %j', (argv) => {
    expect(() => parseTestServerArgs(argv)).toThrow(UsageError);
  });

  it.each(['::', '[::]', '::1', '[::1]', 'fe80::1%lo0', '2001:db8::1', '::ffff:127.0.0.1'])(
    'refuses the IPv6 host %j because a client cannot dial the address it advertises',
    (host) => {
      expect(() => parseTestServerArgs(['--host', host])).toThrow(new UsageError(text.USAGE_BAD_HOST(host)));
    },
  );

  it('names the host it refuses', () => {
    expect(() => parseTestServerArgs(['--host', '::1'])).toThrow(
      '--host needs an IPv4 address or a host name, such as 127.0.0.1 or 0.0.0.0, not "::1"',
    );
  });

  it('shows the suite options in the usage text', () => {
    expect(text.USAGE).toContain('  suite [--only NAME,NAME] [--json FILE] -- <driver command...>');
  });

  it('accepts a host name', () => {
    expect(parseTestServerArgs(['--host', 'localhost']).host).toBe('localhost');
  });

  it('accepts 0.0.0.0', () => {
    expect(parseTestServerArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
  });
});
