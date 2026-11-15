import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverProcess } from '../../suite/driver-process.js';
import * as text from '../../suite/text.js';
import { waitFor } from '../fake/oscar-client.js';
import type { FakeOscarServer } from '../fake/oscar-server.js';
import { startFake } from '../lib/support.js';

let fake: FakeOscarServer;
let server: { host: string; port: number };
let proc: DriverProcess | undefined;

const signOn = (password = 'botpass1') =>
  proc?.request({ op: 'signOn', host: server.host, port: server.port, screenName: 'Bot', password }, 20_000);

async function start(): Promise<void> {
  ({ fake, server } = await startFake());
  proc = DriverProcess.start(['node', 'dist/suite/kit-driver.js']);
}

afterEach(async () => {
  await proc?.close();
  proc = undefined;
  await fake?.stop();
});

describe('the driver of open-oscar-client-kit', () => {
  it('signs on and reports online', async () => {
    await start();
    expect(await signOn()).toMatchObject({ ok: true });
    await proc?.nextEvent((e) => e.event === 'online', 5000);
  });

  it('lists the buddies', async () => {
    await start();
    fake.peer('Alice');
    await signOn();
    const reply = await proc?.request({ op: 'buddies' });
    expect(reply).toMatchObject({ ok: true, buddies: [{ screenName: 'Alice' }] });
  });

  it('sends an IM', async () => {
    await start();
    const peer = fake.peer('Alice');
    await signOn();
    expect(await proc?.request({ op: 'sendIm', to: 'Alice', text: 'hi' })).toMatchObject({ ok: true });
    await waitFor(() => peer.ims().some((im) => im.html === 'hi'), 'the IM at the peer');
  });

  it('reports an IM from a peer', async () => {
    await start();
    const peer = fake.peer('Alice');
    await signOn();
    peer.sendIm('Bot', 'hello');
    const event = await proc?.nextEvent((e) => e.event === 'im', 5000);
    expect(event).toEqual({ event: 'im', from: 'Alice', text: 'hello' });
  });

  it('names the kind of a failed sign-on', async () => {
    await start();
    expect(await signOn('nope')).toEqual({ id: expect.any(Number), ok: false, error: 'wrong-password' });
  });

  it('refuses sendIm before sign-on', async () => {
    await start();
    expect(await proc?.request({ op: 'sendIm', to: 'Alice', text: 'hi' })).toMatchObject({ ok: false, error: 'other' });
  });

  it('reconnects after a dropped socket', async () => {
    await start();
    await signOn();
    await proc?.nextEvent((e) => e.event === 'online', 5000);
    proc?.markSeen();
    fake.dropSocket('Bot');
    await proc?.nextEvent((e) => e.event === 'reconnecting', 10_000);
    await proc?.nextEvent((e) => e.event === 'online', 20_000);
  }, 40_000);

  it('ignores a line that is not JSON', async () => {
    const { out, err } = await feed('not json\n');
    expect(out).toBe('{"id":1,"ok":true}\n');
    expect(err).toContain(text.NOT_JSON('not json'));
  });

  it.each(['null', '[]', '7', '"signOn"', '{"op":"buddies"}', '{"id":"2","op":"buddies"}'])(
    'logs %s, which has no id, and keeps running',
    async (line) => {
      const { out, err, code } = await feed(`${line}\n`);
      expect(out).toBe('{"id":1,"ok":true}\n');
      expect(err).toContain(text.NO_COMMAND(line));
      expect(code).toBe(0);
    },
  );

  it('fails an unknown op with other and keeps running', async () => {
    const { out, code } = await feed('{"id":2,"op":"dance"}\n');
    expect(out).toBe('{"id":2,"ok":false,"error":"other"}\n{"id":1,"ok":true}\n');
    expect(code).toBe(0);
  });
});

// Send the lines and an exit with id 1, then collect the output until the driver ends.
async function feed(lines: string): Promise<{ out: string; err: string; code: number | null }> {
  const child = spawn('node', ['dist/suite/kit-driver.js']);
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const exited = once(child, 'exit');
  child.stdin.write(`${lines}{"id":1,"op":"exit"}\n`);
  const [code] = (await exited) as [number | null];
  return { out, err, code };
}
