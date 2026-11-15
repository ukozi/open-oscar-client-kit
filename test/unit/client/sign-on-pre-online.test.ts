import { describe, expect, it } from 'vitest';
import { BosLink } from '../../../src/client/bos-link.js';
import { SignOn } from '../../../src/client/sign-on.js';
import type { PreOnlinePlan } from '../../../src/client/sign-on.js';
import { concatBytes } from '../../../src/wire/bytes.js';
import { encodeLocateInfo } from '../../../src/wire/locate.js';
import { encodeUserInfo } from '../../../src/wire/snac.js';
import { tlv } from '../../../src/wire/tlv.js';
import type { Tlv } from '../../../src/wire/tlv.js';
import type { UserInfoSnapshot } from '../../../src/model/instances.js';
import { ManualTimers, captureLog } from '../../fake/oscar-client.js';
import { StubConn } from '../../fake/stub-conn.js';
import type { SentSnac } from '../../fake/stub-conn.js';

const HOST_ONLINE = Uint8Array.of(0, 1, 0, 2, 0, 3, 0, 4, 0, 0x13);
const block = (tlvs: Tlv[]): Uint8Array => encodeUserInfo({ name: 'Alice', warning: 0, tlvs });
const SESSION = block([tlv.u32(0x06, 0)]);
const INSTANCE = block([tlv.u8(0x14, 1), tlv.u32(0x06, 0)]);
const INVISIBLE = block([tlv.u32(0x06, 0x0100)]);

type Run = { sent: SentSnac[]; heard: (UserInfoSnapshot | null)[]; emitted: UserInfoSnapshot[]; limits: unknown[]; idleReported: boolean };

/** A sign-on with idle at 4000 s against a time of 1 s, run until bringUp settles; `awayWrite` writes a Locate away when asked. */
async function run(version: 1 | 4, plan: PreOnlinePlan, writeAway: boolean): Promise<Run> {
  const timers = new ManualTimers();
  const conn = new StubConn(timers);
  const link = new BosLink(conn, { now: timers.now, timers: timers.api, log: captureLog().log });
  const emitted: UserInfoSnapshot[] = [];
  const signOn = new SignOn({
    log: captureLog().log, now: timers.now, timers: timers.api, budget: { take: async () => {} }, oserviceVersion: version, emitUserInfo: (s) => emitted.push(s),
  });
  conn.onSnac((snac) => {
    signOn.handle(snac);
  });
  const heard: (UserInfoSnapshot | null)[] = [];
  const limits: unknown[] = [];
  const hooks = {
    loadFeedbag: async () => {},
    useFeedbag: () => link.send(0x13, 0x07),
    preOnline: (userInfo: UserInfoSnapshot | null) => {
      heard.push(userInfo);
      return plan;
    },
    awayWrite: async (given: { awayAndProfileBytes: number }) => {
      limits.push(given);
      if (writeAway) await link.send(0x02, 0x04, encodeLocateInfo({ away: 'brb' }));
    },
  };
  let outcome: unknown = 'pending';
  signOn.bringUp(link, hooks, [], { away: null, invisible: false, systemIdleSeconds: () => 4000, idleAfterSeconds: 1 }).then(
    () => { outcome = 'done'; },
    (error: unknown) => { outcome = error; },
  );
  conn.deliver({ family: 1, subtype: 3, body: HOST_ONLINE, requestId: 0x80000000 });
  const replies: Record<string, { family: number; subtype: number; body: Uint8Array; server?: true }> = {
    '1/23': { family: 1, subtype: 0x18, body: Uint8Array.of(0, 1, 0, version) },
    '1/6': { family: 1, subtype: 0x07, body: Uint8Array.of(0, 0) },
    '2/2': { family: 2, subtype: 0x03, body: new Uint8Array(0) },
    '4/4': { family: 4, subtype: 0x05, body: new Uint8Array(0) },
    '1/14': { family: 1, subtype: 0x0f, body: version === 4 ? concatBytes([SESSION, INSTANCE]) : SESSION },
    // The server confirms a status write with its own self info.
    '1/30': { family: 1, subtype: 0x0f, body: INVISIBLE, server: true },
  };
  const answered = new Set<number>();
  for (let turn = 0; turn < 50 && outcome === 'pending'; turn++) {
    await timers.advance(0);
    for (const request of conn.sent) {
      const reply = replies[`${request.family}/${request.subtype}`];
      if (reply === undefined || answered.has(request.requestId)) continue;
      answered.add(request.requestId);
      conn.deliver({ family: reply.family, subtype: reply.subtype, body: reply.body, requestId: reply.server ? 0x80000000 : request.requestId });
    }
  }
  expect(outcome).toBe('done');
  return { sent: conn.sent, heard, emitted, limits, idleReported: signOn.idleReported };
}

const pairs = (sent: SentSnac[]): [number, number][] => sent.map((s) => [s.family, s.subtype]);
const fromFeedbagUse = (sent: SentSnac[]): [number, number][] => pairs(sent.slice(sent.findIndex((s) => s.family === 0x13 && s.subtype === 0x07)));
const idleWrites = (sent: SentSnac[]): string[] => sent.filter((s) => s.family === 1 && s.subtype === 0x11).map((s) => Buffer.from(s.body).toString('hex'));

describe('the pre-online sequence', () => {
  it('reads the user info, writes invisible, the away and idle, then client online', async () => {
    const quiet = await run(4, { invisible: true, reportIdle: true }, false);
    expect(fromFeedbagUse(quiet.sent)).toEqual([[0x13, 0x07], [1, 0x0e], [1, 0x1e], [1, 0x11], [1, 0x02], [1, 0x0e]]);
    expect(idleWrites(quiet.sent)).toEqual(['00000fa0']);
    expect(quiet.idleReported).toBe(true);
    expect(quiet.limits).toEqual([{ awayAndProfileBytes: 1000 }]);

    const away = await run(4, { invisible: true, reportIdle: true }, true);
    expect(fromFeedbagUse(away.sent)).toEqual([[0x13, 0x07], [1, 0x0e], [1, 0x1e], [2, 0x04], [1, 0x11], [1, 0x02], [1, 0x0e]]);
    expect(idleWrites(away.sent)).toEqual(['00000fa0']);
  });

  it('hands the hook the snapshot of the pre-online query', async () => {
    const { heard, emitted } = await run(4, { invisible: false, reportIdle: false }, false);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBe(emitted[0]);
    expect([heard[0]?.multiInstance, heard[0]?.instances.length]).toEqual([true, 1]);
  });

  it('below version 4 the hook hears null and nothing asks for the user info before client online', async () => {
    const { sent, heard } = await run(1, { invisible: false, reportIdle: false }, false);
    expect(heard).toEqual([null]);
    const online = pairs(sent).findIndex(([family, subtype]) => family === 1 && subtype === 0x02);
    expect(online).toBeGreaterThan(0);
    expect(pairs(sent).slice(0, online)).not.toContainEqual([1, 0x0e]);
  });

  it('a plan without idle writes none and forgets that idle was reported', async () => {
    const { sent, idleReported } = await run(4, { invisible: false, reportIdle: false }, false);
    expect(idleWrites(sent)).toEqual([]);
    expect(idleReported).toBe(false);
    expect(pairs(sent)).not.toContainEqual([1, 0x1e]);
  });
});
