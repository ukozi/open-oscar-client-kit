import { describe, expect, it } from 'vitest';
import { Presence } from '../../../src/client/presence.js';
import type { BuddyPresence } from '../../../src/model/buddy-list.js';
import { bytesOf, loadVectors } from '../../support/vectors.js';

const v = loadVectors('hand-session.json');
const NOW = 1_800_000_000_000;
const snac = (subtype: number, name: string) => ({ family: 3, subtype, flags: 0, requestId: 0x80000000, body: bytesOf(v, name) });

function make() {
  const seen: BuddyPresence[] = [];
  return { seen, presence: new Presence({ now: () => NOW, emit: (p) => seen.push(p) }) };
}

describe('Presence', () => {
  it('holds the full state an arrival carries', () => {
    const { seen, presence } = make();
    expect(presence.handle(snac(0x0b, 'buddy arrived body, away and idle'))).toBe(true);
    const want = { screenName: 'Chimr Dev 2', online: true, away: true, idleSince: NOW - 12 * 60_000, signedOnAt: 1_790_000_000_000, warnLevel: 100 };
    expect(seen).toEqual([want]);
    expect(presence.get('chimrdev2')).toEqual(want);
    expect(presence.get('CHIMR dev 2')).toEqual(want);
  });

  it('replaces the held state on a later arrival: no idle value clears idle', () => {
    const { seen, presence } = make();
    presence.handle(snac(0x0b, 'buddy arrived body, away and idle'));
    presence.handle(snac(0x0b, 'buddy arrived body, plain'));
    expect(seen[1]).toEqual({ screenName: 'Chimr Dev 2', online: true, away: false, idleSince: null, signedOnAt: 1_790_000_000_000, warnLevel: 0 });
  });

  it('clears away, idle and signed-on time on a departure and keeps the name and warn level', () => {
    const { seen, presence } = make();
    presence.handle(snac(0x0b, 'buddy arrived body, away and idle'));
    presence.handle(snac(0x0c, 'buddy departed body, display name'));
    expect(seen[1]).toEqual({ screenName: 'Chimr Dev 2', online: false, away: false, idleSince: null, signedOnAt: null, warnLevel: 100 });
  });

  it('reports a departure for a buddy it held nothing for', () => {
    const { seen, presence } = make();
    presence.handle(snac(0x0c, 'buddy departed body, display name'));
    expect(seen).toEqual([{ screenName: 'Chimr Dev 2', online: false, away: false, idleSince: null, signedOnAt: null, warnLevel: 0 }]);
  });

  it('emits a presence nobody can change', () => {
    const { seen, presence } = make();
    presence.handle(snac(0x0b, 'buddy arrived body, plain'));
    expect(() => {
      (seen[0] as { online: boolean }).online = false;
    }).toThrow(TypeError);
    expect(presence.get('chimrdev2')?.online).toBe(true);
  });

  it('ignores other SNACs and forgets everything on reset without an event', () => {
    const { seen, presence } = make();
    expect(presence.handle({ family: 4, subtype: 7, flags: 0, requestId: 0, body: new Uint8Array(0) })).toBe(false);
    presence.handle(snac(0x0b, 'buddy arrived body, plain'));
    presence.reset();
    expect([presence.get('chimrdev2'), seen.length]).toEqual([undefined, 1]);
  });
});
