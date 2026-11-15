import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTestServerArgs } from '../lib/cli/args.js';
import { runTestServer } from '../lib/cli/test-server.js';
import { IM_TO_PEER, SIGNED_ON } from '../lib/cli/text.js';
import { waitFor } from './fake/oscar-client.js';

const root = resolve(import.meta.dirname, '..');

let child: ChildProcess | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  child = undefined;
  await stop?.();
  stop = undefined;
});

describe('examples/echo-bot.mjs', () => {
  it('is the code in the quickstart', () => {
    const page = readFileSync(resolve(root, 'docs/quickstart.md'), 'utf8');
    const block = /\n {3}```js\n([\s\S]*?)\n {3}```\n/.exec(page)?.[1] ?? '';
    const code = block
      .split('\n')
      .map((line) => line.replace(/^ {3}/, ''))
      .join('\n');
    expect(`${code}\n`).toBe(readFileSync(resolve(root, 'examples/echo-bot.mjs'), 'utf8'));
  });

  it('is at most 25 lines', () => {
    expect(readFileSync(resolve(root, 'examples/echo-bot.mjs'), 'utf8').trimEnd().split('\n').length).toBeLessThanOrEqual(25);
  });

  // Runs the example against a test server started with `flags`, and types `hello` as the peer.
  async function echoes(flags: string[], env: Record<string, string>, name: string): Promise<string> {
    const input = new PassThrough();
    const output = new PassThrough();
    let serverOut = '';
    output.on('data', (chunk) => {
      serverOut += String(chunk);
    });
    const running = await runTestServer({ ...parseTestServerArgs(['--port', '0', ...flags]), input, output });
    stop = running.stop;

    // The example takes its account from `env` only.
    const { OSCAR_SCREEN_NAME: _name, OSCAR_PASSWORD: _password, ...inherited } = process.env;
    // The file imports the package by its own name, and the exports map points that name at dist/.
    const bot = spawn(process.execPath, ['examples/echo-bot.mjs'], {
      cwd: root,
      env: { ...inherited, OSCAR_HOST: '127.0.0.1', OSCAR_PORT: String(running.port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = bot;
    let botOut = '';
    let botErr = '';
    bot.stdout?.on('data', (chunk) => {
      botOut += String(chunk);
    });
    bot.stderr?.on('data', (chunk) => {
      botErr += String(chunk);
    });

    await waitFor(() => botOut.includes('Alice') || bot.exitCode !== null, 'the buddy list', 10_000);
    expect(botErr).toBe('');
    expect(botOut).toContain('Alice');

    input.write('hello\n');
    await waitFor(() => serverOut.includes(`${IM_TO_PEER(name, 'You said: hello')}\n`), 'the answer', 10_000);
    return serverOut;
  }

  it('prints the buddy list and answers an IM from the peer', async () => {
    await echoes([], {}, 'Bot');
  });

  it('signs on with the screen name and password of the environment', async () => {
    const out = await echoes(['--user', 'Echo:echopass1'], { OSCAR_SCREEN_NAME: 'Echo', OSCAR_PASSWORD: 'echopass1' }, 'Echo');
    expect(out).toContain(`${SIGNED_ON('Echo')}\n`);
  });
});
