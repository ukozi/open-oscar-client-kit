import { afterEach, describe, expect, it } from 'vitest';
import { DriverProcess } from '../../suite/driver-process.js';

const driver = (name: string): string[] => ['node', `test/suite/drivers/${name}`];
const signOn = { op: 'signOn', host: '127.0.0.1', port: 1, screenName: 'Bot', password: 'x' } as const;
let proc: DriverProcess | undefined;

afterEach(async () => {
  await proc?.close();
  proc = undefined;
});

describe('DriverProcess', () => {
  it('matches a reply to its request', async () => {
    proc = DriverProcess.start(driver('echo-ok.mjs'));
    expect(await proc.request(signOn)).toMatchObject({ ok: true });
    expect(await proc.request({ op: 'buddies' })).toMatchObject({ ok: true });
  });

  it('rejects a request that gets no reply', async () => {
    proc = DriverProcess.start(driver('silent.mjs'));
    await expect(proc.request(signOn, 1000)).rejects.toThrow('no reply to signOn within 1000 ms');
  });

  it('rejects a request when the driver exits', async () => {
    proc = DriverProcess.start(driver('crash.mjs'));
    await expect(proc.request(signOn)).rejects.toThrow('driver exited with code 3');
    expect(proc.exited()).toEqual({ code: 3, signal: null });
  });

  it('joins an event that arrives in two chunks', async () => {
    proc = DriverProcess.start(driver('events.mjs'));
    await proc.request(signOn);
    const event = await proc.nextEvent((e) => e.event === 'im', 2000);
    expect(event).toEqual({ event: 'im', from: 'Alice', text: 'hi' });
  });

  it('finds an event seen before the call, until markSeen', async () => {
    proc = DriverProcess.start(driver('events.mjs'));
    await proc.request(signOn);
    await proc.nextEvent((e) => e.event === 'im', 2000);
    expect(await proc.nextEvent((e) => e.event === 'im', 100)).toMatchObject({ from: 'Alice' });
    proc.markSeen();
    await expect(proc.nextEvent((e) => e.event === 'im', 100)).rejects.toThrow('no matching event within 100 ms');
  });

  it('ends cleanly on close', async () => {
    proc = DriverProcess.start(driver('echo-ok.mjs'));
    await proc.close();
    expect(proc.exited()).toEqual({ code: 0, signal: null });
  });

  it('says why a driver could not start', async () => {
    proc = DriverProcess.start(['no-such-driver-command']);
    await expect(proc.request(signOn)).rejects.toThrow('could not start the driver: spawn no-such-driver-command ENOENT');
  });
});
