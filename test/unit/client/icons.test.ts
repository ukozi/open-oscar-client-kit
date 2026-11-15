import { describe, expect, it, vi } from 'vitest';
import type { BosLink } from '../../../src/client/bos-link.js';
import { ICON_REQUEST_TIMEOUT_MS, Icons, memoryIconStore } from '../../../src/client/icons.js';
import type { IconChange, IconConnection, IconRoute, IconsDeps } from '../../../src/client/icons.js';
import type { Snac } from '../../../src/wire/snac.js';
import { ManualTimers, captureLog } from '../../fake/oscar-client.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

type Call = { family: number; subtype: number; body: Uint8Array | undefined; timeoutMs: number; opts: unknown };

function stubLink(): { link: BosLink; calls: Call[] } {
  const calls: Call[] = [];
  const stub = {
    paced: (): Promise<void> => Promise.resolve(),
    requestMatching(family: number, subtype: number, body: Uint8Array | undefined, timeoutMs: number, _accept: unknown, opts?: unknown): Promise<Snac> {
      calls.push({ family, subtype, body, timeoutMs, opts });
      return new Promise<Snac>(() => {});
    },
  };
  return { link: stub as unknown as BosLink, calls };
}

function service(connect?: IconsDeps['connect']): { icons: Icons; changes: IconChange[] } {
  const timers = new ManualTimers();
  const changes: IconChange[] = [];
  const icons = new Icons({
    log: captureLog().log,
    now: timers.now,
    timers: timers.api,
    store: memoryIconStore(),
    from: () => 'buddies',
    self: () => null,
    emit: (change) => changes.push(change),
    ...(connect ? { connect } : {}),
  });
  return { icons, changes };
}

function stubIconConnection() {
  const closeListeners: unknown[] = [];
  const request = vi.fn<IconConnection['request']>(() => new Promise<Snac>(() => {}));
  const close = vi.fn<IconConnection['close']>();
  const conn: IconConnection = {
    request,
    close,
    onClose: (fn) => {
      closeListeners.push(fn);
      return () => {};
    },
  };
  return { conn, request, close, closeListeners };
}

const arrival = (): Snac => snac(0x03, 0x0b, bytesOf(loadVectors('hand-icons.json'), 'arrival body, Bob with an icon and a status string'));

const snac = (family: number, subtype: number, body: Uint8Array): Snac => ({ family, subtype, flags: 0, requestId: 0x80000000, body });
const server = { host: '127.0.0.1', port: 5190 };

describe('Icons', () => {
  it('asks for a download as a low-priority request', async () => {
    const { icons } = service();
    const { link, calls } = stubLink();
    icons.connected({ onBos: true, server });
    icons.see(link, snac(0x03, 0x0b, bytesOf(loadVectors('hand-icons.json'), 'arrival body, Bob with an icon and a status string')));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ family: 0x10, subtype: 0x04, timeoutMs: ICON_REQUEST_TIMEOUT_MS });
    expect(calls[0]?.opts).toStrictEqual({ low: true });
    expect(calls[0]?.body).toEqual(bytesOf(loadVectors('hand-icons.json'), 'bart download body, bob').map((byte, i) => (i === 1 ? 0x42 : byte)));
  });

  it('see throws nothing for a body that cannot be read', () => {
    const { icons, changes } = service();
    const { link, calls } = stubLink();
    icons.connected({ onBos: true, server });
    expect(icons.see(link, snac(0x03, 0x0b, Uint8Array.of(0x05, 0x42)))).toBeUndefined();
    expect(icons.see(link, snac(0x01, 0x0f, Uint8Array.of(0x05, 0x42)))).toBeUndefined();
    expect(icons.iconOf('Bob')).toBeNull();
    expect(icons.iconOf('B')).toBeNull();
    expect(changes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each<[string, (icons: Icons) => void]>([
    ['bosLost', (icons) => icons.bosLost()],
    ['reset', (icons) => icons.reset()],
  ])('closes the open icon connection when BOS is lost and when the session ends (%s)', async (_method, end) => {
    const stub = stubIconConnection();
    const routes: IconRoute[] = [];
    const { link, calls } = stubLink();
    const { icons } = service(async (asked, route) => {
      expect(asked).toBe(link);
      routes.push(route);
      return stub.conn;
    });
    icons.connected({ onBos: false, server });
    icons.see(link, arrival());
    await vi.waitFor(() => expect(stub.request).toHaveBeenCalledTimes(1));
    expect(stub.request.mock.calls[0]?.slice(0, 2)).toEqual([0x10, 0x04]);
    expect(stub.request.mock.calls[0]?.[3]).toBe(ICON_REQUEST_TIMEOUT_MS);
    expect(routes).toEqual([{ onBos: false, server }]);
    expect(stub.closeListeners).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(stub.close).not.toHaveBeenCalled();

    end(icons);
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it('closes an icon connection that opens after BOS was lost', async () => {
    const stub = stubIconConnection();
    let opened = (_conn: IconConnection): void => {};
    const connect = vi.fn(() => new Promise<IconConnection>((resolve) => (opened = resolve)));
    const { icons, changes } = service(connect);
    const { link } = stubLink();
    icons.connected({ onBos: false, server });
    icons.see(link, arrival());
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    icons.bosLost();
    expect(stub.close).not.toHaveBeenCalled();

    opened(stub.conn);
    await vi.waitFor(() => expect(stub.close).toHaveBeenCalledTimes(1));
    // Everything that waited for the open has had its turn to use it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(stub.request).not.toHaveBeenCalled();
    expect(stub.close).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([]);
  });

  it('asks at most twice for an icon whose download was unanswered when the BOS connection was lost, until the session ends', async () => {
    const { icons, changes } = service();
    const { link, calls } = stubLink();
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    icons.connected({ onBos: true, server });
    icons.see(link, arrival());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    icons.bosLost();

    // One lost connection can have any cause: Icons asks for the icon once more.
    icons.connected({ onBos: true, server });
    icons.see(link, arrival());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    icons.bosLost();

    // Two connections dropped with this download unanswered: Icons does not send it a third time.
    icons.connected({ onBos: true, server });
    icons.see(link, arrival());
    await tick();
    await tick();
    expect(calls).toHaveLength(2);
    expect(icons.iconOf('Bob')).toBeNull();
    expect(changes).toEqual([]);

    icons.reset();
    icons.connected({ onBos: true, server });
    icons.see(link, arrival());
    await vi.waitFor(() => expect(calls).toHaveLength(3));
  });
});
