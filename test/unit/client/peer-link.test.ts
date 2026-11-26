import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PEER_CONNECT_TIMEOUT_MS, PeerClosedError, openPeerLink } from '../../../src/client/peer-link.js';
import type { PeerLink } from '../../../src/client/peer-link.js';
import { ManualTimers, captureLog, waitFor } from '../../fake/oscar-client.js';

let server: net.Server | null = null;
let remote: net.Socket | null = null;
let link: PeerLink | null = null;
const timers = new ManualTimers();

// One listener on loopback. `remote` is the far end of the link.
async function listen(): Promise<number> {
  const listener = net.createServer((socket) => {
    remote = socket;
    socket.on('error', () => {});
  });
  server = listener;
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  return (listener.address() as net.AddressInfo).port;
}

async function open(): Promise<{ link: PeerLink; remote: net.Socket }> {
  const port = await listen();
  const opened = await openPeerLink({ host: '127.0.0.1', port, log: captureLog().log, timers: timers.api });
  link = opened;
  await waitFor(() => remote !== null, 'the far end');
  if (!remote) throw new Error('no far end');
  return { link: opened, remote };
}

afterEach(async () => {
  link?.close();
  remote?.destroy();
  const listener = server;
  server = null;
  remote = null;
  link = null;
  if (listener) await new Promise((resolve) => listener.close(resolve));
});

describe('a peer link', () => {
  it('reads exactly n bytes across chunks and keeps the rest for the next read', async () => {
    const { link: l, remote: far } = await open();
    const first = l.read(6);
    far.write(Uint8Array.of(1, 2, 3, 4));
    await new Promise((resolve) => setTimeout(resolve, 10));
    far.write(Uint8Array.of(5, 6, 7, 8, 9));
    expect([...(await first)]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...(await l.read(3))]).toEqual([7, 8, 9]);
    expect(timers.pending()).toEqual([]);
  });

  it('readSome gives at most max bytes, at least one, and null at a clean end', async () => {
    const { link: l, remote: far } = await open();
    far.end(Uint8Array.of(1, 2, 3));
    expect([...((await l.readSome(2)) ?? [])]).toEqual([1, 2]);
    expect([...((await l.readSome(2)) ?? [])]).toEqual([3]);
    expect(await l.readSome(2)).toBeNull();
  });

  it('read rejects with PeerClosedError when the peer closes before n bytes came', async () => {
    const { link: l, remote: far } = await open();
    const reading = l.read(8);
    far.end(Uint8Array.of(1, 2, 3));
    await expect(reading).rejects.toBeInstanceOf(PeerClosedError);
    await waitFor(() => l.closed, 'the close');
  });

  it('writes reach the peer in order', async () => {
    const { link: l, remote: far } = await open();
    const got: number[] = [];
    far.on('data', (chunk: Buffer) => got.push(...chunk));
    await l.write(Uint8Array.of(1, 2));
    await l.write(new Uint8Array(0));
    await l.write(Uint8Array.of(3));
    await waitFor(() => got.length === 3, 'three bytes');
    expect(got).toEqual([1, 2, 3]);
  });

  it('close ends a waiting read, later reads and later writes', async () => {
    const { link: l, remote: far } = await open();
    far.write(Uint8Array.of(1));
    const reading = l.read(4);
    l.close();
    expect(l.closed).toBe(true);
    await expect(reading).rejects.toBeInstanceOf(PeerClosedError);
    await expect(l.readSome(4)).rejects.toBeInstanceOf(PeerClosedError);
    await expect(l.write(Uint8Array.of(1))).rejects.toBeInstanceOf(PeerClosedError);
    await waitFor(() => far.destroyed, 'the far end closes');
  });

  it('a reset by the peer rejects readSome', async () => {
    const { link: l, remote: far } = await open();
    const reading = l.readSome(4);
    far.resetAndDestroy();
    await expect(reading).rejects.toBeInstanceOf(PeerClosedError);
  });

  it('holds back a peer that sends faster than the reader takes', async () => {
    const { link: l, remote: far } = await open();
    const total = 8 * 1024 * 1024;
    const block = Buffer.alloc(64 * 1024, 7);
    let written = 0;
    let stalled = false;
    const pump = (): void => {
      while (written < total) {
        written += block.length;
        if (!far.write(block)) {
          stalled = true;
          far.once('drain', pump);
          return;
        }
      }
      far.end();
    };
    pump();
    await waitFor(() => stalled, 'the sender stalls');
    let read = 0;
    for (let chunk = await l.readSome(32 * 1024); chunk; chunk = await l.readSome(32 * 1024)) read += chunk.length;
    expect(read).toBe(total);
  });

  it('rejects when nothing listens at the address', async () => {
    const port = await listen();
    await new Promise((resolve) => server?.close(resolve));
    server = null;
    await expect(openPeerLink({ host: '127.0.0.1', port, log: captureLog().log, timers: timers.api })).rejects.toBeInstanceOf(PeerClosedError);
    expect(timers.pending()).toEqual([]);
  });

  it('binds the local address', async () => {
    const port = await listen();
    const o = { host: '127.0.0.1', port, log: captureLog().log, timers: timers.api };
    // The machine does not hold this address, so the bind fails.
    await expect(openPeerLink({ ...o, localAddress: '192.0.2.1' })).rejects.toBeInstanceOf(PeerClosedError);
    expect(remote).toBeNull();
    link = await openPeerLink({ ...o, localAddress: '127.0.0.1' });
    await waitFor(() => remote !== null, 'the far end');
    expect(remote?.remoteAddress?.replace(/^::ffff:/, '')).toBe('127.0.0.1');
    expect(timers.pending()).toEqual([]);
  });

  it('gives up on a connection that does not open in time', async () => {
    const own = new ManualTimers();
    // A reserved test address: no answer comes from it.
    const opening = openPeerLink({ host: '192.0.2.1', port: 5190, log: captureLog().log, timers: own.api });
    const settled = opening.then(
      () => 'opened',
      (error: unknown) => error,
    );
    expect(own.pending()).toEqual([PEER_CONNECT_TIMEOUT_MS]);
    await own.advance(PEER_CONNECT_TIMEOUT_MS);
    expect(await settled).toBeInstanceOf(PeerClosedError);
  });
});
