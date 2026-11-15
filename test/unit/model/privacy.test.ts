import { describe, expect, it } from 'vitest';
import { FEEDBAG_ATTR_PD_MODE, FEEDBAG_ATTR_PENDING } from '../../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../../src/wire/feedbag.js';
import { tlv } from '../../../src/wire/tlv.js';
import { PRIVACY_MODES, blocks, modeOf, privacyChange, privacyOfView, settledBuddies, wireOf } from '../../../src/model/privacy.js';
import type { Privacy, PrivacyMode } from '../../../src/model/privacy.js';
import { blocks as serverBlocks } from '../../fake/relationship.js';

const WIRE: Record<Exclude<PrivacyMode, 'unknown'>, number> = { 'allow-all': 1, 'block-all': 2, 'allow-list': 3, 'block-list': 4, 'allow-buddies': 5 };

describe('modeOf and wireOf', () => {
  it('reads the five modes of the server and nothing else', () => {
    expect([1, 2, 3, 4, 5].map(modeOf)).toEqual(['allow-all', 'block-all', 'allow-list', 'block-list', 'allow-buddies']);
    expect([0, 6, 255].map(modeOf)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('wireOf undoes modeOf for 1 to 5', () => {
    for (const wire of [1, 2, 3, 4, 5]) {
      const mode = modeOf(wire);
      if (mode === 'unknown') throw new Error(`no mode for ${wire}`);
      expect(wireOf(mode)).toBe(wire);
    }
  });

  it("PRIVACY_MODES holds the five in AIM's order", () => {
    expect(PRIVACY_MODES).toEqual(['allow-all', 'allow-buddies', 'allow-list', 'block-all', 'block-list']);
  });
});

// The people of the table: bob a buddy, and pat a buddy waiting for authorisation. al is on the Allow list,
// bl on the Block list, both on both lists and nobody on neither. me is the user.
const ALLOW = ['al', 'both'];
const BLOCK = ['bl', 'both'];
const privacyOf = (mode: PrivacyMode, block: readonly string[] = BLOCK): Privacy => ({ mode, allow: ALLOW, block });
const BUDDIES = new Set(['bob']);
const NAMES = ['bob', 'pat', 'al', 'bl', 'both', 'nobody', 'me'] as const;
const MODES: PrivacyMode[] = ['allow-all', 'block-all', 'allow-list', 'block-list', 'allow-buddies', 'unknown'];

// For each name: the mode's rule, and the user's own name only under block-list when listed.
const EXPECTED: Record<PrivacyMode, Record<(typeof NAMES)[number], boolean>> = {
  'allow-all': { bob: false, pat: false, al: false, bl: false, both: false, nobody: false, me: false },
  unknown: { bob: false, pat: false, al: false, bl: false, both: false, nobody: false, me: false },
  'block-all': { bob: true, pat: true, al: true, bl: true, both: true, nobody: true, me: false },
  'allow-list': { bob: true, pat: true, al: false, bl: true, both: false, nobody: true, me: false },
  'block-list': { bob: false, pat: false, al: false, bl: true, both: true, nobody: false, me: false },
  'allow-buddies': { bob: false, pat: true, al: true, bl: true, both: true, nobody: true, me: true },
};

// The same setting as the server's feedbag; unknown is wire value 6.
function feedbagOf(mode: PrivacyMode, block: readonly string[] = BLOCK): FeedbagItem[] {
  const item = (classId: number, name: string, itemId: number, attrs: FeedbagItem['attrs'] = []): FeedbagItem => ({ name, groupId: classId === 0 ? 1 : 0, itemId, classId, attrs });
  return [
    item(0, 'bob', 1),
    item(0, 'pat', 2, [tlv.bytes(FEEDBAG_ATTR_PENDING, new Uint8Array(0))]),
    ...ALLOW.map((name, i) => item(2, name, 10 + i)),
    ...block.map((name, i) => item(3, name, 20 + i)),
    item(4, '', 30, [tlv.u8(FEEDBAG_ATTR_PD_MODE, mode === 'unknown' ? 6 : WIRE[mode])]),
  ];
}

describe('blocks', () => {
  it.each(MODES)('under %s each name is blocked as the server would block it, and the user only by a Block-list item', (mode) => {
    const got = Object.fromEntries(NAMES.map((name) => [name, blocks(privacyOf(mode), BUDDIES, name, 'me')]));
    expect(got).toEqual({ ...EXPECTED[mode], me: false });
    expect(blocks(privacyOf(mode, [...BLOCK, 'me']), BUDDIES, 'me', 'me')).toBe(mode === 'block-list');
  });

  it.each(MODES)('parity with the test server under %s, for every name but the user', (mode) => {
    const feedbag = feedbagOf(mode);
    const buddies = settledBuddies([{ buddies: [{ screenName: 'bob', pending: false }, { screenName: 'pat', pending: true }] }]);
    for (const name of NAMES.filter((each) => each !== 'me')) {
      expect([name, blocks(privacyOf(mode), buddies, name, 'me')]).toEqual([name, serverBlocks(feedbag, name)]);
    }
  });

  it('takes any spelling of the name and of the user', () => {
    for (const mode of MODES) {
      expect(blocks(privacyOf(mode), BUDDIES, 'B O B', 'M E')).toBe(blocks(privacyOf(mode), BUDDIES, 'bob', 'me'));
      expect(blocks(privacyOf(mode, [...BLOCK, 'me']), BUDDIES, 'M e', 'mE')).toBe(mode === 'block-list');
    }
  });

  it('with no user known, every name follows the mode', () => {
    expect(blocks(privacyOf('allow-buddies'), BUDDIES, 'me', null)).toBe(true);
  });
});

describe('settledBuddies and privacyOfView', () => {
  it('leaves out a buddy waiting for authorisation and holds each name once, normalised', () => {
    const groups = [
      { buddies: [{ screenName: 'Bob', pending: false }, { screenName: 'Pat', pending: true }] },
      { buddies: [{ screenName: 'bob', pending: false }, { screenName: 'Car Ol', pending: false }] },
    ];
    expect([...settledBuddies(groups)]).toEqual(['bob', 'carol']);
  });

  it("maps a view's entries to their normalised names", () => {
    const entry = (name: string, screenName: string) => ({ name, screenName, busy: false });
    expect(privacyOfView({ mode: 'allow-list', allow: [entry('bob', 'Bob')], block: [entry('carol', 'Car Ol'), entry('dave', 'dave')] })).toEqual({
      mode: 'allow-list', allow: ['bob'], block: ['carol', 'dave'],
    });
  });
});

describe('privacyChange', () => {
  const at = (mode: PrivacyMode, allow: string[] = [], block: string[] = []): Privacy => ({ mode, allow, block });
  const buddies = new Set(['bob']);
  const kind = (privacy: Privacy, name: string, want: 'block' | 'unblock'): string => privacyChange(privacy, buddies, name, want, 100).kind;

  it.each<[string, Privacy, string, 'block' | 'unblock', string]>([
    ['allow-all: Block a buddy', at('allow-all'), 'bob', 'block', 'direct'],
    ['allow-all: Block a non-buddy', at('allow-all'), 'zed', 'block', 'direct'],
    ['allow-all: Unblock a buddy', at('allow-all', [], ['bob']), 'bob', 'unblock', 'none'],
    ['allow-all: Unblock a non-buddy', at('allow-all', [], ['zed']), 'zed', 'unblock', 'none'],
    ['unknown: Block a buddy', at('unknown'), 'bob', 'block', 'direct'],
    ['unknown: Block a non-buddy', at('unknown'), 'zed', 'block', 'direct'],
    ['unknown: Unblock a buddy', at('unknown', [], ['bob']), 'bob', 'unblock', 'none'],
    ['unknown: Unblock a non-buddy', at('unknown'), 'zed', 'unblock', 'none'],
    ['block-list: Block a buddy', at('block-list'), 'bob', 'block', 'direct'],
    ['block-list: Block a non-buddy', at('block-list'), 'zed', 'block', 'direct'],
    ['block-list: Block a name already listed', at('block-list', [], ['zed']), 'zed', 'block', 'none'],
    ['block-list: Unblock a buddy', at('block-list', [], ['bob']), 'bob', 'unblock', 'direct'],
    ['block-list: Unblock a non-buddy', at('block-list', [], ['zed']), 'zed', 'unblock', 'direct'],
    ['block-list: Unblock a name not listed', at('block-list'), 'zed', 'unblock', 'none'],
    ['allow-list: Block an allowed buddy', at('allow-list', ['bob']), 'bob', 'block', 'direct'],
    ['allow-list: Block an allowed non-buddy', at('allow-list', ['zed']), 'zed', 'block', 'direct'],
    ['allow-list: Block a buddy not allowed', at('allow-list'), 'bob', 'block', 'none'],
    ['allow-list: Block a non-buddy not allowed', at('allow-list'), 'zed', 'block', 'none'],
    ['allow-list: Unblock a buddy not allowed', at('allow-list'), 'bob', 'unblock', 'direct'],
    ['allow-list: Unblock a non-buddy not allowed', at('allow-list'), 'zed', 'unblock', 'direct'],
    ['allow-list: Unblock an allowed buddy', at('allow-list', ['bob']), 'bob', 'unblock', 'none'],
    ['allow-list: Unblock an allowed non-buddy', at('allow-list', ['zed']), 'zed', 'unblock', 'none'],
    ['allow-buddies: Block a buddy', at('allow-buddies'), 'bob', 'block', 'convert'],
    ['allow-buddies: Block a non-buddy', at('allow-buddies'), 'zed', 'block', 'none'],
    ['allow-buddies: Unblock a buddy', at('allow-buddies'), 'bob', 'unblock', 'none'],
    ['allow-buddies: Unblock a non-buddy', at('allow-buddies'), 'zed', 'unblock', 'convert'],
    ['block-all: Block a buddy', at('block-all'), 'bob', 'block', 'none'],
    ['block-all: Block a non-buddy', at('block-all'), 'zed', 'block', 'none'],
    ['block-all: Unblock a buddy', at('block-all'), 'bob', 'unblock', 'convert'],
    ['block-all: Unblock a non-buddy', at('block-all'), 'zed', 'unblock', 'convert'],
  ])('%s', (_case, privacy, name, want, expected) => {
    expect(kind(privacy, name, want)).toBe(expected);
  });

  it('a buddy waiting for authorisation is no buddy: its Unblock under allow-buddies converts', () => {
    const settled = settledBuddies([{ buddies: [{ screenName: 'bob', pending: false }, { screenName: 'pat', pending: true }] }]);
    expect(privacyChange(at('allow-buddies'), settled, 'pat', 'unblock', 100)).toEqual({ kind: 'convert', others: 0, buddies: 1, needed: 2, fits: true });
    expect(privacyChange(at('allow-buddies'), settled, 'pat', 'block', 100)).toEqual({ kind: 'none' });
  });

  it('counts a conversion: the other names allowed, the buddies inserted and the Allow list after it', () => {
    const three = new Set(['bob', 'cat', 'dan']);
    // dan is inserted; cat is allowed already; x and y are the others.
    expect(privacyChange(at('allow-buddies', ['x', 'y', 'cat']), three, 'bob', 'block', 100)).toEqual({ kind: 'convert', others: 2, buddies: 1, needed: 4, fits: true });
    expect(privacyChange(at('block-all', ['x', 'y']), three, 'zed', 'unblock', 100)).toEqual({ kind: 'convert', others: 2, buddies: 0, needed: 3, fits: true });
    // A pending buddy is never counted among the buddies.
    const withPending = settledBuddies([{ buddies: [{ screenName: 'bob', pending: false }, { screenName: 'pat', pending: true }] }]);
    expect(privacyChange(at('allow-buddies'), withPending, 'zed', 'unblock', 100)).toEqual({ kind: 'convert', others: 0, buddies: 1, needed: 2, fits: true });
  });

  it('under Block everyone counts every other name on the Allow list, buddies too: each is blocked before and allowed after', () => {
    const three = new Set(['carol', 'dave', 'erin']);
    // The Allow list a Block under Allow only my buddies left: every buddy on it.
    expect(privacyChange(at('block-all', ['carol', 'dave', 'erin']), three, 'Bob', 'unblock', 100)).toEqual({ kind: 'convert', others: 3, buddies: 0, needed: 4, fits: true });
    // A stranger unblocked with one buddy on the Allow list.
    expect(privacyChange(at('block-all', ['carol']), three, 'zed', 'unblock', 100)).toEqual({ kind: 'convert', others: 1, buddies: 0, needed: 2, fits: true });
    // A buddy unblocked: the person is never among the others.
    expect(privacyChange(at('block-all', ['carol', 'dave']), three, 'Dave', 'unblock', 100)).toEqual({ kind: 'convert', others: 1, buddies: 0, needed: 2, fits: true });
    // Under Allow only my buddies a buddy on the Allow list is allowed before and after: not counted.
    expect(privacyChange(at('allow-buddies', ['carol', 'x']), three, 'zed', 'unblock', 100)).toMatchObject({ kind: 'convert', others: 1 });
  });

  it('fits at the limit and not one past it', () => {
    const three = new Set(['bob', 'cat', 'dan']);
    const privacy = at('allow-buddies', ['x', 'y', 'cat']);
    expect(privacyChange(privacy, three, 'bob', 'block', 4)).toMatchObject({ kind: 'convert', needed: 4, fits: true });
    expect(privacyChange(privacy, three, 'bob', 'block', 3)).toMatchObject({ kind: 'convert', needed: 4, fits: false });
    const sixtyOne = new Set(Array.from({ length: 61 }, (_, i) => `buddy${i + 1}`));
    expect(privacyChange(at('allow-buddies'), sixtyOne, 'zed', 'unblock', 60)).toEqual({ kind: 'convert', others: 0, buddies: 61, needed: 62, fits: false });
  });

  it('a direct Unblock under allow-list inserts one permit item and does not fit a full Allow list', () => {
    const full = Array.from({ length: 100 }, (_, i) => `friend${i + 1}`);
    expect(privacyChange(at('allow-list', full), buddies, 'zed', 'unblock', 100)).toEqual({ kind: 'direct', needed: 101, fits: false });
    expect(privacyChange(at('allow-list', full.slice(1)), buddies, 'zed', 'unblock', 100)).toEqual({ kind: 'direct', needed: 100, fits: true });
  });

  it('a direct change that inserts no permit item fits, with the Allow list as it is', () => {
    const full = Array.from({ length: 100 }, (_, i) => `friend${i + 1}`);
    expect(privacyChange(at('allow-all', full), buddies, 'zed', 'block', 10)).toEqual({ kind: 'direct', needed: 100, fits: true });
    expect(privacyChange(at('block-list', full, ['zed']), buddies, 'zed', 'unblock', 10)).toEqual({ kind: 'direct', needed: 100, fits: true });
    expect(privacyChange(at('allow-list', ['zed', 'amy']), buddies, 'zed', 'block', 1)).toEqual({ kind: 'direct', needed: 2, fits: true });
  });
});
