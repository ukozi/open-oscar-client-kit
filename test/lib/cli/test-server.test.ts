import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTestServerArgs } from '../../../lib/cli/args.js';
import { runTestServer } from '../../../lib/cli/test-server.js';
import { signOn } from '../../../lib/index.js';
import type { Session } from '../../../lib/index.js';
import { waitFor } from '../../fake/oscar-client.js';

let stop: (() => Promise<void>) | undefined;
let session: Session | undefined;

afterEach(async () => {
  await session?.signOff();
  session = undefined;
  await stop?.();
  stop = undefined;
});

async function start() {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (chunk) => {
    out += String(chunk);
  });
  const running = await runTestServer({ ...parseTestServerArgs(['--port', '0']), input, output });
  stop = running.stop;
  const login = () =>
    signOn({ screenName: 'Bot', password: 'botpass1', app: 'Echo', server: { host: '127.0.0.1', port: running.port } });
  return { input, running, login, out: () => out };
}

describe('runTestServer', () => {
  it('prints the three start lines first', async () => {
    const { running, out } = await start();
    const lines = out().split('\n');
    expect(lines[0]).toBe(`test OSCAR server on 127.0.0.1:${running.port}`);
    expect(lines[1]).toBe('accounts: Bot (password botpass1)');
    expect(lines[2]).toBe(
      'Alice is online. Type a line to send it as Alice to the account that signed on last. Start a line with @Name to send it to that name.',
    );
  });

  it('sends an input line to the account that signed on last', async () => {
    const input = new PassThrough();
    const args = parseTestServerArgs(['--port', '0', '--user', 'Ann:annpass1', '--user', 'Ben:benpass1']);
    const running = await runTestServer({ ...args, input, output: new PassThrough() });
    stop = running.stop;
    const heard: string[] = [];
    const sessions: Session[] = [];
    try {
      for (const name of ['Ann', 'Ben']) {
        const one = await signOn({
          screenName: name,
          password: `${name.toLowerCase()}pass1`,
          app: 'Echo',
          server: { host: '127.0.0.1', port: running.port },
        });
        sessions.push(one);
        one.on('im', (im) => heard.push(`${name}:${im.text}`));
        // The server sees a sign-on within 100 ms.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      input.write('hello\n');
      input.write('@Ann hi\n');
      await waitFor(() => heard.length > 1, 'the IMs');
      expect(heard).toEqual(['Ben:hello', 'Ann:hi']);
    } finally {
      for (const one of sessions) await one.signOff();
    }
  });

  it('says that the first account is not online before any sign-on', async () => {
    const { input, out } = await start();
    input.write('hello\n');
    await waitFor(() => out().includes('Bot is not online\n'), 'the offline line');
  });

  it('reports a sign-on', async () => {
    const { login, out } = await start();
    session = await login();
    await waitFor(() => out().includes('Bot signed on\n'), 'the sign-on line');
  });

  it('sends an input line to the user as an IM from the peer', async () => {
    const { input, login } = await start();
    session = await login();
    const ims: string[] = [];
    session.on('im', (im) => ims.push(`${im.from}:${im.text}`));
    input.write('hello\n');
    await waitFor(() => ims.length > 0, 'the IM');
    expect(ims).toEqual(['Alice:hello']);
  });

  it('sends a line of a name and spaces as text to the account that signed on last', async () => {
    const { input, login } = await start();
    session = await login();
    const ims: string[] = [];
    session.on('im', (im) => ims.push(`${im.from}:${im.text}`));
    input.write('@Bot \n');
    await waitFor(() => ims.length > 0, 'the IM');
    expect(ims).toEqual(['Alice:@Bot ']);
  });

  it('escapes markup in an input line', async () => {
    const { input, login } = await start();
    session = await login();
    const ims: { text: string; html: string }[] = [];
    session.on('im', (im) => ims.push(im));
    input.write('<b>x</b> &amp;\n');
    await waitFor(() => ims.length > 0, 'the IM');
    expect(ims[0]?.text).toBe('<b>x</b> &amp;');
  });

  it('prints an IM sent to the peer as text', async () => {
    const { login, out } = await start();
    session = await login();
    await session.sendIm('Alice', 'a < b');
    await waitFor(() => out().includes('Bot: a < b\n'), 'the IM line');
  });

  it('says when a target is not online', async () => {
    const { input, out } = await start();
    input.write('@Nobody hi\n');
    await waitFor(() => out().includes('Nobody is not online\n'), 'the offline line');
  });

  it('keeps accepting sign-ons after the input ends', async () => {
    const { input, login } = await start();
    input.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    session = await login();
    expect(session.screenName).toBe('Bot');
  });
});

describe('the command', () => {
  it('stays up with a closed stdin and exits 0 on SIGTERM', async () => {
    const child = spawn(process.execPath, ['dist/lib/cli/main.js', 'test-server', '--port', '0'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stdin.end();
    await waitFor(() => out.includes('Alice is online'), 'the start lines', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
  });

  it.each(['::', '::1'])('exits 2 for the host %j', async (host) => {
    const child = spawn(process.execPath, ['dist/lib/cli/main.js', 'test-server', '--host', host], { stdio: 'ignore' });
    const [code] = await once(child, 'exit');
    expect(code).toBe(2);
  });
});
