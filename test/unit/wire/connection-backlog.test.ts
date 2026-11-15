import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fromHex } from '../../../src/wire/bytes.js';
import { openConnection } from '../../../src/wire/connection.js';
import type { CloseInfo, ConnectionOptions, OscarConnection } from '../../../src/wire/connection.js';
import { FlapDecoder, encodeFlap } from '../../../src/wire/flap.js';
import type { FlapFrame } from '../../../src/wire/flap.js';
import { decodeSnac, encodeSnac } from '../../../src/wire/snac.js';
import type { Snac } from '../../../src/wire/snac.js';
import { ManualTimers, captureLog, waitFor } from '../../fake/oscar-client.js';

const SERVER_SIGNON = fromHex('2a010064000400000001');

type Script = { server: net.Server; port: number; frames: FlapFrame[]; sockets: net.Socket[] };
const open: Script[] = [];

async function listen(onConnect: (socket: net.Socket) => void): Promise<Script> {
  const script: Script = { server: null as unknown as net.Server, port: 0, frames: [], sockets: [] };
  script.server = net.createServer((socket) => {
    script.sockets.push(socket);
    const decoder = new FlapDecoder();
    socket.on('data', (chunk: Buffer) => script.frames.push(...decoder.push(new Uint8Array(chunk))));
    socket.on('error', () => {});
    onConnect(socket);
  });
  await new Promise<void>((resolve) => script.server.listen(0, '127.0.0.1', resolve));
  script.port = (script.server.address() as net.AddressInfo).port;
  open.push(script);
  return script;
}

afterEach(async () => {
  for (const s of open.splice(0)) {
    for (const socket of s.sockets) socket.destroy();
    await new Promise((resolve) => s.server.close(resolve));
  }
});

function closeOf(conn: OscarConnection): CloseInfo | null {
  let info: CloseInfo | null = null;
  conn.onClose((i) => {
    info = i;
  });
  return info;
}

const connect = (port: number, timers: ManualTimers, extra: Partial<ConnectionOptions> = {}) =>
  openConnection({ host: '127.0.0.1', port, tls: false, label: 'test', log: captureLog().log, timers: timers.api, ...extra });

// The sign-on frame and three 0x01/0x0F SNACs in one write, so the connection reads all four before the caller gets it.
const signonAndSnacs = (socket: net.Socket): void => {
  const snacs = [1, 2, 3].map((id, i) => encodeFlap(2, i + 1, encodeSnac({ family: 1, subtype: 0x0f, requestId: id })));
  socket.write(Buffer.concat([SERVER_SIGNON, ...snacs]));
};

describe('OscarConnection backlog', () => {
  it('destroys the connection as an error when the SNACs held for a first listener pass backlogMax', async () => {
    const script = await listen(signonAndSnacs);
    const conn = await connect(script.port, new ManualTimers(), { backlogMax: 2 });
    await waitFor(() => !conn.isOpen, 'the backlog to overflow');
    const info = closeOf(conn);
    expect(info).toMatchObject({ kind: 'error', clean: false });
    expect(info?.kind === 'error' ? info.error.message : null).toBe('backlog full');
  });

  it('holds exactly backlogMax SNACs', async () => {
    const script = await listen(signonAndSnacs);
    const conn = await connect(script.port, new ManualTimers(), { backlogMax: 3 });
    const seen: Snac[] = [];
    conn.onSnac((snac) => seen.push(snac));
    expect([conn.isOpen, seen.map((s) => s.requestId)]).toEqual([true, [1, 2, 3]]);
    conn.destroy();
  });

  it('keeps every SNAC for the first listener when there is no limit', async () => {
    const script = await listen(signonAndSnacs);
    const conn = await connect(script.port, new ManualTimers());
    const seen: Snac[] = [];
    conn.onSnac((snac) => seen.push(snac));
    expect([conn.isOpen, seen.map((s) => s.requestId)]).toEqual([true, [1, 2, 3]]);
    conn.destroy();
  });

  it('does not hold a SNAC that a listener has already read', async () => {
    const script = await listen((socket) => {
      socket.write(SERVER_SIGNON);
      setTimeout(() => socket.write(encodeFlap(2, 1, encodeSnac({ family: 1, subtype: 0x0f, requestId: 9 }))), 10);
    });
    const conn = await connect(script.port, new ManualTimers(), { backlogMax: 1 });
    const seen: number[] = [];
    conn.onSnac((snac) => seen.push(snac.requestId));
    await waitFor(() => seen.length === 1, 'the SNAC');
    expect(conn.isOpen).toBe(true);
    conn.destroy();
  });
});

describe('OscarConnection pauseProbeWhile', () => {
  const probes = (script: Script): Snac[] =>
    script.frames.filter((f) => f.type === 2).map((f) => decodeSnac(f.payload)).filter((s) => s.family === 1 && s.subtype === 0x0e);

  it('sends no probe and arms no deadline in a round whose gate is true, and probes again when it is not', async () => {
    const script = await listen((socket) => socket.write(SERVER_SIGNON));
    const timers = new ManualTimers();
    const conn = await connect(script.port, timers);
    let held = true;
    conn.pauseProbeWhile(() => held);
    await timers.advance(90_000);
    await timers.advance(60_000);
    expect([probes(script).length, conn.isOpen]).toEqual([0, true]);
    held = false;
    await timers.advance(30_000);
    await waitFor(() => probes(script).length === 1, 'a probe');
    // Nobody answers it: the deadline was armed.
    await timers.advance(20_000);
    expect(conn.isOpen).toBe(false);
  });

  it('probes every round when no gate is set', async () => {
    const script = await listen((socket) => socket.write(SERVER_SIGNON));
    const timers = new ManualTimers();
    const conn = await connect(script.port, timers);
    await timers.advance(90_000);
    await waitFor(() => probes(script).length === 1, 'a probe');
    conn.destroy();
  });
});
