import { describe, expect, it } from 'vitest';
import { excludedSender, heldForDelivery, knocksWith } from '../../../src/model/knock.js';
import type { KnockState, SenderContext } from '../../../src/model/knock.js';
import type { Privacy } from '../../../src/model/privacy.js';

const context = (privacy: Partial<Privacy> = {}): SenderContext => ({
  groups: [{ buddies: [{ screenName: 'Bob Smith', pending: false }, { screenName: 'carol', pending: true }] }],
  privacy: { mode: 'allow-all', allow: [], block: [], ...privacy },
  self: 'Me Here',
});
const on: KnockState = { knockKnock: true, knocking: false, accepted: false };
const im = (from: string, serverNotice = false) => ({ from, serverNotice });

describe('excludedSender', () => {
  it('discards a sender the privacy setting blocks, by the server rule', () => {
    expect(excludedSender(context({ mode: 'block-list', block: ['dave'] }), 'Dave', false)).toBe(true);
    expect(excludedSender(context({ mode: 'block-list', block: ['dave'] }), 'erin', false)).toBe(false);
    expect(excludedSender(context({ mode: 'allow-buddies' }), 'bobsmith', false)).toBe(false);
    expect(excludedSender(context({ mode: 'allow-buddies' }), 'Carol', false)).toBe(true); // a pending buddy is not settled
    expect(excludedSender(context({ mode: 'allow-list', allow: ['erin'] }), 'E rin', false)).toBe(false);
    expect(excludedSender(context({ mode: 'block-all' }), 'anyone', false)).toBe(true);
  });
  it("never discards a server notice or the user's own name", () => {
    expect(excludedSender(context({ mode: 'block-all' }), 'OOS System Msg', true)).toBe(false);
    expect(excludedSender(context({ mode: 'block-list', block: ['mehere'] }), 'me here', false)).toBe(false);
  });
});

describe('knocksWith', () => {
  it('knocks for a person not on the buddy list, not blocked, not the user and not accepted', () => {
    expect(knocksWith(context(), on, im('Stranger'))).toBe(true);
  });
  it('a buddy row, settled or pending, never knocks', () => {
    expect(knocksWith(context(), on, im('bobsmith'))).toBe(false);
    expect(knocksWith(context(), on, im('CAROL'))).toBe(false);
  });
  it('never knocks for a server notice, the user, or a sender the setting blocks', () => {
    expect(knocksWith(context(), on, im('Stranger', true))).toBe(false);
    expect(knocksWith(context(), on, im('MeHere'))).toBe(false);
    expect(knocksWith(context({ mode: 'block-list', block: ['stranger'] }), on, im('Stranger'))).toBe(false);
  });
  it('not while knock knock is off, nor once accepted', () => {
    expect(knocksWith(context(), { ...on, knockKnock: false }, im('Stranger'))).toBe(false);
    expect(knocksWith(context(), { ...on, accepted: true }, im('Stranger'))).toBe(false);
  });
  it('a conversation that knocks keeps knocking until answered, whatever the setting, but never for a notice', () => {
    const knocking: KnockState = { knockKnock: false, knocking: true, accepted: true };
    expect(knocksWith(context(), knocking, im('bobsmith'))).toBe(true);
    expect(knocksWith(context(), knocking, im('bobsmith', true))).toBe(false);
  });
});

describe('heldForDelivery', () => {
  it('holds a send while every buddy row of the recipient shows offline', () => {
    const rows = (bob: boolean, again: boolean) => [{ buddies: [{ screenName: 'Bob', online: bob }, { screenName: 'carol', online: true }] }, { buddies: [{ screenName: 'b o b', online: again }] }];
    expect(heldForDelivery(rows(false, false), 'BOB', (b) => b.online)).toBe(true);
    expect(heldForDelivery(rows(false, true), 'BOB', (b) => b.online)).toBe(false);
    expect(heldForDelivery(rows(false, false), 'dave', (b) => b.online)).toBe(false);
  });
});
